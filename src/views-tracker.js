// Suivi automatique des vues des vidéos postées (YouTube / TikTok / Instagram) via Apify.
// Une fois toutes les 24h : récupère les vues de chaque lien posté et les garde en cache.
//
// Variables Railway :
//   APIFY_TOKEN              (obligatoire)  token Apify
//   VIEWS_MAX_AGE_DAYS       (défaut 30)    on ne re-scrape que les posts de moins de N jours ;
//                                           les plus anciens gardent leur dernière valeur connue
//   VIEWS_MAX_PER_RUN        (défaut 600)   plafond de liens scrapés par passage (contrôle du coût)
//   VIEWS_CRON               (défaut "0 4 * * *")  heure du passage quotidien (fuseau Europe/Paris)
//   APIFY_ACTOR_TIKTOK / APIFY_ACTOR_INSTAGRAM / APIFY_ACTOR_YOUTUBE   pour changer d'acteur
const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(dataDir, 'views-cache.json');

const APIFY = 'https://api.apify.com/v2';
const ACTORS = {
  tiktok:    process.env.APIFY_ACTOR_TIKTOK    || 'clockworks~tiktok-scraper',
  instagram: process.env.APIFY_ACTOR_INSTAGRAM || 'apify~instagram-scraper',
  youtube:   process.env.APIFY_ACTOR_YOUTUBE   || 'streamers~youtube-scraper',
};
const BATCH = 40;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasToken = () => !!process.env.APIFY_TOKEN;

// ─── Cache ───────────────────────────────────────────────────────────────────
let cache = { updatedAt: null, lastRun: null, running: false, error: null, stats: null, byUrl: {} };
try { if (fs.existsSync(CACHE_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')), running: false }; } catch {}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(cache), 'utf8'); fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE); } catch {}
}

// ─── Identifiants de vidéo (pour relier un résultat Apify à un lien posté) ──
function detectPlatform(url, declared) {
  const u = String(url || '').toLowerCase();
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return declared || null;
}
function videoId(url, platform) {
  const u = String(url || '');
  let m;
  if (platform === 'tiktok')    { m = u.match(/\/video\/(\d+)/); return m ? m[1] : null; }
  if (platform === 'instagram') { m = u.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/); return m ? m[1] : null; }
  if (platform === 'youtube') {
    m = u.match(/youtu\.be\/([\w-]{11})/) || u.match(/[?&]v=([\w-]{11})/) || u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}
const normUrl = u => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

// ─── Clients suivis (cochés dans l'admin : Client Settings > "Track views with Apify") ──
function trackedClients() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-config.json'), 'utf8'));
    const sett = cfg.clientSettings || {};
    return (cfg.clients || []).filter(c => sett[c.id] && sett[c.id].apifyViews === true);
  } catch { return []; }
}

