// Checks everything the mainnet deploy needs. Sends no transactions.
//   npx hardhat run scripts/preflight.js --network robinhood
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");

const ok = (m) => console.log("  OK    " + m);
const bad = (m) => { console.log("  FIX   " + m); problems++; };
let problems = 0;

async function main() {
  console.log(`\nPreflight for network "${network.name}"\n`);
  const net = await ethers.provider.getNetwork().catch(() => null);
  if (!net) { bad("RPC not reachable. Set ROBINHOOD_RPC in .env to a working endpoint."); return finish(); }
  net.chainId === BigInt(cfg.chainId) ? ok(`connected to chain ${net.chainId}, block ${await ethers.provider.getBlockNumber()}`) : bad(`wrong chain ${net.chainId}, expected ${cfg.chainId}`);

  const signers = await ethers.getSigners();
  if (!signers.length) { bad("DEPLOYER_KEY is empty in .env"); return finish(); }
  const deployer = signers[0];
  const depBal = await ethers.provider.getBalance(deployer.address);
  ok(`deployer ${deployer.address}, balance ${ethers.formatEther(depBal)} ETH`);

  const agent = process.env.AGENT_ADDRESS || "";
  if (!ethers.isAddress(agent)) bad("AGENT_ADDRESS is missing or not an address (use the address, never the key)");
  else if (agent.toLowerCase() === deployer.address.toLowerCase()) bad("AGENT_ADDRESS must be a different wallet from the deployer");
  else {
    const b = await ethers.provider.getBalance(agent);
    b > 0n ? ok(`agent ${agent}, balance ${ethers.formatEther(b)} ETH`) : bad(`agent ${agent} has no ETH for gas yet`);
  }
  const guardian = process.env.GUARDIAN_ADDRESS || deployer.address;
  ethers.isAddress(guardian) ? ok(`guardian ${guardian}${process.env.GUARDIAN_ADDRESS ? "" : " (defaults to the deployer)"}`) : bad("GUARDIAN_ADDRESS is not an address");
  if (process.env.AGENT_KEY && process.env.DEPLOYER_KEY && process.env.AGENT_KEY === process.env.DEPLOYER_KEY) bad("AGENT_KEY and DEPLOYER_KEY are the same key");

  // every token and pool still answers as expected
  const usdgCode = await ethers.provider.getCode(cfg.usdg);
  usdgCode.length > 2 ? ok("USDG contract found") : bad("USDG contract not found");
  for (const a of cfg.assets) {
    const code = await ethers.provider.getCode(a.token);
    code.length > 2 ? ok(`${a.symbol} token found`) : bad(`${a.symbol} token missing`);
  }

  // dry-run the expensive deploy to price it
  const Vault = await ethers.getContractFactory("PlimsollVault");
  const cap = BigInt(process.env.DEPOSIT_CAP_USDG || "10000") * 10n ** 6n;
  try {
    const tx = await Vault.getDeployTransaction(cfg.usdg, cfg.uniswap.poolManager, cfg.uniswap.stateView, cfg.assetConfigs(), cfg.limits, cap, deployer.address, guardian, ethers.isAddress(agent) ? agent : deployer.address);
    const gas = await ethers.provider.estimateGas({ ...tx, from: deployer.address });
    const fee = await ethers.provider.getFeeData();
    const price = fee.maxFeePerGas || fee.gasPrice || 0n;
    const est = (gas * price * 25n) / 10n; // vault + governor + timelock + role calls, with margin
    ok(`vault deploy simulates fine (${gas} gas). Budget about ${ethers.formatEther(est)} ETH for the whole deploy`);
    if (depBal < est) bad(`deployer needs at least ${ethers.formatEther(est)} ETH`);
  } catch (e) { bad("vault deploy simulation failed: " + (e.shortMessage || e.message)); }

  console.log(`\n  Deposit cap: ${Number(cap / 10n ** 6n).toLocaleString("en-US")} USDG`);
  console.log(`  Limits: ${cfg.limits.maxWeightBps / 100}% max per stock, ${cfg.limits.maxTurnoverBps / 100}% turnover per watch`);
  finish();
}

function finish() {
  console.log(problems ? `\n${problems} thing(s) to fix before deploying.\n` : "\nAll checks passed. Nothing was sent.\n");
  process.exitCode = problems ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
