import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm";
import CFG from "./config.js";

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BPS = 10000;
const SYMBOLS = CFG.assets.map((a) => a.symbol);
const C = { ink: "#12181b", slate: "#475a62", course: "#b0107c", paper: "#fbfdfb", sea: "#e6f0ef", contour: "rgba(48,96,116,.62)" };
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (raw) => Number(raw) / 1e6;
const short = (h) => h ? h.slice(0, 12) + "…" + h.slice(-6) : "";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ contracts

const VAULT_ABI = [
  "function currentEpoch() view returns (uint256)", "function navSpot() view returns (uint256)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function weights() view returns (uint16[])",
  "function limits() view returns (uint16,uint16,uint16,uint16,uint16,uint16,uint8)", "function spotPrice(uint256) view returns (uint256)",
  "function depositCap() view returns (uint256)", "function brakeTripped() view returns (bool)", "function depositsPaused() view returns (bool)",
  "function tradingPaused() view returns (bool)", "function owed(address,address) view returns (uint256)", "function getVotes(address) view returns (uint256)",
  "function delegates(address) view returns (address)", "function deposit(uint256,uint256,address) returns (uint256)", "function redeem(uint256,address)",
  "function claimOwed(address)", "function delegate(address)",
  "event Committed(uint256 indexed epoch, bytes32 commit)",
  "event Executed(uint256 indexed epoch, uint16[] weights, uint256 navBefore, uint256 navAfter, uint256 turnover, bytes32 reasonHash)",
  "event ReasonRevealed(uint256 indexed epoch, string reason)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const GOV_ABI = [
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
  "function state(uint256) view returns (uint8)", "function proposalVotes(uint256) view returns (uint256,uint256,uint256)",
  "function castVote(uint256,uint8) returns (uint256)", "function hasVoted(uint256,address) view returns (bool)",
];
const STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

let provider = null, live = null, account = null, signer = null;
const deployed = !!(CFG.vault && CFG.governor);

async function pickRpc() {
  for (const url of CFG.rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url, CFG.chainId, { staticNetwork: true });
      await Promise.race([p.getBlockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
      return p;
    } catch { /* try the next one */ }
  }
  return null;
}

/** eth_getLogs in chunks, shrinking the range when a node refuses it. */
async function logsChunked(contract, filter, from, to) {
  const out = [];
  let step = 50000;
  for (let a = from; a <= to;) {
    const b = Math.min(to, a + step - 1);
    try { out.push(...await contract.queryFilter(filter, a, b)); a = b + 1; }
    catch (e) { if (step <= 500) throw e; step = Math.floor(step / 4); }
  }
  return out;
}

async function readLive() {
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, provider);
  const usdg = new ethers.Contract(CFG.usdg, ERC20_ABI, provider);
  const [epoch, nav, supply, w, lim, cap, brake, dPaused, tPaused, cash, block] = await Promise.all([
    v.currentEpoch(), v.navSpot(), v.totalSupply(), v.weights(), v.limits(), v.depositCap(), v.brakeTripped(), v.depositsPaused(), v.tradingPaused(), usdg.balanceOf(CFG.vault), provider.getBlockNumber(),
  ]);
  const assets = await Promise.all(CFG.assets.map(async (a, i) => {
    const [spot, bal] = await Promise.all([v.spotPrice(i), new ethers.Contract(a.token, ERC20_ABI, provider).balanceOf(CFG.vault)]);
    return { ...a, spot, bal, value: (bal * spot) / 10n ** 18n };
  }));
  const limits = { maxWeightBps: Number(lim[0]), minWeightBps: Number(lim[1]), maxTurnoverBps: Number(lim[2]), maxSlippageBps: Number(lim[3]), maxDeviationBps: Number(lim[4]), brakeDrawdownBps: Number(lim[5]), brakeWindow: Number(lim[6]) };
  const market = nav > 0n ? assets.map((a) => Number((a.value * 10000n) / nav)) : assets.map(() => 0);
  market.push(BPS - market.reduce((s, x) => s + x, 0));
  return { v, epoch: Number(epoch), nav, supply, target: w.map(Number), limits, cap, brake, dPaused, tPaused, cash, block, assets, market,
    sharePrice: supply > 0n ? Number((nav * 10n ** 18n) / supply) / 1e6 : 1 };
}

// ------------------------------------------------------------------ logbook from events

let book = { rows: [], executed: [] };
// The VPS indexer publishes all events to /data/feed.json, so visitors never need eth_getLogs.
let feed = null;
async function readFeed() {
  try {
    const r = await fetch("/data/feed.json", { cache: "no-store" });
    if (!r.ok) return null;
    const f = await r.json();
    return Date.now() / 1000 - f.updatedAt < 900 ? f : null; // ignore a feed older than 15 minutes
  } catch { return null; }
}
function bookFromFeed(f) {
  const byEpoch = new Map();
  const get = (e) => { if (!byEpoch.has(e)) byEpoch.set(e, { epoch: e }); return byEpoch.get(e); };
  f.commits.forEach((c) => { get(c.epoch).commit = c.commit; });
  f.executes.forEach((x) => { const r = get(x.epoch); r.weights = x.weights; r.navBefore = BigInt(x.navBefore); r.navAfter = BigInt(x.navAfter); r.turnover = BigInt(x.turnover); r.block = x.block; });
  f.reveals.forEach((x) => { get(x.epoch).reason = x.reason; });
  const rows = [...byEpoch.values()].sort((a, b) => b.epoch - a.epoch);
  return { rows, executed: rows.filter((r) => r.weights).reverse(), counts: f.counts };
}

async function readLogbook() {
  if (feed) return bookFromFeed(feed);
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, provider);
  const to = await provider.getBlockNumber();
  const from = Math.max(Number(CFG.deployBlock || 0), to - 400000);
  const [commits, execs, reveals] = await Promise.all([
    logsChunked(v, v.filters.Committed(), from, to), logsChunked(v, v.filters.Executed(), from, to), logsChunked(v, v.filters.ReasonRevealed(), from, to),
  ]);
  const byEpoch = new Map();
  const get = (e) => { if (!byEpoch.has(e)) byEpoch.set(e, { epoch: e }); return byEpoch.get(e); };
  commits.forEach((l) => { get(Number(l.args[0])).commit = l.args[1]; });
  execs.forEach((l) => { const r = get(Number(l.args[0])); r.weights = l.args[1].map(Number); r.navBefore = l.args[2]; r.navAfter = l.args[3]; r.turnover = l.args[4]; r.block = l.blockNumber; });
  reveals.forEach((l) => { get(Number(l.args[0])).reason = l.args[1]; });
  const rows = [...byEpoch.values()].sort((a, b) => b.epoch - a.epoch);
  return { rows, executed: rows.filter((r) => r.weights).reverse(), counts: { sealed: commits.length, executed: execs.length, revealed: reveals.length } };
}

