// Clicks through the console buttons against a local fork, with a stand-in wallet.
//
// Needs, in order:
//   1. a fork node:      npx hardhat node                       (ROBINHOOD_RPC pointing at an archive RPC)
//   2. a deployment:     AGENT_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 npx hardhat run scripts/deploy.js --network localhost
//   3. this script:      node test/e2e/console.e2e.mjs
// It serves a copy of web/ pointed at the fork, injects a wallet that forwards to the node's unlocked
// test account, and checks each button's effect on chain.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cfg = require(path.join(root, "config/robinhood.js"));
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/localhost.json"), "utf8"));
const vaultAbi = require(path.join(root, "artifacts/contracts/PlimsollVault.sol/PlimsollVault.json")).abi;
const pausedArt = require(path.join(root, "artifacts/contracts/test/PausedToken.sol/PausedToken.json"));

const NODE = "http://127.0.0.1:8545";
const USER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // hardhat test account #3, unlocked on the local node
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // hardhat test account #1
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => fs.existsSync(p));

const provider = new ethers.JsonRpcProvider(NODE, cfg.chainId, { staticNetwork: true });
const rpc = (m, p = []) => provider.send(m, p);
const vault = new ethers.Contract(dep.vault, vaultAbi, provider);
const usdg = new ethers.Contract(cfg.usdg, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], provider);
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

// ---------------------------------------------------------------- serve web/ pointed at the fork
const site = fs.mkdtempSync(path.join(os.tmpdir(), "plimsoll-e2e-"));
fs.cpSync(path.join(root, "web"), site, { recursive: true });
let conf = fs.readFileSync(path.join(site, "config.js"), "utf8")
  .replace(/vault: [^,]+,/, `vault: "${dep.vault}",`).replace(/governor: [^,]+,/, `governor: "${dep.governor}",`)
  .replace(/deployBlock: [^,]+,/, `deployBlock: ${dep.deployBlock - 5},`).replace(/rpcs: \[[\s\S]*?\],/, `rpcs: ["${NODE}"],`);
fs.writeFileSync(path.join(site, "config.js"), conf);
const wallet = `<script>
window.ethereum = { isMetaMask: true, _h: {},
  on(e, f) { this._h[e] = f; },
  async request({ method, params }) {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${USER}"];
    if (method === "eth_chainId") return "0x1237";
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    const r = await fetch("${NODE}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }) });
    const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
  } };
</script>`;
const idx = path.join(site, "index.html");
fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace('<script type="module" src="/app.js">', wallet + '\n<script type="module" src="/app.js">'));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "/console") p = "/index.html";
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(5190);

