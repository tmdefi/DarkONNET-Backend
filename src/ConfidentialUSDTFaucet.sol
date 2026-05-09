// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EncryptedERC20.sol";

import "fhevm/FHE.sol";
import {CoprocessorSetup} from "./CoprocessorSetup.sol";

/**
 * @title ConfidentialUSDTFaucet
 * @notice A simple faucet that mints confidential USDT to users for testing.
 */
contract ConfidentialUSDTFaucet {
    EncryptedERC20 public cUSDT;
    uint64 public constant FAUCET_AMOUNT = 1000 * 10 ** 6; // 1,000 cUSDT (6 decimals)
    uint256 public constant COOLDOWN_TIME = 24 hours;

    mapping(address => uint256) public nextRequestAt;

    event TokensRequested(address indexed user, uint64 amount);

    constructor(address _cUSDTAddress) {
        FHE.setCoprocessor(CoprocessorSetup.defaultConfig());
        cUSDT = EncryptedERC20(_cUSDTAddress);
    }

    /**
     * @notice Accepts ownership of the cUSDT token after a two-step transfer.
     * @dev The deployer must call transferOwnership(address(this)) on cUSDT first.
     */
    function acceptTokenOwnership() public {
        cUSDT.acceptOwnership();
    }

    /**
     * @notice Requests a fixed amount of cUSDT tokens.
     */
    function requestTokens() public {
        require(block.timestamp >= nextRequestAt[msg.sender], "Faucet: Please wait 24 hours between requests");

        // Set cooldown
        nextRequestAt[msg.sender] = block.timestamp + COOLDOWN_TIME;

        // Mint tokens to the faucet contract
        cUSDT.mint(FAUCET_AMOUNT);

        // Transfer the minted tokens as an ENCRYPTED amount to the user
        euint64 amount = FHE.asEuint64(FAUCET_AMOUNT);
        FHE.allow(amount, address(cUSDT));
        cUSDT.transfer(msg.sender, amount);

        emit TokensRequested(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Returns the time remaining until the user can request tokens again.
     */
    function getTimeUntilNextRequest(address user) public view returns (uint256) {
        if (block.timestamp >= nextRequestAt[user]) {
            return 0;
        }
        return nextRequestAt[user] - block.timestamp;
    }
}
