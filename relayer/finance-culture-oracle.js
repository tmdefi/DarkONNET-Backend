require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { firstArticleImage, upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const FINANCE_API_KEY = process.env.FINNHUB_API_KEY;
const CULTURE_API_KEY = process.env.CULTURE_FREENEWS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !FINANCE_API_KEY || !CULTURE_API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, FINNHUB_API_KEY, or CULTURE_FREENEWS_API_KEY in .env');
}

// Specialized Source Buckets
const FINNHUB_NEWS_API_URL = 'https://finnhub.io/api/v1/news';
const FREENEWS_API_URL = 'https://api.freenewsapi.io/v1/news';
const CULTURE_TOPICS = ['movies', 'music', 'entertainment', 'celebrities'];

// --- MARKETS ---
const MARKETS = [
    // FINANCE
    {
        id: 5026001,
        category: "Finance",
        description: "Will the Federal Reserve raise interest rates in their next meeting?",
        expiryTimestamp: 1780272000,
        finnhubCategory: "general",
        searchQuery: "Federal Reserve interest rate decision hike increase",
        outcomeA_keywords: ["raised rates", "rate hike", "increased interest rates"],
        outcomeB_keywords: ["kept rates steady", "rates unchanged", "cut rates"]
    },
    // CULTURE
    {
        id: 6026001,
        category: "Culture",
        description: "Will 'Dune: Part Three' be officially greenlit by June?",
        expiryTimestamp: 1782864000,
        searchQuery: "Dune Part 3 greenlit confirmed production",
        outcomeA_keywords: ["officially greenlit", "confirmed for production", "part 3 announced"],
        outcomeB_keywords: ["canceled", "on hold", "no plans for part 3"]
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
const creationCooldown = createCooldownCache('finance-culture');

async function processMarkets() {
    console.log("\n--- Scanning Finance & Culture Markets ---");

    for (const mDef of MARKETS) {
        try {
            const onChainMarket = await withBackoff(`finance-culture getMarketInfo ${mDef.id}`, () => contract.getMarketInfo(mDef.id));

            if (!onChainMarket.exists) {
                if (creationCooldown.shouldSkip(mDef.id)) continue;
                console.log(`[ACTION] Creating ${mDef.category} Market: ${mDef.description}`);
                let tx;
                try {
                    tx = await withBackoff(`finance-culture createMarket ${mDef.id}`, () =>
                        contract.createMarket(mDef.id, mDef.category, mDef.description, mDef.expiryTimestamp),
                    );
                    await withBackoff(`finance-culture wait create ${mDef.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(mDef.id);
                } catch (error) {
                    creationCooldown.markFailure(mDef.id, error);
                    throw error;
                }
                console.log(`[SUCCESS] Market ${mDef.id} Created.`);
                continue;
            }

            if (onChainMarket.isSettled) continue;

            console.log(`[CHECK] Searching news for: ${mDef.description}`);
            const { articles, provider, sourceMetadata } = await fetchArticles(mDef);
            await upsertMarketMetadata({
                marketId: mDef.id,
                category: mDef.category,
                title: mDef.description,
                provider,
                ...firstArticleImage(articles),
                metadata: {
                    searchQuery: mDef.searchQuery,
                    ...sourceMetadata,
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
                console.log(`[SETTLE] Event Confirmed (Outcome A)!`);
                const tx = await withBackoff(`finance-culture settle A ${mDef.id}`, () => contract.settle(mDef.id, 0, false));
                await withBackoff(`finance-culture wait settle A ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
            } else if (countB >= 2) {
                console.log(`[SETTLE] Event Confirmed (Outcome B)!`);
                const tx = await withBackoff(`finance-culture settle B ${mDef.id}`, () => contract.settle(mDef.id, 1, false));
                await withBackoff(`finance-culture wait settle B ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
            }

        } catch (error) {
            console.error(`[ERROR] Oracle failed for ${mDef.id}:`, error.message);
        }
    }
}

async function fetchArticles(mDef) {
    if (mDef.category === "Culture") {
        const topicArticles = await Promise.all(
            CULTURE_TOPICS.map(async topic => {
                const response = await withBackoff(`freenewsapi culture ${mDef.id} ${topic}`, () =>
                    axios.get(FREENEWS_API_URL, {
                        params: {
                            q: mDef.searchQuery,
                            topic,
                            language: 'en',
                            order_by: 'archive',
                            page_size: 10,
                        },
                        headers: { 'x-api-key': CULTURE_API_KEY },
                    }),
                );

                return normalizeFreeNewsArticles(response.data?.data || [], topic);
            }),
        );

        return {
            articles: dedupeArticles(topicArticles.flat()),
            provider: 'FreeNewsApi',
            sourceMetadata: {
                sourceApi: 'freenewsapi',
                topics: CULTURE_TOPICS,
            },
        };
    }

    const response = await withBackoff(`finnhub finance ${mDef.id}`, () => axios.get(FINNHUB_NEWS_API_URL, {
        params: {
            category: mDef.finnhubCategory || 'general',
            token: FINANCE_API_KEY,
        },
    }));
    const articles = normalizeFinnhubArticles(response.data || []);

    return {
        articles,
        provider: 'Finnhub',
        sourceMetadata: {
            sourceApi: 'finnhub',
            category: mDef.finnhubCategory || 'general',
        },
    };
}

function normalizeFinnhubArticles(results) {
    return results.map(result => ({
        title: result.headline || '',
        description: result.summary || '',
        url: result.url,
        urlToImage: result.image,
        source: { name: result.source || 'Finnhub' },
    }));
}

function normalizeFreeNewsArticles(results, topic) {
    return results.map(result => ({
        title: result.title || '',
        description: result.subtitle || result.body || '',
        url: result.original_url,
        urlToImage: result.thumbnail,
        source: { name: result.publisher || 'FreeNewsApi' },
        topic,
    }));
}

function dedupeArticles(articles) {
    const seen = new Set();
    return articles.filter(article => {
        const key = article.url || `${article.title}:${article.description}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

startStaggeredLoop('oracle-finance-culture', 20 * 60 * 1000, processMarkets);
