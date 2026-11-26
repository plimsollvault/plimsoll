// Reads the deployed contracts back from chain and checks every setting. Sends nothing.
//   npx hardhat run scripts/verify-deploy.js --network robinhood
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");
const dep = require(`../deployments/${network.name}.json`);

let bad = 0;
const check = (cond, msg) => { console.log((cond ? "  OK    " : "  FIX   ") + msg); if (!cond) bad++; };

async function main() {
  const vault = await ethers.getContractAt("PlimsollVault", dep.vault);
  const gov = await ethers.getContractAt("PlimsollGovernor", dep.governor);
  const tl = await ethers.getContractAt("TimelockController", dep.timelock);
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

  check(eq(await vault.governance(), dep.timelock), "vault governance is the timelock");
  check(eq(await vault.agent(), dep.agent), `vault agent is ${dep.agent}`);
  check(eq(await vault.guardian(), dep.guardian), `vault guardian is ${dep.guardian}`);
  check(eq(await vault.usdg(), cfg.usdg), "vault base asset is the real USDG");
  check(Number(await vault.assetCount()) === cfg.assets.length, `vault holds ${cfg.assets.length} stock tokens`);
  for (let i = 0; i < cfg.assets.length; i++) {
    const a = await vault.assetAt(i);
    const p = Number(await vault.spotPrice(i)) / 1e6;
    check(eq(a.token, cfg.assets[i].token) && p > 1, `${cfg.assets[i].symbol} token and pool price $${p.toFixed(2)}`);
  }
  const l = await vault.limits();
  check(Number(l[0]) === cfg.limits.maxWeightBps && Number(l[2]) === cfg.limits.maxTurnoverBps, `limits ${Number(l[0]) / 100}% cap, ${Number(l[2]) / 100}% turnover`);
  check(Number(await vault.depositCap()) / 1e6 === dep.depositCapUsdg, `deposit cap ${dep.depositCapUsdg} USDG`);
  check(!(await vault.depositsPaused()) && !(await vault.tradingPaused()) && !(await vault.brakeTripped()), "not paused, brake clear");
  check((await vault.totalSupply()) === 0n, "no shares minted yet");

  check(eq(await gov.token(), dep.vault), "governor counts vault shares as votes");
  check(eq(await gov.timelock(), dep.timelock), "governor queues through the timelock");
  check(Number(await tl.getMinDelay()) === 259200, "timelock delay is 72 hours");
  check(await tl.hasRole(await tl.PROPOSER_ROLE(), dep.governor), "only the governor can propose to the timelock");
  check(await tl.hasRole(await tl.EXECUTOR_ROLE(), ethers.ZeroAddress), "anyone can execute a passed, delayed proposal");
  const [deployer] = await ethers.getSigners();
  check(!(await tl.hasRole(await tl.DEFAULT_ADMIN_ROLE(), deployer.address)), "deployer holds no timelock admin role");
  check(!(await tl.hasRole(await tl.PROPOSER_ROLE(), deployer.address)), "deployer cannot propose");
  console.log(bad ? `\n${bad} problem(s) found.` : "\nEverything matches the intended setup.");
}

main().catch((e) => { console.error(e); process.exit(1); });
