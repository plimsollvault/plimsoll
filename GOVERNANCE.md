# Holder votes

PLIM vault shares are votes. Every change to the vault's settings goes through the governor and a 72-hour timelock.

| Setting | Value |
|---|---|
| Voting power | PLIM shares you have delegated, usually to yourself |
| Proposal threshold | 100 shares of voting power |
| Voting delay | 1 hour |
| Voting period | 3 days |
| Quorum | 10% of all shares |
| Timelock | 72 hours |

## 1. Turn on voting power

Shares only count once delegated. In the console, choose **Turn on voting power**, or call `delegate(yourAddress)` on the vault.

## 2. Propose

```bash
PROPOSER_KEY=0x... ACTION=setDepositCap VALUE=25000 \
DESCRIPTION="Raise the deposit cap to 25,000 USDG" \
npx hardhat run scripts/propose.js --network robinhood
```

Add `DRY_RUN=1` to see the encoded call first. Available actions are listed at the top of [`scripts/propose.js`](scripts/propose.js): `setDepositCap`, `setAgent`, `setGuardian`, `setPaused`, `resetBrake`, and `setLimits`.

The vault rejects limits outside safe bounds: weight cap up to 100%, slippage up to 5%, price deviation up to 20%, brake between 5% and 50%, brake window 1 to 8 watches.

## 3. Vote

Open proposals appear in the console under **Holder votes**, with buttons to vote for, against, or abstain.

## 4. Queue and execute

When voting ends with a majority for and quorum met, anyone can queue the proposal on the governor with `queue(targets, values, calldatas, descriptionHash)`. After 72 hours anyone can call `execute` with the same arguments. `descriptionHash` is `keccak256` of the exact description text.

## What votes cannot do

Votes cannot move holders' funds, add new assets, or give the agent a withdrawal function. The asset list is fixed in the vault contract. Changing it means deploying a new vault.
