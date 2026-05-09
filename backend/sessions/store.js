const crypto = require('crypto');
const { JsonStore, MemoryStore } = require('../store/json-store');
const { ApiAuthError, normalizeAddress } = require('../auth');

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

class JsonSessionStore {
    constructor(filePath) {
        this.store = new JsonStore(filePath);
    }

    createNonce(walletAddress) {
        return createNonce(this.store, walletAddress);
    }

    consumeNonce(walletAddress, nonce) {
        return consumeNonce(this.store, walletAddress, nonce);
    }

    createSession(walletAddress) {
        return createSession(this.store, walletAddress);
    }

    getSession(token) {
        return getSession(this.store, token);
    }

    deleteSession(token) {
        return deleteSession(this.store, token);
    }
}

class MemorySessionStore {
    constructor(seed = {}) {
        this.store = new MemoryStore(seed);
    }

    createNonce(walletAddress) {
        return createNonce(this.store, walletAddress);
    }

    consumeNonce(walletAddress, nonce) {
        return consumeNonce(this.store, walletAddress, nonce);
    }

    createSession(walletAddress) {
        return createSession(this.store, walletAddress);
    }

    getSession(token) {
        return getSession(this.store, token);
    }

    deleteSession(token) {
        return deleteSession(this.store, token);
    }
}

async function createNonce(store, walletAddress) {
    const wallet = normalizeAddress(walletAddress);
    const now = Date.now();
    const nonce = randomToken(24);
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + NONCE_TTL_MS).toISOString();
    const message = buildLoginMessage({ walletAddress: wallet, nonce, issuedAt, expiresAt });
    const challenge = { walletAddress: wallet, nonce, issuedAt, expiresAt, message };

    await store.update((db) => {
        pruneExpired(db, now);
        db.authNonces[nonce] = challenge;
        return challenge;
    });

    return challenge;
}

async function consumeNonce(store, walletAddress, nonce) {
    const wallet = normalizeAddress(walletAddress);
    const nonceKey = String(nonce || '');
    return store.update((db) => {
        pruneExpired(db);
        const challenge = db.authNonces[nonceKey];
        if (!challenge) {
            throw new ApiAuthError('Login nonce is expired or invalid', 401);
        }
        if (challenge.walletAddress !== wallet) {
            throw new ApiAuthError('Login nonce does not match this wallet', 403);
        }
        delete db.authNonces[nonceKey];
        return challenge;
    });
}

async function createSession(store, walletAddress) {
    const wallet = normalizeAddress(walletAddress);
    const now = Date.now();
    const token = randomToken(32);
    const session = {
        token,
        walletAddress: wallet,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };

    await store.update((db) => {
        pruneExpired(db, now);
        db.authSessions[token] = session;
        return session;
    });

    return session;
}

async function getSession(store, token) {
    const sessionToken = String(token || '');
    if (!sessionToken) return null;

    return store.update((db) => {
        pruneExpired(db);
        return db.authSessions[sessionToken] || null;
    });
}

async function deleteSession(store, token) {
    const sessionToken = String(token || '');
    if (!sessionToken) return false;

    return store.update((db) => {
        const existed = Boolean(db.authSessions[sessionToken]);
        delete db.authSessions[sessionToken];
        return existed;
    });
}

function buildLoginMessage({ walletAddress, nonce, issuedAt, expiresAt }) {
    return [
        'DarkONNET wallet login',
        `Wallet: ${normalizeAddress(walletAddress)}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
        `Expires At: ${expiresAt}`,
    ].join('\n');
}

function pruneExpired(db, now = Date.now()) {
    for (const [nonce, challenge] of Object.entries(db.authNonces || {})) {
        if (Date.parse(challenge.expiresAt) <= now) delete db.authNonces[nonce];
    }

    for (const [token, session] of Object.entries(db.authSessions || {})) {
        if (Date.parse(session.expiresAt) <= now) delete db.authSessions[token];
    }
}

function randomToken(byteLength) {
    return crypto.randomBytes(byteLength).toString('base64url');
}

module.exports = {
    JsonSessionStore,
    MemorySessionStore,
    buildLoginMessage,
};
