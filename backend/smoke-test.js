const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCommentsServer } = require('./comments/server');

async function main() {
    const dbPath = path.join(os.tmpdir(), `darkonnet-smoke-${process.pid}.json`);
    process.env.API_STORE = 'json';
    process.env.API_DB_PATH = dbPath;

    const server = createCommentsServer({ authRequired: false });
    await listen(server);

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const walletAddress = '0x1111111111111111111111111111111111111111';

    try {
        await expectJson(`${baseUrl}/health`, { ok: true });

        const market = await requestJson(`${baseUrl}/api/markets/smoke-market`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                marketId: 'smoke-market',
                category: 'test',
                title: 'Smoke Market',
                creatorWalletAddress: walletAddress,
                status: 'pending',
            }),
        });
        assert(market.market?.marketId === 'smoke-market', 'market upsert failed');

        const comment = await requestJson(`${baseUrl}/api/markets/smoke-market/comments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                walletAddress,
                displayName: 'Smoke',
                body: 'Works',
            }),
        });
        assert(comment.comment?.id, 'comment create failed');

        const comments = await requestJson(`${baseUrl}/api/markets/smoke-market/comments`);
        assert(comments.comments?.length === 1, 'comment list failed');

        console.log('backend-smoke-ok');
    } finally {
        await close(server);
        await fs.rm(dbPath, { force: true });
    }
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

async function expectJson(url, expected) {
    const actual = await requestJson(url);
    for (const [key, value] of Object.entries(expected)) {
        assert(actual[key] === value, `${url} returned unexpected ${key}`);
    }
}

async function requestJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`${url} returned invalid JSON: ${text}`);
    }

    if (!response.ok) {
        throw new Error(`${url} returned ${response.status}: ${text}`);
    }

    return body;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
