// Suivi des clics ClickMagick par clipper.
// Nécessite la variable d'environnement CLICKMAGICK_API_KEY (Railway > Variables).
// "Clic valide" = unique_clicks de ClickMagick (doublons et clics signalés/bots exclus).
// On garde aussi total_clicks et flagged_clicks pour comparaison.
const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getAllClippers } = require('./clippers');

const BASE = 'https://api.clickmagick.com/v1';
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(dataDir, 'clickmagick-cache.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasKey = () => !!process.env.CLICKMAGICK_API_KEY;

async function cm(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'X-APIKEY': process.env.CLICKMAGICK_API_KEY, Accept: 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

// ─── Cache ───────────────────────────────────────────────────────────────────
let cache = { updatedAt: null, error: null, byLink: {} }; // byLink[slug] = { linkId, today, d7, d30 }
try { if (fs.existsSync(CACHE_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch {}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(cache), 'utf8'); fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE); } catch {}
}

// ─── Slug du lien ────────────────────────────────────────────────────────────
// https://track.domaine.com/alice  ->  "alice"
function slugOf(link) {
  try {
    // chemin complet ("bryanrgt/abel"); on essaiera aussi le dernier segment ("abel") à la recherche
    const parts = new URL(link).pathname.split('/').filter(Boolean);
    return parts.length ? parts.join('/').toLowerCase() : null;
  } catch { return null; }
}

const pickId = (links, key) => links[key] ?? links[key.split('/').pop()] ?? null;

// ─── Liste des liens (slug -> id) ────────────────────────────────────────────
async function listAllLinks() {
  const map = {};
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: '100', include_archived: 'true', recursive: 'true' });
    if (cursor) q.set('cursor', cursor);
    const res = await cm('/links?' + q);
    if (!res.ok) throw new Error(`/links HTTP ${res.status}`);
    const data = await res.json();
    for (const l of data.links || []) if (l.link_slug) map[String(l.link_slug).toLowerCase()] = l.id;
    cursor = data.cursor?.next;
    if (!cursor) break;
    await sleep(300);
  }
  return map;
}

// ─── Rapport de stats pour jusqu'à 20 liens ──────────────────────────────────
async function statsReport(ids, start, end) {
  const body = new URLSearchParams();
  ids.forEach(id => body.append('id', String(id)));
  body.set('start_time', start.toISOString().replace(/\.\d+Z$/, 'Z'));
  body.set('end_time', end.toISOString().replace(/\.\d+Z$/, 'Z'));
  const created = await cm('/links/stats', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!created.ok) throw new Error(`/links/stats HTTP ${created.status}`);
  const reportId = (await created.json())?.report?.id;
  if (!reportId) throw new Error('rapport sans id');

  const waits = [250, 500, 1000, 1000, 1000, 5000];
  for (let i = 0; i < 40; i++) {
    await sleep(waits[Math.min(i, waits.length - 1)]);
    const r = await cm(`/links/stats/reports/${reportId}`);
    if (r.status === 202) continue;
    if (r.status === 429) { await sleep(10000); continue; }
    if (!r.ok) throw new Error(`rapport HTTP ${r.status}`);
    return (await r.json()).stats || [];
  }
  throw new Error('rapport trop long');
}

const num = v => Number(v) || 0;
const pack = s => s ? { valid: num(s.unique_clicks), total: num(s.total_clicks), flagged: num(s.flagged_clicks) } : { valid: 0, total: 0, flagged: 0 };

// Minuit heure de Paris (approximation fiable à l'heure près, suffisant pour "aujourd'hui")
function startOfTodayParis() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).formatToParts(now).find(x => x.type === 'timeZoneName').value; // GMT+2
  const h = parseInt(off.replace('GMT', '')) || 0;
  return new Date(new Date(`${p}T00:00:00Z`).getTime() - h * 3600000);
}

// ─── Rafraîchissement ────────────────────────────────────────────────────────
let running = false;
async function refresh() {
  if (!hasKey() || running) return;
  running = true;
  try {
    const slugs = [...new Set(getAllClippers().map(c => c.link && slugOf(c.link)).filter(Boolean))];
    if (!slugs.length) { cache = { updatedAt: new Date().toISOString(), error: null, byLink: {} }; saveCache(); return; }

    const links = await listAllLinks();
    const end = new Date();
    const windows = {
      today: startOfTodayParis(),
      d7:  new Date(end.getTime() - 7  * 86400000),
      d30: new Date(end.getTime() - 30 * 86400000),
    };
    const byLink = {};
    const found = slugs.filter(s => pickId(links, s));
    slugs.forEach(s => { byLink[s] = { linkId: pickId(links, s) }; });

    for (let i = 0; i < found.length; i += 20) {
      const batch = found.slice(i, i + 20);
      const ids = batch.map(s => pickId(links, s));
      for (const [key, start] of Object.entries(windows)) {
        const stats = await statsReport(ids, start, end);
        for (const s of batch) byLink[s][key] = pack(stats.find(x => x.link_id === pickId(links, s)));
        await sleep(500);
      }
    }
    cache = { updatedAt: new Date().toISOString(), error: null, byLink };
    saveCache();
    console.log(`[CLICKMAGICK] ${found.length}/${slugs.length} links refreshed`);
  } catch (e) {
    cache.error = e.message;
    saveCache();
    console.error('[CLICKMAGICK] refresh failed:', e.message);
  } finally { running = false; }
}

function startClickTracking() {
  if (!hasKey()) { console.log('[CLICKMAGICK] CLICKMAGICK_API_KEY not set — click tracking disabled'); return; }
  setTimeout(refresh, 15000);
  cron.schedule('*/30 * * * *', refresh);
}

// Infos de clics pour un clipper (utilisé par l'API et la commande Discord)
function clicksFor(clipper) {
  if (!hasKey()) return { status: 'disabled' };
  if (!clipper.link) return { status: 'nolink' };
  const slug = slugOf(clipper.link);
  const e = slug && cache.byLink[slug];
  if (!cache.updatedAt) return { status: 'pending', error: cache.error };
  if (!e) return { status: 'pending' };
  if (!e.linkId) return { status: 'unmatched', slug };
  return { status: 'ok', slug, updatedAt: cache.updatedAt, today: e.today, d7: e.d7, d30: e.d30 };
}

module.exports = { startClickTracking, refresh, clicksFor, slugOf, hasKey };
