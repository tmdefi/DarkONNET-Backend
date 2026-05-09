const crypto = require('crypto');
const { JsonStore, MemoryStore } = require('../store/json-store');
const { getSupabaseClient, throwIfError } = require('../store/supabase-store');

const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

class CommentValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommentValidationError';
        this.statusCode = 400;
    }
}

class CommentNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommentNotFoundError';
        this.statusCode = 404;
    }
}

class JsonCommentStore {
    constructor(filePath) {
        this.store = new JsonStore(filePath);
    }

    async listByMarket(marketId) {
        const db = await this.store.read();
        return db.comments
            .filter((comment) => comment.marketId === marketId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async create(commentInput) {
        return this.store.update(async (db) => {
            const comment = buildComment(commentInput, db.comments);
            db.comments.push(comment);
            return comment;
        });
    }

    async setLike(marketId, commentId, walletAddress, liked) {
        return this.store.update(async (db) => {
            const comment = db.comments.find((item) => item.marketId === marketId && item.id === commentId);
            if (!comment) {
                throw new CommentNotFoundError('Comment was not found for this market');
            }

            const wallet = normalizeWallet(walletAddress);
            const likedBy = new Set(Array.isArray(comment.likedBy) ? comment.likedBy : []);
            const hadLiked = likedBy.has(wallet);
            if (liked) {
                likedBy.add(wallet);
            } else {
                likedBy.delete(wallet);
            }

            comment.likedBy = Array.from(likedBy).sort();
            comment.updatedAt = new Date().toISOString();
            return {
                comment,
                changed: liked ? !hadLiked : hadLiked,
                liked: likedBy.has(wallet),
                likerWalletAddress: wallet,
            };
        });
    }
}

class MemoryCommentStore {
    constructor(seed = []) {
        this.store = new MemoryStore({ comments: seed });
    }

    async listByMarket(marketId) {
        const db = await this.store.read();
        return db.comments
            .filter((comment) => comment.marketId === marketId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async create(commentInput) {
        return this.store.update(async (db) => {
            const comment = buildComment(commentInput, db.comments);
            db.comments.push(comment);
            return comment;
        });
    }

    async setLike(marketId, commentId, walletAddress, liked) {
        return this.store.update(async (db) => {
            const comment = db.comments.find((item) => item.marketId === marketId && item.id === commentId);
            if (!comment) {
                throw new CommentNotFoundError('Comment was not found for this market');
            }

            const wallet = normalizeWallet(walletAddress);
            const likedBy = new Set(Array.isArray(comment.likedBy) ? comment.likedBy : []);
            const hadLiked = likedBy.has(wallet);
            if (liked) {
                likedBy.add(wallet);
            } else {
                likedBy.delete(wallet);
            }

            comment.likedBy = Array.from(likedBy).sort();
            comment.updatedAt = new Date().toISOString();
            return {
                comment,
                changed: liked ? !hadLiked : hadLiked,
                liked: likedBy.has(wallet),
                likerWalletAddress: wallet,
            };
        });
    }
}

class SupabaseCommentStore {
    constructor(client = getSupabaseClient()) {
        this.client = client;
    }

    async listByMarket(marketId) {
        const normalizedMarketId = normalizeRequiredString(marketId, 'marketId', 80);
        const { data, error } = await this.client
            .from('comments')
            .select('*')
            .eq('market_id', normalizedMarketId)
            .order('created_at', { ascending: true });
        throwIfError(error, 'Failed to list comments');
        return (data || []).map(fromCommentRow);
    }

    async create(commentInput) {
        const existingComments = commentInput.parentId ? await this.listByMarket(commentInput.marketId) : [];
        const comment = buildComment(commentInput, existingComments);
        const { data, error } = await this.client.from('comments').insert(toCommentRow(comment)).select('*').single();
        throwIfError(error, 'Failed to create comment');
        return fromCommentRow(data);
    }

    async setLike(marketId, commentId, walletAddress, liked) {
        const normalizedMarketId = normalizeRequiredString(marketId, 'marketId', 80);
        const normalizedCommentId = normalizeRequiredString(commentId, 'commentId', 80);
        const wallet = normalizeWallet(walletAddress);

        const { data: existing, error: readError } = await this.client
            .from('comments')
            .select('*')
            .eq('market_id', normalizedMarketId)
            .eq('id', normalizedCommentId)
            .single();
        if (readError?.code === 'PGRST116') {
            throw new CommentNotFoundError('Comment was not found for this market');
        }
        throwIfError(readError, 'Failed to read comment');

        const comment = fromCommentRow(existing);
        const likedBy = new Set(Array.isArray(comment.likedBy) ? comment.likedBy : []);
        const hadLiked = likedBy.has(wallet);
        if (liked) {
            likedBy.add(wallet);
        } else {
            likedBy.delete(wallet);
        }

        const updatedAt = new Date().toISOString();
        const { data, error } = await this.client
            .from('comments')
            .update({ liked_by: Array.from(likedBy).sort(), updated_at: updatedAt })
            .eq('market_id', normalizedMarketId)
            .eq('id', normalizedCommentId)
            .select('*')
            .single();
        throwIfError(error, 'Failed to update comment like');

        return {
            comment: fromCommentRow(data),
            changed: liked ? !hadLiked : hadLiked,
            liked: likedBy.has(wallet),
            likerWalletAddress: wallet,
        };
    }
}

function buildComment(input, existingComments) {
    const marketId = normalizeRequiredString(input.marketId, 'marketId', 80);
    const walletAddress = normalizeWallet(input.walletAddress);
    const displayName = normalizeRequiredString(input.displayName, 'displayName', 60);
    const body = normalizeRequiredString(input.body, 'body', 2000);
    const parentId = input.parentId ? normalizeRequiredString(input.parentId, 'parentId', 80) : null;

    if (parentId) {
        const parent = existingComments.find((comment) => comment.id === parentId);
        if (!parent || parent.marketId !== marketId) {
            throw new CommentNotFoundError('Parent comment was not found for this market');
        }
    }

    const now = new Date().toISOString();
    return {
        id: crypto.randomUUID(),
        marketId,
        parentId,
        walletAddress,
        displayName,
        body,
        likedBy: [],
        createdAt: now,
        updatedAt: now,
    };
}

function normalizeRequiredString(value, fieldName, maxLength) {
    if (typeof value !== 'string') {
        throw new CommentValidationError(`${fieldName} is required`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new CommentValidationError(`${fieldName} is required`);
    }
    if (normalized.length > maxLength) {
        throw new CommentValidationError(`${fieldName} is too long`);
    }

    return normalized;
}

function normalizeWallet(value) {
    const walletAddress = normalizeRequiredString(value, 'walletAddress', 42);
    if (!WALLET_ADDRESS_PATTERN.test(walletAddress)) {
        throw new CommentValidationError('walletAddress must be an Ethereum address');
    }
    return walletAddress.toLowerCase();
}

function buildThread(comments) {
    const byId = new Map();
    const roots = [];

    for (const comment of comments) {
        byId.set(comment.id, { ...comment, replies: [] });
    }

    for (const comment of byId.values()) {
        if (comment.parentId && byId.has(comment.parentId)) {
            byId.get(comment.parentId).replies.push(comment);
        } else {
            roots.push(comment);
        }
    }

    return roots;
}

function toCommentRow(comment) {
    return {
        id: comment.id,
        market_id: comment.marketId,
        parent_id: comment.parentId || null,
        wallet_address: comment.walletAddress,
        display_name: comment.displayName,
        body: comment.body,
        liked_by: comment.likedBy || [],
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
    };
}

function fromCommentRow(row) {
    return {
        id: row.id,
        marketId: row.market_id,
        parentId: row.parent_id || null,
        walletAddress: row.wallet_address,
        displayName: row.display_name,
        body: row.body,
        likedBy: Array.isArray(row.liked_by) ? row.liked_by : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    CommentNotFoundError,
    CommentValidationError,
    JsonCommentStore,
    MemoryCommentStore,
    SupabaseCommentStore,
    buildThread,
};