const utc = (e) => new Date(e * 1800 * 1000).toISOString().slice(5, 16).replace("T", " ");
function logRowHTML(r) {
  const st = r.reason ? "REVEALED" : r.weights ? "EXECUTED" : "SEALED";
  const cls = st === "SEALED" ? "" : "ok";
  let rm = r.reason ? esc(r.reason) : r.weights ? `Executed. Turnover ${fmt(Number(r.turnover) * 100 / Math.max(1, Number(r.navBefore)), 1)}% of the vault. Reasoning due next watch.` : "Plan sealed. It can execute after the reveal delay.";
  return `<tr><td>W-${r.epoch}</td><td>${utc(r.epoch)}</td><td class="fp">${short(r.commit || "")}</td><td class="${cls}">${st}</td><td class="rm">${rm}</td></tr>`;
}
function paintLogbook() {
  const empty = `<tr><td colspan="5" class="empty">${deployed ? "No watches yet. The first entry appears when the agent seals its first plan." : "The logbook starts with the first watch after launch."}</td></tr>`;
  const html = book.rows.length ? book.rows.slice(0, 12).map(logRowHTML).join("") : empty;
  $("#feed").innerHTML = html; $("#feed2").innerHTML = html;
  if (book.counts) { $("#tLogged").textContent = book.counts.sealed; $("#tExec").textContent = book.counts.executed; $("#tRev").textContent = book.counts.revealed; }
}

// ------------------------------------------------------------------ hero chart (unchanged drawing, illustrative)

