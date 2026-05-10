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
const FREENEWS_DETAILS_URL = 'https://api.freenewsapi.io/v1/details';
const CULTURE_TOPICS = ['movies', 'music', 'entertainment', 'celebrities'];
const FREENEWS_PAGE_SIZE = 5;
const DEFAULT_MIN_HITS = 2;
const DEFAULT_EXPIRY_FALLBACK_DELAY_SECONDS = 24 * 60 * 60;

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
        settleAfterExpiry: true,
        expiryFallbackOutcome: 1,
        searchQuery: "Dune Part 3 greenlit confirmed production",
        apiSearchQuery: "Dune greenlit confirmed production",
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
    const now = Math.floor(Date.now() / 1000);

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
                await syncMarketMetadata(mDef);
                continue;
            }

            if (onChainMarket.isSettled) {
                await syncMarketMetadata(mDef, onChainMarket);
                continue;
            }

            const articles = await syncMarketMetadata(mDef);

            let countA = 0;
            let countB = 0;

            for (const article of articles) {
                const text = (article.title + " " + article.description).toLowerCase();
                if (mDef.outcomeA_keywords.some(k => text.includes(k))) countA++;
                if (mDef.outcomeB_keywords.some(k => text.includes(k))) countB++;
            }

            console.log(`[DATA] Hits for A: ${countA}, Hits for B: ${countB}`);

            if (countA >= (mDef.outcomeA_minHits || DEFAULT_MIN_HITS)) {
                console.log(`[SETTLE] Event Confirmed (Outcome A)!`);
                const tx = await withBackoff(`finance-culture settle A ${mDef.id}`, () => contract.settle(mDef.id, 0, false));
                await withBackoff(`finance-culture wait settle A ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
                await syncMarketMetadata(mDef, { isSettled: true, winningOutcome: 0, isCanceled: false });
            } else if (countB >= (mDef.outcomeB_minHits || DEFAULT_MIN_HITS)) {
                console.log(`[SETTLE] Event Confirmed (Outcome B)!`);
                const tx = await withBackoff(`finance-culture settle B ${mDef.id}`, () => contract.settle(mDef.id, 1, false));
                await withBackoff(`finance-culture wait settle B ${mDef.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[SUCCESS] Market ${mDef.id} Settled.`);
                await syncMarketMetadata(mDef, { isSettled: true, winningOutcome: 1, isCanceled: false });
            } else if (mDef.settleAfterExpiry) {
                const fallbackDelay = mDef.expiryFallbackDelaySeconds || DEFAULT_EXPIRY_FALLBACK_DELAY_SECONDS;
                if (now >= mDef.expiryTimestamp + fallbackDelay) {
                    console.log(`[SETTLE] Resolution window expired. Settling fallback outcome ${mDef.expiryFallbackOutcome}.`);
                    const tx = await withBackoff(`finance-culture settle fallback ${mDef.id}`, () =>
                        contract.settle(mDef.id, mDef.expiryFallbackOutcome, false),
                    );
                    await withBackoff(`finance-culture wait settle fallback ${mDef.id}`, () => tx.wait(), { retries: 1 });
                    console.log(`[SUCCESS] Market ${mDef.id} Settled by expiry fallback.`);
                    await syncMarketMetadata(mDef, {
                        isSettled: true,
                        winningOutcome: mDef.expiryFallbackOutcome,
                        isCanceled: false,
                    });
                }
            }

        } catch (error) {
            console.error(`[ERROR] Oracle failed for ${mDef.id}:`, error.message);
        }
    }
}

async function syncMarketMetadata(mDef, onChainMarket) {
    console.log(`[CHECK] Searching news for: ${mDef.description}`);
    const { articles, provider, sourceMetadata } = await fetchArticles(mDef);
    const settlement = settlementMetadata(onChainMarket);
    await upsertMarketMetadata({
        marketId: mDef.id,
        category: mDef.category,
        title: mDef.description,
        provider,
        startsAt: new Date(mDef.expiryTimestamp * 1000).toISOString(),
        ...settlement,
        ...firstArticleImage(articles),
        metadata: {
            searchQuery: mDef.searchQuery,
            ...sourceMetadata,
        },
    });
    return articles;
}

function settlementMetadata(onChainMarket) {
    if (!onChainMarket?.isSettled) return {};
    const winningOutcome = Number(onChainMarket.winningOutcome);
    return {
        status: 'resolved',
        resolvedAt: new Date().toISOString(),
        resolution: onChainMarket.isCanceled ? 'canceled' : winningOutcome === 0 ? 'yes' : 'no',
    };
}

async function fetchArticles(mDef) {
    if (mDef.category === "Culture") {
        const topicArticles = [];
        for (const topic of CULTURE_TOPICS) {
            try {
                const response = await withBackoff(`freenewsapi culture ${mDef.id} ${topic}`, () =>
                    axios.get(FREENEWS_API_URL, {
                        params: {
                            q: mDef.apiSearchQuery || mDef.searchQuery,
                            topic,
                            language: 'en',
                            order_by: 'archive',
                            page_size: FREENEWS_PAGE_SIZE,
                        },
                        headers: { 'x-api-key': CULTURE_API_KEY },
                    }),
                );

                topicArticles.push(...await hydrateFreeNewsArticles(response.data?.data || [], topic));
            } catch (error) {
                console.warn(`[WARN] FreeNewsApi topic ${topic} failed for ${mDef.id}: ${error.message}`);
            }
        }

        return {
            articles: dedupeArticles(topicArticles),
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
        description: result.subtitle || result.incipit || result.body || '',
        url: result.original_url,
        urlToImage: result.thumbnail,
        source: { name: result.publisher || 'FreeNewsApi' },
        topic,
    }));
}

async function hydrateFreeNewsArticles(results, topic) {
    const articles = [];
    for (const item of results) {
        if (!item.uuid) {
            articles.push(normalizeFreeNewsArticles([item], topic)[0]);
            continue;
        }

        try {
            const response = await withBackoff(`freenewsapi details ${item.uuid}`, () =>
                axios.get(FREENEWS_DETAILS_URL, {
                    params: { uuid: item.uuid },
                    headers: { 'x-api-key': CULTURE_API_KEY },
                }),
            );
            articles.push(normalizeFreeNewsArticles([response.data?.data || item], topic)[0]);
        } catch (error) {
            console.warn(`[WARN] Could not fetch FreeNewsApi details for ${item.uuid}: ${error.message}`);
            articles.push(normalizeFreeNewsArticles([item], topic)[0]);
        }
    }

    return articles.filter(Boolean);
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

if (process.env.ORACLE_RUN_ONCE === 'true') {
    processMarkets()
        .then(() => {
            process.exitCode = 0;
        })
        .catch(error => {
            console.error('[ERROR] One-shot finance-culture oracle failed:', error.message);
            process.exitCode = 1;
        });
} else {
    startStaggeredLoop('oracle-finance-culture', 20 * 60 * 1000, processMarkets);
}
