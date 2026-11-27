// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey, SwapParams, IPoolManager, IUnlockCallback, IStateView, IUniswapV3Pool} from "./interfaces/Uniswap.sol";

/// @title Plimsoll vault
/// @notice Holders deposit USDG and receive shares. An agent may rebalance between whitelisted
///         tokenized stocks and USDG, but only through plans that it commits to first and that pass
///         the mandate checks below. The agent key has no function that moves assets out of the vault.
/// @dev    Manipulation resistance:
///         - deposits value holdings at max(spot, reference) so a depositor can never buy shares cheap;
///         - redemptions pay out in kind, pro rata, with no price involved;
///         - trades go straight to whitelisted pools, outputs always land in this contract, and each
///           trade carries a minimum output derived from the reference price.
contract PlimsollVault is ERC20, ERC20Votes, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    enum Venue {
        V3,
        V4
    }

    struct AssetConfig {
        address token;
        Venue venue;
        address v3Pool; // V3 only
        PoolKey key; // V4 only
    }

    struct Asset {
        address token;
        Venue venue;
        address v3Pool;
        PoolKey key;
        bytes32 poolId;
        bool usdgIs0;
        uint24 feePips; // pool LP fee, millionths
    }

    struct Limits {
        uint16 maxWeightBps; // per stock
        uint16 minWeightBps; // a held stock must be at least this, or zero
        uint16 maxTurnoverBps; // of NAV, per epoch
        uint16 maxSlippageBps; // per trade, against the reference price
        uint16 maxDeviationBps; // spot may differ from reference by at most this when trading
        uint16 brakeDrawdownBps; // share-price drop that trips the storm brake
        uint8 brakeWindow; // number of past epochs the drop is measured over (1..8)
    }

    // ------------------------------------------------------------------ constants

    uint256 public constant EPOCH = 30 minutes;
    uint256 public constant REVEAL_DELAY = 4 minutes;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant MIN_TRADE = 1e6; // 1 USDG

    // ------------------------------------------------------------------ immutables and roles

    IERC20 public immutable usdg;
    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;

    address public governance; // TimelockController run by the holder vote
    address public guardian; // can only pause
    address public agent; // can only commit, execute and sync prices

    // ------------------------------------------------------------------ state

    Asset[] internal _assets;
    Limits public limits;
    uint256 public depositCap; // max NAV in USDG units accepted through deposits

    bool public depositsPaused;
    bool public tradingPaused;
    bool public brakeTripped;

    uint16[] internal _weights; // length assets + 1, last entry is cash
    uint256[] public refPrice; // USDG units per 1e18 token units
    mapping(uint256 => uint256) public refUpdatedEpoch;

    mapping(uint256 => bytes32) public commitOf;
    mapping(uint256 => uint64) public commitTime;
    mapping(uint256 => bytes32) public reasonHashOf;
    uint256 public lastExecutedEpoch;

    uint256[8] internal _navHistory; // share price, 1e18 = 1 USDG per share
    uint8 internal _navCount;
    uint8 internal _navIdx;

    mapping(address => mapping(address => uint256)) public owed; // in-kind payouts that could not be sent
    mapping(address => uint256) public totalOwed; // per token; reserved for its owners and excluded from the vault

    address private _activeV3Pool;
    bool private _inV4Swap;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed from, address indexed receiver, uint256 usdgIn, uint256 shares, uint256 navHigh);
    event Redeemed(address indexed owner, address indexed receiver, uint256 shares);
    event PayoutDeferred(address indexed receiver, address indexed token, uint256 amount);
    event Committed(uint256 indexed epoch, bytes32 commit);
    event Executed(uint256 indexed epoch, uint16[] weights, uint256 navBefore, uint256 navAfter, uint256 turnover, bytes32 reasonHash);
    event Traded(uint256 indexed epoch, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event ReasonRevealed(uint256 indexed epoch, string reason);
    event BrakeTripped(uint256 indexed epoch, uint256 sharePrice, uint256 peak);
    event RefPriceSynced(uint256 indexed index, uint256 price);
    event ConfigChanged(uint8 what); // 1 depositsPaused 2 tradingPaused 3 paused 4 agent 5 guardian 6 governance 7 limits 8 depositCap 9 asset 10 brake

    // ------------------------------------------------------------------ errors

    error NotAgent();
    error NotGovernance();
    error NotGuardian();
    error Paused();
    error BadConfig();
    error AlreadyCommitted();
    error CommitMismatch();
    error TooEarly();
    error AlreadyExecuted();
    error BadWeights(uint8 code);
    error TurnoverTooHigh();
    error PriceDeviation(uint256 index);
    error Slippage();
    error CapExceeded();
    error ZeroShares();
    error BadCaller();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ------------------------------------------------------------------ setup

    constructor(
        IERC20 usdg_,
        IPoolManager poolManager_,
        IStateView stateView_,
        AssetConfig[] memory assets_,
        Limits memory limits_,
        uint256 depositCap_,
        address governance_,
        address guardian_,
        address agent_
    ) ERC20("Plimsoll Vault Share", "PLIM") EIP712("Plimsoll Vault Share", "1") {
        usdg = usdg_;
        poolManager = poolManager_;
        stateView = stateView_;
        governance = governance_;
        guardian = guardian_;
        agent = agent_;
        _checkLimits(limits_);
        limits = limits_;
        depositCap = depositCap_;
        for (uint256 i = 0; i < assets_.length; i++) {
            _addAsset(assets_[i]);
        }
        // start fully in cash
        for (uint256 i = 0; i < assets_.length; i++) _weights.push(0);
        _weights.push(uint16(BPS));
    }

    function _addAsset(AssetConfig memory c) internal {
        Asset memory a;
        a.token = c.token;
        a.venue = c.venue;
        if (c.venue == Venue.V3) {
            address t0 = IUniswapV3Pool(c.v3Pool).token0();
            address t1 = IUniswapV3Pool(c.v3Pool).token1();
            if (t0 == address(usdg) && t1 == c.token) a.usdgIs0 = true;
            else if (t1 == address(usdg) && t0 == c.token) a.usdgIs0 = false;
            else revert BadConfig();
            a.v3Pool = c.v3Pool;
            a.feePips = IUniswapV3Pool(c.v3Pool).fee();
        } else {
            // no hooks, no dynamic fee (flag 0x800000)
            if (c.key.hooks != address(0) || c.key.fee >= 0x800000) revert BadConfig();
            a.feePips = c.key.fee;
            if (c.key.currency0 == address(usdg) && c.key.currency1 == c.token) a.usdgIs0 = true;
            else if (c.key.currency1 == address(usdg) && c.key.currency0 == c.token) a.usdgIs0 = false;
            else revert BadConfig();
            a.key = c.key;
            a.poolId = keccak256(abi.encode(c.key));
        }
        _assets.push(a);
        uint256 p = _spot(_assets.length - 1);
        if (p == 0) revert BadConfig();
        refPrice.push(p);
    }

    function _checkLimits(Limits memory l) internal pure {
        if (
            l.maxWeightBps == 0 || l.maxWeightBps > BPS || l.minWeightBps > l.maxWeightBps
                || l.maxTurnoverBps == 0 || l.maxTurnoverBps > BPS || l.maxSlippageBps > 500
                || l.maxDeviationBps == 0 || l.maxDeviationBps > 2_000 || l.brakeDrawdownBps < 500
                || l.brakeDrawdownBps > 5_000 || l.brakeWindow == 0 || l.brakeWindow > 8
        ) revert BadConfig();
    }

    // ------------------------------------------------------------------ holders

    /// @notice Deposit USDG for shares. Holdings are valued at the higher of spot and reference price.
    function deposit(uint256 amount, uint256 minShares, address receiver) external nonReentrant returns (uint256 shares) {
        if (depositsPaused || brakeTripped) revert Paused();
        uint256 navH = _nav(true);
        if (navH + amount > depositCap) revert CapExceeded();
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = amount * 1e12; // 1 share per USDG at launch
        } else {
            if (navH == 0) revert ZeroShares();
            shares = Math.mulDiv(amount, supply, navH);
        }
        if (shares == 0 || shares < minShares) revert ZeroShares();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, amount, shares, navH);
    }

    /// @notice Burn shares and receive your pro-rata slice of every holding, in kind. Always open.
    function redeem(uint256 shares, address receiver) external nonReentrant {
        uint256 supply = totalSupply();
        if (shares == 0 || supply == 0) revert ZeroShares();
        _burn(msg.sender, shares);
        _payOut(address(usdg), Math.mulDiv(_held(address(usdg)), shares, supply), receiver);
        for (uint256 i = 0; i < _assets.length; i++) {
            address t = _assets[i].token;
            _payOut(t, Math.mulDiv(_held(t), shares, supply), receiver);
        }
        emit Redeemed(msg.sender, receiver, shares);
    }

    /// @notice Collect a payout that failed earlier, for example while a stock token was paused.
    function claimOwed(address token) external nonReentrant {
        uint256 amt = owed[msg.sender][token];
        if (amt == 0) return;
        owed[msg.sender][token] = 0;
        totalOwed[token] -= amt;
        IERC20(token).safeTransfer(msg.sender, amt);
    }

    /// @dev The part of a token balance that belongs to holders: the balance less deferred payouts.
    function _held(address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 o = totalOwed[token];
        return bal > o ? bal - o : 0;
    }

    function _payOut(address token, uint256 amount, address to) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            owed[to][token] += amount;
            totalOwed[token] += amount;
            emit PayoutDeferred(to, token, amount);
        }
    }

    // ------------------------------------------------------------------ agent

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH;
    }

    /// @notice Seal a plan before it can run. commit = keccak256(abi.encode(epoch, weights, reasonHash, nonce)).
    function commit(bytes32 commitHash) external onlyAgent {
        if (tradingPaused) revert Paused();
        uint256 e = currentEpoch();
        if (commitOf[e] != bytes32(0)) revert AlreadyCommitted();
        commitOf[e] = commitHash;
        commitTime[e] = uint64(block.timestamp);
        emit Committed(e, commitHash);
    }

    /// @notice Run the sealed plan. Every mandate check must pass or nothing moves.
    function execute(uint16[] calldata weights, bytes32 reasonHash, bytes32 nonce) external onlyAgent nonReentrant {
        if (tradingPaused) revert Paused();
        uint256 e = currentEpoch();
        if (lastExecutedEpoch == e) revert AlreadyExecuted();
        if (commitOf[e] != keccak256(abi.encode(e, weights, reasonHash, nonce))) revert CommitMismatch();
        if (block.timestamp < commitTime[e] + REVEAL_DELAY) revert TooEarly();
        lastExecutedEpoch = e;
        reasonHashOf[e] = reasonHash;

        uint256 n = _assets.length;
        _checkWeights(weights, n);

        Limits memory l = limits;
        uint256[] memory spot = new uint256[](n);
        uint256[] memory value = new uint256[](n);
        uint256 nav = _held(address(usdg));
        for (uint256 i = 0; i < n; i++) {
            spot[i] = _spot(i);
            uint256 r = refPrice[i];
            uint256 diff = spot[i] > r ? spot[i] - r : r - spot[i];
            if (diff * BPS > r * l.maxDeviationBps) revert PriceDeviation(i);
            value[i] = Math.mulDiv(_held(_assets[i].token), spot[i], 1e18);
            nav += value[i];
        }

        // storm brake: compare share price with the recent peak
        uint256 supply = totalSupply();
        if (supply > 0) {
            uint256 sharePrice = Math.mulDiv(nav, 1e30, supply); // 1e18 = 1 USDG per share
            uint256 peak = _recentPeak(l.brakeWindow);
            _pushNav(sharePrice);
            if (!brakeTripped && peak > 0 && sharePrice * BPS < peak * (BPS - l.brakeDrawdownBps)) {
                brakeTripped = true;
                emit BrakeTripped(e, sharePrice, peak);
            }
        }
        if (brakeTripped && weights[n] != BPS) revert BadWeights(5);

        // turnover across all legs, counted once
        uint256 moved;
        uint256[] memory target = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            target[i] = Math.mulDiv(nav, weights[i], BPS);
            moved += target[i] > value[i] ? target[i] - value[i] : value[i] - target[i];
        }
        uint256 cashNow = _held(address(usdg));
        uint256 cashTarget = Math.mulDiv(nav, weights[n], BPS);
        moved += cashTarget > cashNow ? cashTarget - cashNow : cashNow - cashTarget;
        uint256 turnover = moved / 2;
        if (nav > 0 && turnover * BPS > nav * l.maxTurnoverBps) {
            revert TurnoverTooHigh();
        }

        // sells first, then buys
        for (uint256 i = 0; i < n; i++) {
            if (value[i] > target[i] && value[i] - target[i] >= MIN_TRADE) {
                uint256 usdOut = value[i] - target[i];
                uint256 amountIn = Math.mulDiv(usdOut, 1e18, spot[i]);
                uint256 minOut = _minOut(Math.mulDiv(amountIn, refPrice[i], 1e18), i, l.maxSlippageBps);
                uint256 got = _swap(i, false, amountIn, minOut);
                emit Traded(e, _assets[i].token, address(usdg), amountIn, got);
            }
        }
        for (uint256 i = 0; i < n; i++) {
            if (target[i] > value[i] && target[i] - value[i] >= MIN_TRADE) {
                uint256 amountIn = target[i] - value[i];
                uint256 avail = _held(address(usdg));
                if (amountIn > avail) amountIn = avail;
                if (amountIn < MIN_TRADE) continue;
                uint256 minOut = _minOut(Math.mulDiv(amountIn, 1e18, refPrice[i]), i, l.maxSlippageBps);
                uint256 got = _swap(i, true, amountIn, minOut);
                emit Traded(e, address(usdg), _assets[i].token, amountIn, got);
            }
        }

        delete _weights;
        for (uint256 i = 0; i <= n; i++) _weights.push(weights[i]);
        for (uint256 i = 0; i < n; i++) {
            refPrice[i] = spot[i];
            refUpdatedEpoch[i] = e;
        }
        emit Executed(e, weights, nav, _nav(false), turnover, reasonHash);
    }

    /// @notice Publish the reasoning behind an executed plan, from the next epoch on. Anyone may call.
    function revealReason(uint256 epoch, string calldata reason) external {
        if (currentEpoch() <= epoch) revert TooEarly();
        if (reasonHashOf[epoch] == bytes32(0) || keccak256(bytes(reason)) != reasonHashOf[epoch]) revert CommitMismatch();
        emit ReasonRevealed(epoch, reason);
    }

    /// @notice Walk a reference price toward spot, at most maxDeviationBps per epoch. Anyone may call.
    function syncRefPrice(uint256 i) external {
        uint256 e = currentEpoch();
        if (refUpdatedEpoch[i] == e) return;
        refUpdatedEpoch[i] = e;
        uint256 s = _spot(i);
        uint256 r = refPrice[i];
        uint256 step = Math.mulDiv(r, limits.maxDeviationBps, BPS);
        uint256 next = s > r ? Math.min(s, r + step) : Math.max(s, r - step);
        refPrice[i] = next;
        emit RefPriceSynced(i, next);
    }

    /// @dev Expected output at the reference price, less the pool fee, less the slippage allowance.
    function _minOut(uint256 atRef, uint256 i, uint256 slipBps) internal view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(atRef, 1e6 - _assets[i].feePips, 1e6), BPS - slipBps, BPS);
    }

    function _checkWeights(uint16[] calldata w, uint256 n) internal view {
        if (w.length != n + 1) revert BadWeights(1);
        uint256 sum;
        Limits memory l = limits;
        for (uint256 i = 0; i < n; i++) {
            if (w[i] != 0 && w[i] < l.minWeightBps) revert BadWeights(2);
            if (w[i] > l.maxWeightBps) revert BadWeights(3);
            sum += w[i];
        }
        sum += w[n];
        if (sum != BPS) revert BadWeights(4);
    }

    function _recentPeak(uint8 window) internal view returns (uint256 peak) {
        uint256 count = _navCount < window ? _navCount : window;
        for (uint256 k = 0; k < count; k++) {
            uint256 idx = (uint256(_navIdx) + 8 - 1 - k) % 8;
            if (_navHistory[idx] > peak) peak = _navHistory[idx];
        }
    }

    function _pushNav(uint256 sharePrice) internal {
        _navHistory[_navIdx] = sharePrice;
        _navIdx = uint8((uint256(_navIdx) + 1) % 8);
        if (_navCount < 8) _navCount++;
    }

    // ------------------------------------------------------------------ swaps

    function _swap(uint256 i, bool buy, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        Asset storage a = _assets[i];
        // buying the stock means paying USDG; zeroForOne when USDG is currency0
        bool zeroForOne = buy ? a.usdgIs0 : !a.usdgIs0;
        address tokenIn = buy ? address(usdg) : a.token;
        if (a.venue == Venue.V3) {
            _activeV3Pool = a.v3Pool;
            (int256 d0, int256 d1) = IUniswapV3Pool(a.v3Pool).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1,
                abi.encode(tokenIn)
            );
            _activeV3Pool = address(0);
            out = uint256(-(zeroForOne ? d1 : d0));
        } else {
            _inV4Swap = true;
            bytes memory ret = poolManager.unlock(abi.encode(a.key, zeroForOne, amountIn));
            _inV4Swap = false;
            out = abi.decode(ret, (uint256));
        }
        if (out < minOut) revert Slippage();
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _activeV3Pool || _activeV3Pool == address(0)) revert BadCaller();
        address tokenIn = abi.decode(data, (address));
        uint256 pay = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, pay);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_inV4Swap) revert BadCaller();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        (address cIn, address cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 pay = uint256(uint128(-(zeroForOne ? a0 : a1)));
        uint256 got = uint256(uint128(zeroForOne ? a1 : a0));
        poolManager.sync(cIn);
        IERC20(cIn).safeTransfer(address(poolManager), pay);
        poolManager.settle();
        poolManager.take(cOut, address(this), got);
        return abi.encode(got);
    }

    // ------------------------------------------------------------------ pricing

    /// @return USDG units for 1e18 units of asset i, from the pool's current price
    function _spot(uint256 i) internal view returns (uint256) {
        Asset storage a = _assets[i];
        uint160 sqrtP;
        if (a.venue == Venue.V3) (sqrtP,,,,,,) = IUniswapV3Pool(a.v3Pool).slot0();
        else (sqrtP,,,) = stateView.getSlot0(a.poolId);
        if (sqrtP == 0) return 0;
        if (a.usdgIs0) return Math.mulDiv(Math.mulDiv(1e18, Q96, sqrtP), Q96, sqrtP);
        return Math.mulDiv(Math.mulDiv(1e18, sqrtP, Q96), sqrtP, Q96);
    }

    function _nav(bool high) internal view returns (uint256 nav) {
        nav = _held(address(usdg));
        for (uint256 i = 0; i < _assets.length; i++) {
            uint256 bal = _held(_assets[i].token);
            if (bal == 0) continue;
            uint256 p = _spot(i);
            if (high && refPrice[i] > p) p = refPrice[i];
            nav += Math.mulDiv(bal, p, 1e18);
        }
    }

    // ------------------------------------------------------------------ views for the console and agent

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    function assetAt(uint256 i) external view returns (Asset memory) {
        return _assets[i];
    }

    function weights() external view returns (uint16[] memory) {
        return _weights;
    }

    function navSpot() external view returns (uint256) {
        return _nav(false);
    }

    /// @notice USDG units for 1e18 units of asset i at the pool's current price.
    function spotPrice(uint256 i) external view returns (uint256) {
        return _spot(i);
    }


    // ------------------------------------------------------------------ guardian and governance

    function pauseDeposits() external {
        if (msg.sender != guardian && msg.sender != governance) revert NotGuardian();
        depositsPaused = true;
        emit ConfigChanged(1);
    }

    function pauseTrading() external {
        if (msg.sender != guardian && msg.sender != governance) revert NotGuardian();
        tradingPaused = true;
        emit ConfigChanged(2);
    }

    function setPaused(bool deposits_, bool trading_) external onlyGovernance {
        depositsPaused = deposits_;
        tradingPaused = trading_;
        emit ConfigChanged(3);
    }

    function setAgent(address a) external onlyGovernance {
        agent = a;
        emit ConfigChanged(4);
    }

    function setGuardian(address g) external onlyGovernance {
        guardian = g;
        emit ConfigChanged(5);
    }

    function setGovernance(address g) external onlyGovernance {
        if (g == address(0)) revert BadConfig();
        governance = g;
        emit ConfigChanged(6);
    }

    function setLimits(Limits calldata l) external onlyGovernance {
        _checkLimits(l);
        limits = l;
        emit ConfigChanged(7);
    }

    function setDepositCap(uint256 cap) external onlyGovernance {
        depositCap = cap;
        emit ConfigChanged(8);
    }

    function resetBrake() external onlyGovernance {
        brakeTripped = false;
        delete _navHistory;
        _navCount = 0;
        _navIdx = 0;
        emit ConfigChanged(10);
    }

    // ------------------------------------------------------------------ votes plumbing (timestamp clock)

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

}
