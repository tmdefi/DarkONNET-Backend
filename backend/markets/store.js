const { id: keccakId } = require('ethers');
const { JsonStore, MemoryStore } = require('../store/json-store');
const { getSupabaseClient, throwIfError } = require('../store/supabase-store');

const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

class MarketMetadataValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MarketMetadataValidationError';
        this.statusCode = 400;
    }
}

class MarketMetadataNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MarketMetadataNotFoundError';
        this.statusCode = 404;
    }
}

class JsonMarketMetadataStore {
    constructor(filePath) {
        this.store = new JsonStore(filePath);
    }

    async list(options = {}) {
        const db = await this.store.read();
        return sortMarkets(filterMarkets(Object.values(db.markets), options));
    }

    async get(marketId) {
        const db = await this.store.read();
        const market = findMarket(db.markets, marketId);
        if (!market) {
            throw new MarketMetadataNotFoundError('Market metadata was not found');
        }
        return market;
    }

    async upsert(input) {
        return this.store.update(async (db) => {
            const canonicalMarketId = getCanonicalMarketId(input);
            const existing = findMarket(db.markets, canonicalMarketId) || findMarket(db.markets, input.marketId);
            const market = buildMarketMetadata({ ...input, marketId: canonicalMarketId }, existing);
            if (existing?.marketId && existing.marketId !== market.marketId) {
                delete db.markets[existing.marketId];
            }
            db.markets[market.marketId] = market;
            return market;
        });
    }

    async addParticipant(marketId, walletAddress) {
        return this.store.update(async (db) => {
            const market = findMarket(db.markets, marketId);
            if (!market) {
                throw new MarketMetadataNotFoundError('Market metadata was not found');
            }
            const participant = normalizeWallet(walletAddress, 'walletAddress');
            const participants = new Set(Array.isArray(market.participants) ? market.participants : []);
            participants.add(participant);
            market.participants = Array.from(participants).sort();
            market.updatedAt = new Date().toISOString();
            return market;
        });
    }
}

class MemoryMarketMetadataStore {
    constructor(seed = {}) {
        this.store = new MemoryStore({ markets: seed });
    }

    async list(options = {}) {
        const db = await this.store.read();
        return sortMarkets(filterMarkets(Object.values(db.markets), options));
    }

    async get(marketId) {
        const db = await this.store.read();
        const market = findMarket(db.markets, marketId);
        if (!market) {
            throw new MarketMetadataNotFoundError('Market metadata was not found');
        }
        return market;
    }

    async upsert(input) {
        return this.store.update(async (db) => {
            const canonicalMarketId = getCanonicalMarketId(input);
            const existing = findMarket(db.markets, canonicalMarketId) || findMarket(db.markets, input.marketId);
            const market = buildMarketMetadata({ ...input, marketId: canonicalMarketId }, existing);
            if (existing?.marketId && existing.marketId !== market.marketId) {
                delete db.markets[existing.marketId];
            }
            db.markets[market.marketId] = market;
            return market;
        });
    }

    async addParticipant(marketId, walletAddress) {
        return this.store.update(async (db) => {
            const market = findMarket(db.markets, marketId);
            if (!market) {
                throw new MarketMetadataNotFoundError('Market metadata was not found');
            }
            const participant = normalizeWallet(walletAddress, 'walletAddress');
            const participants = new Set(Array.isArray(market.participants) ? market.participants : []);
            participants.add(participant);
            market.participants = Array.from(participants).sort();
            market.updatedAt = new Date().toISOString();
            return market;
        });
    }
}

class SupabaseMarketMetadataStore {
    constructor(client = getSupabaseClient()) {
        this.client = client;
    }

    async list(options = {}) {
        const { data, error } = await this.client.from('markets').select('*');
        throwIfError(error, 'Failed to list markets');
        return sortMarkets(filterMarkets((data || []).map(fromMarketRow), options));
    }

    async get(marketId) {
        const key = String(marketId || '').trim();
        if (!key) {
            throw new MarketMetadataNotFoundError('Market metadata was not found');
        }

        const { data, error } = await this.client
            .from('markets')
            .select('*')
            .or(`market_id.eq.${escapeSupabaseFilterValue(key)},onchain_market_id.eq.${escapeSupabaseFilterValue(key)},slug.eq.${escapeSupabaseFilterValue(key)}`)
            .limit(1)
            .maybeSingle();
        throwIfError(error, 'Failed to read market');
        if (!data) {
            throw new MarketMetadataNotFoundError('Market metadata was not found');
        }
        return fromMarketRow(data);
    }