const BANDS = [[-.46,[230,240,239]],[-.29,[218,234,238]],[-.14,[204,227,235]],[0,[188,219,231]],[.24,[238,220,156]],[9,[229,207,134]]];
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7 + 7.3) * 43758.5453; return s - Math.floor(s); };
const sm = (t) => t * t * (3 - 2 * t);
function vn(x, y) { const i = Math.floor(x), j = Math.floor(y), u = sm(x - i), v = sm(y - j), a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
function fbm(x, y) { let f = 0, a = .5; for (let o = 0; o < 6; o++) { f += a * vn(x, y); x = x * 2.03 + 11.7; y = y * 2.03 - 5.1; a *= .5; } return f; }
function field(kind, W, H) {
  return (x, y) => {
    if (kind === "cta") return (Math.abs(y / H - .5) * 2 - .8) * 2 + (fbm(x / 380 + 9.1, y / 380 + 4.4) - .48) * 1.5;
    const n = (fbm(x / 410 + 3.2, y / 410 + 1.4) - .48) * 1.55;
    return kind === "wide" ? (x / W - .74) * 2.3 + (y / H - .5) * .32 + n : (y / H - .86) * 2.7 + (x / W - .5) * .55 + n;
  };
}
const inRects = (x, y, rs) => rs.some((r) => x > r.l && x < r.r && y > r.t && y < r.b);
const dms = (v, pos, neg) => { const a = Math.abs(v), deg = Math.floor(a), min = (a - deg) * 60; return `${deg}°${min.toFixed(2).padStart(5, "0")}'${v >= 0 ? pos : neg}`; };
const latAt = (y, H) => dms(54.62 - y / Math.max(H, 1) * .24, "N", "S");
const lonAt = (x, W) => dms(-4.9 + x / Math.max(W, 1) * .52, "E", "W");
function paintBase(cv, W, H, f, avoid, opt) {
  const d = Math.min(devicePixelRatio || 1, 2); cv.width = Math.round(W * d); cv.height = Math.round(H * d);
  const g = cv.getContext("2d");
  if (opt.overlay) g.setTransform(d, 0, 0, d, 0, 0);
  else {
  const step = 4, cols = Math.ceil(W / step) + 2, rows = Math.ceil(H / step) + 2, F = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) F[j * cols + i] = f(i * step, j * step);
  const img = g.createImageData(cv.width, cv.height), D = img.data;
  for (let y = 0, p = 0; y < cv.height; y++) {
    const fy = y / d / step, j = Math.min(rows - 2, Math.floor(fy)), v = fy - j;
    for (let x = 0; x < cv.width; x++, p += 4) {
      const fx = x / d / step, i = Math.min(cols - 2, Math.floor(fx)), u = fx - i, k = j * cols + i;
      const z = F[k] * (1 - u) * (1 - v) + F[k + 1] * u * (1 - v) + F[k + cols] * (1 - u) * v + F[k + cols + 1] * u * v;
      let c = BANDS[0][1]; if (z >= BANDS[0][0]) for (let b = 1; b < BANDS.length; b++) if (z < BANDS[b][0]) { c = BANDS[b][1]; break; }
      D[p] = c[0]; D[p + 1] = c[1]; D[p + 2] = c[2]; D[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0); g.setTransform(d, 0, 0, d, 0, 0);
  const contour = (lv, col, lw) => {
    g.beginPath();
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const k = j * cols + i, a = F[k], b = F[k + 1], c = F[k + cols + 1], e = F[k + cols], x = i * step, y = j * step, pts = [];
      if ((a < lv) !== (b < lv)) pts.push([x + step * (lv - a) / (b - a), y]);
      if ((b < lv) !== (c < lv)) pts.push([x + step, y + step * (lv - b) / (c - b)]);
      if ((e < lv) !== (c < lv)) pts.push([x + step * (lv - e) / (c - e), y + step]);
      if ((a < lv) !== (e < lv)) pts.push([x, y + step * (lv - a) / (e - a)]);
      for (let n = 0; n + 1 < pts.length; n += 2) { g.moveTo(pts[n][0], pts[n][1]); g.lineTo(pts[n + 1][0], pts[n + 1][1]); }
    }
    g.strokeStyle = col; g.lineWidth = lw; g.stroke();
  };
  [-.46, -.29, -.14].forEach((l) => contour(l, C.contour, .7)); contour(.24, "rgba(120,92,30,.45)", .7); contour(0, C.ink, 1.15);
  }
  const gx = W / (W >= 900 ? 6 : 3);
  g.strokeStyle = "rgba(18,24,27,.12)"; g.lineWidth = .7; g.beginPath();
  for (let x = gx; x < W; x += gx) { g.moveTo(x, 0); g.lineTo(x, H); }
  for (let y = gx; y < H; y += gx) { g.moveTo(0, y); g.lineTo(W, y); }
  g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle"; g.font = "italic 400 12px Spectral, Georgia, serif"; g.fillStyle = "#3f6070";
  const sp = W >= 900 ? 47 : 42; let s2 = opt.seed || 977; const r2 = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
  for (let y = 16; y < H - 14; y += sp) for (let x = 16 + (Math.round(y / sp) % 2) * sp / 2; x < W - 12; x += sp) {
    const sx = x + (r2() - .5) * 24, sy = y + (r2() - .5) * 20, z = f(sx, sy);
    if (z < -.015 && sy < H - (opt.scale ? 30 : 12) && !inRects(sx, sy, avoid) && r2() > .22) g.fillText(String(Math.max(1, Math.round(-z * 34))), sx, sy);
  }
  if (opt.scale) {
    g.fillStyle = C.ink; for (let x = 0, n = 0; x < W; x += 18, n++) if (n % 2) g.fillRect(x, H - 5, 18, 5);
    g.fillRect(0, H - 6, W, .8);
    g.textAlign = "left"; g.textBaseline = "alphabetic"; g.font = '400 10px "DM Mono", monospace'; g.fillStyle = C.slate;
    for (let x = gx; x < W - 40; x += gx) g.fillText(lonAt(x, W), x + 4, H - 11);
  }
  return { g, r2 };
}

let W = 0, H = 0, wide = true, depth = () => 0, copyBox = { r: 0, b: 0 }, route = [], routeLen = 0, startT = 0, heroOn = true, px = -1, py = -1;
const clearOfCopy = (x, y, m = 20) => !(x < copyBox.r + m && y < copyBox.b + m);
function renderHero() {
  const hero = $("#top"); if (!hero.clientWidth) return;
  W = hero.clientWidth; H = hero.clientHeight; wide = W >= 900; depth = field(wide ? "wide" : "narrow", W, H);
  const hr = hero.getBoundingClientRect(), cr = $(".hero-copy").getBoundingClientRect(), ca = $(".cartouche").getBoundingClientRect();
  copyBox = { r: cr.right - hr.left, b: cr.bottom - hr.top };
  const avoid = [{ l: -99, t: -99, r: copyBox.r + 20, b: copyBox.b + 20 }];
  if (wide) avoid.push({ l: ca.left - hr.left - 14, t: -99, r: W + 99, b: ca.bottom - hr.top + 14 });
  const roseX = Math.max(copyBox.r + 150, W * .55), roseY = H - 142, hasRose = wide && roseX + 106 < W && depth(roseX, roseY) < .03;
  if (hasRose) avoid.push({ l: roseX - 120, t: roseY - 120, r: roseX + 120, b: roseY + 120 });
  const { g, r2 } = paintBase($("#chartStatic"), W, H, depth, avoid, { scale: true, seed: 977, overlay: true });
  $("#chartLive").width = $("#chartStatic").width; $("#chartLive").height = $("#chartStatic").height;
  heroAvoid = avoid;
  const find = (test, x0, x1, y0, y1) => { for (let n = 0; n < 500; n++) { const x = x0 + r2() * (x1 - x0), y = y0 + r2() * (y1 - y0); if (test(x, y)) return [x, y]; } return null; };
  const label = (t, p, font, col) => { if (!p) return; g.font = font; const w = g.measureText(t).width; g.fillStyle = col; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, Math.max(w / 2 + 12, Math.min(W - w / 2 - 12, p[0])), p[1]); };
  label("PLIMSOLL HEAD", find((x, y) => depth(x, y) > .34 && depth(x - 60, y) > .12 && depth(x + 60, y) > .12 && !inRects(x, y, avoid), W * .4, W - 70, 40, H - 40), "700 13px Archivo, sans-serif", C.ink);
  label("Outer Shoal", find((x, y) => { const f = depth(x, y); return f > -.14 && f < -.03 && clearOfCopy(x, y, 70) && !inRects(x, y, avoid); }, W * .35, W, 30, H - 30), "italic 500 15px Spectral, Georgia, serif", "#25546a");
  if (hasRose) rose(g, roseX, roseY, 106);
  buildRoute(); setupWater(heroAvoid); startT = performance.now(); drawWater(still ? 0 : performance.now()); if (still) drawLive(1e9);
}
// ------------------------------------------------------------------ tide: breathing contours and tidal-stream arrows
// The depth field is computed once. Each water frame adds a slow tide (period about a minute) and a faint
// swell, then refills the depth tints and redraws the contours. Soundings and labels stay on their own layer.
let WG = null, arrows = [], lastWater = 0, heroAvoid = [];
const distToRoute = (x, y) => { let m = 1e9; for (let i = 1; i < route.length; i++) { const a = route[i - 1], b = route[i], dx = b.x - a.x, dy = b.y - a.y, u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1))); m = Math.min(m, Math.hypot(x - a.x - u * dx, y - a.y - u * dy)); } return m; };
const TIDE_W = 0.11; // radians per second
function setupWater(avoid) {
  const step = wide ? 5 : 6, cols = Math.ceil(W / step) + 2, rows = Math.ceil(H / step) + 2, F = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) F[j * cols + i] = depth(i * step, j * step);
  const off = document.createElement("canvas"); off.width = cols; off.height = rows;
  const cv = $("#chartBase"), d = Math.min(devicePixelRatio || 1, 2); cv.width = Math.round(W * d); cv.height = Math.round(H * d);
  WG = { step, cols, rows, F, Z: new Float32Array(cols * rows), off, img: off.getContext("2d").createImageData(cols, rows), d };
  arrows = [];
  let s3 = 4242; const r3 = () => (s3 = (s3 * 16807) % 2147483647) / 2147483647;
  const want = wide ? 7 : 3;
  for (let n = 0; n < 800 && arrows.length < want; n++) {
    const x = 30 + r3() * (W - 60), y = 30 + r3() * (H - 70), z = depth(x, y);
    if (z > -.06 || z < -.42 || inRects(x, y, avoid.map((r) => ({ l: r.l - 50, t: r.t - 30, r: r.r + 50, b: r.b + 30 }))) || !clearOfCopy(x, y, 40) || distToRoute(x, y) < 60 || arrows.some((a) => Math.hypot(a.x - x, a.y - y) < 120)) continue;
    const gx = depth(x + 4, y) - depth(x - 4, y), gy = depth(x, y + 4) - depth(x, y - 4), m = Math.hypot(gx, gy) || 1;
    let tx = -gy / m, ty = gx / m; if (ty > 0) { tx = -tx; ty = -ty; } // the flood stream runs along the contours, northward
    arrows.push({ x, y, tx, ty, kn: (0.6 + (1 + z) * 1.4).toFixed(1), ph: r3() });
  }
}
function drawWater(now) {
  if (!WG) return;
  const { step, cols, rows, F, Z, off, img, d } = WG, t = now / 1000, D = img.data;
  const tide = Math.sin(t * TIDE_W) * .028;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    const z = Z[k] = F[k] + tide + .014 * Math.sin(t * .55 + i * .05 + j * .032) * Math.sin(t * .31 - i * .021 + j * .044);
    let c = BANDS[0][1]; if (z >= BANDS[0][0]) for (let b = 1; b < BANDS.length; b++) if (z < BANDS[b][0]) { c = BANDS[b][1]; break; }
    const p = k * 4; D[p] = c[0]; D[p + 1] = c[1]; D[p + 2] = c[2]; D[p + 3] = 255;
  }
  off.getContext("2d").putImageData(img, 0, 0);
  const g = $("#chartBase").getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0); g.imageSmoothingEnabled = true;
  g.drawImage(off, 0, 0, cols, rows, -step / 2, -step / 2, cols * step, rows * step);
  const contour = (lv, col, lw) => {
    g.beginPath();
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const k = j * cols + i, a = Z[k], b = Z[k + 1], c = Z[k + cols + 1], e = Z[k + cols], x = i * step, y = j * step, pts = [];
      if ((a < lv) !== (b < lv)) pts.push([x + step * (lv - a) / (b - a), y]);
      if ((b < lv) !== (c < lv)) pts.push([x + step, y + step * (lv - b) / (c - b)]);
      if ((e < lv) !== (c < lv)) pts.push([x + step * (lv - e) / (c - e), y + step]);
      if ((a < lv) !== (e < lv)) pts.push([x, y + step * (lv - a) / (e - a)]);
      for (let n = 0; n + 1 < pts.length; n += 2) { g.moveTo(pts[n][0], pts[n][1]); g.lineTo(pts[n + 1][0], pts[n + 1][1]); }
    }
    g.strokeStyle = col; g.lineWidth = lw; g.stroke();
  };
  [-.46, -.29, -.14].forEach((l) => contour(l, C.contour, .7)); contour(.24, "rgba(120,92,30,.45)", .7); contour(0, C.ink, 1.15);
}
// Chart convention: a feathered arrow is the flood (rising) stream, a plain arrow the ebb, with the rate in knots.
function drawArrows(g, now) {
  if (!arrows.length) return;
  const t = now / 1000, flood = Math.cos(t * TIDE_W) >= 0;
  g.save(); g.lineWidth = 1.2; g.font = '400 10px "DM Mono", monospace'; g.textAlign = "left"; g.textBaseline = "middle";
  arrows.forEach((a) => {
    const life = still ? .5 : ((t * .16 + a.ph) % 1), alpha = Math.sin(life * Math.PI) * .75;
    const dir = flood ? 1 : -1, tx = a.tx * dir, ty = a.ty * dir, shift = (life - .5) * 28;
    const cx = a.x + tx * shift, cy = a.y + ty * shift, L = 34, nx = -ty, ny = tx;
    const x0 = cx - tx * L / 2, y0 = cy - ty * L / 2, x1 = cx + tx * L / 2, y1 = cy + ty * L / 2;
    g.strokeStyle = g.fillStyle = `rgba(18,24,27,${alpha.toFixed(3)})`;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - tx * 8 + nx * 4, y1 - ty * 8 + ny * 4); g.lineTo(x1 - tx * 8 - nx * 4, y1 - ty * 8 - ny * 4); g.closePath(); g.fill();
    if (flood) for (const f of [0, 6]) { const fx = x0 + tx * f, fy = y0 + ty * f; g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx - tx * 5 + nx * 5, fy - ty * 5 + ny * 5); g.stroke(); }
    g.fillText(a.kn + "kn", cx + nx * 12 + 3, cy + ny * 12);
  });
  g.restore();
}
function rose(g, x, y, R) {
  g.save(); g.translate(x, y); g.strokeStyle = C.course; g.fillStyle = C.course; g.lineWidth = .8;
  g.beginPath(); g.arc(0, 0, R, 0, 6.2832); g.moveTo(R - 11, 0); g.arc(0, 0, R - 11, 0, 6.2832); g.stroke();
  for (let a = 0; a < 360; a += 5) { const t = (a - 90) * Math.PI / 180, l = a % 30 === 0 ? 11 : a % 10 === 0 ? 7 : 4; g.beginPath(); g.moveTo(Math.cos(t) * R, Math.sin(t) * R); g.lineTo(Math.cos(t) * (R - l), Math.sin(t) * (R - l)); g.stroke(); }
  g.font = '400 9px "DM Mono", monospace'; g.textAlign = "center"; g.textBaseline = "middle";
  for (let a = 0; a < 360; a += 30) { const t = (a - 90) * Math.PI / 180; g.save(); g.translate(Math.cos(t) * (R - 19), Math.sin(t) * (R - 19)); g.rotate(a * Math.PI / 180); g.fillText(String(a).padStart(3, "0"), 0, 0); g.restore(); }
  g.rotate(-3.33 * Math.PI / 180); g.beginPath(); g.moveTo(0, R - 30); g.lineTo(0, -(R - 26)); g.moveTo(-(R - 30), 0); g.lineTo(R - 30, 0); g.stroke();
  g.beginPath(); g.moveTo(0, -(R - 26)); g.lineTo(5, -(R - 44)); g.lineTo(-5, -(R - 44)); g.closePath(); g.fill();
  g.rotate(3.33 * Math.PI / 180); g.font = "italic 400 11px Spectral, Georgia, serif"; g.fillText("VAR 3°20'W", 0, 17); g.restore();
}
function buildRoute() {
  let coast = null;
  if (wide) { const y = H * .36; for (let x = W * .5; x < W; x += 2) if (depth(x, y) > -.02) { coast = [x, y]; break; } }
  else { const x = W * .72; for (let y = copyBox.b + 30; y < H; y += 2) if (depth(x, y) > -.02) { coast = [x, y]; break; } }
  if (!coast) coast = wide ? [W * .8, H * .36] : [W * .72, H - 60];
  const safe = (p, dx, dy) => { let n = 0; while (depth(p[0], p[1]) > -.08 && n++ < 60) { p[0] += dx; p[1] += dy; } return p; };
  const pts = wide
    ? [[Math.max(copyBox.r + 26, W * .47), H - 22], safe([coast[0] - 190, H * .68], -5, 1), safe([coast[0] - 70, H * .46], -5, 0), coast]
    : [safe([20, copyBox.b + 78], 0, -2), safe([W * .4, copyBox.b + 112], 0, -2), coast];
  route = pts.map((p) => ({ x: p[0], y: p[1] })); routeLen = 0;
  route.forEach((p, i) => { p.at = i ? (routeLen += Math.hypot(p.x - route[i - 1].x, p.y - route[i - 1].y)) : 0; });
}
const along = (l) => { for (let i = 1; i < route.length; i++) if (l <= route[i].at) { const a = route[i - 1], b = route[i], t = (l - a.at) / (b.at - a.at); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: Math.atan2(b.y - a.y, b.x - a.x) }; } const e = route[route.length - 1], p = route[route.length - 2]; return { x: e.x, y: e.y, h: Math.atan2(e.y - p.y, e.x - p.x) }; };
function drawLive(now) {
  const c = $("#chartLive"); if (!c.width || !route.length) return;
  const d = c.width / W, g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  drawArrows(g, now);
  const drawn = Math.min(1, (now - startT) / 2400), L = routeLen * (1 - (1 - drawn) ** 3);
  g.strokeStyle = C.course; g.lineWidth = 1.5; g.beginPath(); g.moveTo(route[0].x, route[0].y);
  for (let i = 1; i < route.length; i++) { if (L >= route[i].at) g.lineTo(route[i].x, route[i].y); else { const q = along(L); g.lineTo(q.x, q.y); break; } }
  g.stroke(); g.font = '500 10px "DM Mono", monospace'; g.textAlign = "left"; g.textBaseline = "middle";
  route.forEach((p, i) => {
    if (L + .5 < p.at) return;
    g.beginPath(); g.arc(p.x, p.y, 5, 0, 6.2832); g.fillStyle = C.paper; g.fill(); g.stroke();
    g.beginPath(); g.arc(p.x, p.y, 1.3, 0, 6.2832); g.fillStyle = C.course; g.fill();
    if (i) { const a = route[i - 1], brg = ((Math.atan2(p.x - a.x, a.y - p.y) * 180 / Math.PI) + 360) % 360, mx = (a.x + p.x) / 2, my = (a.y + p.y) / 2; g.fillStyle = "rgba(251,253,251,.85)"; g.fillRect(mx + 7, my - 8, 38, 15); g.fillStyle = C.course; g.fillText(String(Math.round(brg)).padStart(3, "0") + "°T", mx + 10, my); }
  });
  if (drawn >= 1 && routeLen) {
    const v = along(routeLen * (still ? .62 : (((now - startT - 2400) / 52000) % 1)));
    g.save(); g.translate(v.x, v.y); g.rotate(v.h); g.fillStyle = C.ink; g.beginPath(); g.moveTo(9, 0); g.lineTo(-6, -4.5); g.lineTo(-6, 4.5); g.closePath(); g.fill(); g.restore();
  }
  if (px >= 0 && clearOfCopy(px, py, 4)) {
    g.strokeStyle = "rgba(18,24,27,.55)"; g.lineWidth = .7; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.moveTo(0, py); g.lineTo(W, py); g.stroke();
    const t = `${latAt(py, H)}  ${lonAt(px, W)}  ${Math.max(0, Math.round(-depth(px, py) * 34))}m`; g.font = '400 11px "DM Mono", monospace';
    const w = g.measureText(t).width + 14, lx = px + w + 12 > W ? px - w - 8 : px + 8, ly = py < 30 ? py + 8 : py - 27;
    g.fillStyle = C.ink; g.fillRect(lx, ly, w, 19); g.fillStyle = C.paper; g.fillText(t, lx + 7, ly + 10);
  }
}
function renderCta() {
  const s = $("#cta"); if (!s.clientWidth) return; const w = s.clientWidth, h = s.clientHeight, sr = s.getBoundingClientRect(), br = $("#ctaBox").getBoundingClientRect();
  paintBase($("#ctaChart"), w, h, field("cta", w, h), [{ l: br.left - sr.left - 16, t: br.top - sr.top - 16, r: br.right - sr.left + 16, b: br.bottom - sr.top + 16 }], { seed: 313 });
}
function loop(now) {
  if (heroOn && !$("#home").hidden) {
    if (!still && now - lastWater > (wide ? 70 : 140)) { drawWater(now); lastWater = now; }
    drawLive(now);
  } if (!still) requestAnimationFrame(loop); }
