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
        const now = new Date().toISOString();
        const payload = {
            market_id: String(market.marketId),
            onchain_market_id: String(market.onchainMarketId || market.marketId),
            slug: market.slug || null,
            category: market.category,
            title: market.title,
            description: market.description || null,
            provider: market.provider || null,
            image_url: market.imageUrl || null,
            home_name: market.homeName || null,
            away_name: market.awayName || null,
            home_logo_url: market.homeLogoUrl || null,
            away_logo_url: market.awayLogoUrl || null,
            league_name: market.leagueName || null,
            league_logo_url: market.leagueLogoUrl || null,
            source_url: market.sourceUrl || null,
            source_name: market.sourceName || null,
            starts_at: market.startsAt || null,
            creator_wallet_address: market.creatorWalletAddress || null,
            status: market.status || 'accepted',
            accepted_at: market.acceptedAt || now,
            resolved_at: market.resolvedAt || null,
            resolution: market.resolution || null,
            participants: Array.isArray(market.participants) ? market.participants : [],
            metadata: market.metadata || {},
            updated_at: now,
        };

        const { error } = await withBackoff(`metadata upsert ${market.marketId}`, () =>
            supabase
                .from('markets')
                .upsert(payload, { onConflict: 'market_id' }),
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
