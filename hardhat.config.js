require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

// Public RPC that served valid TLS during development. The official endpoint
// (https://rpc.mainnet.chain.robinhood.com) returned an expired certificate on 2026-11-24.
// MetaMask exports keys without 0x; accept both forms
const hexKey = (k) => (k.trim().startsWith("0x") ? k.trim() : "0x" + k.trim());
const RPC = process.env.ROBINHOOD_RPC || "https://rpc.nodeflare.app/robinhood/public";

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: {
      chainId: 4663,
      forking: process.env.FORK === "0" ? undefined : { url: RPC, blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined },
      hardfork: "cancun",
    },
    localhost: { url: "http://127.0.0.1:8545", chainId: 4663 },
    robinhood: {
      url: RPC,
      chainId: 4663,
      accounts: process.env.DEPLOYER_KEY ? [hexKey(process.env.DEPLOYER_KEY)] : [],
    },
  },
  // Source verification on Robinhood Chain's Blockscout (no API key needed)
  etherscan: {
    apiKey: { robinhood: "blockscout" },
    customChains: [{ network: "robinhood", chainId: 4663, urls: { apiURL: "https://robinhoodchain.blockscout.com/api", browserURL: "https://robinhoodchain.blockscout.com" } }],
  },
  sourcify: { enabled: false },
  mocha: { timeout: 600000 },
};