$("#top").addEventListener("pointermove", (e) => { const r = $("#top").getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top; if (still) drawLive(1e9); });
$("#top").addEventListener("pointerleave", () => { px = -1; if (still) drawLive(1e9); });
new IntersectionObserver((es) => { heroOn = es[0].isIntersecting; }).observe($("#top"));

// ------------------------------------------------------------------ trim lab (a simulator of the contract's checks)

const NAMES = [...SYMBOLS, "CASH"];
let limits = { ...CFG.limits };
let simBook = [2000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 2000];
let plan = [...simBook];
const HOLD_X = (i) => 100 + i * 49;
$("#sliders").innerHTML = NAMES.map((n, i) => `<label class="sl" for="w${i}"><span>${n}</span><input id="w${i}" type="range" min="0" max="${i === NAMES.length - 1 ? 100 : 50}" step="1"><output id="o${i}"></output></label>`).join("");
$("#holds").innerHTML = NAMES.map((n, i) => { const x = HOLD_X(i); return `<rect x="${x}" y="98" width="45" height="118" fill="${i === NAMES.length - 1 ? "#eedc9c" : "#fbfdfb"}" stroke-width="1"/><rect id="h${i}" x="${x}" width="45" fill="url(#hatch)" stroke="none" style="transition:y .3s ease,height .3s ease"/><text x="${x + 22.5}" y="111" text-anchor="middle" fill="#12181b" stroke="none" font-family="DM Mono, monospace" font-size="8.5">${n}</text>`; }).join("");
const pct = (bps) => bps / 100;
function tests(p) {
  const stocks = p.slice(0, -1), total = p.reduce((a, b) => a + b, 0), top = Math.max(...stocks);
  const held = stocks.filter((x) => x > 0), low = held.length ? Math.min(...held) : 0;
  const turn = p.reduce((a, v, i) => a + Math.abs(v - simBook[i]), 0) / 2;
  return [
    ["Adds up to 100%", total === BPS, pct(total) + "%"], ["Largest ≤ " + pct(limits.maxWeightBps) + "%", top <= limits.maxWeightBps, pct(top) + "%"],
    ["Held ≥ " + pct(limits.minWeightBps) + "%", held.length === 0 || low >= limits.minWeightBps, held.length ? pct(low) + "%" : "none"],
    ["Turnover ≤ " + pct(limits.maxTurnoverBps) + "%", turn <= limits.maxTurnoverBps, pct(turn) + "%"],
  ];
}
const checkHTML = (p) => tests(p).map(([a, ok, v]) => `<li><span>${a}</span><span class="mono ${ok ? "ok" : "bad"}">${ok ? "pass" : "fail"} ${v}</span></li>`).join("");
function paintLab() {
  plan.forEach((v, i) => { $("#w" + i).value = v / 100; $("#o" + i).textContent = pct(v) + "%"; const h = Math.min(1, v / (i === NAMES.length - 1 ? BPS : 5000)) * 100, r = $("#h" + i); r.setAttribute("y", 216 - h); r.setAttribute("height", h); r.style.y = (216 - h) + "px"; r.style.height = h + "px"; });
  const moment = plan.reduce((a, v, i) => a + v * (i - 4), 0), base = simBook.reduce((a, v, i) => a + v * (i - 4), 0), tilt = Math.max(-7, Math.min(7, (moment - base) / 1000 * .6));
  $("#hullG").style.transform = `rotate(${tilt}deg)`;
  $("#trimRead").textContent = Math.abs(tilt) < .05 ? "0.0° level" : `${Math.abs(tilt).toFixed(1)}° by the ${tilt > 0 ? "bow" : "stern"}`;
  $("#checks").innerHTML = checkHTML(plan);
}
$("#sliders").addEventListener("input", (e) => { const i = +e.target.id.slice(1); plan[i] = Math.round(+e.target.value * 100); paintLab(); $("#verdict").textContent = ""; });
$("#reset").onclick = () => { plan = [...simBook]; paintLab(); $("#verdict").textContent = ""; };
$("#submit").onclick = () => {
  const fails = tests(plan).filter((x) => !x[1]), v = $("#verdict");
  if (fails.length) { v.className = "bad"; v.textContent = "The contract would refuse this: " + fails.map((f) => f[0]).join(", ") + "."; setTimeout(() => { plan = [...simBook]; paintLab(); }, 900); }
  else { v.className = "ok"; v.textContent = "The contract would accept this mix. On chain, only the agent's sealed plans can trade."; }
};

