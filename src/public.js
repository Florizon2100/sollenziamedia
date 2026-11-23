/* ─────────────────────────────────────────────────────────────
   Données PUBLIQUES d'un seul client, avec sa clé client (lien dashboard?c=…)
   GET /api/public/:key
   → ses posts, ses vues, ses top vidéos, ses témoignages, ses comptes (classement)
   Jamais : les autres clients, les tarifs/salaires, les webhooks, les finances.
   Les pages publiques (dashboard, classement, snapshot) n'ont donc plus besoin de la clé API.
   ───────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const SAFE_SETTINGS = ['showPosts', 'showMonthlyViews', 'showFollowers', 'totalFollowers', 'showLikes', 'totalLikes', 'totalPostsOverride', 'totalViewsOverride', 'customWorkflow', 'apifyViews', 'profileImage', 'avatar'];

function mountPublic(app, { dataDir }) {
  // limite simple : 120 requêtes / minute / adresse
  const hits = new Map();
  setInterval(() => hits.clear(), 60 * 1000).unref();
  const limit = (req, res, next) => {
    const ip = String(req.ip || req.socket.remoteAddress || '');
    const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 120) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
  const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

  app.get('/api/public/:key', limit, (req, res) => {
    try {
      const key = String(req.params.key || '').trim();
      const cfg = readJSON(path.join(dataDir, 'admin-config.json'), {}) || {};
      const slug = s => String(s || '').toLowerCase().replace(/\s+/g, '-');
      // mêmes liens qu'avant : clé du client (majuscules ignorées) ou nom du client (?c=Dmo, ?c=silva-twins)
      const k = key.toLowerCase();
      const list = cfg.clients || [];
      const bySecret = list.find(c => c.clientSecret && c.clientSecret === key)
        || list.find(c => c.clientSecret && c.clientSecret.toLowerCase() === k);
      // lien par nom (?c=silva-twins) : stats seulement, et la clé secrète du client n'est JAMAIS renvoyée
      const c = bySecret || list.find(c => slug(c.name) === k || String(c.name || '').toLowerCase() === k);
      if (!key || !c) return res.status(404).json({ error: 'unknown_client' });

      const chIds = new Set((c.channels || []).map(ch => String(ch.id)));
      const client = { id: c.id, name: c.name, clientSecret: bySecret ? (c.clientSecret || '') : '', channels: (c.channels || []).map(ch => ({ id: ch.id, name: ch.name })) };
      const s = (cfg.clientSettings || {})[c.id] || {};
      const settings = {}; for (const k of SAFE_SETTINGS) if (k in s) settings[k] = s[k];
      const own = list => (Array.isArray(list) ? list : []).filter(x => String(x.clientId) === String(c.id));
      const views = (cfg.views || []).map(w => ({ week: w.week, entries: (w.entries || []).filter(e => chIds.has(String(e.channelId)) || String(e.channelId) === String(c.id)) })).filter(w => w.entries.length);

      // posts du client (tous les mois), sans doublons
      let viewsTracker = null; try { viewsTracker = require('./views-tracker'); } catch {}
      const tracked = viewsTracker ? viewsTracker.trackedChannels() : new Set();
      const posts = [], users = {}, seen = new Set(), known = {};
      for (const f of fs.readdirSync(dataDir).filter(f => f.startsWith('posts-') || f === 'posts.json')) {
        const db = readJSON(path.join(dataDir, f), null); if (!db) continue;
        Object.assign(known, db.known_users || {});
        for (const p of db.posts || []) {
          // même dédoublonnage que /api/posts/all (sur tous les posts), pour avoir exactement les mêmes chiffres
          const k = `${p.date_key}|${p.video_url}|${p.user_id}`; if (seen.has(k)) continue; seen.add(k);
          if (!chIds.has(String(p.channel_id))) continue;
          posts.push({ ...p, views: tracked.has(String(p.channel_id)) && viewsTracker ? viewsTracker.viewsForUrl(p.video_url) : null });
          users[p.user_id] = true;
        }
      }
      const known_users = {}; for (const id of Object.keys(users)) if (known[id]) known_users[id] = known[id];

      let clippers = [], clickTracking = false;
      try {
        const { getAllClippers } = require('./clippers'), ck = require('./clickmagick');
        clickTracking = ck.hasKey();
        clippers = getAllClippers().filter(x => String(x.clientId) === String(c.id)).map(x => { const { addedBy, ...rest } = x; return { ...rest, clicks: ck.clicksFor(x) }; });
      } catch {}

      res.set('Cache-Control', 'no-store');
      res.json({
        client,
        config: { clients: [client], views, topVideos: own(cfg.topVideos), testimonials: own(cfg.testimonials), clientSettings: { [c.id]: settings } },
        posts, known_users, viewsTracking: viewsTracker ? viewsTracker.summary() : null,
        clippers, clickTracking,
      });
    } catch (e) { console.error('[PUBLIC]', e.message); res.status(500).json({ error: 'server_error' }); }
  });
}

module.exports = { mountPublic };
