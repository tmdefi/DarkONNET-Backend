// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {CoprocessorConfig} from "fhevm/Impl.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title   CoprocessorSetup
 * @notice  This library returns all addresses for the ACL, FHEVMExecutor and KMSVerifier contracts.
 */
library CoprocessorSetup {
    /**
     * @notice This function returns a struct containing all contract addresses.
     * @dev    It returns an immutable struct.
     */
    function defaultConfig() internal view returns (CoprocessorConfig memory) {
        return ZamaConfig.getEthereumCoprocessorConfig();
    }
}
