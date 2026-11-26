// Site configuration. After `npm run deploy`, copy vault, governor and deployBlock from
// deployments/robinhood.json into the fields below (scripts/sync-web-config.js does it for you).
export default {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorer: "https://robinhoodchain.blockscout.com",
  // Tried in order. Nodeflare serves event logs from the browser; PublicNode refuses log queries
  // without a paid token, and the official endpoint served an expired TLS certificate on 2026-11-24.
  rpcs: [
    "https://rpc.nodeflare.app/robinhood/public",
    "https://rpc.mainnet.chain.robinhood.com",
    "https://4663.rpc.thirdweb.com",
    "https://robinhood-rpc.publicnode.com",
  ],
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  vault: "0x400AdDF7026e821028BEC03B2b42f2e4F98B3a22",
  governor: "0xE7d5602c061263De60b4Db20745c98538844F4f3",
  deployBlock: 123394765,
  assets: [
    { symbol: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
    { symbol: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
    { symbol: "MSFT", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
    { symbol: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
    { symbol: "AMZN", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
    { symbol: "GOOGL", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
    { symbol: "META", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },
    { symbol: "COIN", token: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b" },
  ],
  // Launch limits, shown until the vault is live and can be read directly.
  limits: { maxWeightBps: 2500, minWeightBps: 500, maxTurnoverBps: 800, maxSlippageBps: 100, maxDeviationBps: 500, brakeDrawdownBps: 2000, brakeWindow: 8 },
};
