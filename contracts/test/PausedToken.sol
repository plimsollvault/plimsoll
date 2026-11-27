// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test helper only. Its runtime code is copied over a stock token's proxy on a fork to mimic the
/// issuer pausing transfers: `transfer` reverts, every other call runs the real implementation
/// against the token's untouched storage.
contract PausedToken {
    address public immutable impl;

    constructor(address impl_) {
        impl = impl_;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("token paused");
    }

    fallback() external payable {
        address target = impl;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
