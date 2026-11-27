// Plimsoll watchdog: runs every few minutes (systemd timer), checks the agent, indexer, vault and
// website, and pushes a notification when something goes wrong and again when it recovers.
//
// Channels (set either or both in .env.agent):
//   NTFY_TOPIC=plimsoll-xxxx                       push to the ntfy app (https://ntfy.sh), no account needed
//   TELEGRAM_BOT_TOKEN=...  TELEGRAM_CHAT_ID=...   message from your own Telegram bot
// TEST_ALERT=1 sends one test message and exits.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dep = require("../deployments/robinhood.json");
const cfg = require("../config/robinhood.js");
const vaultAbi = require("../artifacts/contracts/PlimsollVault.sol/PlimsollVault.json").abi;

const STATE_DIR = process.env.STATE_DIR || path.join(here, "state");
const FEED = process.env.FEED_PATH || "/var/www/plimsoll/data/feed.json";
const SITE = process.env.SITE_URL || "https://plimsollvault.com/";
const MEMORY = path.join(STATE_DIR, "watchdog.json");
const GAS_WARN = Number(process.env.GAS_WARN_ETH || "0.0005");
const SUMMARY_HOUR_UTC = Number(process.env.SUMMARY_HOUR_UTC || "2"); // 09:00 in UTC+7

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com", cfg.chainId, { staticNetwork: true });
const vault = new ethers.Contract(process.env.VAULT_ADDRESS || dep.vault, vaultAbi, provider);

async function notify(title, body, urgent) {
  const sent = [];
  if (process.env.NTFY_TOPIC) {
    try {
      const r = await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
        method: "POST", body,
        headers: { Title: title, Priority: urgent ? "high" : "default", Tags: urgent ? "warning" : "white_check_mark" },
      });
      sent.push("ntfy " + r.status);
    } catch (e) { sent.push("ntfy failed: " + e.message); }
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${title}\n${body}` }),
      });
      sent.push("telegram " + r.status);
    } catch (e) { sent.push("telegram failed: " + e.message); }
  }
  console.log(new Date().toISOString(), title, "|", body.replace(/\n/g, " / "), "|", sent.join(", ") || "no channel configured");
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

async function checks() {
  const now = Math.floor(Date.now() / 1000);
  const problems = {};
  const facts = {};

  const hb = readJson(path.join(STATE_DIR, "heartbeat.json"));
  if (!hb) problems.agent = "The agent has never reported in.";
  else {
    const mins = Math.round((now - hb.at) / 60);
    if (mins > 10) problems.agent = `The agent has not reported for ${mins} minutes. Check: journalctl -u plimsoll-agent`;
    else if (/error|limited/i.test(hb.status || "")) problems.agentError = `The agent reports: ${hb.status}`;
    facts.agent = hb.status;
  }

  const feed = readJson(FEED);
  if (!feed) problems.indexer = "The website feed is missing.";
  else if (now - feed.updatedAt > 600) problems.indexer = `The website feed is ${Math.round((now - feed.updatedAt) / 60)} minutes old. Check: journalctl -u plimsoll-indexer`;

  try {
    const gas = Number(ethers.formatEther(await provider.getBalance(dep.agent)));
    facts.gas = gas;
    if (gas < GAS_WARN) problems.gas = `Agent gas is low: ${gas.toFixed(5)} ETH left on ${dep.agent}. Top it up on Robinhood Chain.`;
    const [brake, dPaused, tPaused, nav, supply] = await Promise.all([vault.brakeTripped(), vault.depositsPaused(), vault.tradingPaused(), vault.navSpot(), vault.totalSupply()]);
    facts.nav = Number(nav) / 1e6; facts.shares = Number(ethers.formatUnits(supply, 18));
    if (brake) problems.brake = "The storm brake has tripped. The vault is cash-only and deposits are stopped until a holder vote resets it.";
    if (dPaused || tPaused) problems.paused = `The vault is paused (${[dPaused && "deposits", tPaused && "trading"].filter(Boolean).join(" and ")}).`;
    // totalOwed exists from vault v2 on; older vaults simply skip this check
    const owed = [];
    try {
      for (const a of [{ symbol: "USDG", token: cfg.usdg }, ...cfg.assets]) {
        if ((await vault.totalOwed(a.token)) > 0n) owed.push(a.symbol);
      }
    } catch { /* older vault */ }
    if (owed.length) problems.owed = `Deferred payouts are waiting in ${owed.join(", ")}, usually because the issuer paused the token.`;
  } catch (e) {
    problems.rpc = "Could not read the vault from Robinhood Chain: " + (e.shortMessage || e.message);
  }

  try {
    const r = await fetch(SITE, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) problems.site = `${SITE} answered ${r.status}.`;
  } catch (e) { problems.site = `${SITE} is unreachable: ${e.message}`; }

  return { problems, facts };
}

if (process.env.TEST_ALERT === "1") {
  await notify("Plimsoll test alert", "If you can read this, alerts reach you.", false);
  process.exit(0);
}

const memory = readJson(MEMORY) || { active: {}, lastSummaryDay: null };
const { problems, facts } = await checks();

for (const [key, text] of Object.entries(problems)) {
  if (!memory.active[key]) await notify("Plimsoll alert", text, true);
}
for (const key of Object.keys(memory.active)) {
  if (!problems[key]) await notify("Plimsoll recovered", `Resolved: ${memory.active[key]}`, false);
}
memory.active = problems;

const today = new Date().toISOString().slice(0, 10);
if (new Date().getUTCHours() === SUMMARY_HOUR_UTC && memory.lastSummaryDay !== today) {
  const issues = Object.keys(problems).length;
  await notify("Plimsoll daily check", `${issues ? issues + " open issue(s)" : "All systems normal"}. Vault value $${(facts.nav ?? 0).toFixed(2)}, ${(facts.shares ?? 0).toFixed(2)} shares. Agent: ${facts.agent ?? "unknown"}. Gas ${(facts.gas ?? 0).toFixed(5)} ETH.`, false);
  memory.lastSummaryDay = today;
}
fs.writeFileSync(MEMORY, JSON.stringify(memory));
