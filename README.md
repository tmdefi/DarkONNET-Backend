<<<<<<< HEAD
# DarkONNET-Backend
=======
# DarkONNET: Confidential Multi-Market Prediction Platform

**DarkONNET** is a privacy-preserving, automated prediction market built on the **Zama fhEVM Sepolia Testnet**. It leverages Fully Homomorphic Encryption (FHE) to keep user positions and market totals confidential while maintaining trustless, automated settlement.

---

## Current Status

- Smart contracts, faucet, deployment script, and oracle workers are implemented.
- Contract tests cover market admin actions, faucet minting/cooldown, encrypted betting, settlement claims, cancellation refunds, and two-phase early exits.
- Off-chain threaded market comments and real-time wallet notifications are available through the comments backend.
- The Next.js frontend application is built and integrated. It supports user wallet connection, market exploration, confidential betting via FHE, creator market requests, and a secure admin panel for creator market approval or resolving unresolved markets if there is any error.
- Token wrapping is planned but not implemented; current test liquidity comes from the confidential cUSDT faucet.
- Relayers read `INFURA_API_KEY` and `CONTRACT_ADDRESS` from `.env`.

---

## 🛡️ The FHE Advantage
Traditional prediction markets (like Polymarket) are fully transparent. This leads to several issues:
- **Copy-Trading**: Large bettors can be tracked and copied.
- **Market Manipulation**: Visible pool totals allow whales to "swing" odds to their advantage.
- **Privacy Leakage**: A user's financial convictions are public knowledge.

**DarkONNET solves this** by using Zama's `fhevm`:
- **Encrypted Bets**: User bet amounts are stored as `euint64`.
- **Private Liquidity**: Total pool sizes are never revealed in plaintext until settlement.
- **Confidential Payouts**: Uses the **Asynchronous Gateway Pattern** to verify winnings and distribute payouts without ever exposing the math in the clear.

---

## 🤖 The Oracle Ecosystem
Foundr features a fully autonomous relayer suite that bridges real-world data into the FHE environment across **7 categories**:

| Category | Data Provider | Logic |
| :--- | :--- | :--- |
| **Esports** | PandaScore API | Automatic match creation and winner settlement. |
| **Sports** | API-Sports | Covers Football (Premier League), NFL, and Formula 1. |
| **Politics** | NewsAPI (Reuters/AP) | Headlines-based settlement with consensus logic. |
| **Tech** | NewsAPI (TechCrunch/Verge) | Tracks product launches and tech milestones. |
| **Crypto** | CoinGecko API | Price-threshold markets (e.g., "BTC > $70k"). |
| **Finance** | NewsAPI (WSJ/Bloomberg) | Economic indicators and interest rate decisions. |
| **Culture** | NewsAPI (Variety) | Entertainment awards and cultural events. |

---

## 🏗️ Architecture

1.  **Smart Contracts (`src/`)**: 
    - `ConfidentialPredictionMarket.sol`: The core engine handling categorized markets and encrypted state.
    - `EncryptedERC20.sol`: A custom cUSDT stablecoin.
    - `ConfidentialUSDTFaucet.sol`: A rate-limited faucet for test liquidity.
2.  **Relayers (`relayer/`)**: 5 Node.js scripts that poll global APIs and trigger `createMarket` and `settle` functions on-chain.
3.  **Comments Backend (`backend/comments/`)**: Stores off-chain, wallet-linked market commentary, threaded replies, market metadata, and real-time notifications.
4.  **Coprocessor**: Utilizes Zama's KMS and Gateway for secure decryption of payout ratios.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Foundry](https://getfoundry.sh/)
- Node.js (v18+)
- Zama fhEVM Environment

### 2. Environment Setup
Create a `.env` file with the following:
```text
PRIVATE_KEY=your_wallet_private_key
INFURA_API_KEY=your_infura_api_key
ESPORTS_API_KEY=your_pandascore_key
NEWS_API_KEY=your_newsapi_key
SPORTS_API_KEY=your_apisports_key
CONTRACT_ADDRESS=0xYourDeployedPredictionMarketAddress
COMMENTS_PORT=8787
COMMENTS_DB_PATH=data/comments.json
API_AUTH_REQUIRED=true
API_ADMIN_WALLETS=0xYourAdminWallet
```

