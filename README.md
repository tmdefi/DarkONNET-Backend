# DarkONNET Backend

Backend API, oracle workers, Supabase metadata sync, and Foundry contracts for DarkONNET, a confidential prediction market on Zama fhEVM Sepolia.

DarkONNET keeps user position sizes, cUSDT balances, and pool totals encrypted with `euint64` while still allowing markets to be created, settled, claimed, refunded, and exited on-chain.

## Current Status

- Smart contracts, faucet, deployment scripts, and oracle workers are implemented.
- Foundry tests cover market creation, admin actions, encrypted betting, settlement claims, cancellation refunds, faucet minting, cooldowns, and early exits.
- The backend API supports markets, comments, threaded replies, notifications, participants, and wallet profiles.
- Supabase is the production storage path when credentials are present; local JSON storage remains available for development.
- Sports markets currently use BSD Sports for football events.
- Esports markets use PandaScore.
- Football team logos are synced into Supabase Storage and referenced through the `team_logos` catalog.

## Repository Layout

```text
backend/                 REST + WebSocket API, auth, stores, profile validation
relayer/                 Oracle workers and Supabase market metadata writers
scripts/                 Railway start helpers, Foundry runner, logo sync/backfill scripts
src/                     Solidity contracts
test/                    Foundry tests
supabase/migrations/     Supabase schema migrations
ecosystem.config.js      PM2 process definitions
```

## Contracts

Current Sepolia addresses used by the frontend:

| Contract | Address |
| --- | --- |
| `ConfidentialPredictionMarket` | `0x3cA14ae6ae8eCDD32023D2041aF2B60F2c58DD6B` |
| `EncryptedERC20` (cUSDT) | `0x0CbC92CA4D7eD07e935dc93bf6Ca6A5e26682035` |
| `ConfidentialUSDTFaucet` | `0xcDda033C5F914cCBFf39D7517cc4Dba54Bf7eeD9` |

Set `CONTRACT_ADDRESS` to the prediction market address for oracle workers.

## Environment

Copy `.env.example` to `.env` and fill the values you need.

Core values:

```text
PRIVATE_KEY=0x...
CONTRACT_ADDRESS=0x3cA14ae6ae8eCDD32023D2041aF2B60F2c58DD6B
RPC_URL=https://...
ALCHEMY_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...

COMMENTS_PORT=8787
API_STORE=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
API_AUTH_REQUIRED=true
API_ADMIN_WALLETS=0xAdminWallet,...
```

Oracle/provider values:

```text
ESPORTS_API_KEY=...             # PandaScore
BSD_SPORTS_API_KEY=...          # BSD Sports
BSD_SPORTS_API_URL=https://sports.bzzoiro.com/api/v2
BSD_SPORTS_LEAGUE_IDS=7,1,5,4,39,6,35
NEWS_API_KEY=...                # Politics
TECH_GUARDIAN_API_KEY=...       # Tech
FINNHUB_API_KEY=...             # Finance
CULTURE_FREENEWS_API_KEY=...    # Culture
```

Logo catalog values:

```text
TEAM_LOGO_BUCKET=team-logos
FOOTBALL_LOGOS_GITHUB_OWNER=luukhopman
FOOTBALL_LOGOS_GITHUB_REPO=football-logos
FOOTBALL_LOGOS_GITHUB_REF=master
FOOTBALL_LOGOS_GITHUB_PREFIX=logos/
```

Notes:

- Sports and esports workers prefer `ALCHEMY_RPC_URL`, then `NEXT_PUBLIC_ALCHEMY_API_KEY`, then `RPC_URL`, then public Sepolia fallback.
- `BSD_SPORTS_LEAGUE_IDS` controls football market creation and settlement. The default list is Champions League, Premier League, Bundesliga, Serie A, FA Cup, Ligue 1, and Copa do Brasil.
- Other workers currently use `RPC_URL` with public Sepolia fallback.
- Do not put `Authorization: Token ...` into `.env`; store only the raw BSD token in `BSD_SPORTS_API_KEY`.

## Local Development

Install dependencies:

```powershell
npm install
```

Run the API:

```powershell
npm run comments:dev
```

Run one oracle:

```powershell
npm run oracle:sports
npm run oracle:esports
npm run oracle:crypto
npm run oracle:politics
npm run oracle:tech
npm run oracle:finance-culture
```

Run with PM2:

```powershell
pm2 start ecosystem.config.js
pm2 status
pm2 logs oracle-sports
```

Run tests/checks:

```powershell
npm run test:backend
npm run test:foundry
npm run foundry:build
npm run foundry:fmt
```

## Supabase

Apply migrations from `supabase/migrations/` in Supabase SQL editor or your migration flow.

The backend stores:

- `markets`
- `comments`
- `notifications`
- `profiles`
- `market_participants`
- `team_logos`

Profile data is validated server-side. Profile images must be image data URLs and are compressed client-side before save.

## Logo Sync

The sports oracle uses BSD event/team data first, then looks up normalized team names in Supabase `team_logos`.

Useful scripts:

```powershell
npm run logos:sync
npm run logos:sync:wikimedia
npm run logos:backfill
```

`logos:sync` imports from `luukhopman/football-logos` into Supabase Storage. The Wikimedia script is an optional fallback for missing teams. `logos:backfill` updates existing sports market metadata with catalog logos.

## API

Common routes:

```text
GET    /api/markets
GET    /api/markets/:marketId
PUT    /api/markets/:marketId
POST   /api/markets/:marketId/comments
POST   /api/markets/:marketId/participants
GET    /api/wallets/:walletAddress/profile
PUT    /api/wallets/:walletAddress/profile
GET    /api/wallets/:walletAddress/notifications
PATCH  /api/wallets/:walletAddress/notifications/:notificationId
WS     /ws/notifications?walletAddress=:walletAddress
```

When `API_AUTH_REQUIRED` is not `false`, mutating routes require signed wallet auth. Admin/oracle metadata writes require a wallet listed in `API_ADMIN_WALLETS`.

Message shape:

```text
DarkONNET API request
Wallet: 0x...
Method: POST
Path: /api/markets/123/comments
Timestamp: 1770000000000
BodyHash: 0x...
```

## Railway

`npm run start:railway` starts selected processes from `scripts/start-railway.js`.

Use `RAILWAY_PROCESSES` to choose processes, for example:

```text
RAILWAY_PROCESSES=api,oracle-sports,oracle-esports
```

## License

MIT
