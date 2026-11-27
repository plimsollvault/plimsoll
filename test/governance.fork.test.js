// Holder-vote lifecycle on a local fork of Robinhood Chain mainnet, wired exactly like scripts/deploy.js.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");

async function reverts(p, label = "") {
  let failed = false;
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); } catch { failed = true; }
  expect(failed, "expected a revert " + label).to.equal(true);
}
const advance = async (sec) => { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); };

describe("Holder votes on a Robinhood Chain mainnet fork", function () {
  let vault, governor, timelock, usdg, deployer, agent, guardian, alice, bob;
  const DELAY = 259200;

  before(async function () {
    [deployer, agent, guardian, alice, bob] = await ethers.getSigners();
    usdg = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", cfg.usdg);
    const whaleAddr = cfg.uniswap.poolManager;
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [whaleAddr] });
    await network.provider.send("hardhat_setBalance", [whaleAddr, "0x56BC75E2D63100000"]);
    const whale = await ethers.getSigner(whaleAddr);
    await (await usdg.connect(whale).transfer(alice.address, 5_000n * 10n ** 6n)).wait();
    await (await usdg.connect(whale).transfer(bob.address, 1_000n * 10n ** 6n)).wait();

    timelock = await (await ethers.getContractFactory("TimelockController")).deploy(DELAY, [], [ethers.ZeroAddress], deployer.address);
    vault = await (await ethers.getContractFactory("PlimsollVault")).deploy(
      cfg.usdg, cfg.uniswap.poolManager, cfg.uniswap.stateView, cfg.assetConfigs(), cfg.limits,
      10_000n * 10n ** 6n, await timelock.getAddress(), guardian.address, agent.address);
    governor = await (await ethers.getContractFactory("PlimsollGovernor")).deploy(await vault.getAddress(), await timelock.getAddress(), 100n * 10n ** 18n);
    await (await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress())).wait();
    await (await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governor.getAddress())).wait();
    await (await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).wait();

    for (const [who, amt] of [[alice, 3_000n], [bob, 500n]]) {
      await (await usdg.connect(who).approve(await vault.getAddress(), amt * 10n ** 6n)).wait();
      await (await vault.connect(who).deposit(amt * 10n ** 6n, 0, who.address)).wait();
    }
  });

  it("counts no votes until a holder turns on voting power", async function () {
    expect(await vault.getVotes(alice.address)).to.equal(0n);
    await (await vault.connect(alice).delegate(alice.address)).wait();
    await (await vault.connect(bob).delegate(bob.address)).wait();
    expect(await vault.getVotes(alice.address)).to.equal(3_000n * 10n ** 18n);
  });

  it("refuses direct changes from anyone but the timelock", async function () {
    await reverts(vault.connect(deployer).setDepositCap(1), "deployer");
    await reverts(vault.connect(agent).setDepositCap(1), "agent");
    await reverts(vault.connect(guardian).setDepositCap(1), "guardian");
    await reverts(vault.connect(guardian).setPaused(false, false), "guardian unpause");
  });

  it("runs a proposal from vote to execution through the 72-hour timelock", async function () {
    await advance(2);
    const target = await vault.getAddress();
    const data = vault.interface.encodeFunctionData("setDepositCap", [25_000n * 10n ** 6n]);
    const desc = "Raise the deposit cap to 25,000 USDG";
    await (await governor.connect(alice).propose([target], [0], [data], desc)).wait();
    const id = await governor.hashProposal([target], [0], [data], ethers.id(desc));
    expect(Number(await governor.state(id))).to.equal(0); // Pending

    await advance(3601);
    expect(Number(await governor.state(id))).to.equal(1); // Active
    await (await governor.connect(alice).castVote(id, 1)).wait();
    await (await governor.connect(bob).castVote(id, 0)).wait();
    expect(await governor.hasVoted(id, alice.address)).to.equal(true);
    await reverts(governor.connect(alice).castVote(id, 1), "double vote");

    await advance(3 * 86400 + 1);
    expect(Number(await governor.state(id))).to.equal(4); // Succeeded
    await (await governor.queue([target], [0], [data], ethers.id(desc))).wait();
    expect(Number(await governor.state(id))).to.equal(5); // Queued
    await reverts(governor.execute([target], [0], [data], ethers.id(desc)), "execute before the delay");

    await advance(DELAY + 1);
    await (await governor.connect(bob).execute([target], [0], [data], ethers.id(desc))).wait();
    expect(Number(await governor.state(id))).to.equal(7); // Executed
    expect(await vault.depositCap()).to.equal(25_000n * 10n ** 6n);
  });

  it("rejects a proposal from a holder under the 100-share threshold", async function () {
    const lil = (await ethers.getSigners())[5];
    const data = vault.interface.encodeFunctionData("setDepositCap", [1n]);
    await reverts(governor.connect(lil).propose([await vault.getAddress()], [0], [data], "tiny"), "below threshold");
  });

  it("defeats a proposal that misses quorum", async function () {
    const target = await vault.getAddress();
    const data = vault.interface.encodeFunctionData("setGuardian", [bob.address]);
    const desc = "Make bob the guardian";
    await (await governor.connect(alice).propose([target], [0], [data], desc)).wait();
    const id = await governor.hashProposal([target], [0], [data], ethers.id(desc));
    await advance(3601);
    await advance(3 * 86400 + 1);
    expect(Number(await governor.state(id))).to.equal(3); // Defeated: nobody voted
  });
});
