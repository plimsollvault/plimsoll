// Publishes the contract source on Robinhood Chain's Blockscout for the deployed addresses.
//   npx hardhat run scripts/verify-source.js --network robinhood
const hre = require("hardhat");
const cfg = require("../config/robinhood");
const dep = require("../deployments/robinhood.json");

// The deployer only appears as the timelock's initial admin, which it renounced after setup.
const DEPLOYER = process.env.DEPLOYER_ADDRESS || "0x767Fc0A8A2EC6cf3785ea80F16786819A0Ebe74f";

async function verify(label, address, constructorArguments, contract) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`OK    ${label} ${address}`);
  } catch (e) {
    const msg = String(e.message || e);
    if (/already verified/i.test(msg)) console.log(`OK    ${label} already verified`);
    else console.log(`FAIL  ${label}: ${msg.split("\n")[0]}`);
  }
}

async function main() {
  await verify("Vault", dep.vault, [
    cfg.usdg, cfg.uniswap.poolManager, cfg.uniswap.stateView, cfg.assetConfigs(), cfg.limits,
    BigInt(dep.depositCapUsdg) * 10n ** 6n, dep.timelock, dep.guardian, dep.agent,
  ], "contracts/PlimsollVault.sol:PlimsollVault");
  await verify("Governor", dep.governor, [dep.vault, dep.timelock, 100n * 10n ** 18n], "contracts/PlimsollGovernor.sol:PlimsollGovernor");
  await verify("Timelock", dep.timelock, [259200, [], [hre.ethers.ZeroAddress], DEPLOYER],
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController");
}

main().catch((e) => { console.error(e); process.exit(1); });
