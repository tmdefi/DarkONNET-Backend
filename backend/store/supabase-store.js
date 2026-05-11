const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getSupabaseUrl() {
    const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    return normalizeSupabaseUrl(rawUrl);
}

function getSupabaseServiceKey() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

function hasSupabaseConfig() {
    return Boolean(getSupabaseUrl() && getSupabaseServiceKey());
}

function getSupabaseClient() {
    const supabaseUrl = getSupabaseUrl();
    const serviceKey = getSupabaseServiceKey();
    if (!supabaseUrl || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use Supabase storage');
    }

    if (!cachedClient) {
        cachedClient = createClient(supabaseUrl, serviceKey, {
            auth: { persistSession: false },
        });
    }

    return cachedClient;
}

function normalizeSupabaseUrl(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('://')) return `https${url}`;
    return `https://${url}`;
}

function shouldUseSupabase() {
    const backend = String(process.env.API_STORE || process.env.STORAGE_BACKEND || '').trim().toLowerCase();
    if (backend) return backend === 'supabase';
    return hasSupabaseConfig();
}

function mapSupabaseError(error, fallbackMessage = 'Supabase request failed') {
    if (!error) return null;
    const mapped = new Error(error.message || fallbackMessage);
    mapped.name = 'SupabaseStoreError';
    mapped.statusCode = Number(error.code) === 23503 ? 404 : 500;
    mapped.details = error;
    return mapped;
}

function throwIfError(error, fallbackMessage) {
    const mapped = mapSupabaseError(error, fallbackMessage);
    if (mapped) throw mapped;
}

module.exports = {
    getSupabaseClient,
    hasSupabaseConfig,
    normalizeSupabaseUrl,
    shouldUseSupabase,
    throwIfError,
};
