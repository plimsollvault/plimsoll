// Runs against a local fork of Robinhood Chain mainnet. Nothing is sent to the real network.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");

const USDG_WHALE = cfg.uniswap.poolManager; // the v4 PoolManager holds plenty of USDG
const EPOCH = 1800;

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

async function toNextEpoch() {
  const b = await ethers.provider.getBlock("latest");
  const next = (Math.floor(b.timestamp / EPOCH) + 1) * EPOCH + 5;
  await network.provider.send("evm_setNextBlockTimestamp", [next]);
  await network.provider.send("evm_mine");
}

async function advance(sec) {
  await network.provider.send("evm_increaseTime", [sec]);
  await network.provider.send("evm_mine");
}

async function reverts(p, label = "") {
  let failed = false;
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); } catch (e) { failed = true; }
  expect(failed, "expected a revert " + label).to.equal(true);
}

function commitHash(epoch, weights, reasonHash, nonce) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint16[]", "bytes32", "bytes32"], [epoch, weights, reasonHash, nonce])
  );
}

async function plan(vault, agent, weights, reason) {
  const e = await vault.currentEpoch();
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason));
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  await (await vault.connect(agent).commit(commitHash(e, weights, reasonHash, nonce))).wait();
  return { e, reasonHash, nonce };
}

