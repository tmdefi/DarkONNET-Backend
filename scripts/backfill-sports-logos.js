require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getTeamLogoUrl } = require('../relayer/team-logo-store');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMIT = Number(process.env.SPORTS_LOGO_BACKFILL_LIMIT || 500);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
    const { data, error } = await supabase
        .from('markets')
        .select('market_id,title,home_name,away_name,home_logo_url,away_logo_url')
        .eq('category', 'Sports - Football')
        .limit(LIMIT);

    if (error) throw error;

    let updated = 0;
    for (const market of data || []) {
        const homeLogoUrl = market.home_logo_url || await getTeamLogoUrl(market.home_name);
        const awayLogoUrl = market.away_logo_url || await getTeamLogoUrl(market.away_name);

        if (homeLogoUrl === market.home_logo_url && awayLogoUrl === market.away_logo_url) continue;

        const { error: updateError } = await supabase
            .from('markets')
            .update({
                home_logo_url: homeLogoUrl || null,
                away_logo_url: awayLogoUrl || null,
                updated_at: new Date().toISOString(),
            })
            .eq('market_id', market.market_id);

        if (updateError) throw updateError;
        updated += 1;
        console.log(`[LOGOS] Backfilled ${market.market_id}: ${market.title}`);
    }

    console.log(`[LOGOS] Backfill complete. Updated ${updated}/${(data || []).length} sports markets.`);
}

main().catch(error => {
    console.error(`[LOGOS ERROR] ${error.message}`);
    process.exit(1);
});
