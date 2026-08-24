const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');

const MNEMONIC = process.env.WALLET_MNEMONIC;
const TRON_RPC_URL = process.env.TRON_RPC_URL;

if (!MNEMONIC) throw new Error('WALLET_MNEMONIC is not set in .env');
if (!TRON_RPC_URL) throw new Error('TRON_RPC_URL is not set in .env');

const tronWeb = new TronWeb({ fullHost: TRON_RPC_URL });

// Same root node as ethWallet.js's masterNode (same mnemonic), but Tron
// gets its own BIP44 coin type (195) so every key/address it derives is
// completely distinct from the ETH ones, despite sharing one seed.
const masterNode = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m");

function deriveTronWallet(index) {
  const child = masterNode.derivePath(`m/44'/195'/0'/0/${index}`);
  const privateKeyHex = child.privateKey.slice(2); // tronweb wants no "0x" prefix
  const address = TronWeb.address.fromPrivateKey(privateKeyHex);
  return { address, privateKey: privateKeyHex };
}

module.exports = { tronWeb, deriveTronWallet };