    async upsert(input) {
        const canonicalMarketId = getCanonicalMarketId(input);
        let existing = null;
        try {
            existing = await this.get(input.marketId || canonicalMarketId);
        } catch (error) {
            if (error.statusCode !== 404) throw error;
        }

        const market = buildMarketMetadata({ ...input, marketId: canonicalMarketId }, existing);
        if (existing?.marketId && existing.marketId !== market.marketId) {
            const { error: deleteError } = await this.client.from('markets').delete().eq('market_id', existing.marketId);
            throwIfError(deleteError, 'Failed to replace legacy market id');
        }

        const { data, error } = await this.client
            .from('markets')
            .upsert(toMarketRow(market), { onConflict: 'market_id' })
            .select('*')
            .single();
        throwIfError(error, 'Failed to upsert market');
        return fromMarketRow(data);
    }

    async addParticipant(marketId, walletAddress) {
        const market = await this.get(marketId);
        const participant = normalizeWallet(walletAddress, 'walletAddress');
        const participants = new Set(Array.isArray(market.participants) ? market.participants : []);
        participants.add(participant);
        market.participants = Array.from(participants).sort();
        market.updatedAt = new Date().toISOString();

        const { data, error } = await this.client
            .from('markets')
            .update({ participants: market.participants, updated_at: market.updatedAt })
            .eq('market_id', market.marketId)
            .select('*')
            .single();
        throwIfError(error, 'Failed to add market participant');
        return fromMarketRow(data);
    }
}

function buildMarketMetadata(input, existing) {
    const now = new Date().toISOString();
    const marketId = normalizeRequiredString(input.marketId, 'marketId', 80);
    const legacySlug = existing?.slug || (existing?.marketId && existing.marketId !== marketId ? existing.marketId : null) || (/^\d+$/.test(marketId) ? null : marketId);
    const slug = normalizeOptionalString(input.slug, 120) || legacySlug;
    const category = normalizeRequiredString(input.category, 'category', 80);
    const title = normalizeRequiredString(input.title, 'title', 240);
    const description = normalizeOptionalString(input.description, 2000) || existing?.description || null;

    return {
        marketId,
        onchainMarketId:
            normalizeOptionalUintString(input.onchainMarketId) ||
            normalizeOptionalUintString(existing?.onchainMarketId) ||
            deriveOnchainMarketId(marketId),
        slug,
        category,
        title,
        description,
        provider: normalizeOptionalString(input.provider, 80),
        imageUrl: normalizeOptionalUrl(input.imageUrl, 'imageUrl'),
        homeName: normalizeOptionalString(input.homeName, 120),
        awayName: normalizeOptionalString(input.awayName, 120),
        homeLogoUrl: normalizeOptionalUrl(input.homeLogoUrl, 'homeLogoUrl'),
        awayLogoUrl: normalizeOptionalUrl(input.awayLogoUrl, 'awayLogoUrl'),
        leagueName: normalizeOptionalString(input.leagueName, 120),
        leagueLogoUrl: normalizeOptionalUrl(input.leagueLogoUrl, 'leagueLogoUrl'),
        sourceUrl: normalizeOptionalUrl(input.sourceUrl, 'sourceUrl'),
        sourceName: normalizeOptionalString(input.sourceName, 120),
        startsAt: normalizeOptionalString(input.startsAt, 80),
        creatorWalletAddress: normalizeOptionalWallet(input.creatorWalletAddress) || existing?.creatorWalletAddress || null,
        status: normalizeOptionalString(input.status, 40) || existing?.status || 'pending',
        acceptedAt: normalizeOptionalString(input.acceptedAt, 80) || existing?.acceptedAt || null,
        resolvedAt: normalizeOptionalString(input.resolvedAt, 80) || existing?.resolvedAt || null,
        resolution: normalizeOptionalString(input.resolution, 240) || existing?.resolution || null,
        participants: normalizeParticipants(input.participants, existing?.participants),
        metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
}

function getCanonicalMarketId(input) {
    return normalizeOptionalUintString(input.onchainMarketId) || normalizeRequiredString(input.marketId, 'marketId', 80);
}

function findMarket(markets, key) {
    if (!key) return null;
    const normalizedKey = String(key);
    return (
        markets[normalizedKey] ||
        Object.values(markets).find(
            (market) =>
                market?.marketId === normalizedKey ||
                market?.onchainMarketId === normalizedKey ||
                market?.slug === normalizedKey,
        ) ||
        null
    );
}

function normalizeRequiredString(value, fieldName, maxLength) {
    if (typeof value !== 'string') {
        throw new MarketMetadataValidationError(`${fieldName} is required`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new MarketMetadataValidationError(`${fieldName} is required`);
    }
    if (normalized.length > maxLength) {
        throw new MarketMetadataValidationError(`${fieldName} is too long`);
    }

    return normalized;
}

function normalizeOptionalString(value, maxLength) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        throw new MarketMetadataValidationError('Optional text fields must be strings');
    }

    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > maxLength) {
        throw new MarketMetadataValidationError('Optional text field is too long');
    }
    return normalized;
}

