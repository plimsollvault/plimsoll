// Creates a holder-vote proposal on the Plimsoll governor.
//
//   PROPOSER_KEY=0x... ACTION=setDepositCap VALUE=25000 DESCRIPTION="Raise the deposit cap to 25,000 USDG" \
//     npx hardhat run scripts/propose.js --network robinhood
//
// ACTION is one of:
//   setDepositCap   VALUE = new cap in whole USDG
//   setAgent        VALUE = new agent address
//   setGuardian     VALUE = new guardian address
//   setPaused       VALUE = "deposits,trading" as true/false, e.g. "false,false"
//   resetBrake      (no VALUE)
//   setLimits       VALUE = "maxWeight,minWeight,maxTurnover,maxSlippage,maxDeviation,brakeDrawdown,brakeWindow" in bps,
//                   e.g. "3000,500,1500,100,500,2000,8"
//
// The proposer needs at least 100 shares of voting power (turn it on in the console first).
// Set DRY_RUN=1 to print the encoded call without sending anything.
const { ethers, network } = require("hardhat");
const dep = require(`../deployments/${network.name}.json`);

async function main() {
  const action = process.env.ACTION;
  const value = process.env.VALUE || "";
  const description = process.env.DESCRIPTION;
  if (!action || !description) throw new Error("Set ACTION and DESCRIPTION (and VALUE where needed).");

  const vault = await ethers.getContractAt("PlimsollVault", dep.vault);
  let args;
  switch (action) {
    case "setDepositCap": args = [BigInt(value) * 10n ** 6n]; break;
    case "setAgent":
    case "setGuardian": if (!ethers.isAddress(value)) throw new Error("VALUE must be an address"); args = [value]; break;
    case "setPaused": args = value.split(",").map((v) => v.trim() === "true"); break;
    case "resetBrake": args = []; break;
    case "setLimits": {
      const n = value.split(",").map((v) => Number(v.trim()));
      if (n.length !== 7) throw new Error("setLimits needs 7 numbers");
      args = [{ maxWeightBps: n[0], minWeightBps: n[1], maxTurnoverBps: n[2], maxSlippageBps: n[3], maxDeviationBps: n[4], brakeDrawdownBps: n[5], brakeWindow: n[6] }];
      break;
    }
    default: throw new Error(`Unknown ACTION ${action}`);
  }
  const calldata = vault.interface.encodeFunctionData(action, args);
  console.log(`Target   ${dep.vault}\nCall     ${action}(${value})\nCalldata ${calldata}\nText     ${description}`);
  if (process.env.DRY_RUN === "1") return;

  const [signer] = await ethers.getSigners();
  const governor = await ethers.getContractAt("PlimsollGovernor", dep.governor, signer);
  const votes = await vault.getVotes(signer.address);
  const threshold = await governor.proposalThreshold();
  if (votes < threshold) throw new Error(`Voting power ${ethers.formatUnits(votes, 18)} is below the ${ethers.formatUnits(threshold, 18)} share threshold.`);
  const tx = await governor.propose([dep.vault], [0], [calldata], description);
  const rc = await tx.wait();
  const id = await governor.hashProposal([dep.vault], [0], [calldata], ethers.id(description));
  console.log(`Proposed in ${rc.hash}\nProposal id ${id}`);
  console.log("Voting opens in 1 hour and lasts 3 days. Then queue it, wait 72 hours, and execute (see GOVERNANCE.md).");
}

main().catch((e) => { console.error(e); process.exit(1); });
