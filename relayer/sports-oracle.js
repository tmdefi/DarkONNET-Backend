require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { footballTeamLogo, upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const API_KEY = process.env.SPORTS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, or SPORTS_API_KEY in .env');
}

const ABI = [
    "function createMarket(uint256 _id, string _category, string _description, uint64 _expiresAt) public",
    "function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public",
    "function getMarketInfo(uint256 _id) public view returns (uint256 id, string category, string description, uint64 expiresAt, bool isSettled, uint8 winningOutcome, bool isCanceled, bool exists)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const creationCooldown = createCooldownCache('sports');

function expiryFromDate(value, fallbackDays = 7) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    return Math.floor(Date.now() / 1000) + fallbackDays * 24 * 60 * 60;
}

// API Hosts
const HOSTS = {
    FOOTBALL: 'v3.football.api-sports.io',
    NFL: 'v1.american-football.api-sports.io',
    F1: 'v1.formula-1.api-sports.io'
};

/**
 * UTILITY: API Request Helper
 */
async function fetchFromSportsAPI(host, endpoint, params) {
    return await withBackoff(`sports api ${host}/${endpoint}`, () => axios.get(`https://${host}/${endpoint}`, {
        params: params,
        headers: { 'x-apisports-key': API_KEY }
    }));
}

/**
 * MODULE: FOOTBALL (Soccer)
 */
