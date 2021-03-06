const cors = require('cors')
const bodyParser = require('body-parser');
const express = require('express');
const request = require('request-promise');
const {
  TypedDataUtils
} = require('eth-sig-util');

const ethUtil = require('ethereumjs-util');
const abi = require('ethereumjs-abi');
const Web3 = require('web3')

const port = process.env.PORT || '8000'

const network = process.env.NETWORK || 'ropsten'
const chainId = process.env.CHAINID || 3

const adminPrivateKey = process.env.ADMIN_PRIVATEKEY
const adminAddress = ethUtil.privateToAddress(Buffer.from(adminPrivateKey.substring(2), 'hex'))
const admin = ethUtil.bufferToHex(adminAddress);

const apikey = process.env.APIKEY
const rocksideURL = process.env.APIURL
const forwarderAddress = process.env.FORWARDER

const gnosisSafeProxyFactory = process.env.GNOSIS_SAFE_PROXY_FACTORY || "0x016457118b425fe86952381eC5127F28D4248984"
const gnosisSafeMasterCopy = process.env.GNOSIS_SAFE_MASTERCOPY || "0xB6998f4E968573534D6ea6A500323B0d1cd03767"

const rpc = process.env.RPC
const web3 = new Web3(rpc)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

async function deployGnosisSafe(req, res) {
  const owner = req.body.owner
  const initData = web3.eth.abi.encodeFunctionCall({
    name: 'setup',
    type: 'function',
    inputs: [{
      type: 'address[]',
      name: '_owners'
    },{
      type: 'uint256',
      name: '_threshold'
    },{
      type: 'address',
      name: 'to'
    },{
      type: 'bytes',
      name: 'data'
    },{
      type: 'address',
      name: 'fallbackHandler'
    },{
      type: 'address',
      name: 'paymentToken'
    },{
      type: 'uint256',
      name: 'payment'
    },{
      type: 'address',
      name: 'paymentReceiver'
    },]
  }, [[owner], 1, ZERO_ADDRESS, '0x', ZERO_ADDRESS, ZERO_ADDRESS, 0, ZERO_ADDRESS]);

  const salt = getRandomSalt();
  const dataForFactory = web3.eth.abi.encodeFunctionCall({
    name: 'createProxyWithNonce',
    type: 'function',
    inputs: [{
      type: 'address',
      name: '_mastercopy'
    }, {
      type: 'bytes',
      name: 'initializer'
    }, {
      type: 'uint256',
      name: 'saltNonce'
    }]
  }, [gnosisSafeMasterCopy, initData, salt]);
  const {
    nonce,
    gas_prices: gasPrice
  } = await fetchForwardParams(admin);

  const proxyAddress = await getCreate2AddressWithBlockchainCall(gnosisSafeProxyFactory, dataForFactory)
  const hash = hashRelayMessage(admin, gnosisSafeProxyFactory, dataForFactory, nonce);
  const signature = await sign(hash)
  const trackingId = await _forward(admin, gnosisSafeProxyFactory, dataForFactory, nonce, signature, gasPrice)
  res.status(200).json({
    trackingId,
    proxyAddress
  })
}

async function getCreate2AddressWithBlockchainCall(factory, dataForFactory) {
  return '0x' + (await web3.eth.call({
    'to': gnosisSafeProxyFactory,
    'data': dataForFactory
  })).slice(26)
}

// The dapp pay the gas
async function forward(req, res) {
  const to = req.body.to
  const data = req.body.data

  const {
    nonce,
    gas_prices: gasPrice
  } = await fetchForwardParams(admin);
  const hash = hashRelayMessage(admin, to, data, nonce);

  const signature = await sign(hash)
  const trackingId = await _forward(admin, to, data, nonce, signature, gasPrice)
  res.status(200).json({
    trackingId
  })
}

// The user pay the gas
async function relay(req, res) {
  const to = req.body.to
  const data = req.body.data
  const speed = req.body.speed

  const trackingId = await _relay(to, data, speed)
  res.status(200).json({
    trackingId
  })
}

