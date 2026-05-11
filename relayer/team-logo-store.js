const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const logoCache = new Map();

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

function normalizeTeamName(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\bst[.]?\b/g, 'saint')
        .replace(/\b(fc|cf|sc|afc|ac|cd|rc|ud|club|de|the|af)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

async function getTeamLogoUrl(name, sport = 'football') {
    const normalizedName = normalizeTeamName(name);
    if (!normalizedName || !supabase) return null;

    const cacheKey = `${sport}:${normalizedName}`;
    if (logoCache.has(cacheKey)) return logoCache.get(cacheKey);

    try {
        const { data, error } = await supabase
            .from('team_logos')
            .select('logo_url')
            .eq('sport', sport)
            .eq('normalized_name', normalizedName)
            .maybeSingle();

        if (error) throw error;

        const logoUrl = data?.logo_url || null;
        logoCache.set(cacheKey, logoUrl);
        return logoUrl;
    } catch (error) {
        console.warn(`[TEAM LOGO WARN] Could not read logo for ${name}: ${error.message}`);
        logoCache.set(cacheKey, null);
        return null;
    }
}

module.exports = {
    getTeamLogoUrl,
    normalizeTeamName,
};