// ------------------------------------------------------------------ watch clock

const PH = [{ n: "Seal", a: 0, b: 4 }, { n: "Inspect", a: 4, b: 20 }, { n: "Reveal next", a: 20, b: 30 }];
const pol = (m, r) => { const t = (m / 30 * 360 - 90) * Math.PI / 180; return [160 + Math.cos(t) * r, 160 + Math.sin(t) * r]; };
const arcD = (a, b, r) => { const p = pol(a, r), q = pol(b, r); return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}A${r} ${r} 0 ${b - a > 15 ? 1 : 0} 1 ${q[0].toFixed(1)} ${q[1].toFixed(1)}`; };
(function buildDial() {
  let s = '<circle cx="160" cy="160" r="150" fill="#fbfdfb" stroke="#12181b"/><circle cx="160" cy="160" r="143" fill="none" stroke="#12181b"/>';
  for (let m = 0; m < 30; m += .5) { const big = m % 5 === 0, one = m % 1 === 0, p = pol(m, 143), q = pol(m, big ? 128 : one ? 135 : 139); s += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="#12181b" stroke-width="${big ? 1.6 : .8}"/>`; }
  for (let m = 0; m < 30; m += 5) { const p = pol(m, 114); s += `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="DM Mono, monospace" font-size="12" fill="#12181b">${String(m).padStart(2, "0")}</text>`; }
  PH.forEach((ph, i) => { s += `<path id="arc${i}" d="${arcD(ph.a + .15, ph.b - .15, 96)}" fill="none" stroke="#c5e3ec" stroke-width="12"/>`; const mid = pol((ph.a + ph.b) / 2, 76); s += `<text x="${mid[0].toFixed(1)}" y="${mid[1].toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="Spectral, serif" font-style="italic" font-size="13" fill="#475a62">${ph.n}</text>`; });
  s += '<g id="hand"><line x1="160" y1="172" x2="160" y2="30" stroke="#b0107c" stroke-width="2"/><circle cx="160" cy="160" r="6" fill="#b0107c"/></g>';
  s += '<text id="dialTime" x="160" y="200" text-anchor="middle" font-family="DM Mono, monospace" font-size="15" fill="#12181b">T+00:00</text>';
  $("#dial").innerHTML = s;
})();
$$(".step .note")[0].textContent = "Minute 0";
$$(".step .note")[1].textContent = "Minute 4 onward";
$$(".step .note")[2].textContent = "Next watch";
let curPh = -1;
function setMinute(m) {
  $("#hand").setAttribute("transform", `rotate(${(m / 30 * 360).toFixed(2)} 160 160)`);
  $("#dialTime").textContent = "T+" + String(Math.floor(m)).padStart(2, "0") + ":" + String(Math.floor((m % 1) * 60)).padStart(2, "0");
  const i = m < 4 ? 0 : m < 20 ? 1 : 2; if (i === curPh) return; curPh = i;
  PH.forEach((_, n) => $("#arc" + n).setAttribute("stroke", n === i ? "#b0107c" : n < i ? "#12181b" : "#c5e3ec"));
  $$(".step").forEach((e, n) => e.classList.toggle("on", n === i));
  paintClockRows();
}
function paintClockRows() {
  const last = book.executed[book.executed.length - 1];
  const rows = [
    [["Plan", "agent seals a hash"], ["Latest seal", book.rows[0]?.commit ? short(book.rows[0].commit) : "none yet"], ["Earliest trade", "4 minutes later"]],
    [["Largest position", `cap ${pct(limits.maxWeightBps)}%`], ["Held position", `${pct(limits.minWeightBps)}% minimum`], ["Turnover", last ? `${fmt(Number(last.turnover) * 100 / Math.max(1, Number(last.navBefore)), 1)}% of ${pct(limits.maxTurnoverBps)}%` : `limit ${pct(limits.maxTurnoverBps)}%`]],
    [["Reasoning", "published next watch"], ["Must match", "the sealed hash"], ["Published so far", book.counts ? String(book.counts.revealed) : "—"]],
  ][curPh < 0 ? 0 : curPh];
  $("#clockRows").innerHTML = rows.map((r) => `<div><span>${r[0]}</span><span>${r[1]}</span></div>`).join("");
}
setMinute(1);
function onScroll() {
  const m = document.documentElement.scrollHeight - innerHeight; $("#track").style.setProperty("--p", m > 0 ? (scrollY / m).toFixed(4) : 0);
  if ($("#home").hidden) return;
  const r = $(".voyage").getBoundingClientRect(), p = Math.max(0, Math.min(.999, (innerHeight * .5 - r.top) / r.height));
  setMinute(p * 30);
}
addEventListener("scroll", onScroll, { passive: true });

