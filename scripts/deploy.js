// Deploys the timelock, the vault and the holder-vote governor, then hands the timelock to the governor.
//
//   DEPLOYER_KEY=0x... AGENT_ADDRESS=0x... GUARDIAN_ADDRESS=0x... npx hardhat run scripts/deploy.js --network robinhood
//
// Optional: DEPOSIT_CAP_USDG (default 10000), PROPOSAL_THRESHOLD_SHARES (default 100), TIMELOCK_SECONDS (default 259200 = 72h)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");

async function main() {
  const [deployer] = await ethers.getSigners();
  const agent = process.env.AGENT_ADDRESS;
  const guardian = process.env.GUARDIAN_ADDRESS || deployer.address;
  if (!agent || !ethers.isAddress(agent)) throw new Error("Set AGENT_ADDRESS to the agent wallet's address (not its key).");
  if (agent.toLowerCase() === deployer.address.toLowerCase()) throw new Error("Use a separate wallet for the agent.");
  const cap = BigInt(process.env.DEPOSIT_CAP_USDG || "10000") * 10n ** 6n;
  const threshold = BigInt(process.env.PROPOSAL_THRESHOLD_SHARES || "100") * 10n ** 18n;
  const delay = Number(process.env.TIMELOCK_SECONDS || 259200);

  const net = await ethers.provider.getNetwork();
  console.log(`Network ${network.name} (chain ${net.chainId}), deployer ${deployer.address}`);
  console.log(`Deployer balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  if (net.chainId !== BigInt(cfg.chainId)) throw new Error(`Expected chain ${cfg.chainId}`);

  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(delay, [], [ethers.ZeroAddress], deployer.address);
  await timelock.waitForDeployment();
  console.log("TimelockController", await timelock.getAddress());

  const Vault = await ethers.getContractFactory("PlimsollVault");
  const vault = await Vault.deploy(
    cfg.usdg, cfg.uniswap.poolManager, cfg.uniswap.stateView, cfg.assetConfigs(), cfg.limits,
    cap, await timelock.getAddress(), guardian, agent
  );
  await vault.waitForDeployment();
  const vaultTx = vault.deploymentTransaction();
  console.log("PlimsollVault", await vault.getAddress());

  const Governor = await ethers.getContractFactory("PlimsollGovernor");
  const governor = await Governor.deploy(await vault.getAddress(), await timelock.getAddress(), threshold);
  await governor.waitForDeployment();
  console.log("PlimsollGovernor", await governor.getAddress());

  const gov = await governor.getAddress();
  await (await timelock.grantRole(await timelock.PROPOSER_ROLE(), gov)).wait();
  await (await timelock.grantRole(await timelock.CANCELLER_ROLE(), gov)).wait();
  await (await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).wait();
  console.log("Timelock now answers only to the governor; deployer admin renounced.");

  const out = {
    chainId: Number(net.chainId),
    network: network.name,
    vault: await vault.getAddress(),
    governor: gov,
    timelock: await timelock.getAddress(),
    agent,
    guardian,
    depositCapUsdg: Number(cap / 10n ** 6n),
    deployBlock: vaultTx ? (await vaultTx.wait()).blockNumber : null,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(`Saved deployments/${network.name}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
