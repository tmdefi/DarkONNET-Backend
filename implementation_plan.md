# Implementation Plan: DarkONNET Confidential Prediction Market (v2)

This document outlines the architecture for a privacy-preserving prediction market using Zama's FHEVM, now including **Token Wrapping** for end-to-end confidentiality.

## 1. Overview
The dApp enables users to bet on outcomes without revealing their bet amounts or individual positions. To achieve this, the system uses **Encrypted ERC-20 (eERC20)** tokens instead of standard public tokens.

## 2. The Wrapping Process
Before betting, users must move their funds from the public realm to the private realm:
1.  **Deposit**: User sends standard Sepolia ETH or ERC-20 to a `Wrapper` contract.
2.  **Mint**: The `Wrapper` contract mints an equivalent amount of `eERC20` tokens to the user's encrypted balance (`euint32`).
3.  **Confidentiality**: Once wrapped, the user's balance and any subsequent transfers are fully encrypted.

## 3. Smart Contract Architecture (`ConfidentialPredictionMarket.sol`)

### State Variables
- `euint32 private totalBetsOutcomeA`: Encrypted total for Outcome A.
- `euint32 private totalBetsOutcomeB`: Encrypted total for Outcome B.
- `mapping(address => euint32) private userBetsOutcomeA`: Encrypted individual positions.
- `mapping(address => euint32) private userBetsOutcomeB`: Encrypted individual positions.
- `IERC20 public publicToken`: The token used for payouts (e.g., WETH).
- `IEncryptedERC20 public encryptedToken`: The wrapper token used for betting.

### Core Functions

#### A. Betting (`bet`)
- **Encrypted Transfer**: User calls `encryptedToken.transferFrom(msg.sender, address(this), encryptedValue)`.
- **Logic**: The contract adds the `encryptedValue` to the chosen outcome's total and the user's mapping.
- **Privacy**: The transaction on the block explorer shows a transfer occurred, but the **amount is hidden**.

#### B. Settlement (`settle`)
- **Action**: Owner sets the `winningOutcome` (0 or 1).
- **Public Reveal**: Market is marked as settled. Aggregate totals remain encrypted until requested.

#### C. Claiming (Pattern A - Two Phases)
1.  **`requestClaim()`**: 
    - Contract calculates `numerator = userBet * totalPool` and identifies `denominator = totalWinningBets`.
    - Both handles are marked as `publiclyDecryptable`.
2.  **`fulfillClaim()`**:
    - User provides the KMS decryption proof.
    - Contract verifies signatures and decodes cleartexts.
    - Contract calculates `payout = decodedNumerator / decodedDenominator`.
    - **Unwrapping**: The contract sends the payout to the user in the `publicToken`.

## 4. Technical Considerations
- **Overflow Prevention**: Use `euint64` for the numerator ($Bet \times Pool$) to prevent math errors.
- **Gas Optimization**: Public decryption is asynchronous; users must be aware of the two-step claim process.
- **Network**: Deploy only on **fhEVM Sepolia** testnet.

## 5. Implementation Roadmap
1. [x] **Environment Setup**: Foundry remappings and Zama library integration.
2. [x] **Core Contract**: Basic FHEVM arithmetic and state management.
3. [x] **Settlement Logic**: Implementation of Pattern A (Numerator/Denominator).
4. [ ] **Token Integration**: Linking the `IEncryptedERC20` interface for real transfers.
5. [ ] **Frontend (fhevmjs)**: Implementing the wrapping UI and KMS proof fetching.