async function processFootball() {
    console.log("\n[FOOTBALL] Scanning...");
    try {
        // 1. Create Upcoming (Premier League = 39)
        const upcoming = await fetchFromSportsAPI(HOSTS.FOOTBALL, 'fixtures', { league: 39, season: 2026, status: 'NS', next: 5 });
        for (const f of upcoming.data.response) {
            const market = await withBackoff(`football getMarketInfo ${f.fixture.id}`, () => contract.getMarketInfo(f.fixture.id));
            if (!market.exists) {
                if (creationCooldown.shouldSkip(f.fixture.id)) continue;
                console.log(`[FOOTBALL] Creating: ${f.teams.home.name} vs ${f.teams.away.name}`);
                let tx;
                try {
                    tx = await withBackoff(`football createMarket ${f.fixture.id}`, () =>
                        contract.createMarket(
                            f.fixture.id,
                            "Sports - Football",
                            `${f.teams.home.name} vs ${f.teams.away.name}`,
                            expiryFromDate(f.fixture.date),
                        ),
                    );
                    await withBackoff(`football wait create ${f.fixture.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(f.fixture.id);
                } catch (error) {
                    creationCooldown.markFailure(f.fixture.id, error);
                    throw error;
                }
                await upsertMarketMetadata({
                    marketId: f.fixture.id,
                    category: "Sports - Football",
                    title: `${f.teams.home.name} vs ${f.teams.away.name}`,
                    provider: "API-Sports Football",
                    homeName: f.teams.home.name,
                    awayName: f.teams.away.name,
                    homeLogoUrl: f.teams.home.logo || footballTeamLogo(f.teams.home.id),
                    awayLogoUrl: f.teams.away.logo || footballTeamLogo(f.teams.away.id),
                    leagueName: f.league?.name,
                    leagueLogoUrl: f.league?.logo,
                    startsAt: f.fixture?.date,
                    metadata: {
                        venue: f.fixture?.venue?.name,
                        city: f.fixture?.venue?.city,
                    },
                });
            }
        }

        // 2. Settle Finished
        const finished = await fetchFromSportsAPI(HOSTS.FOOTBALL, 'fixtures', { league: 39, season: 2026, status: 'FT', last: 5 });
        for (const f of finished.data.response) {
            const market = await withBackoff(`football getMarketInfo finished ${f.fixture.id}`, () => contract.getMarketInfo(f.fixture.id));
            if (market.exists && !market.isSettled) {
                console.log(`[FOOTBALL] Settling: ${f.teams.home.name} vs ${f.teams.away.name}`);
                let winner = (f.goals.home > f.goals.away) ? 0 : 1;
                let isCanceled = (f.goals.home === f.goals.away); // Draw = Refund
                const tx = await withBackoff(`football settle ${f.fixture.id}`, () => contract.settle(f.fixture.id, winner, isCanceled));
                await withBackoff(`football wait settle ${f.fixture.id}`, () => tx.wait(), { retries: 1 });
            }
        }
    } catch (e) { console.error("[FOOTBALL ERROR]", e.message); }
}

/**
 * MODULE: NFL (American Football)
 */
async function processNFL() {
    console.log("\n[NFL] Scanning...");
    try {
        // 1. Create Upcoming (League 1 = NFL)
        const upcoming = await fetchFromSportsAPI(HOSTS.NFL, 'games', { league: 1, season: 2026, status: 'NS', next: 5 });
        for (const g of upcoming.data.response) {
            const market = await withBackoff(`nfl getMarketInfo ${g.game.id}`, () => contract.getMarketInfo(g.game.id));
            if (!market.exists) {
                if (creationCooldown.shouldSkip(g.game.id)) continue;
                console.log(`[NFL] Creating: ${g.teams.home.name} vs ${g.teams.away.name}`);
                let tx;
                try {
                    tx = await withBackoff(`nfl createMarket ${g.game.id}`, () =>
                        contract.createMarket(
                            g.game.id,
                            "Sports - NFL",
                            `${g.teams.home.name} vs ${g.teams.away.name}`,
                            expiryFromDate(g.game.date?.date),
                        ),
                    );
                    await withBackoff(`nfl wait create ${g.game.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(g.game.id);
                } catch (error) {
                    creationCooldown.markFailure(g.game.id, error);
                    throw error;
                }
                await upsertMarketMetadata({
                    marketId: g.game.id,
                    category: "Sports - NFL",
                    title: `${g.teams.home.name} vs ${g.teams.away.name}`,
                    provider: "API-Sports NFL",
                    homeName: g.teams.home.name,
                    awayName: g.teams.away.name,
                    homeLogoUrl: g.teams.home.logo,
                    awayLogoUrl: g.teams.away.logo,
                    leagueName: g.league?.name || "NFL",
                    startsAt: g.game?.date?.date || g.game?.date,
                    metadata: {
                        week: g.game?.week,
                        venue: g.game?.venue,
                    },
                });
            }
        }

        // 2. Settle Finished
        const finished = await fetchFromSportsAPI(HOSTS.NFL, 'games', { league: 1, season: 2026, status: 'FT', last: 5 });
        for (const g of finished.data.response) {
            const market = await withBackoff(`nfl getMarketInfo finished ${g.game.id}`, () => contract.getMarketInfo(g.game.id));
            if (market.exists && !market.isSettled) {
                console.log(`[NFL] Settling: ${g.teams.home.name} vs ${g.teams.away.name}`);
                let winner = (g.scores.home.total > g.scores.away.total) ? 0 : 1;
                let isCanceled = (g.scores.home.total === g.scores.away.total);
                const tx = await withBackoff(`nfl settle ${g.game.id}`, () => contract.settle(g.game.id, winner, isCanceled));
                await withBackoff(`nfl wait settle ${g.game.id}`, () => tx.wait(), { retries: 1 });
            }
        }
    } catch (e) { console.error("[NFL ERROR]", e.message); }
}

/**
 * MODULE: FORMULA 1
 */
async function processF1() {
    console.log("\n[F1] Scanning...");
    try {
        // 1. Create Upcoming Races
        const upcoming = await fetchFromSportsAPI(HOSTS.F1, 'races', { season: 2026, type: 'race', next: 1 });
        for (const r of upcoming.data.response) {
            const market = await withBackoff(`f1 getMarketInfo ${r.id}`, () => contract.getMarketInfo(r.id));
            if (!market.exists) {
                if (creationCooldown.shouldSkip(r.id)) continue;
                console.log(`[F1] Creating Race: ${r.competition.name}`);
                // Simple market: Who wins? We define Option A as "The Favorite" or a specific driver.
                // For simplicity, we'll label it by race name.
                let tx;
                try {
                    tx = await withBackoff(`f1 createMarket ${r.id}`, () =>
                        contract.createMarket(
                            r.id,
                            "Sports - F1",
                            `Winner of ${r.competition.name}`,
                            expiryFromDate(r.date),
                        ),
                    );
                    await withBackoff(`f1 wait create ${r.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(r.id);
                } catch (error) {
                    creationCooldown.markFailure(r.id, error);
                    throw error;
                }
                await upsertMarketMetadata({
                    marketId: r.id,
                    category: "Sports - F1",
                    title: `Winner of ${r.competition.name}`,
                    provider: "API-Sports Formula 1",
                    imageUrl: r.competition?.logo,
                    leagueName: "Formula 1",
                    startsAt: r.date,
                    metadata: {
                        circuit: r.circuit?.name,
                        country: r.competition?.location?.country,
                    },
                });
            }
        }

        // 2. Settle Finished
        const lastRace = await fetchFromSportsAPI(HOSTS.F1, 'races', { season: 2026, type: 'race', last: 1 });
        for (const r of lastRace.data.response) {
            const market = await withBackoff(`f1 getMarketInfo finished ${r.id}`, () => contract.getMarketInfo(r.id));
            if (market.exists && !market.isSettled && r.status === 'Completed') {
                const results = await fetchFromSportsAPI(HOSTS.F1, 'rankings/races', { race: r.id });
                if (results.data.response.length > 0) {
                    const winnerDriver = results.data.response[0].driver.name;
                    console.log(`[F1] Winner of ${r.competition.name}: ${winnerDriver}`);
                    // Note: Outcome mapping for F1 depends on how you set up the betting.
                    // For now, we settle for 0 (meaning the race was completed).
                    const tx = await withBackoff(`f1 settle ${r.id}`, () => contract.settle(r.id, 0, false));
                    await withBackoff(`f1 wait settle ${r.id}`, () => tx.wait(), { retries: 1 });
                }
            }
        }
    } catch (e) { console.error("[F1 ERROR]", e.message); }
}

async function runAll() {
    await processFootball();
    await processNFL();
    await processF1();
    console.log("\n--- All Sports Synced. Waiting 15 minutes... ---");
}

startStaggeredLoop('oracle-sports', 15 * 60 * 1000, runAll);
