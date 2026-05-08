const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JSON_DB_PATH = path.resolve(__dirname, process.env.COMMENTS_DB_PATH || 'data/comments.json');

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function migrate() {
    console.log('Reading JSON database...');
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));

    const { profiles, markets, comments, notifications } = data;

    // 1. Migrate Profiles
    console.log('Migrating Profiles...');
    const profileEntries = Object.values(profiles).map(p => ({
        wallet_address: p.walletAddress,
        profile_name: p.profileName,
        bio: p.bio,
        email: p.email,
        profile_image_data_url: p.profileImageDataUrl,
        receive_updates: p.receiveUpdates,
        receive_position_notifications: p.receivePositionNotifications,
        created_at: p.createdAt,
        updated_at: p.updatedAt
    }));

    if (profileEntries.length > 0) {
        const { error: pError } = await supabase.from('profiles').upsert(profileEntries);
        if (pError) console.error('Error migrating profiles:', pError);
        else console.log(`Migrated ${profileEntries.length} profiles.`);
    }

    // 2. Migrate Markets
    console.log('Migrating Markets...');
    const marketEntries = Object.values(markets).map(m => ({
        market_id: m.marketId,
        onchain_market_id: m.onchainMarketId,
        slug: m.slug,
        category: m.category,
        title: m.title,
        description: m.description,
        provider: m.provider,
        image_url: m.imageUrl,
        home_name: m.homeName,
        away_name: m.awayName,
        home_logo_url: m.homeLogoUrl,
        away_logo_url: m.awayLogoUrl,
        league_name: m.leagueName,
        league_logo_url: m.leagueLogoUrl,
        source_url: m.sourceUrl,
        source_name: m.sourceName,
        starts_at: m.startsAt,
        creator_wallet_address: m.creatorWalletAddress,
        status: m.status,
        accepted_at: m.acceptedAt,
        resolved_at: m.resolvedAt,
        resolution: m.resolution,
        participants: m.participants || [],
        metadata: m.metadata || {},
        created_at: m.createdAt,
        updated_at: m.updatedAt
    }));

    if (marketEntries.length > 0) {
        const { error: mError } = await supabase.from('markets').upsert(marketEntries);
        if (mError) console.error('Error migrating markets:', mError);
        else console.log(`Migrated ${marketEntries.length} markets.`);
    }

    // 3. Migrate Comments (Handle parent/child relationship by ordering or multiple passes)
    console.log('Migrating Comments...');
    // Sort comments so parents are inserted before children if possible, 
    // but upsert handles this better if we do it in batches or one by one.
    // We'll try a batch upsert first.
    const commentEntries = comments.map(c => ({
        id: c.id,
        market_id: c.marketId,
        parent_id: c.parentId || null,
        wallet_address: c.walletAddress,
        display_name: c.displayName,
        body: c.body,
        liked_by: c.likedBy || [],
        created_at: c.createdAt,
        updated_at: c.updatedAt
    }));

    if (commentEntries.length > 0) {
        // To handle parent_id constraints, we insert in two passes or use a loop.
        // First pass: insert all comments without parent_id
        const firstPass = commentEntries.map(c => ({ ...c, parent_id: null }));
        const { error: cError1 } = await supabase.from('comments').upsert(firstPass);
        
        if (cError1) {
            console.error('Error migrating comments (pass 1):', cError1);
        } else {
            // Second pass: update parent_ids
            const { error: cError2 } = await supabase.from('comments').upsert(commentEntries);
            if (cError2) console.error('Error migrating comments (pass 2):', cError2);
            else console.log(`Migrated ${commentEntries.length} comments.`);
        }
    }

    // 4. Migrate Notifications
    console.log('Migrating Notifications...');
    const notificationEntries = notifications.map(n => ({
        id: n.id,
        wallet_address: n.walletAddress,
        type: n.type,
        title: n.title,
        body: n.body,
        market_id: n.marketId,
        comment_id: n.commentId,
        metadata: n.metadata || {},
        read_at: n.readAt,
        created_at: n.createdAt
    }));

    if (notificationEntries.length > 0) {
        const { error: nError } = await supabase.from('notifications').upsert(notificationEntries);
        if (nError) console.error('Error migrating notifications:', nError);
        else console.log(`Migrated ${notificationEntries.length} notifications.`);
    }

    console.log('Migration complete!');
}

migrate().catch(err => {
    console.error('Fatal error during migration:', err);
    process.exit(1);
});
