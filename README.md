# Plimsoll

A shared vault of tokenized US stocks on Robinhood Chain. Holders deposit USDG and receive PLIM shares. An AI agent (Claude) sets the mix of eight stock tokens and USDG cash every 30 minutes, and the vault contract holds every plan to fixed limits. The agent's key can propose and trade within the mandate, but it has no function that moves funds out.

- Website: [plimsollvault.com](https://plimsollvault.com)
- Docs: [plimsollvault.com/docs](https://plimsollvault.com/docs)
- X: [@plimsollvault](https://x.com/plimsollvault)

> The contracts have not been reviewed by an independent auditor. Deposits are capped at 10,000 USDG.

## Deployed contracts (Robinhood Chain, chain ID 4663)

| Contract | Address |
|---|---|
| Vault (PLIM) | [`0x400AdDF7026e821028BEC03B2b42f2e4F98B3a22`](https://robinhoodchain.blockscout.com/address/0x400AdDF7026e821028BEC03B2b42f2e4F98B3a22) |
| Governor | [`0xE7d5602c061263De60b4Db20745c98538844F4f3`](https://robinhoodchain.blockscout.com/address/0xE7d5602c061263De60b4Db20745c98538844F4f3) |
| Timelock (72h) | [`0xD9B4342f47b0F4031D8aFdDD262cd338D596841A`](https://robinhoodchain.blockscout.com/address/0xD9B4342f47b0F4031D8aFdDD262cd338D596841A) |

Token and pool addresses are in [`config/robinhood.js`](config/robinhood.js). Each was read back from the chain before use, because Robinhood Chain has many look-alike tokens.

## How it works

1. **Deposit.** USDG in, shares out. Holdings are valued at the higher of the pool price and a slow-moving reference price, so pushing a pool down never buys cheap shares.
2. **Seal.** Once per 30-minute watch, the agent asks Claude for target weights, checks them locally, and commits only `keccak256(epoch, weights, reasonHash, nonce)`.
3. **Execute.** At least 4 minutes later it reveals the weights. The vault rechecks the hash and the mandate, then trades directly against whitelisted Uniswap v3 and v4 pools. Outputs always land in the vault, and any failed check or trade reverts the whole plan.
4. **Reveal.** In the next watch the written reasoning is published on chain and must match the hash.
5. **Redeem.** Burn shares for a pro-rata slice of every holding, in kind. No price is involved, and redemptions stay open while deposits or trading are paused.

### The mandate (launch values)

| Rule | Limit |
|---|---|
| Weight per stock | 0%, or 5% to 25% |
| Turnover | 8% of vault value per watch |
| Slippage | 1% beyond the pool fee |
| Price check | no trading if a pool is more than 5% from its reference price |
| Storm brake | 20% share-price drop over 8 watches: cash only, deposits stop |
| Deposit cap | 10,000 USDG |

Limits, the cap, the agent, the guardian and pauses change only through a holder vote and the timelock. See [GOVERNANCE.md](GOVERNANCE.md).

## Repository

| Path | What it is |
|---|---|
| `contracts/PlimsollVault.sol` | Vault, shares, mandate checks, commit-reveal, storm brake, Uniswap v3/v4 swaps |
| `contracts/PlimsollGovernor.sol` | OpenZeppelin Governor with timestamp votes and a timelock |
| `test/vault.fork.test.js` | Tests against a local fork of Robinhood Chain mainnet |
| `agent/agent.mjs` | The agent: one Claude call per watch, local mandate checks, commit, execute, reveal |
| `web/` | The static website and console (ethers + browser wallet) |
| `scripts/` | Deploy, preflight, post-deploy verification, proposals, page builder |
| `deploy/` | Nginx and systemd files for a VPS |

## Running it

```bash
npm install
npx hardhat compile
ROBINHOOD_RPC=https://rpc.nodeflare.app/robinhood/public npx hardhat test
```

The fork tests need an RPC that serves historical state; Nodeflare does.

### Agent

```bash
cp .env.example .env    # fill AGENT_KEY, VAULT_ADDRESS, ANTHROPIC_API_KEY
DRY_RUN=1 ONCE=1 node agent/agent.mjs   # print one plan, send nothing
node agent/agent.mjs                    # run continuously
```

The agent keeps sealed plans in `agent/state/` so it can execute them after a restart. It skips watches while the vault is empty. Claude is called with structured output and the server-side refusal fallback enabled.

### Website

```bash
npx serve web
```

`web/config.js` holds the chain, RPC list and contract addresses. `scripts/sync-web-config.js` copies them from a deployment file.

### Deploying your own vault

```bash
npx hardhat run scripts/preflight.js --network robinhood   # checks only, sends nothing
npx hardhat run scripts/deploy.js --network robinhood
npx hardhat run scripts/verify-deploy.js --network robinhood
```

See `.env.example` for the variables. The deployer keeps no power after deployment.

## Risks

Stock prices can fall. The contracts are unreviewed by an independent auditor. Robinhood can pause its stock tokens or block addresses. Pools can run thin. The agent can make poor calls within its limits. Tokenized stocks may be restricted where you live. Nothing here is investment advice.
