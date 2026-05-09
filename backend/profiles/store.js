const { JsonStore, MemoryStore } = require('../store/json-store');
const { getSupabaseClient, throwIfError } = require('../store/supabase-store');

const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

class ProfileValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProfileValidationError';
        this.statusCode = 400;
    }
}

class JsonProfileStore {
    constructor(filePath) {
        this.store = new JsonStore(filePath);
    }

    async get(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const db = await this.store.read();
        return db.profiles[wallet] || defaultProfile(wallet);
    }

    async upsert(walletAddress, input) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const profile = buildProfile(wallet, input, db.profiles[wallet]);
            db.profiles[wallet] = profile;
            return profile;
        });
    }
}

class MemoryProfileStore {
    constructor(seed = {}) {
        this.store = new MemoryStore({ profiles: seed });
    }

    async get(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const db = await this.store.read();
        return db.profiles[wallet] || defaultProfile(wallet);
    }

    async upsert(walletAddress, input) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const profile = buildProfile(wallet, input, db.profiles[wallet]);
            db.profiles[wallet] = profile;
            return profile;
        });
    }
}

class SupabaseProfileStore {
    constructor(client = getSupabaseClient()) {
        this.client = client;
    }

    async get(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const { data, error } = await this.client
            .from('profiles')
            .select('*')
            .eq('wallet_address', wallet)
            .maybeSingle();
        throwIfError(error, 'Failed to read profile');
        return data ? fromProfileRow(data) : defaultProfile(wallet);
    }

    async upsert(walletAddress, input) {
        const wallet = normalizeWallet(walletAddress);
        const existing = await this.get(wallet);
        const profile = buildProfile(wallet, input, existing.createdAt ? existing : null);
        const { data, error } = await this.client
            .from('profiles')
            .upsert(toProfileRow(profile), { onConflict: 'wallet_address' })
            .select('*')
            .single();
        throwIfError(error, 'Failed to upsert profile');
        return fromProfileRow(data);
    }
}

function buildProfile(walletAddress, input, existing) {
    const now = new Date().toISOString();
    return {
        walletAddress,
        profileName: normalizeRequiredString(input.profileName, 'profileName', 60),
        bio: normalizeOptionalString(input.bio, 500),
        email: normalizeOptionalEmail(input.email),
        profileImageDataUrl: normalizeOptionalImageDataUrl(input.profileImageDataUrl),
        receiveUpdates: input.receiveUpdates !== false,
        receivePositionNotifications: input.receivePositionNotifications !== false,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
}

function defaultProfile(walletAddress) {
    return {
        walletAddress,
        profileName: '',
        bio: '',
        email: '',
        profileImageDataUrl: '',
        receiveUpdates: true,
        receivePositionNotifications: true,
        createdAt: null,
        updatedAt: null,
    };
}

function normalizeRequiredString(value, fieldName, maxLength) {
    if (typeof value !== 'string') {
        throw new ProfileValidationError(`${fieldName} is required`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new ProfileValidationError(`${fieldName} is required`);
    }
    if (normalized.length > maxLength) {
        throw new ProfileValidationError(`${fieldName} is too long`);
    }
    return normalized;
}

function normalizeOptionalString(value, maxLength) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new ProfileValidationError('Optional profile fields must be strings');
    }

    const normalized = value.trim();
    if (normalized.length > maxLength) {
        throw new ProfileValidationError('Optional profile field is too long');
    }
    return normalized;
}

function normalizeOptionalEmail(value) {
    const normalized = normalizeOptionalString(value, 320);
    if (!normalized) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw new ProfileValidationError('email must be valid');
    }
    return normalized;
}

function normalizeOptionalImageDataUrl(value) {
    const normalized = normalizeOptionalString(value, 1_000_000);
    if (!normalized) return '';
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(normalized)) {
        throw new ProfileValidationError('profileImageDataUrl must be an image data URL');
    }
    return normalized;
}

function normalizeWallet(value) {
    if (typeof value !== 'string') {
        throw new ProfileValidationError('walletAddress is required');
    }
    const walletAddress = value.trim();
    if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
        throw new ProfileValidationError('walletAddress must be an Ethereum address');
    }
    return walletAddress.toLowerCase();
}

function toProfileRow(profile) {
    return {
        wallet_address: profile.walletAddress,
        profile_name: profile.profileName,
        bio: profile.bio,
        email: profile.email,
        profile_image_data_url: profile.profileImageDataUrl,
        receive_updates: profile.receiveUpdates,
        receive_position_notifications: profile.receivePositionNotifications,
        created_at: profile.createdAt,
        updated_at: profile.updatedAt,
    };
}

function fromProfileRow(row) {
    return {
        walletAddress: row.wallet_address,
        profileName: row.profile_name || '',
        bio: row.bio || '',
        email: row.email || '',
        profileImageDataUrl: row.profile_image_data_url || '',
        receiveUpdates: row.receive_updates !== false,
        receivePositionNotifications: row.receive_position_notifications !== false,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    JsonProfileStore,
    MemoryProfileStore,
    ProfileValidationError,
    SupabaseProfileStore,
};