// ─── Collecte des posts des clients suivis (tous serveurs, tous mois) ──────── (tous serveurs, tous mois) ───────────────────
function collectPosts() {
  const channelIds = new Set();
  for (const c of trackedClients()) for (const ch of c.channels || []) channelIds.add(String(ch.id));
  if (!channelIds.size) return [];
  const out = new Map(); // normUrl -> { url, platform, date_key, channel_id }
  let files = [];
  try { files = fs.readdirSync(dataDir).filter(f => f.startsWith('posts-') || f === 'posts.json'); } catch {}
  for (const f of files) {
    let db; try { db = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { continue; }
    for (const p of db.posts || []) {
      if (!p.video_url || !channelIds.has(String(p.channel_id))) continue;
      const platform = detectPlatform(p.video_url, p.platform);
      if (!platform || !videoId(p.video_url, platform)) continue;
      const k = normUrl(p.video_url);
      if (!out.has(k)) out.set(k, { url: p.video_url, platform, date_key: p.date_key || '', channel_id: p.channel_id });
    }
  }
  return [...out.entries()].map(([k, v]) => ({ key: k, ...v }));
}

// ─── Appels Apify ────────────────────────────────────────────────────────────
async function apify(pathname, opts = {}) {
  const res = await fetch(APIFY + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

function buildInput(platform, urls) {
  if (platform === 'tiktok')    return { postURLs: urls, resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false };
  if (platform === 'instagram') return { directUrls: urls, resultsType: 'posts', resultsLimit: 1, addParentData: false };
  return { startUrls: urls.map(url => ({ url })), maxResults: 1, maxResultsShorts: 1, maxResultsStreams: 0 };
}

async function runActor(platform, urls) {
  const start = await apify(`/acts/${ACTORS[platform]}/runs`, { method: 'POST', body: JSON.stringify(buildInput(platform, urls)) });
  if (!start.ok) throw new Error(`Apify ${platform}: HTTP ${start.status} ${(await start.text()).slice(0, 160)}`);
  const run = (await start.json()).data;
  const deadline = Date.now() + 25 * 60 * 1000;
  let info = run;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(info.status)) {
    if (Date.now() > deadline) throw new Error(`Apify ${platform}: timeout`);
    await sleep(8000);
    const r = await apify(`/actor-runs/${run.id}`);
    if (r.ok) info = (await r.json()).data;
  }
  if (info.status !== 'SUCCEEDED') throw new Error(`Apify ${platform}: run ${info.status}`);
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await apify(`/datasets/${info.defaultDatasetId}/items?clean=true&limit=1000&offset=${offset}`);
    if (!r.ok) throw new Error(`Apify dataset: HTTP ${r.status}`);
    const page = await r.json();
    items.push(...page);
    if (page.length < 1000) break;
  }
  return items;
}

// Lit le nombre de vues dans un résultat, quel que soit l'acteur
function viewsOf(item) {
  for (const k of ['playCount', 'videoPlayCount', 'videoViewCount', 'viewCount', 'views', 'playsCount', 'plays']) {
    const v = item[k];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}
function idsOf(item, platform) {
  const ids = new Set();
  for (const k of ['webVideoUrl', 'url', 'inputUrl', 'postUrl', 'postURL', 'videoUrl', 'input']) {
    const id = typeof item[k] === 'string' ? videoId(item[k], platform) : null;
    if (id) ids.add(id);
  }
  for (const k of ['id', 'shortCode', 'shortcode']) if (item[k]) ids.add(String(item[k]));
  return ids;
}

// ─── Passage principal ───────────────────────────────────────────────────────
async function refreshViews({ force = false } = {}) {
  if (!hasToken()) return { ok: false, reason: 'APIFY_TOKEN manquant' };
  if (cache.running) return { ok: false, reason: 'déjà en cours' };
  cache.running = true; cache.error = null; saveCache();

  const maxAgeDays = Number(process.env.VIEWS_MAX_AGE_DAYS) || 30;
  const maxPerRun  = Number(process.env.VIEWS_MAX_PER_RUN) || 600;
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  const stats = { scraped: 0, updated: 0, missing: 0, skippedOld: 0, byPlatform: {}, errors: [] };

  try {
    const all = collectPosts();
    // priorité : jamais scrapés, puis les plus récents
    let todo = all.filter(p => {
      const known = cache.byUrl[p.key];
      const recent = p.date_key >= cutoff;
      if (!known) return true;
      if (!recent) { stats.skippedOld++; return false; }
      // déjà vérifié il y a moins de 20h (ex. passage interrompu par un redémarrage) : on ne repaie pas
      if (!force && known.checkedAt && !known.error && Date.now() - new Date(known.checkedAt).getTime() < 20 * 3600 * 1000) { stats.skippedFresh = (stats.skippedFresh || 0) + 1; return false; }
      return true;
    });
    todo.sort((a, b) => (!cache.byUrl[a.key] - !cache.byUrl[b.key]) * -1 || String(b.date_key).localeCompare(String(a.date_key)));
    todo = todo.slice(0, maxPerRun);
    const tc = trackedClients();
    if (!tc.length) console.log('[VIEWS] Aucun client sélectionné — cochez « Track views with Apify » dans l\'admin (Client Settings)');
    console.log(`[VIEWS] Passage démarré : ${todo.length} lien(s) à scraper pour ${tc.map(c => c.name).join(', ') || '—'} (${all.length} posts suivis au total)`);

    for (const platform of ['tiktok', 'instagram', 'youtube']) {
      const group = todo.filter(p => p.platform === platform);
      for (let i = 0; i < group.length; i += BATCH) {
        const chunk = group.slice(i, i + BATCH);
        try {
          console.log(`[VIEWS] ${platform}: lot de ${chunk.length} lien(s) envoyé à Apify…`);
          const items = await runActor(platform, chunk.map(p => p.url));
          const byId = new Map();
          for (const it of items) for (const id of idsOf(it, platform)) if (!byId.has(id)) byId.set(id, it);
          for (const p of chunk) {
            stats.scraped++;
            const item = byId.get(videoId(p.url, platform));
            const v = item ? viewsOf(item) : null;
            const prev = cache.byUrl[p.key];
            if (v == null) {
              stats.missing++;
              cache.byUrl[p.key] = { ...(prev || { platform, views: 0 }), platform, checkedAt: new Date().toISOString(), error: item ? 'no-views' : 'not-found' };
            } else {
              stats.updated++;
              stats.byPlatform[platform] = (stats.byPlatform[platform] || 0) + 1;
              cache.byUrl[p.key] = { platform, views: v, checkedAt: new Date().toISOString() };
            }
          }
        } catch (e) {
          stats.errors.push(e.message);
          console.error('[VIEWS]', e.message);
        }
        saveCache();
      }
    }
    cache.lastRun = new Date().toISOString();
    if (stats.updated || !stats.errors.length) cache.updatedAt = cache.lastRun;
    if (stats.errors.length) cache.error = stats.errors[0];
    cache.stats = stats;
    console.log(`[VIEWS] ${stats.updated}/${stats.scraped} liens mis à jour (${stats.missing} introuvables, ${stats.skippedOld} anciens ignorés, ${stats.skippedFresh || 0} déjà à jour)`);
    return { ok: true, stats };
  } catch (e) {
    cache.error = e.message; console.error('[VIEWS]', e.message);
    return { ok: false, reason: e.message };
  } finally {
    cache.running = false; saveCache();
  }
}

// ─── Lecture (API / site) ────────────────────────────────────────────────────
function viewsForUrl(url) {
  const e = cache.byUrl[normUrl(url)];
  return e && typeof e.views === 'number' && (e.views > 0 || !e.error) ? e.views : null;
}
// canaux des clients cochés : seuls leurs posts affichent des vues
function trackedChannels() {
  const set = new Set();
  for (const c of trackedClients()) for (const ch of c.channels || []) set.add(String(ch.id));
  return set;
}
function summary() {
  const byPlatform = {};
  let total = 0, tracked = 0;
  const keep = new Set(collectPosts().map(p => p.key)); // uniquement les liens des clients suivis
  for (const [k, e] of Object.entries(cache.byUrl)) {
    if (!keep.has(k)) continue;
    if (!e || typeof e.views !== 'number') continue;
    total += e.views; tracked++;
    byPlatform[e.platform] = (byPlatform[e.platform] || 0) + e.views;
  }
  return { enabled: hasToken(), clients: trackedClients().map(c => c.name), running: cache.running, updatedAt: cache.updatedAt, lastRun: cache.lastRun, error: cache.error, stats: cache.stats, tracked, total, byPlatform };
}

// ─── Planification : une fois toutes les 24h ─────────────────────────────────
function startViewsTracking() {
  if (!hasToken()) { console.log('[VIEWS] APIFY_TOKEN absent — suivi des vues désactivé'); return; }
  const expr = process.env.VIEWS_CRON || '0 4 * * *';
  cron.schedule(expr, () => { refreshViews().catch(e => console.error('[VIEWS]', e.message)); }, { timezone: 'Europe/Paris' });
  // Au démarrage : rattrape si le dernier passage date de plus de 24h (ou n'a jamais eu lieu)
  const age = cache.lastRun ? Date.now() - new Date(cache.lastRun).getTime() : Infinity;
  if (age > 24 * 3600 * 1000) setTimeout(() => refreshViews().catch(() => {}), 60 * 1000);
  console.log(`[VIEWS] Suivi des vues Apify actif (cron "${expr}" Europe/Paris, ${trackedClients().length} client(s) suivi(s), max ${process.env.VIEWS_MAX_PER_RUN || 600} liens/passage)`);
}

module.exports = { startViewsTracking, refreshViews, viewsForUrl, summary, normUrl, hasToken, trackedChannels };
