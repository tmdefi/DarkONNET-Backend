require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { firstArticleImage, upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const API_KEY = process.env.NEWS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, or NEWS_API_KEY in .env');
}

// Trusted News Sources
const SOURCES = 'reuters,associated-press,bbc-news,the-wall-street-journal';

// --- ACTIVE POLITICAL MARKETS ---
// Define your markets here. The script will auto-create and auto-settle them.
const POLITICAL_MARKETS = [
    {
        id: 2026001,
        description: "Will the Infrastructure Bill pass by May?",
        expiryTimestamp: 1780272000,
        searchQuery: "Infrastructure bill vote result 2026",
        outcomeA_keywords: ["passed", "approved", "signed into law"],
        outcomeB_keywords: ["rejected", "failed", "voted down"]
    }
];

const ABI = [
    "function createMarket(uint256 _id, string _category, string _description, uint64 _expiresAt) public",
    "function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public",
    "function getMarketInfo(uint256 _id) public view returns (uint256 id, string category, string description, uint64 expiresAt, bool isSettled, uint8 winningOutcome, bool isCanceled, bool exists)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const creationCooldown = createCooldownCache('politics');

async function processPolitics() {
    console.log("\n--- Scanning Political Markets ---");

    for (const mDef of POLITICAL_MARKETS) {
        try {
            // 1. Check if market exists
            const onChainMarket = await withBackoff(`politics getMarketInfo ${mDef.id}`, () => contract.getMarketInfo(mDef.id));

            if (!onChainMarket.exists) {
                if (creationCooldown.shouldSkip(mDef.id)) continue;
                console.log(`[ACTION] Creating Market: ${mDef.description}`);
                let tx;
                try {
                    tx = await withBackoff(`politics createMarket ${mDef.id}`, () =>
                        contract.createMarket(mDef.id, "Politics", mDef.description, mDef.expiryTimestamp),
                    );
                    await withBackoff(`politics wait create ${mDef.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(mDef.id);
                } catch (error) {
                    creationCooldown.markFailure(mDef.id, error);
                    throw error;
                }
                console.log(`[SUCCESS] Market ${mDef.id} Created.`);
                continue;
            }

            if (onChainMarket.isSettled) continue;

            // 2. Search for News
            console.log(`[CHECK] Searching news for: ${mDef.description}`);
            const response = await withBackoff(`newsapi politics ${mDef.id}`, () => axios.get('https://newsapi.org/v2/everything', {
                params: {
                    q: mDef.searchQuery,
                    sources: SOURCES,
                    sortBy: 'relevancy',
                    language: 'en'
                },
                headers: { 'X-Api-Key': API_KEY }
            }));

            const articles = response.data.articles;
            await upsertMarketMetadata({
                marketId: mDef.id,
                category: "Politics",
                title: mDef.description,
                provider: "NewsAPI",
                ...firstArticleImage(articles),
                metadata: {
                    searchQuery: mDef.searchQuery,
                    sources: SOURCES,
                },
            });

            let countA = 0;
            let countB = 0;

            for (const article of articles) {
                const text = (article.title + " " + article.description).toLowerCase();

                if (mDef.outcomeA_keywords.some(k => text.includes(k))) countA++;
                if (mDef.outcomeB_keywords.some(k => text.includes(k))) countB++;
            }

            console.log(`[DATA] Hits for A: ${countA}, Hits for B: ${countB}`);

            // 3. Settle if threshold met (e.g., 2+ articles confirm)
            if (countA >= 2) {
                console.log(`[SETTLE] Outcome A confirmed!`);
                const tx = await withBackoff(`politics settle A ${mDef.id}`, () => contract.settle(mDef.id, 0, false));
                await withBackoff(`politics wait settle A ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled for A.`);
            } else if (countB >= 2) {
                console.log(`[SETTLE] Outcome B confirmed!`);
                const tx = await withBackoff(`politics settle B ${mDef.id}`, () => contract.settle(mDef.id, 1, false));
                await withBackoff(`politics wait settle B ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled for B.`);
            }

        } catch (error) {
            console.error(`[ERROR] Processing market ${mDef.id}:`, error.message);
        }
    }
}

startStaggeredLoop('oracle-politics', 10 * 60 * 1000, processPolitics);
