// Plimsoll agent: once per 30-minute watch it asks Claude for target weights, checks them against
// the vault's mandate, seals the plan on chain, executes it after the reveal delay, and publishes
// the reasoning one watch later. The key it holds can only commit, execute and sync prices.
//
//   AGENT_KEY=0x...  VAULT_ADDRESS=0x...  ANTHROPIC_API_KEY=...  node agent/agent.mjs
//   DRY_RUN=1 prints the plan it would seal and sends nothing.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cfg = require("../config/robinhood.js");
const vaultAbi = require("../artifacts/contracts/PlimsollVault.sol/PlimsollVault.json").abi;

const RPC = process.env.ROBINHOOD_RPC || "https://rpc.nodeflare.app/robinhood/public";
const DRY = process.env.DRY_RUN === "1";
const STATE_DIR = process.env.STATE_DIR || path.join(here, "state");
const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const TICK_MS = 60_000;
const PLAN_WINDOW_S = 20 * 60; // only seal plans in the first 20 minutes of a watch
const BPS = 10_000;
const SYMBOLS = cfg.assets.map((a) => a.symbol);

if (!process.env.VAULT_ADDRESS) throw new Error("Set VAULT_ADDRESS to the deployed vault.");
if (!DRY && !process.env.AGENT_KEY) throw new Error("Set AGENT_KEY to the agent's private key, or run with DRY_RUN=1.");

