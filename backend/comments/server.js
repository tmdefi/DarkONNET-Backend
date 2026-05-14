const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { WebSocket, WebSocketServer } = require('ws');
const { verifyMessage } = require('ethers');
const { JsonCommentStore, SupabaseCommentStore, buildThread } = require('./store');
const { JsonMarketMetadataStore, SupabaseMarketMetadataStore } = require('../markets/store');
const { JsonNotificationStore, SupabaseNotificationStore, normalizeWallet } = require('../notifications/store');
const { JsonProfileStore, SupabaseProfileStore } = require('../profiles/store');
const { ApiAuthError, ReplayGuard, getAdminWallets, normalizeAddress, verifyApiAuth } = require('../auth');
const { JsonSessionStore } = require('../sessions/store');
const { shouldUseSupabase } = require('../store/supabase-store');

const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'darkonnet-api.json');

function createCommentsServer({
    store,
    commentStore,
    marketStore,
    notificationStore,
    profileStore,
    sessionStore,
    allowedOrigin = '*',
    authRequired = process.env.API_AUTH_REQUIRED !== 'false',
    adminWallets = getAdminWallets(),
    replayGuard = new ReplayGuard(),
} = {}) {
    const dbPath = process.env.API_DB_PATH || process.env.COMMENTS_DB_PATH || DEFAULT_DB_PATH;
    const useSupabase = shouldUseSupabase();
    const comments = commentStore || store || (useSupabase ? new SupabaseCommentStore() : new JsonCommentStore(dbPath));
    const markets = marketStore || (useSupabase ? new SupabaseMarketMetadataStore() : new JsonMarketMetadataStore(dbPath));
    const notifications = notificationStore || (useSupabase ? new SupabaseNotificationStore() : new JsonNotificationStore(dbPath));
    const profiles = profileStore || (useSupabase ? new SupabaseProfileStore() : new JsonProfileStore(dbPath));
    const sessions = sessionStore || new JsonSessionStore(dbPath);
    const notificationHub = new NotificationHub();

    const server = http.createServer(async (req, res) => {
        setCorsHeaders(res, allowedOrigin);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
                sendJson(res, 200, { ok: true });
                return;
            }

            const authRoute = matchAuthRoute(req.method, url.pathname);
            if (authRoute) {
                await handleAuthRoute(authRoute, req, res, sessions, { url });
                return;
            }

            const notificationsRoute = matchNotificationsRoute(req.method, url.pathname);
            if (notificationsRoute) {
                await handleNotificationsRoute(notificationsRoute, req, res, notifications, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            const profileRoute = matchProfileRoute(req.method, url.pathname);
            if (profileRoute) {
                await handleProfileRoute(profileRoute, req, res, profiles, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            const participantsRoute = matchMarketParticipantsRoute(req.method, url.pathname);
            if (participantsRoute) {
                await handleParticipantsRoute(participantsRoute, req, res, markets, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            const marketsRoute = matchMarketsRoute(req.method, url.pathname);
            if (marketsRoute) {
                await handleMarketsRoute(marketsRoute, req, res, markets, notifications, notificationHub, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            const commentsRoute = matchMarketCommentsRoute(req.method, url.pathname);
            if (commentsRoute) {
                await handleCommentsRoute(commentsRoute, req, res, comments, notifications, notificationHub, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            const commentLikesRoute = matchCommentLikesRoute(req.method, url.pathname);
            if (commentLikesRoute) {
                await handleCommentLikesRoute(commentLikesRoute, req, res, comments, notifications, notificationHub, {
                    authRequired,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                    url,
                });
                return;
            }

            sendJson(res, 404, { error: 'Not found' });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error' : error.message });
        }
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/ws/notifications') {
            socket.destroy();
            return;
        }

        let walletAddress;
        try {
            walletAddress = normalizeWallet(url.searchParams.get('walletAddress'));
            if (authRequired) {
                await verifyApiAuth({
                    req,
                    url,
                    expectedWalletAddress: walletAddress,
                    adminWallets,
                    replayGuard,
                    sessionStore: sessions,
                });
            }
        } catch {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            notificationHub.add(walletAddress, ws);
            ws.send(JSON.stringify({ type: 'notifications.ready', walletAddress }));
        });
    });
    const closeHttpServer = server.close.bind(server);
    server.close = (callback) => {
        for (const client of wss.clients) {
            client.terminate();
        }
        wss.close();
        return closeHttpServer(callback);
    };

    return server;
}

async function handleAuthRoute(route, req, res, sessionStore, authContext) {
    if (route.action === 'nonce') {
        const body = await readJsonBody(req);
        const challenge = await sessionStore.createNonce(body.walletAddress);
        sendJson(res, 200, {
            walletAddress: challenge.walletAddress,
            nonce: challenge.nonce,
            issuedAt: challenge.issuedAt,
            expiresAt: challenge.expiresAt,
            message: challenge.message,
        });
        return;
    }

    if (route.action === 'login') {
        const body = await readJsonBody(req);
        const walletAddress = normalizeAddress(body.walletAddress);
        const challenge = await sessionStore.consumeNonce(walletAddress, body.nonce);
        const recovered = normalizeAddress(verifyMessage(challenge.message, body.signature || ''));
        if (recovered !== walletAddress) {
            throw new ApiAuthError('Invalid login signature', 401);
        }

        const session = await sessionStore.createSession(walletAddress);
        sendJson(res, 200, { session: publicSession(session) });
        return;
    }

    const sessionWallet = await verifyApiAuth({
        req,
        url: authContext.url,
        sessionStore,
        adminWallets: getAdminWallets(),
    });

    if (route.action === 'logout') {
        const token = getBearerToken(req);
        if (token) await sessionStore.deleteSession(token);
        sendJson(res, 200, { ok: true });
        return;
    }

    sendJson(res, 200, { session: { walletAddress: sessionWallet } });
}

async function handleMarketsRoute(route, req, res, marketStore, notificationStore, notificationHub, authContext) {
    if (req.method === 'GET' && route.marketId) {
        const market = await marketStore.get(route.marketId);
        sendJson(res, 200, { market: publicMarket(market) });
        return;
    }

    if (req.method === 'GET') {
        const markets = await marketStore.list({
            includeEnded: isTruthyQueryParam(authContext.url.searchParams.get('includeEnded')),
        });
        sendJson(res, 200, { markets: markets.map(publicMarket) });
        return;
    }

    const body = await readJsonBody(req);
    if (authContext.authRequired) {
        const status = normalizeMarketStatus(body.status);
        const isAdminMutation =
            status === 'accepted' || status === 'declined' || status === 'resolved' || !body.creatorWalletAddress;
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.rawBody,
            expectedWalletAddress: isAdminMutation ? undefined : body.creatorWalletAddress,
            adminWallets: authContext.adminWallets,
            requireAdmin: isAdminMutation,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }
    const existing = route.marketId || body.marketId ? await tryGetMarket(marketStore, route.marketId || body.marketId) : null;
    const market = await marketStore.upsert({
        ...body,
        marketId: route.marketId || body.marketId,
    });
    await createMarketTransitionNotifications(existing, market, notificationStore, notificationHub);
    sendJson(res, 200, { market });
}

async function handleParticipantsRoute(route, req, res, marketStore, authContext) {
    const body = await readJsonBody(req);
    if (authContext.authRequired) {
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.rawBody,
            expectedWalletAddress: body.walletAddress,
            adminWallets: authContext.adminWallets,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }
    const market = await marketStore.addParticipant(route.marketId, body.walletAddress);
    sendJson(res, 200, { market: publicMarket(market) });
}

async function handleNotificationsRoute(route, req, res, notificationStore, authContext) {
    if (authContext.authRequired) {
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.method === 'GET' ? '' : await readRawBody(req),
            expectedWalletAddress: route.walletAddress,
            adminWallets: authContext.adminWallets,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }

    if (req.method === 'GET') {
        const notifications = await notificationStore.listByWallet(route.walletAddress);
        sendJson(res, 200, { notifications });
        return;
    }

    if (req.method === 'PATCH' && route.notificationId) {
        const notification = await notificationStore.markRead(route.walletAddress, route.notificationId);
        sendJson(res, notification ? 200 : 404, notification ? { notification } : { error: 'Notification was not found' });
        return;
    }

    const count = await notificationStore.markAllRead(route.walletAddress);
    sendJson(res, 200, { markedRead: count });
}

async function handleProfileRoute(route, req, res, profileStore, authContext) {
    if (authContext.authRequired) {
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.method === 'GET' ? '' : await readRawBody(req),
            expectedWalletAddress: route.walletAddress,
            adminWallets: authContext.adminWallets,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }

    if (req.method === 'GET') {
        const profile = await profileStore.get(route.walletAddress);
        sendJson(res, 200, { profile });
        return;
    }

    const body = await readJsonBody(req);
    const profile = await profileStore.upsert(route.walletAddress, body);
    sendJson(res, 200, { profile });
}

async function handleCommentsRoute(route, req, res, commentStore, notificationStore, notificationHub, authContext) {
    if (req.method === 'GET') {
        const comments = await commentStore.listByMarket(route.marketId);
        sendJson(res, 200, { marketId: route.marketId, comments: buildThread(comments) });
        return;
    }

    const body = await readJsonBody(req);
    if (authContext.authRequired) {
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.rawBody,
            expectedWalletAddress: body.walletAddress,
            adminWallets: authContext.adminWallets,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }
    const existingComments = body.parentId ? await commentStore.listByMarket(route.marketId) : [];
    const parent = body.parentId ? existingComments.find((comment) => comment.id === body.parentId) : null;
    const comment = await commentStore.create({
        marketId: route.marketId,
        walletAddress: body.walletAddress,
        displayName: body.displayName,
        body: body.body,
        parentId: body.parentId,
    });

    if (parent && parent.walletAddress !== comment.walletAddress) {
        await createAndPublishNotification(notificationStore, notificationHub, {
            walletAddress: parent.walletAddress,
            type: 'comment.reply',
            title: 'New reply to your comment',
            body: `${comment.displayName} replied to your comment.`,
            marketId: route.marketId,
            commentId: comment.id,
            metadata: {
                parentCommentId: parent.id,
                replyAuthorWalletAddress: comment.walletAddress,
            },
        });
    }

    sendJson(res, 201, { comment });
}

async function handleCommentLikesRoute(route, req, res, commentStore, notificationStore, notificationHub, authContext) {
    const body = await readJsonBody(req);
    if (authContext.authRequired) {
        await verifyApiAuth({
            req,
            url: authContext.url,
            rawBody: req.rawBody,
            expectedWalletAddress: body.walletAddress,
            adminWallets: authContext.adminWallets,
            replayGuard: authContext.replayGuard,
            sessionStore: authContext.sessionStore,
        });
    }

    const liked = body.liked !== false;
    const result = await commentStore.setLike(route.marketId, route.commentId, body.walletAddress, liked);

    if (
        liked &&
        result.changed &&
        result.comment.walletAddress &&
        result.comment.walletAddress !== result.likerWalletAddress
    ) {
        await createAndPublishNotification(notificationStore, notificationHub, {
            walletAddress: result.comment.walletAddress,
            type: 'comment.like',
            title: 'New like on your comment',
            body: 'Someone liked your comment.',
            marketId: route.marketId,
            commentId: result.comment.id,
            metadata: {
                likerWalletAddress: result.likerWalletAddress,
            },
        });
    }

    sendJson(res, 200, { comment: result.comment, liked: result.liked });
}

function matchAuthRoute(method, pathname) {
    if (method === 'POST' && pathname === '/api/auth/nonce') return { action: 'nonce' };
    if (method === 'POST' && pathname === '/api/auth/login') return { action: 'login' };
    if (method === 'POST' && pathname === '/api/auth/logout') return { action: 'logout' };
    if (method === 'GET' && pathname === '/api/auth/me') return { action: 'me' };
    return null;
}

function matchMarketsRoute(method, pathname) {
    if (method !== 'GET' && method !== 'PUT' && method !== 'POST') return null;

    if (pathname === '/api/markets') {
        return { marketId: null };
    }

    const match = pathname.match(/^\/api\/markets\/([^/]+)$/);
    if (!match) return null;

    return { marketId: decodeURIComponent(match[1]) };
}

function getBearerToken(req) {
    const authorization = String(req.headers.authorization || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : '';
}

function publicSession(session) {
    return {
        token: session.token,
        walletAddress: session.walletAddress,
        expiresAt: session.expiresAt,
    };
}

function publicMarket(market) {
    if (!market || typeof market !== 'object') return market;
    const { participants, ...publicFields } = market;
    return publicFields;
}

function matchMarketParticipantsRoute(method, pathname) {
    if (method !== 'POST') return null;

    const match = pathname.match(/^\/api\/markets\/([^/]+)\/participants$/);
    if (!match) return null;

    return { marketId: decodeURIComponent(match[1]) };
}

function matchMarketCommentsRoute(method, pathname) {
    if (method !== 'GET' && method !== 'POST') return null;

    const match = pathname.match(/^\/api\/markets\/([^/]+)\/comments$/);
    if (!match) return null;

    return { marketId: decodeURIComponent(match[1]) };
}

function matchCommentLikesRoute(method, pathname) {
    if (method !== 'POST') return null;

    const match = pathname.match(/^\/api\/markets\/([^/]+)\/comments\/([^/]+)\/like$/);
    if (!match) return null;

    return {
        marketId: decodeURIComponent(match[1]),
        commentId: decodeURIComponent(match[2]),
    };
}

function matchNotificationsRoute(method, pathname) {
    if (method !== 'GET' && method !== 'PATCH' && method !== 'POST') return null;

    const listMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/notifications$/);
    if (listMatch) {
        return { walletAddress: decodeURIComponent(listMatch[1]), notificationId: null };
    }

    const itemMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/notifications\/([^/]+)$/);
    if (itemMatch) {
        return {
            walletAddress: decodeURIComponent(itemMatch[1]),
            notificationId: decodeURIComponent(itemMatch[2]),
        };
    }

    return null;
}

function matchProfileRoute(method, pathname) {
    if (method !== 'GET' && method !== 'PUT') return null;

    const match = pathname.match(/^\/api\/wallets\/([^/]+)\/profile$/);
    if (!match) return null;

    return { walletAddress: decodeURIComponent(match[1]) };
}

async function tryGetMarket(marketStore, marketId) {
    if (!marketId) return null;
    try {
        return await marketStore.get(marketId);
    } catch (error) {
        if (error.statusCode === 404) return null;
        throw error;
    }
}

async function createMarketTransitionNotifications(existing, market, notificationStore, notificationHub) {
    if (isNewStatus(existing, market, 'accepted') && market.creatorWalletAddress) {
        await createAndPublishNotification(notificationStore, notificationHub, {
            walletAddress: market.creatorWalletAddress,
            type: 'market.accepted',
            title: 'Market accepted',
            body: `Your market "${market.title}" was accepted.`,
            marketId: market.marketId,
            metadata: { title: market.title },
        });
    }

    if (!isNewStatus(existing, market, 'resolved')) return;

    for (const walletAddress of market.participants || []) {
        await createAndPublishNotification(notificationStore, notificationHub, {
            walletAddress,
            type: 'market.resolved',
            title: 'Market resolved',
            body: `A market you participated in was resolved: ${market.title}`,
            marketId: market.marketId,
            metadata: {
                title: market.title,
                resolution: market.resolution,
            },
        });
    }
}

function isNewStatus(existing, market, status) {
    return market.status === status && existing?.status !== status;
}

async function createAndPublishNotification(notificationStore, notificationHub, input) {
    const notification = await notificationStore.create(input);
    notificationHub.publish(notification.walletAddress, {
        type: 'notification.created',
        notification,
    });
    return notification;
}

function readJsonBody(req) {
    if (req.parsedBody !== undefined) {
        return Promise.resolve(req.parsedBody);
    }

    return readRawBody(req).then((raw) => {
        if (!raw) {
            req.parsedBody = {};
            return req.parsedBody;
        }

        try {
            req.parsedBody = JSON.parse(raw);
            return req.parsedBody;
        } catch {
            throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
        }
    });
}

function readRawBody(req) {
    if (req.rawBody !== undefined) {
        return Promise.resolve(req.rawBody);
    }

    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 5_000_000) {
                reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
                req.destroy();
            }
        });
        req.on('end', () => {
            req.rawBody = raw;
            resolve(raw);
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function setCorsHeaders(res, allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-DarkONNET-Session,X-DarkONNET-Wallet,X-DarkONNET-Signature,X-DarkONNET-Timestamp',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
}

function normalizeMarketStatus(status) {
    return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function isTruthyQueryParam(value) {
    return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

class NotificationHub {
    constructor() {
        this.connectionsByWallet = new Map();
    }

    add(walletAddress, ws) {
        if (!this.connectionsByWallet.has(walletAddress)) {
            this.connectionsByWallet.set(walletAddress, new Set());
        }

        const connections = this.connectionsByWallet.get(walletAddress);
        connections.add(ws);
        ws.on('close', () => {
            connections.delete(ws);
            if (connections.size === 0) {
                this.connectionsByWallet.delete(walletAddress);
            }
        });
    }

    publish(walletAddress, payload) {
        const connections = this.connectionsByWallet.get(walletAddress);
        if (!connections) return;

        const message = JSON.stringify(payload);
        for (const ws of connections) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
}

if (require.main === module) {
    const port = Number(process.env.PORT || process.env.COMMENTS_PORT || DEFAULT_PORT);
    const host = process.env.HOST || '0.0.0.0';
    const server = createCommentsServer();
    server.listen(port, host, () => {
        console.log(`Comments API listening on http://${host}:${port}`);
    });
}

module.exports = {
    createCommentsServer,
};
