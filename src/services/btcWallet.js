const { ethers } = require('ethers');
const ECPairFactory = require('ecpair').default;
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');

const ECPair = ECPairFactory(ecc);

const MNEMONIC = process.env.WALLET_MNEMONIC;
if (!MNEMONIC) throw new Error('WALLET_MNEMONIC is not set in .env');

// Same root node as ethWallet.js/tronWallet.js (same mnemonic), but
// Bitcoin gets its own BIP44 coin type (1 = "any testnet") and purpose
// (84 = native SegWit), so its keys/addresses are entirely distinct.
const masterNode = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m");

function deriveBtcWallet(index) {
  const child = masterNode.derivePath(`m/84'/1'/0'/0/${index}`);
  const privateKeyBuffer = Buffer.from(child.privateKey.slice(2), 'hex');
  const keyPair = ECPair.fromPrivateKey(privateKeyBuffer, { network: bitcoin.networks.testnet });
  const { address, output } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: bitcoin.networks.testnet,
  });
  return { address, scriptPubKey: output, keyPair };
}

module.exports = { deriveBtcWallet, ECPair, bitcoin };