const provider = new ethers.JsonRpcProvider(RPC, cfg.chainId, { staticNetwork: true });
const wallet = DRY ? null : new ethers.Wallet(process.env.AGENT_KEY.trim().startsWith("0x") ? process.env.AGENT_KEY.trim() : "0x" + process.env.AGENT_KEY.trim(), provider);
const vault = new ethers.Contract(process.env.VAULT_ADDRESS, vaultAbi, wallet || provider);
const claude = new Anthropic();
fs.mkdirSync(STATE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const statePath = (e) => path.join(STATE_DIR, `watch-${e}.json`);
const readState = (e) => { try { return JSON.parse(fs.readFileSync(statePath(e), "utf8")); } catch { return null; } };
const writeState = (e, s) => fs.writeFileSync(statePath(e), JSON.stringify(s, null, 2));
const historyPath = path.join(STATE_DIR, "prices.json");

// ----------------------------------------------------------------- reading the vault

async function readVault() {
  const [limitsRaw, n, w, cash, nav, supply, epoch, brake, paused, lastExec] = await Promise.all([
    vault.limits(), vault.assetCount(), vault.weights(), new ethers.Contract(cfg.usdg, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(vault.target),
    vault.navSpot(), vault.totalSupply(), vault.currentEpoch(), vault.brakeTripped(), vault.tradingPaused(), vault.lastExecutedEpoch(),
  ]);
  const limits = {
    maxWeightBps: Number(limitsRaw[0]), minWeightBps: Number(limitsRaw[1]), maxTurnoverBps: Number(limitsRaw[2]),
    maxSlippageBps: Number(limitsRaw[3]), maxDeviationBps: Number(limitsRaw[4]), brakeDrawdownBps: Number(limitsRaw[5]), brakeWindow: Number(limitsRaw[6]),
  };
  const assets = [];
  for (let i = 0; i < Number(n); i++) {
    const erc = new ethers.Contract(cfg.assets[i].token, ["function balanceOf(address) view returns (uint256)"], provider);
    const [spot, ref, bal] = await Promise.all([vault.spotPrice(i), vault.refPrice(i), erc.balanceOf(vault.target)]);
    const value = (bal * spot) / 10n ** 18n;
    assets.push({ symbol: SYMBOLS[i], spot, ref, bal, value });
  }
  return { limits, assets, targetWeights: w.map(Number), cash, nav, supply, epoch: Number(epoch), brake, paused, lastExec: Number(lastExec) };
}

const usd = (x) => Number(x) / 1e6;

function marketWeights(v) {
  if (v.nav === 0n) return [...v.assets.map(() => 0), BPS];
  const w = v.assets.map((a) => Number((a.value * BigInt(BPS)) / v.nav));
  return [...w, BPS - w.reduce((s, x) => s + x, 0)];
}

function recordPrices(v) {
  let h = [];
  try { h = JSON.parse(fs.readFileSync(historyPath, "utf8")); } catch {}
  h.push({ t: Date.now(), p: Object.fromEntries(v.assets.map((a) => [a.symbol, usd(a.spot)])) });
  h = h.slice(-96); // two days of watches
  fs.writeFileSync(historyPath, JSON.stringify(h));
  return h;
}

// ----------------------------------------------------------------- mandate checks (mirror of the contract)

function turnoverBps(target, current) {
  const moved = target.reduce((s, t, i) => s + Math.abs(t - current[i]), 0);
  return moved / 2;
}

function checkPlan(w, current, limits, brake) {
  const n = w.length - 1;
  if (w.some((x) => !Number.isInteger(x) || x < 0)) return "weights must be whole basis points";
  if (w.reduce((s, x) => s + x, 0) !== BPS) return "weights must add up to 10000";
  for (let i = 0; i < n; i++) {
    if (w[i] > limits.maxWeightBps) return `${SYMBOLS[i]} above the ${limits.maxWeightBps} cap`;
    if (w[i] !== 0 && w[i] < limits.minWeightBps) return `${SYMBOLS[i]} below the ${limits.minWeightBps} minimum`;
  }
  if (brake && w[n] !== BPS) return "storm brake is on: cash only";
  // the contract measures turnover in USDG; keep a 10% margin for price movement before execution
  if (turnoverBps(w, current) > limits.maxTurnoverBps * 0.9) return "turnover above the limit";
  return null;
}

/** Move from the current mix toward Claude's target only as far as the turnover limit allows. */
function fitToMandate(target, current, limits) {
  const n = target.length - 1;
  const full = turnoverBps(target, current);
  const k = full === 0 ? 1 : Math.min(1, (limits.maxTurnoverBps * 0.85) / full);
  const w = target.map((t, i) => Math.round(current[i] + (t - current[i]) * k));
  for (let i = 0; i < n; i++) {
    w[i] = Math.min(w[i], limits.maxWeightBps);
    if (w[i] > 0 && w[i] < limits.minWeightBps) w[i] = target[i] > current[i] ? limits.minWeightBps : 0;
  }
  w[n] = BPS - w.slice(0, n).reduce((s, x) => s + x, 0);
  return w;
}

// ----------------------------------------------------------------- asking Claude

const PlanSchema = z.object({
  weights: z.array(z.object({ symbol: z.enum(SYMBOLS), bps: z.number().int() })),
  cash_bps: z.number().int(),
  reasoning: z.string(),
});

const SYSTEM = `You set the target mix for Plimsoll, a shared vault of tokenized US stocks and USDG cash on Robinhood Chain.
Each 30-minute watch you return target weights in basis points (10000 = 100%).
The vault contract enforces these rules and rejects any plan that breaks them:
- Only the listed stocks plus cash. Weights are whole basis points and add up to 10000 with cash included.
- Each stock is either 0 or between the minimum and the maximum weight you are given.
- The mix may only move by the turnover limit per watch. Larger targets are scaled down toward the current mix before sealing.
- If the storm brake is on, the only accepted plan is 100% cash.
Every trade pays the pool fee (0.3% to 1%) plus slippage, so small changes cost more than they are worth. Holding the current mix is a valid answer.
Your reasoning is published on chain one watch later, next to the outcome. Write it for the vault's holders: two to four plain sentences that name the main reason for the change, under 600 characters.`;

async function askClaude(v, history) {
  const current = marketWeights(v);
  const rows = v.assets.map((a, i) => {
    const past = history.length > 1 ? history[0].p[a.symbol] : null;
    const chg = past ? ((usd(a.spot) / past - 1) * 100).toFixed(2) + "%" : "n/a";
    return `${a.symbol}: price $${usd(a.spot).toFixed(2)}, change over the last ${history.length} watches ${chg}, current weight ${current[i]} bps`;
  });
  const user = [
    `Watch ${v.epoch}. Vault value $${usd(v.nav).toFixed(2)}. Cash weight ${current[current.length - 1]} bps.`,
    `Limits: min ${v.limits.minWeightBps} bps, max ${v.limits.maxWeightBps} bps per stock, turnover ${v.limits.maxTurnoverBps} bps per watch. Storm brake: ${v.brake ? "ON" : "off"}.`,
    ...rows,
    "Return the target weights for every listed stock, the cash weight, and your reasoning.",
  ].join("\n");

  const msg = await claude.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a safety classifier declines, the server retries on a fallback model
    output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to plan this watch: " + (msg.stop_details?.explanation || ""));
  if (!msg.parsed_output) throw new Error("Claude returned no parseable plan (stop_reason " + msg.stop_reason + ")");
  const p = msg.parsed_output;
  const target = SYMBOLS.map((s) => p.weights.find((x) => x.symbol === s)?.bps ?? 0);
  target.push(p.cash_bps);
  return { target, reasoning: p.reasoning.slice(0, 1200), model: msg.model, usage: msg.usage };
}

// ----------------------------------------------------------------- one watch

async function plan(v) {
  const history = recordPrices(v);
  const current = marketWeights(v);
  let target, reasoning, model = MODEL;
  if (v.brake) {
    target = [...v.assets.map(() => 0), BPS];
    reasoning = "The storm brake is on, so the vault moves to cash until holders vote to restart.";
  } else if (process.env.AGENT_MOCK_TARGET) {
    // local testing only: a fixed target instead of a Claude call
    target = JSON.parse(process.env.AGENT_MOCK_TARGET);
    reasoning = "Test plan from AGENT_MOCK_TARGET.";
    model = "mock";
  } else {
    ({ target, reasoning, model } = await askClaude(v, history));
  }
  let w = fitToMandate(target, current, v.limits);
  let problem = checkPlan(w, current, v.limits, v.brake);
  if (problem) {
    log(`plan for watch ${v.epoch} failed the mandate (${problem}); falling back to holding the current mix`);
    w = fitToMandate(current, current, v.limits);
    reasoning = `Holding the current mix. The proposed change failed a mandate check: ${problem}.`;
    problem = checkPlan(w, current, v.limits, v.brake);
    if (problem) return null;
  }
  return { weights: w, reasoning, model, nonce: ethers.hexlify(ethers.randomBytes(32)) };
}

const reasonHash = (r) => ethers.keccak256(ethers.toUtf8Bytes(r));
const commitHashOf = (e, p) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint16[]", "bytes32", "bytes32"], [e, p.weights, reasonHash(p.reasoning), p.nonce]));

async function send(label, fn) {
  if (DRY) { log(`[dry run] would ${label}`); return; }
  const tx = await fn();
  log(`${label}: ${cfg.explorer}/tx/${tx.hash}`);
  await tx.wait();
}

async function tick() {
  const v = await readVault();
  const now = (await provider.getBlock("latest")).timestamp; // chain time, not the server clock
  const intoWatch = now - v.epoch * 1800;
  if (v.paused) { log("trading is paused by the guardian or the holder vote"); return; }
  // nothing to manage yet: no Claude call, no gas
  if (v.supply === 0n && process.env.PLAN_WHEN_EMPTY !== "1") { log("vault is empty, waiting for the first deposit"); return; }

  // keep reference prices tracking the market (bounded per watch by the contract)
  for (let i = 0; i < v.assets.length; i++) {
    const ref = Number(v.assets[i].ref), spot = Number(v.assets[i].spot);
    if (Math.abs(spot - ref) / ref > v.limits.maxDeviationBps / BPS / 2 && !DRY) {
      await send(`sync ${SYMBOLS[i]} reference price`, () => vault.syncRefPrice(i)).catch((e) => log("sync failed", e.shortMessage || e.message));
    }
  }

  // 1. publish last watch's reasoning
  const prev = readState(v.epoch - 1);
  if (prev && prev.executed && !prev.revealed) {
    await send(`reveal reasoning for watch ${v.epoch - 1}`, () => vault.revealReason(v.epoch - 1, prev.reasoning))
      .then(() => { prev.revealed = true; writeState(v.epoch - 1, prev); })
      .catch((e) => log("reveal failed", e.shortMessage || e.message));
  }

  let s = readState(v.epoch);
  const onChainCommit = await vault.commitOf(v.epoch);

  // 2. seal a plan early in the watch
  if (!s && onChainCommit === ethers.ZeroHash && v.lastExec < v.epoch && intoWatch < PLAN_WINDOW_S) {
    const p = await plan(v);
    if (!p) { log(`no valid plan for watch ${v.epoch}`); return; }
    s = { epoch: v.epoch, ...p, commit: commitHashOf(v.epoch, p), executed: false, revealed: false };
    log(`watch ${v.epoch} plan`, JSON.stringify(Object.fromEntries([...SYMBOLS, "CASH"].map((k, i) => [k, p.weights[i]]))), "-", p.reasoning);
    if (DRY) return;
    writeState(v.epoch, s); // persist before sending, so a restart can still execute it
    await send(`commit watch ${v.epoch}`, () => vault.commit(s.commit));
    return;
  }

  // 3. execute once the reveal delay has passed
  if (s && !s.executed && onChainCommit === s.commit && v.lastExec < v.epoch) {
    const ct = Number(await vault.commitTime(v.epoch));
    if (now < ct + 245) return;
    try {
      await vault.execute.staticCall(s.weights, reasonHash(s.reasoning), s.nonce);
    } catch (e) {
      log(`execute for watch ${v.epoch} would revert (${e.shortMessage || e.message}); skipping this watch`);
      s.executed = false; s.skipped = true; writeState(v.epoch, s);
      return;
    }
    await send(`execute watch ${v.epoch}`, () => vault.execute(s.weights, reasonHash(s.reasoning), s.nonce));
    s.executed = true; writeState(v.epoch, s);
  }
}

async function main() {
  log(`Plimsoll agent on chain ${cfg.chainId}, vault ${vault.target}, model ${MODEL}${DRY ? " (dry run)" : ""}`);
  if (wallet) log(`agent address ${wallet.address}, gas balance ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
  for (;;) {
    try { await tick(); } catch (e) {
      if (e instanceof Anthropic.RateLimitError) log("Claude rate limit, will retry next tick");
      else if (e instanceof Anthropic.APIError) log(`Claude API error ${e.status}: ${e.message}`);
      else log("tick failed:", e.shortMessage || e.message);
    }
    if (process.env.ONCE === "1") break;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main();