async function relayParams(req, res) {
  res.json(await fetchRelayParams(req.params.gnosis))
}

async function getRocksideTx(req, res) {
  const response = await request({
    uri: `${rocksideURL}/ethereum/${network}/transactions/${req.params.trackingId}?apikey=${apikey}`,
    method: 'GET',
    json: true,
  })

  res.json(response)
}

function hashRelayMessage(signer, to, data, nonce) {
  const domain = {
    verifyingContract: forwarderAddress,
    chainId
  };

  const eip712DomainType = [{
      name: 'verifyingContract',
      type: 'address'
    },
    {
      name: 'chainId',
      type: 'uint256'
    }
  ];
  const encodedDomain = TypedDataUtils.encodeData(
    'EIP712Domain',
    domain, {
      EIP712Domain: eip712DomainType
    }
  );
  const hashedDomain = ethUtil.keccak256(encodedDomain);

  const messageTypes = {
    'TxMessage': [{
      name: "signer",
      type: "address"
    }, {
      name: "to",
      type: "address"
    }, {
      name: "data",
      type: "bytes"
    }, {
      name: "nonce",
      type: "uint256"
    }, ]
  };

  const encodedMessage = TypedDataUtils.encodeData(
    'TxMessage', {
      signer,
      to,
      data,
      nonce
    },
    messageTypes,
  );

  const hashedMessage = ethUtil.keccak256(encodedMessage);

  return ethUtil.keccak256(
    Buffer.concat([
      Buffer.from('1901', 'hex'),
      hashedDomain,
      hashedMessage,
    ])
  );
}

async function _forward(signer, to, data, nonce, signature, gasPrice) {
  const requestBody = {
    message: {
      signer,
      to,
      data,
      nonce
    },
    signature,
    speed: 'safelow',
    gas_price_limit: gasPrice.safelow,
  };

  const response = await request({
    method: 'POST',
    uri: `${rocksideURL}/ethereum/${network}/forwarders/${forwarderAddress}?apikey=${apikey}`,
    method: 'POST',
    body: requestBody,
    json: true,
  })

  return response.tracking_id;
}

async function _relay(destination, data, speed) {
  const requestBody = {
    data: data,
    speed: speed,
  };

  const response = await request({
    method: 'POST',
    uri: `${rocksideURL}/ethereum/${network}/relay/${destination}?apikey=${apikey}`,
    method: 'POST',
    body: requestBody,
    json: true,
  })

  return response.tracking_id;
}

async function sign(hash) {
  const sig = await ethUtil.ecsign(hash, Buffer.from(adminPrivateKey.substring(2), 'hex'));
  const signature = ethUtil.toRpcSig(sig.v, sig.r, sig.s);
  return signature
}

async function fetchForwardParams(account) {
  const requestBody = {
    account,
    channel_id: '0'
  };

  const response = await request({
    uri: `${rocksideURL}/ethereum/${network}/forwarders/${forwarderAddress}/relayParams?apikey=${apikey}`,
    method: 'POST',
    body: requestBody,
    json: true,
  })

  return response;
}

async function fetchRelayParams(gnosis) {
  const response = await request({
    uri: `${rocksideURL}/ethereum/${network}/relay/${gnosis}/params?apikey=${apikey}`,
    method: 'GET',
    json: true,
  })

  return response;
}

function getRandomSalt() {
  const salt = Math.ceil(Math.random() * 10000000000000000000);
  return '0x' + salt.toString(16);
}

function wrap(handler) {
  return (req, res, next) => {
    return Promise
      .resolve(handler(req, res))
      .catch(next);
  }
}

let app = express();

app.use(bodyParser.json())
app.use(cors())

app.post('/deploy', wrap(deployGnosisSafe))
app.post('/forward', wrap(forward))
app.post('/relay', wrap(relay))
app.get('/relay/:gnosis/params', wrap(relayParams))
app.get('/tx/:trackingId', wrap(getRocksideTx))

app.set('trust proxy', true);
app.use(function(err, req, res, next) {
  res.status(500).json({
    error: err.message
  })
});
app.listen(port);
