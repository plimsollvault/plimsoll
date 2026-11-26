// Copies the deployed addresses into web/config.js.
//   node scripts/sync-web-config.js [robinhood|localhost]
const fs = require("fs");
const path = require("path");
const name = process.argv[2] || "robinhood";
const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${name}.json`), "utf8"));
const file = path.join(__dirname, "..", "web", "config.js");
let s = fs.readFileSync(file, "utf8");
s = s.replace(/vault: [^,]+,/, `vault: "${dep.vault}",`)
  .replace(/governor: [^,]+,/, `governor: "${dep.governor}",`)
  .replace(/deployBlock: [^,]+,/, `deployBlock: ${dep.deployBlock},`);
if (name === "localhost") s = s.replace(/rpcs: \[[\s\S]*?\],/, 'rpcs: ["http://127.0.0.1:8545"],');
fs.writeFileSync(file, s);
console.log(`web/config.js now points at ${dep.vault} (${name})`);
