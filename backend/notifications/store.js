const crypto = require('crypto');
const { JsonStore, MemoryStore } = require('../store/json-store');
const { getSupabaseClient, throwIfError } = require('../store/supabase-store');

const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

class NotificationValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotificationValidationError';
        this.statusCode = 400;
    }
}

class JsonNotificationStore {
    constructor(filePath) {
        this.store = new JsonStore(filePath);
    }

    async listByWallet(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const db = await this.store.read();
        return sortNotifications(db.notifications.filter((notification) => notification.walletAddress === wallet));
    }

    async create(input) {
        return this.store.update(async (db) => {
            const notification = buildNotification(input);
            db.notifications.push(notification);
            return notification;
        });
    }

    async markRead(walletAddress, notificationId) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const notification = db.notifications.find((item) => item.id === notificationId && item.walletAddress === wallet);
            if (!notification) return null;
            notification.readAt = notification.readAt || new Date().toISOString();
            return notification;
        });
    }

    async markAllRead(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const now = new Date().toISOString();
            let count = 0;
            for (const notification of db.notifications) {
                if (notification.walletAddress === wallet && !notification.readAt) {
                    notification.readAt = now;
                    count += 1;
                }
            }
            return count;
        });
    }
}

class MemoryNotificationStore {
    constructor(seed = []) {
        this.store = new MemoryStore({ notifications: seed });
    }

    async listByWallet(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const db = await this.store.read();
        return sortNotifications(db.notifications.filter((notification) => notification.walletAddress === wallet));
    }

    async create(input) {
        return this.store.update(async (db) => {
            const notification = buildNotification(input);
            db.notifications.push(notification);
            return notification;
        });
    }

    async markRead(walletAddress, notificationId) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const notification = db.notifications.find((item) => item.id === notificationId && item.walletAddress === wallet);
            if (!notification) return null;
            notification.readAt = notification.readAt || new Date().toISOString();
            return notification;
        });
    }

    async markAllRead(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        return this.store.update(async (db) => {
            const now = new Date().toISOString();
            let count = 0;
            for (const notification of db.notifications) {
                if (notification.walletAddress === wallet && !notification.readAt) {
                    notification.readAt = now;
                    count += 1;
                }
            }
            return count;
        });
    }
}

class SupabaseNotificationStore {
    constructor(client = getSupabaseClient()) {
        this.client = client;
    }

    async listByWallet(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const { data, error } = await this.client
            .from('notifications')
            .select('*')
            .eq('wallet_address', wallet)
            .order('created_at', { ascending: false });
        throwIfError(error, 'Failed to list notifications');
        return (data || []).map(fromNotificationRow);
    }

    async create(input) {
        const notification = buildNotification(input);
        const { data, error } = await this.client
            .from('notifications')
            .insert(toNotificationRow(notification))
            .select('*')
            .single();
        throwIfError(error, 'Failed to create notification');
        return fromNotificationRow(data);
    }

    async markRead(walletAddress, notificationId) {
        const wallet = normalizeWallet(walletAddress);
        const readAt = new Date().toISOString();
        const { data, error } = await this.client
            .from('notifications')
            .update({ read_at: readAt })
            .eq('wallet_address', wallet)
            .eq('id', String(notificationId || ''))
            .is('read_at', null)
            .select('*')
            .maybeSingle();
        throwIfError(error, 'Failed to mark notification read');
        if (data) return fromNotificationRow(data);

        const { data: existing, error: readError } = await this.client
            .from('notifications')
            .select('*')
            .eq('wallet_address', wallet)
            .eq('id', String(notificationId || ''))
            .maybeSingle();
        throwIfError(readError, 'Failed to read notification');
        return existing ? fromNotificationRow(existing) : null;
    }

    async markAllRead(walletAddress) {
        const wallet = normalizeWallet(walletAddress);
        const readAt = new Date().toISOString();
        const { data, error } = await this.client
            .from('notifications')
            .update({ read_at: readAt })
            .eq('wallet_address', wallet)
            .is('read_at', null)
            .select('id');
        throwIfError(error, 'Failed to mark notifications read');
        return (data || []).length;
    }
}

function buildNotification(input) {
    const now = new Date().toISOString();
    const type = normalizeRequiredString(input.type, 'type', 80);

    return {
        id: crypto.randomUUID(),
        walletAddress: normalizeWallet(input.walletAddress),
        type,
        title: normalizeRequiredString(input.title, 'title', 160),
        body: normalizeRequiredString(input.body, 'body', 500),
        marketId: normalizeOptionalString(input.marketId, 80),
        commentId: normalizeOptionalString(input.commentId, 80),
        metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
        readAt: null,
        createdAt: now,
    };
}

function normalizeWallet(value) {
    const walletAddress = normalizeRequiredString(value, 'walletAddress', 42);
    if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
        throw new NotificationValidationError('walletAddress must be an Ethereum address');
    }
    return walletAddress.toLowerCase();
}

function normalizeRequiredString(value, fieldName, maxLength) {
    if (typeof value !== 'string') {
        throw new NotificationValidationError(`${fieldName} is required`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new NotificationValidationError(`${fieldName} is required`);
    }
    if (normalized.length > maxLength) {
        throw new NotificationValidationError(`${fieldName} is too long`);
    }

    return normalized;
}

function normalizeOptionalString(value, maxLength) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        throw new NotificationValidationError('Optional text fields must be strings');
    }

    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > maxLength) {
        throw new NotificationValidationError('Optional text field is too long');
    }
    return normalized;
}

function sortNotifications(notifications) {
    return notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function toNotificationRow(notification) {
    return {
        id: notification.id,
        wallet_address: notification.walletAddress,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        market_id: notification.marketId,
        comment_id: notification.commentId,
        metadata: notification.metadata || {},
        read_at: notification.readAt,
        created_at: notification.createdAt,
    };
}

function fromNotificationRow(row) {
    return {
        id: row.id,
        walletAddress: row.wallet_address,
        type: row.type,
        title: row.title,
        body: row.body,
        marketId: row.market_id,
        commentId: row.comment_id,
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        readAt: row.read_at,
        createdAt: row.created_at,
    };
}

module.exports = {
    JsonNotificationStore,
    MemoryNotificationStore,
    NotificationValidationError,
    SupabaseNotificationStore,
    normalizeWallet,
};
