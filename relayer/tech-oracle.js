require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { firstArticleImage, upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const API_KEY = process.env.TECH_GUARDIAN_API_KEY || process.env.GUARDIAN_API_KEY || process.env.TECH_NEWS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, or TECH_GUARDIAN_API_KEY/GUARDIAN_API_KEY in .env');
}

const GUARDIAN_API_URL = 'https://content.guardianapis.com/search';
const GUARDIAN_SECTION = 'technology';
const GUARDIAN_FIELDS = 'headline,trailText,thumbnail';

// --- ACTIVE TECH MARKETS ---
const TECH_MARKETS = [
    {
        id: 3026001,
        description: "Will OpenAI release GPT-5 before July 2026?",
        expiryTimestamp: 1782864000,
        searchQuery: "OpenAI GPT-5 release launch announcement",
        outcomeA_keywords: ["released", "launched", "available now", "announces gpt-5"],
        outcomeB_keywords: ["delayed", "postponed", "no release in 2026"]
    },
    {
        id: 3026002,
        description: "Will Apple announce a new AI-dedicated chip at WWDC?",
        expiryTimestamp: 1782864000,
        searchQuery: "Apple WWDC AI chip silicon announcement",
        outcomeA_keywords: ["announces m4 ai", "new ai chip", "dedicated ai processor"],
        outcomeB_keywords: ["no new chip", "incremental update only"]
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
const creationCooldown = createCooldownCache('tech');

async function processTech() {
    console.log("\n--- Scanning Tech Markets ---");

    for (const mDef of TECH_MARKETS) {
        try {
            const onChainMarket = await withBackoff(`tech getMarketInfo ${mDef.id}`, () => contract.getMarketInfo(mDef.id));

            if (!onChainMarket.exists) {
                if (creationCooldown.shouldSkip(mDef.id)) continue;
                console.log(`[ACTION] Creating Tech Market: ${mDef.description}`);
                let tx;
                try {
                    tx = await withBackoff(`tech createMarket ${mDef.id}`, () =>
                        contract.createMarket(mDef.id, "Tech", mDef.description, mDef.expiryTimestamp),
                    );
                    await withBackoff(`tech wait create ${mDef.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(mDef.id);
                } catch (error) {
                    creationCooldown.markFailure(mDef.id, error);
                    throw error;
                }
                console.log(`[SUCCESS] Market ${mDef.id} Created.`);
                await upsertMarketMetadata({
                    marketId: mDef.id,
                    category: "Tech",
                    title: mDef.description,
                    provider: "The Guardian",
                    startsAt: new Date(mDef.expiryTimestamp * 1000).toISOString(),
                    metadata: {
                        searchQuery: mDef.searchQuery,
                        section: GUARDIAN_SECTION,
                    },
                });
                continue;
            }

            if (onChainMarket.isSettled) continue;

            console.log(`[CHECK] Searching news for: ${mDef.description}`);
            const response = await withBackoff(`guardian tech ${mDef.id}`, () => axios.get(GUARDIAN_API_URL, {
                params: {
                    'api-key': API_KEY,
                    q: mDef.searchQuery,
                    section: GUARDIAN_SECTION,
                    'order-by': 'relevance',
                    'page-size': 10,
                    'show-fields': GUARDIAN_FIELDS,
                },
            }));

            const articles = normalizeGuardianArticles(response.data?.response?.results || []);
            await upsertMarketMetadata({
                marketId: mDef.id,
                category: "Tech",
                title: mDef.description,
                provider: "The Guardian",
                startsAt: new Date(mDef.expiryTimestamp * 1000).toISOString(),
                ...firstArticleImage(articles),
                metadata: {
                    searchQuery: mDef.searchQuery,
                    section: GUARDIAN_SECTION,
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

            if (countA >= 2) {
                console.log(`[SETTLE] Tech Event Confirmed (A)!`);
                const tx = await withBackoff(`tech settle A ${mDef.id}`, () => contract.settle(mDef.id, 0, false));
                await withBackoff(`tech wait settle A ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
            } else if (countB >= 2) {
                console.log(`[SETTLE] Tech Event Confirmed (B)!`);
                const tx = await withBackoff(`tech settle B ${mDef.id}`, () => contract.settle(mDef.id, 1, false));
                await withBackoff(`tech wait settle B ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
            }

        } catch (error) {
            console.error(`[ERROR] Tech Oracle failed for ${mDef.id}:`, error.message);
        }
    }
}

function normalizeGuardianArticles(results) {
    return results.map(result => ({
        title: result.fields?.headline || result.webTitle || '',
        description: result.fields?.trailText || '',
        url: result.webUrl,
        urlToImage: result.fields?.thumbnail,
        source: { name: 'The Guardian' },
    }));
}

startStaggeredLoop('oracle-tech', 15 * 60 * 1000, processTech);
