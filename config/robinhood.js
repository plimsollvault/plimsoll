// Robinhood Chain mainnet (chain id 4663). Every address below was read back from the chain on
// 2026-11-24: token contracts via Blockscout, pool tokens/fees via eth_call on the pools and the
// Uniswap v4 PositionManager. Uniswap v4 core addresses come from Uniswap's deployments page.
module.exports = {
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // Global Dollar (Paxos), 6 decimals
  uniswap: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  },
  // venue 0 = Uniswap v3 pool, 1 = Uniswap v4 pool. All pairs are against USDG, no hooks.
  assets: [
    { symbol: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", venue: 1, fee: 3000, tickSpacing: 60 },
    { symbol: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", venue: 0, v3Pool: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" },
    { symbol: "MSFT", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", venue: 1, fee: 3000, tickSpacing: 60 },
    { symbol: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", venue: 0, v3Pool: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3" },
    { symbol: "AMZN", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", venue: 0, v3Pool: "0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef" },
    { symbol: "GOOGL", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", venue: 1, fee: 3000, tickSpacing: 60 },
    { symbol: "META", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", venue: 1, fee: 3000, tickSpacing: 60 },
    { symbol: "COIN", token: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", venue: 1, fee: 10000, tickSpacing: 200 },
  ],
  // Launch limits ("Coastal" trial). Governance can change them after a 72-hour timelock.
  limits: {
    maxWeightBps: 2500,
    minWeightBps: 500,
    maxTurnoverBps: 800,
    maxSlippageBps: 100,
    maxDeviationBps: 500,
    brakeDrawdownBps: 2000,
    brakeWindow: 8,
  },
};

const ZERO = "0x0000000000000000000000000000000000000000";

/** Build the AssetConfig[] tuple the vault constructor expects. */
module.exports.assetConfigs = function assetConfigs(cfg = module.exports) {
  const usdg = cfg.usdg.toLowerCase();
  return cfg.assets.map((a) => {
    const t = a.token.toLowerCase();
    const [c0, c1] = usdg < t ? [cfg.usdg, a.token] : [a.token, cfg.usdg];
    return {
      token: a.token,
      venue: a.venue,
      v3Pool: a.venue === 0 ? a.v3Pool : ZERO,
      key: a.venue === 1
        ? { currency0: c0, currency1: c1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: ZERO }
        : { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
    };
  });
};
