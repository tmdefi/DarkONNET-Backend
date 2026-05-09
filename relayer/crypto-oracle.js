require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
    throw new Error('Missing PRIVATE_KEY or CONTRACT_ADDRESS in .env');
}

const CRYPTO_MARKETS = [
    {
        id: 4026001,
        description: "Will Bitcoin (BTC) be above $70,000 by May 1st?",
        coinId: "bitcoin",
        coinImageId: 1,
        coinImageFile: "bitcoin.png",
        targetPrice: 70000,
        expiryTimestamp: 1746057600
    },
    {
        id: 4026002,
        description: "Will Ethereum (ETH) be above $4,000 by May 1st?",
        coinId: "ethereum",
        coinImageId: 279,
        coinImageFile: "ethereum.png",
        targetPrice: 4000,
        expiryTimestamp: 1746057600
    }
];

const ABI = [
    "function createMarket(uint256 _id, string _category, string _description) public",
    "function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public",
    "function getMarketInfo(uint256 _id) public view returns (uint256 id, string category, string description, bool isSettled, uint8 winningOutcome, bool isCanceled, bool exists)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const creationCooldown = createCooldownCache('crypto');

async function processCrypto() {
    console.log("\n--- Scanning Crypto Price Markets ---");
    const now = Math.floor(Date.now() / 1000);

    for (const mDef of CRYPTO_MARKETS) {
        try {
            const onChainMarket = await withBackoff(`crypto getMarketInfo ${mDef.id}`, () => contract.getMarketInfo(mDef.id));
            if (!onChainMarket.exists) {
                if (creationCooldown.shouldSkip(mDef.id)) continue;
                console.log(`[ACTION] Creating Crypto Market: ${mDef.description}`);
                let tx;
                try {
                    tx = await withBackoff(`crypto createMarket ${mDef.id}`, () =>
                        contract.createMarket(mDef.id, "Crypto", mDef.description, { gasLimit: 3000000 }),
                    );
                    await withBackoff(`crypto wait create ${mDef.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(mDef.id);
                } catch (error) {
                    creationCooldown.markFailure(mDef.id, error);
                    throw error;
                }
                await upsertMarketMetadata({
                    marketId: mDef.id,
                    category: "Crypto",
                    title: mDef.description,
                    provider: "CoinGecko",
                    imageUrl: `https://assets.coingecko.com/coins/images/${mDef.coinImageId}/large/${mDef.coinImageFile}`,
                    metadata: {
                        coinId: mDef.coinId,
                        targetPrice: mDef.targetPrice,
                        expiryTimestamp: mDef.expiryTimestamp,
                    },
                });
                console.log(`[SUCCESS] Market ${mDef.id} Created.`);
                continue;
            }

            if (onChainMarket.isSettled) continue;

            if (now >= mDef.expiryTimestamp) {
                console.log(`[SETTLE] Market ${mDef.id} expired. Fetching price...`);
                const response = await withBackoff(`coingecko price ${mDef.coinId}`, () => axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
                    params: { ids: mDef.coinId, vs_currencies: 'usd' }
                }));

                const currentPrice = response.data[mDef.coinId].usd;
                const winner = (currentPrice >= mDef.targetPrice) ? 0 : 1;

                console.log(`[ACTION] Settling Market ${mDef.id} for Outcome ${winner} (Price: $${currentPrice})`);

                // MANUAL GAS LIMIT to prevent estimateGas failure on FHEVM
                const tx = await withBackoff(`crypto settle ${mDef.id}`, () =>
                    contract.settle(mDef.id, winner, false, { gasLimit: 5000000 }),
                );
                console.log(`[TX] Sent! Hash: ${tx.hash}`);
                await withBackoff(`crypto wait settle ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
            }
        } catch (error) {
            console.error(`[ERROR] Crypto Oracle failed for ${mDef.id}:`, error.message);
        }
    }
}

startStaggeredLoop('oracle-crypto', 30 * 60 * 1000, processCrypto);
