const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { withBackoff } = require('./oracle-utils');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn('[METADATA WARN] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env. Metadata sync will be disabled.');
}

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Persists market metadata directly to Supabase.
 * Replaces the legacy axios call to localhost:8787.
 */
async function upsertMarketMetadata(market) {
    if (process.env.DISABLE_MARKET_METADATA === 'true' || !supabase) return;

    try {
        const payload = {
            ...market,
            marketId: String(market.marketId),
            onchainMarketId: String(market.onchainMarketId || market.marketId),
            updatedAt: new Date().toISOString()
        };

        const { error } = await withBackoff(`metadata upsert ${market.marketId}`, () =>
            supabase
                .from('markets')
                .upsert(payload, { onConflict: 'marketId' }),
        );

        if (error) throw error;

        console.log(`[METADATA] Successfully synced market ${market.marketId} to Supabase.`);
    } catch (error) {
        console.warn(`[METADATA WARN] Could not save metadata for market ${market.marketId}: ${error.message}`);
    }
}

function firstArticleImage(articles) {
    const article = articles.find((item) => item.urlToImage);
    if (!article) return {};

    return {
        imageUrl: article.urlToImage,
        sourceUrl: article.url,
        sourceName: article.source?.name,
    };
}

function footballTeamLogo(teamId) {
    if (!teamId) return null;
    return `https://media.api-sports.io/football/teams/${teamId}.png`;
}

module.exports = {
    firstArticleImage,
    footballTeamLogo,
    upsertMarketMetadata,
};