function normalizeOptionalUintString(value) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = typeof value === 'bigint' || typeof value === 'number' ? String(value) : normalizeOptionalString(value, 80);
    if (!normalized || !/^\d+$/.test(normalized)) {
        throw new MarketMetadataValidationError('onchainMarketId must be a uint256 decimal string');
    }
    return normalized.replace(/^0+(?=\d)/, '');
}

function deriveOnchainMarketId(marketId) {
    return BigInt(keccakId(marketId)).toString();
}

function normalizeOptionalUrl(value, fieldName) {
    const normalized = normalizeOptionalString(value, 2000);
    if (!normalized) return null;

    try {
        const url = new URL(normalized);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error('Unsupported protocol');
        }
        return url.toString();
    } catch {
        throw new MarketMetadataValidationError(`${fieldName} must be a valid URL`);
    }
}

function normalizeOptionalWallet(value) {
    if (value === undefined || value === null || value === '') return null;
    return normalizeWallet(value, 'creatorWalletAddress');
}

function normalizeWallet(value, fieldName) {
    const walletAddress = normalizeRequiredString(value, fieldName, 42);
    if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
        throw new MarketMetadataValidationError(`${fieldName} must be an Ethereum address`);
    }
    return walletAddress.toLowerCase();
}

function normalizeParticipants(value, existing = []) {
    const participants = new Set(Array.isArray(existing) ? existing : []);
    if (value === undefined || value === null) return Array.from(participants).sort();
    if (!Array.isArray(value)) {
        throw new MarketMetadataValidationError('participants must be an array of wallet addresses');
    }

    for (const participant of value) {
        participants.add(normalizeWallet(participant, 'participants'));
    }

    return Array.from(participants).sort();
}

function filterMarkets(markets, { includeEnded = false, now = Date.now() } = {}) {
    if (includeEnded) return markets;
    return markets.filter((market) => !isEndedMarket(market, now));
}

function isEndedMarket(market, now = Date.now()) {
    const status = String(market?.status || '').trim().toLowerCase();
    if (['resolved', 'declined', 'canceled', 'cancelled', 'closed', 'ended'].includes(status)) return true;
    if (market?.resolvedAt) return true;

    const endsAt = market?.metadata?.endsAt || market?.endsAt || market?.expiresAt || market?.startsAt;
    if (!endsAt) return false;

    const endsAtMs = Date.parse(endsAt);
    return Number.isFinite(endsAtMs) && endsAtMs <= now;
}

function sortMarkets(markets) {
    return markets.sort((a, b) => {
        if (a.startsAt && b.startsAt) return a.startsAt.localeCompare(b.startsAt);
        return b.updatedAt.localeCompare(a.updatedAt);
    });
}

function escapeSupabaseFilterValue(value) {
    return String(value).replace(/["'(),]/g, '\\$&');
}

function toMarketRow(market) {
    return {
        market_id: market.marketId,
        onchain_market_id: market.onchainMarketId,
        slug: market.slug,
        category: market.category,
        title: market.title,
        description: market.description,
        provider: market.provider,
        image_url: market.imageUrl,
        home_name: market.homeName,
        away_name: market.awayName,
        home_logo_url: market.homeLogoUrl,
        away_logo_url: market.awayLogoUrl,
        league_name: market.leagueName,
        league_logo_url: market.leagueLogoUrl,
        source_url: market.sourceUrl,
        source_name: market.sourceName,
        starts_at: market.startsAt,
        creator_wallet_address: market.creatorWalletAddress,
        status: market.status,
        accepted_at: market.acceptedAt,
        resolved_at: market.resolvedAt,
        resolution: market.resolution,
        participants: market.participants || [],
        metadata: market.metadata || {},
        created_at: market.createdAt,
        updated_at: market.updatedAt,
    };
}

function fromMarketRow(row) {
    return {
        marketId: row.market_id,
        onchainMarketId: row.onchain_market_id,
        slug: row.slug,
        category: row.category,
        title: row.title,
        description: row.description,
        provider: row.provider,
        imageUrl: row.image_url,
        homeName: row.home_name,
        awayName: row.away_name,
        homeLogoUrl: row.home_logo_url,
        awayLogoUrl: row.away_logo_url,
        leagueName: row.league_name,
        leagueLogoUrl: row.league_logo_url,
        sourceUrl: row.source_url,
        sourceName: row.source_name,
        startsAt: row.starts_at,
        creatorWalletAddress: row.creator_wallet_address,
        status: row.status,
        acceptedAt: row.accepted_at,
        resolvedAt: row.resolved_at,
        resolution: row.resolution,
        participants: Array.isArray(row.participants) ? row.participants : [],
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    JsonMarketMetadataStore,
    MarketMetadataNotFoundError,
    MarketMetadataValidationError,
    MemoryMarketMetadataStore,
    SupabaseMarketMetadataStore,
    isEndedMarket,
};