// ------------------------------------------------------------------ console painting

function gauge(el, val, max, txt, warn) {
  const cx = 110, cy = 110, R = 88, ang = (v) => Math.PI + Math.min(1, Math.max(0, v) / max) * Math.PI, pt = (v, r) => [cx + Math.cos(ang(v)) * r, cy + Math.sin(ang(v)) * r];
  let s = `<path d="M${cx - R} ${cy}A${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="#12181b"/>`;
  const w0 = pt(warn, R - 7), w1 = pt(max, R - 7);
  s += `<path d="M${w0[0].toFixed(1)} ${w0[1].toFixed(1)}A${R - 7} ${R - 7} 0 0 1 ${w1[0].toFixed(1)} ${w1[1].toFixed(1)}" fill="none" stroke="#c32c1a" stroke-width="6" opacity=".35"/>`;
  for (let i = 0; i <= 10; i++) { const v = max * i / 10, a = pt(v, R), b = pt(v, R - (i % 5 ? 7 : 13)); s += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#12181b" stroke-width="${i % 5 ? .8 : 1.5}"/>`; }
  s += `<text x="${cx - R + 4}" y="${cy + 16}" font-family="DM Mono, monospace" font-size="11" fill="#475a62">0</text><text x="${cx + R - 4}" y="${cy + 16}" text-anchor="end" font-family="DM Mono, monospace" font-size="11" fill="#475a62">${max}%</text>`;
  const n = pt(val, R - 18); s += `<line x1="${cx}" y1="${cy}" x2="${n[0].toFixed(1)}" y2="${n[1].toFixed(1)}" stroke="#b0107c" stroke-width="2.2"/><circle cx="${cx}" cy="${cy}" r="5" fill="#b0107c"/>`;
  s += `<text x="${cx}" y="${cy - 26}" text-anchor="middle" font-family="DM Mono, monospace" font-size="19" fill="#12181b">${txt}</text>`;
  el.innerHTML = s;
}
const PAT = ["p0", "p1", "p2", "p3", "p4", "p5", "p0", "p2", "p1"];
function phaseName(l) { return l.maxWeightBps <= 2500 && l.maxTurnoverBps <= 800 ? "Coastal limits" : l.maxWeightBps <= 3000 ? "Open water limits" : "Custom limits"; }

function paintLive() {
  if (!live) {
    $("#notDeployed").hidden = deployed;
    $("#mixRows").innerHTML = `<tr><td class="empty">${deployed ? "Reading the vault…" : "Waiting for deployment."}</td></tr>`;
    gauge($("#g1"), 0, pct(limits.maxTurnoverBps), "—", pct(limits.maxTurnoverBps) * .8);
    gauge($("#g2"), 0, pct(limits.maxWeightBps), "—", pct(limits.maxWeightBps) * .9);
    gauge($("#g3"), 0, 100, "—", 90);
    $("#checks2").innerHTML = '<li class="empty">No executed plan yet.</li>';
    drawIndex();
    return;
  }
  const L = live;
  $("#gWatch").textContent = L.epoch.toLocaleString("en-US");
  $("#cWatch").textContent = L.epoch.toLocaleString("en-US");
  $("#gIndex").textContent = $("#cIndex").textContent = fmt(L.sharePrice, 4);
  $("#gMax").textContent = fmt(Math.max(...L.market.slice(0, -1)) / 100, 1) + "%";
  $("#gBlock").textContent = L.block.toLocaleString("en-US");
  $("#chipBrake").className = "chip" + (L.brake ? " warn" : "");
  $("#chipBrake").innerHTML = `<i></i>Storm brake: ${L.brake ? "tripped" : "clear"}${L.tPaused ? " · trading paused" : ""}${L.dPaused ? " · deposits paused" : ""}`;
  $("#chipPhase").textContent = `${phaseName(L.limits)}: ${pct(L.limits.maxWeightBps)}% cap, ${pct(L.limits.maxTurnoverBps)}% turnover`;
  $("#stack").innerHTML = L.market.map((w, i) => `<span class="${PAT[i]}" style="flex-basis:${w / 100}%" title="${NAMES[i]} ${pct(w)}%"></span>`).join("");
  $("#mixRows").innerHTML = `<tr><td style="font-style:italic">Holding</td><td>Price</td><td>Weight</td><td>Target</td></tr>` + NAMES.map((n, i) => {
    const price = i < L.assets.length ? "$" + fmt(usd(L.assets[i].spot)) : "$1.00";
    return `<tr><td><i class="${PAT[i]}"></i>${n}</td><td>${price}</td><td>${fmt(L.market[i] / 100, 1)}%</td><td>${fmt(L.target[i] / 100, 1)}%</td></tr>`;
  }).join("") + `<tr><td><b>Total</b></td><td></td><td><b>$${fmt(usd(L.nav))}</b></td><td></td></tr>`;
  const last = book.executed[book.executed.length - 1];
  const turn = last ? Number(last.turnover) * 100 / Math.max(1, Number(last.navBefore)) : 0;
  gauge($("#g1"), turn, pct(L.limits.maxTurnoverBps), last ? fmt(turn, 1) + "%" : "—", pct(L.limits.maxTurnoverBps) * .8);
  const top = Math.max(...L.market.slice(0, -1)) / 100;
  gauge($("#g2"), top, pct(L.limits.maxWeightBps), fmt(top, 1) + "%", pct(L.limits.maxWeightBps) * .9);
  const capUsed = L.cap > 0n ? Number(L.nav * 10000n / L.cap) / 100 : 0;
  gauge($("#g3"), capUsed, 100, fmt(capUsed, 1) + "%", 90);
  $("#g1sub").textContent = `Limit ${pct(L.limits.maxTurnoverBps)}% of vault value`;
  $("#g2sub").textContent = `Limit ${pct(L.limits.maxWeightBps)}% per stock`;
  $("#g3sub").textContent = `$${fmt(usd(L.nav), 0)} of $${fmt(usd(L.cap), 0)} cap`;
  if (last) {
    const t = last.weights, held = t.slice(0, -1).filter((x) => x > 0);
    const rows = [
      ["Adds up to 100%", t.reduce((a, b) => a + b, 0) === BPS],
      [`Largest ≤ ${pct(L.limits.maxWeightBps)}%`, Math.max(...t.slice(0, -1)) <= L.limits.maxWeightBps],
      [`Held ≥ ${pct(L.limits.minWeightBps)}%`, held.every((x) => x >= L.limits.minWeightBps)],
      [`Turnover ≤ ${pct(L.limits.maxTurnoverBps)}%`, turn <= pct(L.limits.maxTurnoverBps)],
      ["Matched its seal", true],
    ];
    $("#checks2").innerHTML = rows.map(([a, ok]) => `<li><span>${a}</span><span class="mono ${ok ? "ok" : "bad"}">${ok ? "pass" : "fail"}</span></li>`).join("");
    $("#inspSub").textContent = `Watch ${last.epoch}, checked by the contract before it traded`;
  } else $("#checks2").innerHTML = '<li class="empty">No executed plan yet.</li>';
  drawIndex();
}

function drawIndex() {
  const c = $("#indexChart"); if (!c || !c.clientWidth) return;
  const d = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
  c.width = w * d; c.height = h * d; const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const series = book.executed.map((r) => usd(r.navAfter));
  g.font = '10.5px "DM Mono", monospace'; g.fillStyle = C.slate;
  if (series.length < 2) { g.font = 'italic 15px Spectral, Georgia, serif'; g.fillText("The chart starts after two executed watches.", 12, h / 2); return; }
  const lo = Math.min(...series) * .995, hi = Math.max(...series) * 1.005, pad = { l: 60, r: 8, t: 6, b: 20 };
  const X = (i) => pad.l + i / (series.length - 1) * (w - pad.l - pad.r), Y = (v) => pad.t + (hi - v) / (hi - lo) * (h - pad.t - pad.b);
  g.strokeStyle = "rgba(18,24,27,.16)"; g.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const v = lo + (hi - lo) * i / 3, y = Y(v); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.fillText("$" + fmt(v, 0), 0, y + 4); }
  g.fillText(`W-${book.executed[0].epoch}`, pad.l, h - 4); g.textAlign = "right"; g.fillText(`W-${book.executed[series.length - 1].epoch}`, w - pad.r, h - 4); g.textAlign = "left";
  g.beginPath(); series.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); g.strokeStyle = C.course; g.lineWidth = 1.8; g.stroke();
  g.fillStyle = C.paper; g.strokeStyle = C.course; g.beginPath(); g.arc(X(series.length - 1), Y(series[series.length - 1]), 4, 0, 7); g.fill(); g.stroke();
}