describe("PlimsollVault on a Robinhood Chain mainnet fork", function () {
  let vault, usdg, deployer, agent, alice, bob, guardian;
  const N = cfg.assets.length;

  before(async function () {
    [deployer, agent, alice, bob, guardian] = await ethers.getSigners();
    usdg = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", cfg.usdg);
    const whale = await impersonate(USDG_WHALE);
    await (await usdg.connect(whale).transfer(alice.address, 50_000n * 10n ** 6n)).wait();
    await (await usdg.connect(whale).transfer(bob.address, 50_000n * 10n ** 6n)).wait();

    const limits = { ...cfg.limits, maxTurnoverBps: 10000 }; // allow a full first allocation in tests
    const Vault = await ethers.getContractFactory("PlimsollVault");
    vault = await Vault.deploy(
      cfg.usdg, cfg.uniswap.poolManager, cfg.uniswap.stateView, cfg.assetConfigs(), limits,
      1_000_000n * 10n ** 6n, deployer.address, guardian.address, agent.address
    );
    await vault.waitForDeployment();
  });

  it("reads a sane spot price for every stock", async function () {
    for (let i = 0; i < N; i++) {
      const p = Number(await vault.spotPrice(i)) / 1e6;
      expect(p, cfg.assets[i].symbol).to.be.greaterThan(5).and.lessThan(5000);
    }
  });

  it("mints one share per USDG on the first deposit", async function () {
    const amt = 10_000n * 10n ** 6n;
    await (await usdg.connect(alice).approve(await vault.getAddress(), amt)).wait();
    await (await vault.connect(alice).deposit(amt, 0, alice.address)).wait();
    expect(await vault.balanceOf(alice.address)).to.equal(amt * 10n ** 12n);
  });

  it("rejects an execute whose weights differ from the commit", async function () {
    await toNextEpoch();
    const w = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    const p = await plan(vault, agent, w, "test");
    await advance(241);
    const other = [2000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 2000];
    await reverts(vault.connect(agent).execute(other, p.reasonHash, p.nonce));
  });

  it("rejects weights above the cap even when committed", async function () {
    await toNextEpoch();
    const w = [3000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0];
    const p = await plan(vault, agent, w, "too heavy");
    await advance(241);
    await reverts(vault.connect(agent).execute(w, p.reasonHash, p.nonce));
  });

  it("refuses an execute before the reveal delay", async function () {
    await toNextEpoch();
    const w = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    const p = await plan(vault, agent, w, "early");
    await reverts(vault.connect(agent).execute(w, p.reasonHash, p.nonce));
  });

  it("only the agent can commit", async function () {
    await reverts(vault.connect(alice).commit(ethers.ZeroHash));
  });

  it("executes a sealed plan through real v3 and v4 pools", async function () {
    await toNextEpoch();
    const w = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    const reason = "Equal weight across the eight names, 20% cash while the trial runs.";
    const p = await plan(vault, agent, w, reason);
    await advance(241);
    const navBefore = await vault.navSpot();
    const tx = await vault.connect(agent).execute(w, p.reasonHash, p.nonce);
    const rc = await tx.wait();
    console.log("      execute gas:", rc.gasUsed.toString());
    for (let i = 0; i < N; i++) {
      const bal = await (await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", cfg.assets[i].token)).balanceOf(await vault.getAddress());
      expect(bal > 0n, cfg.assets[i].symbol).to.equal(true);
    }
    const navAfter = await vault.navSpot();
    const lossBps = Number((navBefore - navAfter) * 10000n / navBefore);
    console.log("      NAV before/after (USDG):", Number(navBefore) / 1e6, Number(navAfter) / 1e6, "cost bps:", lossBps);
    expect(lossBps).to.be.lessThan(150);
    expect((await vault.weights()).map(Number)).to.deep.equal(w);

    // the reasoning can only be published from the next epoch, and must match the seal
    await reverts(vault.revealReason(p.e, reason));
    await toNextEpoch();
    await reverts(vault.revealReason(p.e, "something else"));
    await (await vault.revealReason(p.e, reason)).wait();
  });

  it("runs only one execute per epoch", async function () {
    await toNextEpoch();
    const w = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    const p = await plan(vault, agent, w, "hold");
    await advance(241);
    await (await vault.connect(agent).execute(w, p.reasonHash, p.nonce)).wait();
    await reverts(vault.connect(agent).execute(w, p.reasonHash, p.nonce));
  });

  it("prices a second deposit fairly", async function () {
    const supply = await vault.totalSupply();
    const nav = await vault.navSpot();
    const amt = 5_000n * 10n ** 6n;
    await (await usdg.connect(bob).approve(await vault.getAddress(), amt)).wait();
    await (await vault.connect(bob).deposit(amt, 0, bob.address)).wait();
    const got = await vault.balanceOf(bob.address);
    const fair = amt * supply / nav;
    // max(spot, ref) can only give the depositor fewer shares, never more
    expect(got <= fair).to.equal(true);
    expect(Number((fair - got) * 10000n / fair)).to.be.lessThan(100);
  });

  it("redeems in kind, pro rata", async function () {
    const shares = (await vault.balanceOf(alice.address)) / 2n;
    const supply = await vault.totalSupply();
    const aapl = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", cfg.assets[0].token);
    const vaultAapl = await aapl.balanceOf(await vault.getAddress());
    await (await vault.connect(alice).redeem(shares, alice.address)).wait();
    const got = await aapl.balanceOf(alice.address);
    expect(got).to.equal(vaultAapl * shares / supply);
  });

  it("lets the guardian pause trading but not unpause it", async function () {
    await (await vault.connect(guardian).pauseTrading()).wait();
    await reverts(vault.connect(guardian).setPaused(false, false));
    await reverts(vault.connect(agent).commit(ethers.ZeroHash));
    await (await vault.connect(deployer).setPaused(false, false)).wait();
  });

  it("blocks trading when spot drifts too far from the reference", async function () {
    // push AAPL's pool price up hard with a large buy, then try to trade
    const whale = await impersonate(USDG_WHALE);
    await toNextEpoch();
    const w = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    const p = await plan(vault, agent, w, "after a price shock");
    await advance(241);
    const Mover = await ethers.getContractFactory("PoolMover");
    const mover = await Mover.deploy(cfg.uniswap.poolManager);
    const big = 3_000_000n * 10n ** 6n;
    await (await usdg.connect(whale).transfer(await mover.getAddress(), big)).wait();
    const key = cfg.assetConfigs()[0].key;
    await (await mover.buy(key, cfg.usdg.toLowerCase() === key.currency0.toLowerCase(), big)).wait();
    const spot = Number(await vault.spotPrice(0)) / 1e6, ref = Number(await vault.refPrice(0)) / 1e6;
    console.log("      AAPL spot after shock:", spot.toFixed(2), "ref:", ref.toFixed(2));
    await reverts(vault.connect(agent).execute(w, p.reasonHash, p.nonce));
  });
});
