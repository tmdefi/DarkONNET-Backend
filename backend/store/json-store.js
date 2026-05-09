const fs = require('fs/promises');
const path = require('path');

const fileWriteQueues = new Map();

class JsonStore {
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
    }

    async read() {
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return normalizeDb(parsed);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return normalizeDb({});
            }
            throw error;
        }
    }

    async update(mutator) {
        const currentQueue = fileWriteQueues.get(this.filePath) || Promise.resolve();
        const next = currentQueue.then(async () => {
            const db = await this.read();
            const result = await mutator(db);
            await this.write(db);
            return result;
        });
        fileWriteQueues.set(this.filePath, next.catch(() => {}));
        return next;
    }

    async write(db) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        const serialized = `${JSON.stringify(normalizeDb(db), null, 2)}\n`;
        JSON.parse(serialized);
        await fs.writeFile(tmpPath, serialized);
        await fs.rename(tmpPath, this.filePath);
    }
}

class MemoryStore {
    constructor(seed = {}) {
        this.db = normalizeDb(seed);
    }

    async read() {
        return normalizeDb(JSON.parse(JSON.stringify(this.db)));
    }

    async update(mutator) {
        const result = await mutator(this.db);
        this.db = normalizeDb(this.db);
        return result;
    }
}

function normalizeDb(db) {
    return {
        comments: Array.isArray(db.comments) ? db.comments : [],
        markets: db.markets && typeof db.markets === 'object' && !Array.isArray(db.markets) ? db.markets : {},
        notifications: Array.isArray(db.notifications) ? db.notifications : [],
        profiles: db.profiles && typeof db.profiles === 'object' && !Array.isArray(db.profiles) ? db.profiles : {},
        authNonces: db.authNonces && typeof db.authNonces === 'object' && !Array.isArray(db.authNonces) ? db.authNonces : {},
        authSessions:
            db.authSessions && typeof db.authSessions === 'object' && !Array.isArray(db.authSessions)
                ? db.authSessions
                : {},
    };
}

module.exports = {
    JsonStore,
    MemoryStore,
};
