const { ethers } = require('ethers');

const MNEMONIC = process.env.WALLET_MNEMONIC;
const RPC_URL = process.env.SEPOLIA_RPC_URL;

if (!MNEMONIC) throw new Error('WALLET_MNEMONIC is not set in .env');
if (!RPC_URL) throw new Error('SEPOLIA_RPC_URL is not set in .env');

const provider = new ethers.JsonRpcProvider(RPC_URL);

// The third argument ("m") tells ethers to stop at the mnemonic's root
// node instead of auto-deriving down to the default account path
// (m/44'/60'/0'/0/0). We need the root so derivePath() below can apply
// its own absolute "m/..." path per user.
const masterNode = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m");

// Standard Ethereum derivation path: m/44'/60'/0'/0/{index}.
// We use the user's DB id as the index — Postgres SERIAL ids never
// get reused, so this stays a stable 1:1 mapping for the app's lifetime.
function deriveEthWallet(index) {
  const child = masterNode.derivePath(`m/44'/60'/0'/0/${index}`);
  return child; // has .address and .privateKey
}

module.exports = { provider, deriveEthWallet };