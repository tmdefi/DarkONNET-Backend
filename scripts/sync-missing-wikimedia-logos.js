require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { getTeamLogoUrl, normalizeTeamName } = require('../relayer/team-logo-store');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.TEAM_LOGO_BUCKET || 'team-logos';
const LIMIT = Number(process.env.WIKIMEDIA_LOGO_SYNC_LIMIT || 20);
const REQUEST_DELAY_MS = Number(process.env.WIKIMEDIA_LOGO_REQUEST_DELAY_MS || 1_500);
const INCLUDE_PAST_MARKETS = process.env.WIKIMEDIA_LOGO_INCLUDE_PAST === 'true';
const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';
const COMMONS_FILE_URL = 'https://commons.wikimedia.org/wiki/Special:FilePath';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class RateLimitError extends Error {
    constructor(url) {
        super(`Wikidata rate limit reached: ${url}`);
        this.name = 'RateLimitError';
    }
}

async function fetchJson(url) {
    await sleep(REQUEST_DELAY_MS);
    const response = await fetch(url, {
        headers: { 'User-Agent': 'DarkONNET logo sync' },
    });
    if (response.status === 429) throw new RateLimitError(url);
    if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`);
    return response.json();
}

async function fetchFile(url) {
    await sleep(REQUEST_DELAY_MS);
    const response = await fetch(url, {
        headers: { 'User-Agent': 'DarkONNET logo sync' },
    });
    if (response.status === 429) throw new RateLimitError(url);
    if (!response.ok) throw new Error(`Logo download failed ${response.status}: ${url}`);
    return {
        content: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
}

async function missingTeams() {
    let query = supabase
        .from('markets')
        .select('home_name,away_name,home_logo_url,away_logo_url,starts_at')
        .eq('category', 'Sports - Football')
        .order('starts_at', { ascending: true })
        .limit(500);

    if (!INCLUDE_PAST_MARKETS) {
        query = query.gte('starts_at', new Date().toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    const teams = new Map();
    for (const market of data || []) {
        if (market.home_name && !market.home_logo_url) teams.set(normalizeTeamName(market.home_name), market.home_name);
        if (market.away_name && !market.away_logo_url) teams.set(normalizeTeamName(market.away_name), market.away_name);
    }

    const names = [];
    for (const teamName of teams.values()) {
        if (!await getTeamLogoUrl(teamName)) names.push(teamName);
    }
    return names.slice(0, LIMIT);
}

async function searchWikidata(teamName) {
    const pageEntity = await searchWikipediaTitles(teamName);
    if (pageEntity !== undefined) return pageEntity;

    const searches = [`${teamName} football club`, teamName];
    const seenIds = new Set();
    const ids = [];

    for (const search of searches) {
        const url = `${WIKIDATA_API_URL}?action=wbsearchentities&format=json&language=en&limit=8&search=${encodeURIComponent(search)}`;
        const data = await fetchJson(url);
        for (const result of data.search || []) {
            if (!seenIds.has(result.id)) {
                seenIds.add(result.id);
                ids.push(result.id);
            }
        }
    }

    if (ids.length === 0) return null;

    const entitiesUrl = `${WIKIDATA_API_URL}?action=wbgetentities&format=json&props=labels|aliases|claims&languages=en&ids=${ids.join('|')}`;
    const data = await fetchJson(entitiesUrl);
    const entities = ids.map(id => data.entities?.[id]).filter(Boolean);
    return entities.find(entity => isTeamMatch(teamName, entity) && logoFileName(entity)) || null;
}

async function searchWikipediaTitles(teamName) {
    const titles = wikipediaTitleCandidates(teamName);
    const url = `${WIKIPEDIA_API_URL}?action=query&format=json&redirects=1&prop=pageprops&titles=${encodeURIComponent(titles.join('|'))}`;
    const data = await fetchJson(url);
    const ids = Object.values(data.query?.pages || {})
        .map(page => page.pageprops?.wikibase_item)
        .filter(Boolean);

    if (ids.length === 0) return null;

    const entitiesUrl = `${WIKIDATA_API_URL}?action=wbgetentities&format=json&props=labels|aliases|claims&languages=en&ids=${ids.join('|')}`;
    const entityData = await fetchJson(entitiesUrl);
    const entities = ids.map(id => entityData.entities?.[id]).filter(Boolean);
    const matchingEntity = entities.find(entity => isTeamMatch(teamName, entity));
    if (!matchingEntity) return undefined;
    return logoFileName(matchingEntity) ? matchingEntity : null;
}

function wikipediaTitleCandidates(teamName) {
    const name = String(teamName || '').trim();
    const withoutFc = name.replace(/\s+(fc|f\.c\.|afc|a\.f\.c\.|cf|c\.f\.|sc|s\.c\.)$/i, '').trim();
    const baseNames = Array.from(new Set([name, withoutFc].filter(Boolean)));
    const suffixes = ['', ' F.C.', ' FC', ' A.F.C.', ' AFC', ' C.F.', ' CF', ' S.C.', ' SC'];
    return baseNames.flatMap(base => suffixes.map(suffix => `${base}${suffix}`));
}

function entityNames(entity) {
    const names = [entity.labels?.en?.value];
    for (const alias of entity.aliases?.en || []) {
        names.push(alias.value);
    }
    return names.filter(Boolean);
}

function isTeamMatch(teamName, entity) {
    const requested = normalizeTeamName(teamName);
    return entityNames(entity).some(name => {
        const candidate = normalizeTeamName(name);
        return candidate === requested || (requested.length >= 4 && candidate.endsWith(` ${requested}`));
    });
}

function logoFileName(entity) {
    return entity.claims?.P154?.[0]?.mainsnak?.datavalue?.value || null;
}

function fileExtension(fileName, contentType) {
    const ext = path.extname(fileName).toLowerCase().replace('.', '');
    if (['svg', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) return ext;
    if (contentType.includes('svg')) return 'svg';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    return 'png';
}

function uploadContentType(ext, contentType) {
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'png') return 'image/png';
    return contentType;
}

async function uploadWikimediaLogo(teamName, entity) {
    const fileName = logoFileName(entity);
    const fileUrl = `${COMMONS_FILE_URL}/${encodeURIComponent(fileName)}`;
    const downloaded = await fetchFile(fileUrl);
    const normalizedName = normalizeTeamName(teamName);
    const ext = fileExtension(fileName, downloaded.contentType);
    const storagePath = `football/${normalizedName}.${ext}`;

    const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, downloaded.content, {
            contentType: uploadContentType(ext, downloaded.contentType),
            upsert: true,
        });
    if (uploadError) throw uploadError;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const logoUrl = data.publicUrl;

    const { error: upsertError } = await supabase
        .from('team_logos')
        .upsert({
            sport: 'football',
            source: 'wikimedia',
            team_name: teamName,
            normalized_name: normalizedName,
            logo_url: logoUrl,
            source_path: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'sport,normalized_name' });

    if (upsertError) throw upsertError;
    return logoUrl;
}

async function main() {
    const teams = await missingTeams();
    console.log(`[WIKIMEDIA] Searching logos for ${teams.length} missing teams.`);

    let imported = 0;
    for (const teamName of teams) {
        try {
            const entity = await searchWikidata(teamName);
            if (!entity) {
                console.log(`[WIKIMEDIA] No confident logo match for ${teamName}.`);
                continue;
            }

            await uploadWikimediaLogo(teamName, entity);
            imported += 1;
            console.log(`[WIKIMEDIA] Imported ${teamName} from ${entity.labels?.en?.value || entity.id}.`);
        } catch (error) {
            if (error instanceof RateLimitError) {
                console.warn(`[WIKIMEDIA WARN] ${error.message}. Stop now and rerun later.`);
                break;
            }
            console.warn(`[WIKIMEDIA WARN] ${teamName}: ${error.message}`);
        }
    }

    console.log(`[WIKIMEDIA] Imported ${imported}/${teams.length} missing team logos.`);
}

main().catch(error => {
    console.error(`[WIKIMEDIA ERROR] ${error.message}`);
    process.exit(1);
});
