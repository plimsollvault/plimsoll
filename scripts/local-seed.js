// Local fork only: gives a test wallet USDG and deposits it, so the agent has something to manage.
//   npx hardhat run scripts/local-seed.js --network localhost
const { ethers, network } = require("hardhat");
const cfg = require("../config/robinhood");
const dep = require("../deployments/localhost.json");

async function main() {
  if (network.name !== "localhost") throw new Error("local-seed only runs against the local fork");
  const [, , user] = await ethers.getSigners();
  const whale = cfg.uniswap.poolManager;
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [whale] });
  await network.provider.send("hardhat_setBalance", [whale, "0x56BC75E2D63100000"]);
  const usdg = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", cfg.usdg);
  const amt = 5_000n * 10n ** 6n;
  await (await usdg.connect(await ethers.getSigner(whale)).transfer(user.address, amt)).wait();
  const vault = await ethers.getContractAt("PlimsollVault", dep.vault);
  await (await usdg.connect(user).approve(dep.vault, amt)).wait();
  await (await vault.connect(user).deposit(amt, 0, user.address)).wait();
  console.log(`Deposited 5000 USDG from ${user.address}; shares ${ethers.formatUnits(await vault.balanceOf(user.address), 18)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
