const { getAddress, id: keccakId, verifyMessage } = require('ethers');

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const EMPTY_BODY_HASH = keccakId('');

class ApiAuthError extends Error {
    constructor(message, statusCode = 401) {
        super(message);
        this.name = 'ApiAuthError';
        this.statusCode = statusCode;
    }
}

class ReplayGuard {
    constructor({ ttlMs = AUTH_WINDOW_MS } = {}) {
        this.ttlMs = ttlMs;
        this.seen = new Map();
    }

    assertFresh(key, now = Date.now()) {
        for (const [entry, expiresAt] of this.seen.entries()) {
            if (expiresAt <= now) this.seen.delete(entry);
        }

        if (this.seen.has(key)) {
            throw new ApiAuthError('Authentication signature has already been used', 401);
        }

        this.seen.set(key, now + this.ttlMs);
    }
}

function buildAuthMessage({ walletAddress, method, path, timestamp, bodyHash }) {
    return [
        'DarkONNET API request',
        `Wallet: ${normalizeAddress(walletAddress)}`,
        `Method: ${String(method || '').toUpperCase()}`,
        `Path: ${path}`,
        `Timestamp: ${timestamp}`,
        `BodyHash: ${bodyHash || EMPTY_BODY_HASH}`,
    ].join('\n');
}

function getAdminWallets(value = process.env.API_ADMIN_WALLETS || '') {
    return new Set(
        String(value)
            .split(',')
            .map((wallet) => wallet.trim())
            .filter(Boolean)
            .map(normalizeAddress),
    );
}

function getAuthHeaders(req, url) {
    return {
        walletAddress:
            req.headers['x-darkonnet-wallet'] ||
            req.headers['x-wallet-address'] ||
            url.searchParams.get('authWallet') ||
            url.searchParams.get('walletAddress'),
        signature:
            req.headers['x-darkonnet-signature'] ||
            req.headers['x-wallet-signature'] ||
            url.searchParams.get('authSignature'),
        timestamp:
            req.headers['x-darkonnet-timestamp'] ||
            req.headers['x-wallet-timestamp'] ||
            url.searchParams.get('authTimestamp'),
    };
}

function getSessionToken(req, url) {
    const authorization = req.headers.authorization || '';
    const bearerMatch = String(authorization).match(/^Bearer\s+(.+)$/i);
    return (
        (bearerMatch && bearerMatch[1]) ||
        req.headers['x-darkonnet-session'] ||
        url.searchParams.get('authSession') ||
        ''
    );
}

async function verifyApiAuth({
    req,
    url,
    rawBody = '',
    expectedWalletAddress,
    adminWallets,
    requireAdmin = false,
    replayGuard,
    sessionStore,
}) {
    if (sessionStore) {
        const token = getSessionToken(req, url);
        if (token) {
            const session = await sessionStore.getSession(token);
            if (!session) {
                throw new ApiAuthError('API session is expired or invalid', 401);
            }

            const walletAddress = normalizeAddress(session.walletAddress);
            if (expectedWalletAddress && walletAddress !== normalizeAddress(expectedWalletAddress)) {
                throw new ApiAuthError('Authenticated wallet does not match this request', 403);
            }

            if (requireAdmin && !adminWallets.has(walletAddress)) {
                throw new ApiAuthError('Authenticated wallet is not an API admin', 403);
            }

            return walletAddress;
        }
    }

    return verifyWalletAuth({
        req,
        url,
        rawBody,
        expectedWalletAddress,
        adminWallets,
        requireAdmin,
        replayGuard,
    });
}

function verifyWalletAuth({
    req,
    url,
    rawBody = '',
    expectedWalletAddress,
    adminWallets,
    requireAdmin = false,
    replayGuard,
}) {
    const auth = getAuthHeaders(req, url);
    if (!auth.walletAddress || !auth.signature || !auth.timestamp) {
        throw new ApiAuthError('Missing wallet authentication headers', 401);
    }

    const walletAddress = normalizeAddress(auth.walletAddress);
    if (expectedWalletAddress && walletAddress !== normalizeAddress(expectedWalletAddress)) {
        throw new ApiAuthError('Authenticated wallet does not match this request', 403);
    }

    if (requireAdmin && !adminWallets.has(walletAddress)) {
        throw new ApiAuthError('Authenticated wallet is not an API admin', 403);
    }

    const timestamp = Number(auth.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > AUTH_WINDOW_MS) {
        throw new ApiAuthError('Authentication timestamp is expired or invalid', 401);
    }

    const bodyHash = keccakId(rawBody || '');
    const message = buildAuthMessage({
        walletAddress,
        method: req.method,
        path: url.pathname,
        timestamp,
        bodyHash,
    });
    const recovered = normalizeAddress(verifyMessage(message, auth.signature));
    if (recovered !== walletAddress) {
        throw new ApiAuthError('Invalid wallet signature', 401);
    }

    replayGuard?.assertFresh(`${walletAddress}:${auth.signature}`);
    return walletAddress;
}

function normalizeAddress(value) {
    try {
        return getAddress(String(value || '')).toLowerCase();
    } catch {
        throw new ApiAuthError('walletAddress must be an Ethereum address', 400);
    }
}

module.exports = {
    ApiAuthError,
    EMPTY_BODY_HASH,
    ReplayGuard,
    buildAuthMessage,
    getAdminWallets,
    normalizeAddress,
    verifyApiAuth,
    verifyWalletAuth,
};
