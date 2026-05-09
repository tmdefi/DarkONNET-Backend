require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');

// --- CONFIGURATION ---
const API_BASE_URL = 'https://api.pandascore.co';
const API_KEY = process.env.ESPORTS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, or ESPORTS_API_KEY in .env');
}

const ABI = [
    "function createMarket(uint256 _id, string _category, string _description, uint64 _expiresAt) public",
    "function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public",
    "function getMarketInfo(uint256 _id) public view returns (uint256 id, string category, string description, uint64 expiresAt, bool isSettled, uint8 winningOutcome, bool isCanceled, bool exists)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const creationCooldown = createCooldownCache('esports');

function matchExpiryTimestamp(match) {
    const beginAt = Date.parse(match.begin_at || '');
    if (Number.isFinite(beginAt)) return Math.floor(beginAt / 1000);
    return Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
}

async function autoCreateMarkets() {
    console.log("\n[ESPORTS] Scanning for upcoming matches...");
    try {
        const response = await withBackoff('pandascore upcoming matches', () => axios.get(`${API_BASE_URL}/matches`, {
            params: { 'filter[status]': 'not_started', 'per_page': 10, 'sort': 'begin_at' },
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        }));

        for (const match of response.data) {
            const market = await withBackoff(`esports getMarketInfo ${match.id}`, () => contract.getMarketInfo(match.id));
            if (market.exists) continue;
            if (creationCooldown.shouldSkip(match.id)) continue;

            if (match.opponents && match.opponents.length >= 2) {
                console.log(`[ESPORTS] Creating Market: ${match.name}`);
                let tx;
                try {
                    tx = await withBackoff(`esports createMarket ${match.id}`, () =>
                        contract.createMarket(match.id, "Esports", match.name, matchExpiryTimestamp(match)),
                    );
                    await withBackoff(`esports wait create ${match.id}`, () => tx.wait(), { retries: 1 });
                    creationCooldown.clear(match.id);
                } catch (error) {
                    creationCooldown.markFailure(match.id, error);
                    throw error;
                }
                await upsertMarketMetadata({
                    marketId: match.id,
                    category: "Esports",
                    title: match.name,
                    provider: "PandaScore",
                    homeName: match.opponents[0]?.opponent?.name,
                    awayName: match.opponents[1]?.opponent?.name,
                    homeLogoUrl: match.opponents[0]?.opponent?.image_url,
                    awayLogoUrl: match.opponents[1]?.opponent?.image_url,
                    leagueName: match.league?.name,
                    leagueLogoUrl: match.league?.image_url,
                    startsAt: match.begin_at,
                    metadata: {
                        videogame: match.videogame?.name,
                        tournament: match.tournament?.name,
                    },
                });
                console.log(`[ESPORTS] Market ${match.id} Created.`);
            }
        }
    } catch (error) { console.error("[ESPORTS ERROR] Creator:", error.message); }
}

async function autoSettleMatches() {
    console.log("[ESPORTS] Checking for finished matches...");
    try {
        const response = await withBackoff('pandascore finished matches', () => axios.get(`${API_BASE_URL}/matches`, {
            params: { 'filter[status]': 'finished', 'per_page': 10 },
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        }));

        for (const match of response.data) {
            const market = await withBackoff(`esports getMarketInfo finished ${match.id}`, () => contract.getMarketInfo(match.id));
            if (market.exists && !market.isSettled) {
                console.log(`[ESPORTS] Settling: ${match.name}`);
                const isCanceled = match.forfeit || match.draw;
                let winner = 0;

                // Fetch match details to get team IDs if needed, or use winner_id logic
                // Simple logic: if winner_id matches first opponent, it's 0
                const matchDetails = await withBackoff(`pandascore match details ${match.id}`, () => axios.get(`${API_BASE_URL}/matches/${match.id}`, {
                    headers: { 'Authorization': `Bearer ${API_KEY}` }
                }));
                const teamAId = matchDetails.data.opponents[0].opponent.id;
                winner = (match.winner_id == teamAId) ? 0 : 1;

                const tx = await withBackoff(`esports settle ${match.id}`, () => contract.settle(match.id, winner, isCanceled));
                await withBackoff(`esports wait settle ${match.id}`, () => tx.wait(), { retries: 1 });
                console.log(`[ESPORTS] Match ${match.id} Settled.`);
            }
        }
    } catch (error) { console.error("[ESPORTS ERROR] Settler:", error.message); }
}

async function main() {
    await autoCreateMarkets();
    await autoSettleMatches();
}

startStaggeredLoop('oracle-esports', 5 * 60 * 1000, main);
