require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { upsertMarketMetadata } = require('./market-metadata');
const { createCooldownCache, startStaggeredLoop, withBackoff } = require('./oracle-utils');
const { getTeamLogoUrl } = require('./team-logo-store');

// --- CONFIGURATION ---
const API_KEY = process.env.BSD_SPORTS_API_KEY;
const API_BASE_URL = (process.env.BSD_SPORTS_API_URL || 'https://sports.bzzoiro.com/api/v2').replace(/\/$/, '');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ALCHEMY_RPC_URL || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const CREATE_MARKET_GAS_LIMIT = 600_000;
const SETTLE_MARKET_GAS_LIMIT = 400_000;
const UPCOMING_LOOKAHEAD_DAYS = 2;
const DEFAULT_FOOTBALL_LEAGUES = {
    7: 'Champions League',
    1: 'Premier League',
    5: 'Bundesliga',
    4: 'Serie A',
    39: 'FA Cup',
    6: 'Ligue 1',
    35: 'Copa do Brasil',
};
const ALLOWED_FOOTBALL_LEAGUES = parseLeagueAllowlist();

if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !API_KEY) {
    throw new Error('Missing PRIVATE_KEY, CONTRACT_ADDRESS, or BSD_SPORTS_API_KEY in .env');
}

const ABI = [
    "function createMarket(uint256 _id, string _category, string _description, uint64 _expiresAt) public",
    "function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public",
    "function getMarketInfo(uint256 _id) public view returns (uint256 id, string category, string description, uint64 expiresAt, bool isSettled, uint8 winningOutcome, bool isCanceled, bool exists)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const creationCooldown = createCooldownCache('bsd-sports');

function eventTitle(event) {
    return `${event.home_team || 'Home'} vs ${event.away_team || 'Away'}`;
}

function eventExpiryTimestamp(event) {
    const parsed = Date.parse(event.event_date || '');
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    return Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
}

function isoDaysFromNow(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchBsdEvents(params) {
    const response = await withBackoff(`bsd sports events ${params.status || 'all'}`, () =>
        axios.get(`${API_BASE_URL}/events/`, {
            params,
            headers: { Authorization: `Token ${API_KEY}` },
        }),
    );
    return Array.isArray(response.data?.results) ? response.data.results : [];
}

function parseLeagueAllowlist() {
    const rawLeagueIds = process.env.BSD_SPORTS_LEAGUE_IDS;
    if (!rawLeagueIds) return DEFAULT_FOOTBALL_LEAGUES;

    const ids = rawLeagueIds
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

    if (!ids.length) return DEFAULT_FOOTBALL_LEAGUES;
    return Object.fromEntries(ids.map((id) => [id, `League ${id}`]));
}

function isAllowedFootballLeague(event) {
    return Boolean(ALLOWED_FOOTBALL_LEAGUES[Number(event.league_id)]);
}

function allowedLeagueName(event) {
    return ALLOWED_FOOTBALL_LEAGUES[Number(event.league_id)] || null;
}

async function fetchAllowedFootballEvents(params) {
    const eventMap = new Map();

    for (const leagueId of Object.keys(ALLOWED_FOOTBALL_LEAGUES)) {
        const leagueEvents = await fetchBsdEvents({
            ...params,
            league_id: leagueId,
        });

        for (const event of leagueEvents) {
            if (isAllowedFootballLeague(event)) {
                eventMap.set(String(event.id), event);
            }
        }
    }

    return [...eventMap.values()];
}

function sortByEventDate(events) {
    return [...events].sort((left, right) => Date.parse(left.event_date || '') - Date.parse(right.event_date || ''));
}

async function autoCreateMarkets() {
    console.log(`\n[BSD SPORTS] Scanning allowed football leagues: ${Object.values(ALLOWED_FOOTBALL_LEAGUES).join(', ')}`);
    try {
        const events = await fetchAllowedFootballEvents({
            status: 'notstarted',
            date_from: new Date().toISOString(),
            date_to: isoDaysFromNow(UPCOMING_LOOKAHEAD_DAYS),
            limit: 20,
        });

        for (const event of sortByEventDate(events)) {
            const market = await withBackoff(`bsd sports getMarketInfo ${event.id}`, () => contract.getMarketInfo(event.id));
            if (market.exists) {
                await syncEventMetadata(event);
                continue;
            }
            if (creationCooldown.shouldSkip(event.id)) continue;

            const title = eventTitle(event);
            console.log(`[BSD SPORTS] Creating football market: ${title}`);
            let tx;
            try {
                tx = await withBackoff(`bsd sports createMarket ${event.id}`, () =>
                    contract.createMarket(event.id, "Sports - Football", title, eventExpiryTimestamp(event), {
                        gasLimit: CREATE_MARKET_GAS_LIMIT,
                    }),
                );
                await withBackoff(`bsd sports wait create ${event.id}`, () => tx.wait(), { retries: 1 });
                creationCooldown.clear(event.id);
            } catch (error) {
                creationCooldown.markFailure(event.id, error);
                throw error;
            }

            await syncEventMetadata(event);
            console.log(`[BSD SPORTS] Market ${event.id} created.`);
        }
    } catch (error) {
        console.error("[BSD SPORTS ERROR] Creator:", error.response?.data?.detail || error.message);
    }
}

async function autoSettleMarkets() {
    console.log("[BSD SPORTS] Checking for finished football events...");
    try {
        const events = await fetchAllowedFootballEvents({
            status: 'finished',
            date_from: isoDaysFromNow(-7),
            date_to: new Date().toISOString(),
            limit: 20,
        });

        for (const event of events) {
            const market = await withBackoff(`bsd sports getMarketInfo finished ${event.id}`, () => contract.getMarketInfo(event.id));
            if (!market.exists || market.isSettled) continue;

            const homeScore = Number(event.home_score);
            const awayScore = Number(event.away_score);
            if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

            const isCanceled = homeScore === awayScore;
            const winner = homeScore > awayScore ? 0 : 1;
            console.log(`[BSD SPORTS] Settling football market: ${eventTitle(event)}`);

            const tx = await withBackoff(`bsd sports settle ${event.id}`, () =>
                contract.settle(event.id, winner, isCanceled, { gasLimit: SETTLE_MARKET_GAS_LIMIT }),
            );
            await withBackoff(`bsd sports wait settle ${event.id}`, () => tx.wait(), { retries: 1 });

            await syncEventMetadata(event, {
                isSettled: true,
                winningOutcome: winner,
                isCanceled,
            });
            console.log(`[BSD SPORTS] Market ${event.id} settled.`);
        }
    } catch (error) {
        console.error("[BSD SPORTS ERROR] Settler:", error.response?.data?.detail || error.message);
    }
}

async function syncEventMetadata(event, settlement = {}) {
    const title = eventTitle(event);
    const [homeLogoUrl, awayLogoUrl] = await Promise.all([
        getTeamLogoUrl(event.home_team),
        getTeamLogoUrl(event.away_team),
    ]);
    await upsertMarketMetadata({
        marketId: event.id,
        category: "Sports - Football",
        title,
        provider: "BSD Sports",
        leagueName: allowedLeagueName(event),
        homeName: event.home_team,
        awayName: event.away_team,
        homeLogoUrl,
        awayLogoUrl,
        startsAt: event.event_date,
        ...settlementMetadata(settlement),
        metadata: {
            leagueId: event.league_id,
            roundNumber: event.round_number,
            period: event.period,
            homeScore: event.home_score,
            awayScore: event.away_score,
            status: event.status,
            neutralGround: event.is_neutral_ground,
            localDerby: event.is_local_derby,
        },
    });
}

function settlementMetadata(settlement) {
    if (!settlement.isSettled) return {};
    return {
        status: settlement.isCanceled ? 'canceled' : 'resolved',
        resolvedAt: new Date().toISOString(),
        resolution: settlement.isCanceled ? 'canceled' : String(settlement.winningOutcome),
    };
}

async function main() {
    await autoCreateMarkets();
    await autoSettleMarkets();
}

startStaggeredLoop('oracle-sports', 15 * 60 * 1000, main);