// ---------------------------------------------------------------- helpers
async function impersonate(addr) { await rpc("hardhat_impersonateAccount", [addr]); await rpc("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]); return new ethers.JsonRpcSigner(provider, addr); }
async function advance(sec) { await rpc("evm_increaseTime", [sec]); await rpc("evm_mine"); }
async function nextEpoch() { const b = await provider.getBlock("latest"); await rpc("evm_setNextBlockTimestamp", [(Math.floor(b.timestamp / 1800) + 1) * 1800 + 5]); await rpc("evm_mine"); }
async function waitStatus(page, re, ms = 60000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#txStatus")?.textContent || ""), { timeout: ms }, re.source);
  return page.$eval("#txStatus", (e) => e.textContent);
}
async function openConsole(page) {
  await page.goto("http://127.0.0.1:5190/#console", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname === "/console" && document.querySelector("#cWatch")?.textContent !== "—", { timeout: 60000 });
  await page.click("#connectBtn");
  await page.waitForFunction(() => /0x/.test(document.querySelector("#pAddr")?.textContent || ""), { timeout: 30000 });
}

// ---------------------------------------------------------------- run
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.setViewport({ width: 1280, height: 900 });

  const whale = await impersonate(cfg.uniswap.poolManager);
  await (await usdg.connect(whale).transfer(USER, 1_000n * 10n ** 6n)).wait();

  // 1. connect and deposit through the form (approve + deposit)
  await openConsole(page);
  check("connect wallet shows the address", (await page.$eval("#pAddr", (e) => e.textContent)).toLowerCase() === USER.toLowerCase());
  await page.type("#depAmt", "600");
  await page.click("#depBtn");
  await waitStatus(page, /Deposit: done|failed/);
  const shares = await vault.balanceOf(USER);
  check("deposit button mints shares", shares === 600n * 10n ** 18n, ethers.formatUnits(shares, 18) + " shares");

  // 2. turn on voting power
  await page.waitForSelector("#delegateBtn:not([hidden])", { timeout: 20000 });
  await page.click("#delegateBtn");
  await waitStatus(page, /voting power: done|failed/);
  check("voting power button delegates", (await vault.getVotes(USER)) === shares);

  // 3. give the vault some AAPL through a sealed plan, as the agent would
  const agent = await impersonate(AGENT);
  await nextEpoch();
  const e = await vault.currentEpoch();
  const w = [500, 0, 0, 0, 0, 0, 0, 0, 9500], reason = ethers.keccak256(ethers.toUtf8Bytes("e2e")), nonce = ethers.hexlify(ethers.randomBytes(32));
  const commit = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint16[]", "bytes32", "bytes32"], [e, w, reason, nonce]));
  await (await vault.connect(agent).commit(commit)).wait();
  await advance(250);
  await (await vault.connect(agent).execute(w, reason, nonce)).wait();
  const aapl = new ethers.Contract(cfg.assets[0].token, ["function balanceOf(address) view returns (uint256)"], provider);
  check("agent plan bought AAPL for the test", (await aapl.balanceOf(dep.vault)) > 0n);

  // 4. a proposal, then vote for it from the console
  const gov = new ethers.Contract(dep.governor, ["function propose(address[],uint256[],bytes[],string) returns (uint256)", "function hashProposal(address[],uint256[],bytes[],bytes32) view returns (uint256)", "function hasVoted(uint256,address) view returns (bool)", "function state(uint256) view returns (uint8)"], provider);
  const data = vault.interface.encodeFunctionData("setDepositCap", [20_000n * 10n ** 6n]);
  const desc = "E2E: raise the deposit cap to 20,000 USDG";
  await (await gov.connect(await provider.getSigner(USER)).propose([dep.vault], [0], [data], desc)).wait();
  const pid = await gov.hashProposal([dep.vault], [0], [data], ethers.id(desc));
  await advance(3605);
  await openConsole(page);
  await page.waitForSelector('[data-vote="1"]', { timeout: 40000 });
  check("proposal appears in the console", (await page.$eval("#props", (e) => e.textContent)).includes("E2E: raise"));
  await page.click('[data-vote="1"]');
  await waitStatus(page, /Vote: done|failed/);
  check("vote button casts a vote", await gov.hasVoted(pid, USER));

  // 5. redeem while AAPL is paused, then claim the deferred part
  const original = await provider.getCode(cfg.assets[0].token);
  const factory = new ethers.ContractFactory(pausedArt.abi, pausedArt.bytecode, await provider.getSigner(USER));
  const stand = await factory.deploy("0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2"); await stand.waitForDeployment();
  await rpc("hardhat_setCode", [cfg.assets[0].token, await provider.getCode(await stand.getAddress())]);
  await openConsole(page);
  await page.type("#redAmt", "100");
  await page.click("#redBtn");
  await waitStatus(page, /Redeem: done|failed/);
  const owed = await vault.owed(USER, cfg.assets[0].token);
  check("redeem defers the paused stock", owed > 0n, ethers.formatUnits(owed, 18) + " AAPL owed");
  await rpc("hardhat_setCode", [cfg.assets[0].token, original]);
  await openConsole(page);
  await page.waitForSelector("[data-claim]", { timeout: 30000 });
  await page.click("[data-claim]");
  await waitStatus(page, /Claim: done|failed/);
  check("claim button pays the deferred stock", (await vault.owed(USER, cfg.assets[0].token)) === 0n && (await aapl.balanceOf(USER)) === owed);

  // 6. logbook and inspection read back from the chain
  await openConsole(page);
  await page.waitForFunction(() => /EXECUTED|REVEALED/.test(document.querySelector("#feed2")?.textContent || ""), { timeout: 30000 });
  check("logbook shows the executed plan", true);
  check("inspection lists the checks", /pass/.test(await page.$eval("#checks2", (e) => e.textContent)));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(site, { recursive: true, force: true });
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
