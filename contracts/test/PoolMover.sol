// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey, SwapParams, IPoolManager, IUnlockCallback} from "../interfaces/Uniswap.sol";

/// Test helper only: swaps a large amount through a v4 pool to move its price.
contract PoolMover is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function buy(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external {
        pm.unlock(abi.encode(key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool z, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        int256 d = pm.swap(key, SwapParams(z, -int256(amountIn), z ? 4295128740 : 1461446703485210103287273052203988822378723970341), "");
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        (address cin, address cout) = z ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        pm.sync(cin);
        IERC20(cin).transfer(address(pm), uint256(uint128(-(z ? a0 : a1))));
        pm.settle();
        pm.take(cout, address(this), uint256(uint128(z ? a1 : a0)));
        return "";
    }
}