### 3. Automated Deployment
Deploy the entire ecosystem (Token, Faucet, Market) with one command:
```powershell
./deploy.ps1
```

### 4. Activate the Oracles
Run your preferred oracle to start populating the market:
```powershell
npm run oracle:crypto
```

### 5. Run Market Comments API
Start the off-chain threaded comments backend:
```powershell
npm run comments:dev
```

The comments API supports:
- `GET /api/markets/:marketId/comments`
- `POST /api/markets/:marketId/comments`
- `GET /api/markets`
- `GET /api/markets/:marketId`
- `PUT /api/markets/:marketId`
- `POST /api/markets/:marketId/participants`
- `GET /api/wallets/:walletAddress/notifications`
- `PATCH /api/wallets/:walletAddress/notifications/:notificationId`
- `POST /api/wallets/:walletAddress/notifications`
- `GET /api/wallets/:walletAddress/profile`
- `PUT /api/wallets/:walletAddress/profile`
- `WS /ws/notifications?walletAddress=:walletAddress`

Mutating routes and wallet notification feeds require signed wallet authentication when `API_AUTH_REQUIRED` is not set to `false`.
Clients sign this message shape with their wallet:

```text
DarkONNET API request
Wallet: 0x...
Method: POST
Path: /api/markets/123/comments
Timestamp: 1770000000000
BodyHash: 0x...
```

Creator submissions must be signed by `creatorWalletAddress`. Comment, participant, profile, and notification actions must be signed by the target wallet. Admin/oracle metadata writes, market acceptance, decline, and resolution must be signed by a wallet listed in `API_ADMIN_WALLETS`.

Create a comment or reply with:
```json
{
  "walletAddress": "0x1111111111111111111111111111111111111111",
  "displayName": "Alice",
  "body": "This market is heating up.",
  "parentId": "optional-existing-comment-id"
}
```

Market metadata is written by the relayers after on-chain market creation. The frontend can use it for market cards:
```json
{
  "marketId": "123",
  "onchainMarketId": "123",
  "slug": "arsenal-vs-chelsea",
  "category": "Sports - Football",
  "title": "Arsenal vs Chelsea",
  "homeLogoUrl": "https://media.api-sports.io/football/teams/42.png",
  "awayLogoUrl": "https://media.api-sports.io/football/teams/49.png",
  "imageUrl": "https://example.com/article-or-league-image.png",
  "creatorWalletAddress": "0x1111111111111111111111111111111111111111",
  "status": "pending"
}
```

Notifications are stored by wallet address and pushed live to connected clients. Connect with:
```text
ws://localhost:8787/ws/notifications?walletAddress=0x1111111111111111111111111111111111111111
```

The server creates notifications when:
- someone replies to a user's comment;
- a creator's market transitions to `status: "accepted"`;
- a market transitions to `status: "resolved"` for wallets registered through `POST /api/markets/:marketId/participants`.

Live notification messages are JSON:
```json
{
  "type": "notification.created",
  "notification": {
    "type": "market.resolved",
    "marketId": "123",
    "title": "Market resolved",
    "body": "A market you participated in was resolved: Arsenal vs Chelsea"
  }
}
```

---

## 📜 Contract Addresses (Latest Sepolia)
- **Prediction Market**: `0x0dbeA55D54647759dC7eA6523d005B3c9C173730`
- **cUSDT Token**: `0x3f14f7f11131E4698ED5Ad6A03C3EF1924cF3F0d`
- **Faucet**: `0xd978f57d7fD0fAb73a99D7D68c962386F25E1D00`

---

## ⚖️ License
MIT - Built for the Zama dApp Demo Challenge.
>>>>>>> c42f364 (initial commit: DarkONNET backend, oracles, and smart contracts)
