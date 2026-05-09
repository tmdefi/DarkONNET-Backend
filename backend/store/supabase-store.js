const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function hasSupabaseConfig() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseClient() {
    if (!hasSupabaseConfig()) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use Supabase storage');
    }

    if (!cachedClient) {
        cachedClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false },
        });
    }

    return cachedClient;
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
    shouldUseSupabase,
    throwIfError,
};