function paintAgent() {
  const chip = $("#chipAgent"); if (!chip) return;
  if (!feed) { chip.className = "chip"; chip.innerHTML = "<i></i>Agent: status unavailable"; return; }
  const a = feed.agent, now = Date.now() / 1000;
  const ago = a.lastTickAt ? Math.round((now - a.lastTickAt) / 60) : null;
  const gas = Number(a.ethBalance);
  const stale = ago === null || ago > 10;
  const lowGas = gas < 0.0005;
  let text = stale ? `Agent offline${ago !== null ? " for " + ago + " min" : ""}` : `Agent ${a.status === "waiting for deposits" ? "waiting for deposits" : "online"}`;
  text += ` · gas ${gas.toFixed(4)} ETH${lowGas ? " (low)" : ""}`;
  chip.className = "chip" + (stale || lowGas ? " warn" : "");
  chip.innerHTML = `<i></i>${text}`;
}

// ------------------------------------------------------------------ wallet

const status = (t, cls = "") => { const s = $("#txStatus"); s.className = cls; s.textContent = t; };
async function ensureChain() {
  const hexId = "0x" + CFG.chainId.toString(16);
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hexId, chainName: CFG.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: CFG.rpcs.filter((u) => u.startsWith("https")), blockExplorerUrls: [CFG.explorer] }] });
  }
}
async function connect() {
  if (!window.ethereum) { status("No browser wallet found. Install MetaMask or Rabby, then reload this page.", "bad"); if (location.pathname !== "/console") location.href = "/console"; return; }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    const bp = new ethers.BrowserProvider(window.ethereum);
    signer = await bp.getSigner(); account = await signer.getAddress();
    $$("#connectBtn, #navConnect").forEach((b) => (b.textContent = account.slice(0, 6) + "…" + account.slice(-4)));
    status("Wallet connected.", "ok");
    await refreshPosition();
  } catch (e) { status(e.shortMessage || e.message || "Connection was cancelled.", "bad"); }
}
$("#connectBtn").onclick = connect;
$("#navConnect").onclick = connect;
if (window.ethereum) { window.ethereum.on?.("accountsChanged", () => connect()); window.ethereum.on?.("chainChanged", () => location.reload()); }

async function refreshPosition() {
  if (!account || !deployed || !provider) return;
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, provider);
  const usdg = new ethers.Contract(CFG.usdg, ERC20_ABI, provider);
  const [bal, sh, votes, del] = await Promise.all([usdg.balanceOf(account), v.balanceOf(account), v.getVotes(account), v.delegates(account)]);
  $("#pAddr").textContent = account;
  $("#pUsdg").textContent = fmt(usd(bal)) + " USDG";
  $("#pShares").textContent = fmt(Number(ethers.formatUnits(sh, 18)), 4);
  $("#pValue").textContent = live && live.supply > 0n ? "$" + fmt(usd((sh * live.nav) / live.supply)) : "—";
  $("#pVotes").textContent = fmt(Number(ethers.formatUnits(votes, 18)), 2);
  $("#delegateBtn").hidden = !(sh > 0n && del === ethers.ZeroAddress);
  $("#redAmt").dataset.max = ethers.formatUnits(sh, 18);
  const tokens = [{ symbol: "USDG", token: CFG.usdg }, ...CFG.assets];
  const owed = await Promise.all(tokens.map((t) => v.owed(account, t.token)));
  $("#owedList").innerHTML = owed.map((o, i) => o > 0n ? `<div class="kv"><span>Owed ${tokens[i].symbol}</span><button class="btn small" type="button" data-claim="${tokens[i].token}">Claim</button></div>` : "").join("");
  await paintProposals();
}

