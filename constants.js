const fs = require('fs');

module.exports = Object.freeze({
    CHUNK_SIZE: 32500,
    SONG_INDEX: 0,
    JSON_RPC_URL: 'http://165.22.79.111:9090/chains/tst1prwy70s642runwg42ktd2slz632ldqapaxdsfxpu0a8w26z77sk9xhue72u/evm',
    FAUCET_URL: 'http://165.22.79.111/debug/faucet/',
    CHAIN_ID: 1074,
    CONTRACT_ADDR: '0xf04F4a58F88237e748e20812fE767534aA771f17', 
    ABI: JSON.parse(fs.readFileSync('./abi.json')),
    HORNET_API_URL: 'http://165.22.79.111:14265'
});