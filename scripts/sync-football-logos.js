require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { normalizeTeamName } = require('../relayer/team-logo-store');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.TEAM_LOGO_BUCKET || 'team-logos';
const OWNER = process.env.FOOTBALL_LOGOS_GITHUB_OWNER || 'luukhopman';
const REPO = process.env.FOOTBALL_LOGOS_GITHUB_REPO || 'football-logos';
const REF = process.env.FOOTBALL_LOGOS_GITHUB_REF || 'master';
const SOURCE_PREFIX = process.env.FOOTBALL_LOGOS_GITHUB_PREFIX || 'logos/';
const MAX_LOGOS = Number(process.env.FOOTBALL_LOGOS_SYNC_LIMIT || 0);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function ensureBucket() {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) throw listError;
    if (buckets.some(bucket => bucket.name === BUCKET)) return;

    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) throw error;
    console.log(`[LOGOS] Created public storage bucket ${BUCKET}.`);
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'DarkONNET logo sync' },
    });
    if (!response.ok) {
        throw new Error(`GitHub request failed ${response.status}: ${url}`);
    }
    return response.json();
}

async function fetchBuffer(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'DarkONNET logo sync' },
    });
    if (!response.ok) {
        throw new Error(`Logo download failed ${response.status}: ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function logoEntries(tree) {
    return tree
        .filter(item => item.type === 'blob' && item.path.startsWith(SOURCE_PREFIX) && item.path.toLowerCase().endsWith('.png'))
        .map(item => {
            const teamName = path.basename(item.path, path.extname(item.path));
            const leagueName = item.path.slice(SOURCE_PREFIX.length).split('/')[0] || null;
            const normalizedName = normalizeTeamName(teamName);
            return {
                githubPath: item.path,
                leagueName,
                teamName,
                normalizedName,
                storagePath: `football/${normalizedName}.png`,
                rawUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${REF}/${encodeURI(item.path).replace(/#/g, '%23')}`,
            };
        })
        .filter(entry => entry.normalizedName);
}

async function uploadLogo(entry) {
    const content = await fetchBuffer(entry.rawUrl);
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(entry.storagePath, content, {
            contentType: 'image/png',
            upsert: true,
        });
    if (error) throw error;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(entry.storagePath);
    const logoUrl = data.publicUrl;

    const { error: upsertError } = await supabase
        .from('team_logos')
        .upsert({
            sport: 'football',
            source: `${OWNER}/${REPO}`,
            league_name: entry.leagueName,
            team_name: entry.teamName,
            normalized_name: entry.normalizedName,
            logo_url: logoUrl,
            source_path: entry.githubPath,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'sport,normalized_name' });

    if (upsertError) throw upsertError;
}

async function main() {
    await ensureBucket();

    const treeUrl = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${REF}?recursive=1`;
    const { tree } = await fetchJson(treeUrl);
    const entries = logoEntries(Array.isArray(tree) ? tree : []);
    const selectedEntries = MAX_LOGOS > 0 ? entries.slice(0, MAX_LOGOS) : entries;

    console.log(`[LOGOS] Syncing ${selectedEntries.length} football logos from ${OWNER}/${REPO}.`);
    for (const [index, entry] of selectedEntries.entries()) {
        await uploadLogo(entry);
        if ((index + 1) % 25 === 0 || index + 1 === selectedEntries.length) {
            console.log(`[LOGOS] Synced ${index + 1}/${selectedEntries.length}.`);
        }
    }
}

main().catch(error => {
    console.error(`[LOGOS ERROR] ${error.message}`);
    process.exit(1);
});