async function sendTx(label, fn) {
  try {
    status(`${label}: confirm in your wallet…`);
    const tx = await fn();
    status(`${label}: waiting for the block… ${tx.hash}`);
    await tx.wait();
    status(`${label}: done.`, "ok");
    await refreshAll();
    return true;
  } catch (e) { status(`${label} failed: ${e.shortMessage || e.reason || e.message}`, "bad"); return false; }
}

$("#depForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!signer) return connect();
  if (!deployed) return status("The vault is not deployed yet.", "bad");
  let amt; try { amt = ethers.parseUnits($("#depAmt").value.trim() || "0", 6); } catch { return status("Enter an amount like 100 or 100.50.", "bad"); }
  if (amt <= 0n) return status("Enter an amount above zero.", "bad");
  const usdg = new ethers.Contract(CFG.usdg, ERC20_ABI, signer);
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, signer);
  if ((await usdg.balanceOf(account)) < amt) return status("Your wallet holds less USDG than that.", "bad");
  // shares are priced at max(spot, reference); allow 6% below the spot estimate before the deposit reverts
  const est = live && live.supply > 0n ? (amt * live.supply) / live.nav : amt * 10n ** 12n;
  const minShares = (est * 94n) / 100n;
  if ((await usdg.allowance(account, CFG.vault)) < amt) {
    if (!await sendTx("Approve USDG", () => usdg.approve(CFG.vault, amt))) return;
  }
  if (await sendTx("Deposit", () => v.deposit(amt, minShares, account))) $("#depAmt").value = "";
});
$("#redMax").onclick = () => { $("#redAmt").value = $("#redAmt").dataset.max || ""; };
$("#redForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!signer) return connect();
  let sh; try { sh = ethers.parseUnits($("#redAmt").value.trim() || "0", 18); } catch { return status("Enter a share amount like 10 or 10.5.", "bad"); }
  if (sh <= 0n) return status("Enter a share amount above zero.", "bad");
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, signer);
  if (await sendTx("Redeem", () => v.redeem(sh, account))) $("#redAmt").value = "";
});
$("#owedList").addEventListener("click", (e) => {
  const t = e.target.closest("[data-claim]"); if (!t) return;
  const v = new ethers.Contract(CFG.vault, VAULT_ABI, signer);
  sendTx("Claim", () => v.claimOwed(t.dataset.claim));
});
$("#delegateBtn").onclick = () => { const v = new ethers.Contract(CFG.vault, VAULT_ABI, signer); sendTx("Turn on voting power", () => v.delegate(account)); };

// ------------------------------------------------------------------ holder votes

let proposals = [];
async function readProposals() {
  if (feed) {
    proposals = feed.proposals.map((p) => ({ id: BigInt(p.id), description: p.description, state: p.state, against: BigInt(p.against), for: BigInt(p.for), abstain: BigInt(p.abstain) })).reverse();
    return;
  }
  const g = new ethers.Contract(CFG.governor, GOV_ABI, provider);
  const to = await provider.getBlockNumber();
  const logs = await logsChunked(g, g.filters.ProposalCreated(), Math.max(Number(CFG.deployBlock || 0), to - 400000), to);
  proposals = await Promise.all(logs.map(async (l) => {
    const id = l.args[0];
    const [st, votes] = await Promise.all([g.state(id), g.proposalVotes(id)]);
    return { id, description: l.args[8], state: Number(st), against: votes[0], for: votes[1], abstain: votes[2] };
  }));
  proposals.reverse();
}
async function paintProposals() {
  if (!proposals.length) { $("#props").innerHTML = '<p class="empty">No proposals yet. Holders with at least 100 shares and voting power turned on can propose changes.</p>'; return; }
  const g = account ? new ethers.Contract(CFG.governor, GOV_ABI, provider) : null;
  const voted = g ? await Promise.all(proposals.map((p) => g.hasVoted(p.id, account))) : proposals.map(() => false);
  $("#props").innerHTML = proposals.map((p, i) => {
    const total = p.for + p.against + p.abstain, forPct = total > 0n ? Number(p.for * 10000n / total) / 100 : 0;
    const canVote = p.state === 1 && account && !voted[i];
    return `<div class="prop"><b>${esc(p.description.split("\n")[0].slice(0, 140))}</b><span class="mono" style="font-size:.8rem">${STATES[p.state]} · ${fmt(forPct, 1)}% for · ${fmt(Number(ethers.formatUnits(total, 18)), 0)} votes cast${voted[i] ? " · you voted" : ""}</span>
      <div class="votebar"><i style="width:${forPct}%"></i></div>
      ${canVote ? `<div class="inrow"><button class="btn small primary" type="button" data-vote="1" data-id="${p.id}">Vote for</button><button class="btn small" type="button" data-vote="0" data-id="${p.id}">Vote against</button><button class="btn small" type="button" data-vote="2" data-id="${p.id}">Abstain</button></div>` : ""}</div>`;
  }).join("");
}
$("#props").addEventListener("click", (e) => {
  const b = e.target.closest("[data-vote]"); if (!b) return;
  if (!signer) return connect();
  const g = new ethers.Contract(CFG.governor, GOV_ABI, signer);
  sendTx("Vote", () => g.castVote(BigInt(b.dataset.id), Number(b.dataset.vote)));
});

// ------------------------------------------------------------------ refresh loop and routing

async function refreshAll() {
  if (!deployed || !provider) { paintLive(); paintLogbook(); return; }
  feed = await readFeed();
  paintAgent();
  try {
    live = await readLive();
    limits = live.limits;
    simBook = [...live.market];
    if (!$("#trim").matches(":focus-within")) { plan = [...simBook]; paintLab(); }
  } catch (e) { console.warn("vault read failed", e); }
  try { book = await readLogbook(); } catch (e) { console.warn("logbook read failed", e); }
  try { await readProposals(); } catch (e) { console.warn("governor read failed", e); }
  paintLive(); paintLogbook(); paintClockRows();
  if (account) await refreshPosition(); else await paintProposals();
}
setInterval(() => { const s = 1800 - Math.floor(Date.now() / 1000) % 1800; $("#cCount").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }, 1000);

function go() {
  if (location.hash === "#console") history.replaceState(null, "", "/console");
  const isCon = location.pathname.replace(/\/+$/, "") === "/console";
  $("#home").hidden = isCon; $("#consoleView").hidden = !isCon;
  if (isCon) { scrollTo(0, 0); paintLive(); }
  else { if ($("#top").clientWidth !== W) { renderHero(); renderCta(); } if (location.hash.length > 1) { const el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); } }
}
addEventListener("hashchange", go);
let lastW = innerWidth, rt;
addEventListener("resize", () => { drawIndex(); if (innerWidth === lastW) return; lastW = innerWidth; clearTimeout(rt); rt = setTimeout(() => { renderHero(); renderCta(); }, 160); });

const vl = $("#vaultLink"); if (vl) { if (deployed) vl.href = `${CFG.explorer}/address/${CFG.vault}`; else vl.textContent = "Vault contract (not deployed yet)"; }
paintLab(); renderHero(); renderCta(); go(); onScroll(); paintLive(); paintLogbook();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { renderHero(); renderCta(); drawIndex(); });
requestAnimationFrame(loop);
(async () => {
  provider = deployed ? await pickRpc() : null;
  if (deployed && !provider) { status("Could not reach a Robinhood Chain RPC. Retrying shortly.", "bad"); }
  await refreshAll();
  setInterval(refreshAll, 20000);
})();
