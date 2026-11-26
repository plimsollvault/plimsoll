// Plimsoll indexer: reads vault and governor events once a minute and writes them to a static JSON
// file that the website serves. Visitors then never need eth_getLogs, which public RPCs ration.
//
//   VAULT_ADDRESS=0x... ROBINHOOD_RPC=https://... FEED_PATH=/var/www/plimsoll/data/feed.json node agent/indexer.mjs

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dep = require("../deployments/robinhood.json");
const vaultAbi = require("../artifacts/contracts/PlimsollVault.sol/PlimsollVault.json").abi;

const RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const FEED = process.env.FEED_PATH || path.join(here, "..", "web", "data", "feed.json");
const CACHE = process.env.INDEXER_CACHE || path.join(process.env.STATE_DIR || path.join(here, "state"), "indexer.json");
const HEARTBEAT = path.join(process.env.STATE_DIR || path.join(here, "state"), "heartbeat.json");
const STEP = 50_000;

const GOV_ABI = [
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
  "function state(uint256) view returns (uint8)",
  "function proposalVotes(uint256) view returns (uint256,uint256,uint256)",
];

const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const vault = new ethers.Contract(process.env.VAULT_ADDRESS || dep.vault, vaultAbi, provider);
const gov = new ethers.Contract(dep.governor, GOV_ABI, provider);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); }
  catch { return { cursor: dep.deployBlock - 1, commits: [], executes: [], reveals: [], deposits: 0, redeems: 0, proposals: [] }; }
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function scan(c, latest) {
  for (let from = c.cursor + 1; from <= latest; from += STEP) {
    const to = Math.min(latest, from + STEP - 1);
    const [commits, execs, reveals, deps, reds, props] = await Promise.all([
      vault.queryFilter(vault.filters.Committed(), from, to),
      vault.queryFilter(vault.filters.Executed(), from, to),
      vault.queryFilter(vault.filters.ReasonRevealed(), from, to),
      vault.queryFilter(vault.filters.Deposited(), from, to),
      vault.queryFilter(vault.filters.Redeemed(), from, to),
      gov.queryFilter(gov.filters.ProposalCreated(), from, to),
    ]);
    for (const l of commits) c.commits.push({ epoch: Number(l.args[0]), commit: l.args[1], block: l.blockNumber, tx: l.transactionHash });
    for (const l of execs) c.executes.push({ epoch: Number(l.args[0]), weights: l.args[1].map(Number), navBefore: l.args[2].toString(), navAfter: l.args[3].toString(), turnover: l.args[4].toString(), block: l.blockNumber, tx: l.transactionHash });
    for (const l of reveals) c.reveals.push({ epoch: Number(l.args[0]), reason: l.args[1], tx: l.transactionHash });
    c.deposits += deps.length;
    c.redeems += reds.length;
    for (const l of props) c.proposals.push({ id: l.args[0].toString(), proposer: l.args[1], description: l.args[8], block: l.blockNumber });
    c.cursor = to;
  }
}

async function run() {
  const c = loadCache();
  const latest = await provider.getBlockNumber();
  await scan(c, latest);
  writeAtomic(CACHE, JSON.stringify(c));

  const proposals = await Promise.all(c.proposals.map(async (p) => {
    const [st, v] = await Promise.all([gov.state(p.id), gov.proposalVotes(p.id)]);
    return { ...p, state: Number(st), against: v[0].toString(), for: v[1].toString(), abstain: v[2].toString() };
  }));
  let heartbeat = null;
  try { heartbeat = JSON.parse(fs.readFileSync(HEARTBEAT, "utf8")); } catch {}
  const lastCommit = c.commits[c.commits.length - 1];
  const lastCommitAt = lastCommit ? (await provider.getBlock(lastCommit.block)).timestamp : null;
  const feed = {
    updatedAt: Math.floor(Date.now() / 1000),
    block: latest,
    vault: dep.vault,
    commits: c.commits.slice(-200),
    executes: c.executes.slice(-500),
    reveals: c.reveals.slice(-200),
    counts: { sealed: c.commits.length, executed: c.executes.length, revealed: c.reveals.length, deposits: c.deposits, redeems: c.redeems },
    proposals,
    agent: {
      address: dep.agent,
      ethBalance: ethers.formatEther(await provider.getBalance(dep.agent)),
      lastCommitAt,
      lastTickAt: heartbeat?.at ?? null,
      status: heartbeat?.status ?? null,
    },
  };
  writeAtomic(FEED, JSON.stringify(feed));
  log(`feed written at block ${latest}: ${feed.counts.sealed} sealed, ${feed.counts.executed} executed, ${proposals.length} proposals`);
}

for (;;) {
  try { await run(); } catch (e) { log("indexer run failed:", e.shortMessage || e.message); }
  if (process.env.ONCE === "1") break;
  await new Promise((r) => setTimeout(r, 60_000));
}
