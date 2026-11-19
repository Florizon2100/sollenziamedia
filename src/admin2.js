/* ─────────────────────────────────────────────────────────────
   Sollenzia — API du nouvel admin (admin2.html)

   Toutes les routes demandent le header x-api-key = API_SECRET.

     GET  /api/v2/state            → tout ce dont l'admin a besoin (config, serveurs Discord,
                                     salons, workflow, monteurs, sauvegardes)
     POST /api/v2/save             → { ops: [...] } modifications précises, enregistrées tout de suite
     GET  /api/v2/history          → copies de la config + sauvegardes quotidiennes
     POST /api/v2/history/restore  → { name } remet une ancienne copie de la config
                                     (la version actuelle est d'abord copiée, rien n'est perdu)

   Sécurité des données
     • Chaque modification lit le fichier à jour sur le disque puis ne change QUE ce qui est
       demandé : deux onglets ou l'ancien admin ne s'écrasent pas entre eux.
     • Avant chaque écriture, la config est copiée dans backups/config/ (les 400 dernières).
     • Une sauvegarde complète datée est faite chaque jour dans backups/daily/AAAA-MM-JJ/.
       Une sauvegarde existante n'est JAMAIS écrasée. On garde 90 jours + le 1er de chaque mois.
     • Supprimer un client le met à la corbeille (récupérable). Son workflow reste sur le disque.
     • Les nouvelles données de l'admin sont rangées sous "v2" dans admin-config.json :
       l'ancien admin, le dashboard et le workflow continuent de marcher sans changement.
   ───────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;
const KEEP_SNAPSHOTS = 400;
const KEEP_DAILY_DAYS = 90;

let discord = null;                       // client discord.js (branché depuis index.js)
function attachDiscord(client) { discord = client; }

const SETTINGS_KEYS = {
  showPosts: 'bool', showMonthlyViews: 'bool', showFollowers: 'bool', showLikes: 'bool', apifyViews: 'bool',
  customWorkflow: 'bool', totalFollowers: 'int', totalLikes: 'int', totalPostsOverride: 'int', totalViewsOverride: 'int',
  workflowMode: 'str', workflowPlatforms: 'plats', workflowWebhook: 'webhook',
};
const PLATS = ['instagram', 'tiktok', 'youtube', 'facebook'];
const get = (o, p, fb) => { for (const k of p) { if (o == null) return fb; o = o[k]; } return o === undefined ? fb : o; };
const V2_ROOTS = ['channels', 'people', 'finance', 'notify', 'prefs'];

function mountAdmin2(app, { dataDir, secret }) {
  const CONFIG = path.join(dataDir, 'admin-config.json');
  const SNAP_DIR = path.join(dataDir, 'backups', 'config');
  const DAILY_DIR = path.join(dataDir, 'backups', 'daily');

  const auth = (req, res, next) => {
    if (!secret || req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const writeJSON = (f, data) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(tmp, f); };
  const mkdir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const parisDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  /* ───────── copies de la config ───────── */
  function snapshotConfig(reason) {
    if (!fs.existsSync(CONFIG)) return null;
    mkdir(SNAP_DIR);
    const name = `admin-config-${stamp()}-${String(reason || 'save').replace(/[^\w-]/g, '').slice(0, 20)}.json`;
    fs.copyFileSync(CONFIG, path.join(SNAP_DIR, name));
    const all = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) { try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch {} }
    return name;
  }

  /* ───────── sauvegarde quotidienne (jamais écrasée) ───────── */
  function copyTree(src, dst) {
    mkdir(dst);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === 'backups' || e.name === 'node_modules' || e.name === 'lost+found' || e.name.endsWith('.tmp')) continue;
      const a = path.join(src, e.name), b = path.join(dst, e.name);
      if (e.isDirectory()) copyTree(a, b);
      else if (e.isFile()) fs.copyFileSync(a, b);
    }
  }
  function dailyBackup() {
    try {
      mkdir(DAILY_DIR);
      const day = parisDay();
      const dst = path.join(DAILY_DIR, day);
      if (fs.existsSync(dst)) return { skipped: true, day };
      const tmp = dst + '.partial';
      fs.rmSync(tmp, { recursive: true, force: true });
      copyTree(dataDir, tmp);
      fs.renameSync(tmp, dst);
      // ménage : 90 derniers jours + le 1er de chaque mois pour toujours
      const days = fs.readdirSync(DAILY_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAILY_DAYS))) {
        if (!d.endsWith('-01')) fs.rmSync(path.join(DAILY_DIR, d), { recursive: true, force: true });
      }
      console.log(`[ADMIN2] Daily backup saved: backups/daily/${day}`);
      return { ok: true, day };
    } catch (e) { console.error('[ADMIN2] Daily backup failed:', e.message); return { error: e.message }; }
  }
  setTimeout(dailyBackup, 20 * 1000);
  setInterval(dailyBackup, 60 * 60 * 1000);

  /* ───────── config : lecture + modification sûre ───────── */
  const loadConfig = () => {
    const c = readJSON(CONFIG, {}) || {};
    if (!Array.isArray(c.clients)) c.clients = [];
    if (!c.clientSettings || typeof c.clientSettings !== 'object') c.clientSettings = {};
    if (!c.v2 || typeof c.v2 !== 'object') c.v2 = {};
    return c;
  };
  // une seule écriture à la fois (file d'attente) ; une erreur ne bloque pas les suivantes
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const withConfig = fn => serial(() => {
    const cfg = loadConfig();
    const result = fn(cfg);
    cfg.v2.rev = (cfg.v2.rev || 0) + 1;
    cfg.v2.updatedAt = Date.now();
    snapshotConfig('admin2');
    writeJSON(CONFIG, cfg);
    return { cfg, result };
  });

  const cleanId = v => String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40);
  const cleanStr = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
  const findClient = (cfg, id) => cfg.clients.find(c => String(c.id) === String(id));
  const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 30);

  function applyOp(cfg, op) {
    const t = op && op.op;
    if (t === 'client.upsert') {
      const b = op.client || {};
      const name = cleanStr(b.name, 80);
      let c = b.id ? findClient(cfg, b.id) : null;
      let isNew = false;
      if (!c) {
        if (!name) throw new Error('Name required');
        c = { id: Date.now().toString(), name, channels: [], clientSecret: '' };
        cfg.clients.push(c);
        isNew = true;
      }
      // Ancien client sans clé : son lien marche avec son nom ("silva-twins"). On fige ce lien
      // AVANT tout changement de nom, pour qu'il continue de marcher.
      if (!isNew && !c.clientSecret) c.clientSecret = String(c.name || '').toLowerCase().replace(/\s+/g, '-');
      if (name) c.name = name;
      if (b.clientSecret !== undefined) {
        const key = cleanStr(b.clientSecret, 40).replace(/[^\w-]/g, '');
        if (key && cfg.clients.some(o => o !== c && o.clientSecret === key)) throw new Error('This client key is already used by another client');
        if (key) c.clientSecret = key;
      }
      if (!c.clientSecret) {         // chaque client a une clé (lien dashboard / workflow)
        let base = slug(c.name) || 'client', key = base, i = 2;
        while (cfg.clients.some(o => o !== c && o.clientSecret === key)) key = base + i++;
        c.clientSecret = key;
      }
      if (b.guildId !== undefined) { const g = cleanId(b.guildId); if (g) c.guildId = g; else delete c.guildId; }
      if (!Array.isArray(c.channels)) c.channels = [];
      return { id: c.id };
    }
    if (t === 'client.delete') {
      const c = findClient(cfg, op.id);
      if (!c) throw new Error('Client not found');
      cfg.v2.trash = cfg.v2.trash || {};
      (cfg.v2.trash.clients = cfg.v2.trash.clients || []).push({ client: c, settings: cfg.clientSettings[c.id] || null, deletedAt: Date.now() });
      cfg.clients = cfg.clients.filter(x => x !== c);
      return { id: c.id };
    }
    if (t === 'client.restore') {
      const list = (cfg.v2.trash && cfg.v2.trash.clients) || [];
      const i = list.findIndex(x => String(x.client.id) === String(op.id));
      if (i < 0) throw new Error('Not in trash');
      const [x] = list.splice(i, 1);
      if (!findClient(cfg, x.client.id)) cfg.clients.push(x.client);
      if (x.settings && !cfg.clientSettings[x.client.id]) cfg.clientSettings[x.client.id] = x.settings;
      return { id: x.client.id };
    }
    if (t === 'channel.add') {
      const c = findClient(cfg, op.clientId); if (!c) throw new Error('Client not found');
      const id = cleanId(op.channel && op.channel.id); if (!/^\d{5,25}$/.test(id)) throw new Error('Invalid channel ID');
      const other = cfg.clients.find(o => o !== c && (o.channels || []).some(ch => String(ch.id) === id));
      if (other && !op.move) throw new Error(`This channel already belongs to ${other.name}`);
      if (other) other.channels = other.channels.filter(ch => String(ch.id) !== id);
      c.channels = c.channels || [];
      if (!c.channels.some(ch => String(ch.id) === id)) c.channels.push({ id, name: cleanStr(op.channel.name, 60) || id, salary: Number(op.channel.salary) || 0 });
      return { id };
    }
    if (t === 'channel.update') {
      const c = findClient(cfg, op.clientId); if (!c) throw new Error('Client not found');
      const ch = (c.channels || []).find(x => String(x.id) === String(op.channelId)); if (!ch) throw new Error('Channel not found');
      const f = op.fields || {};
      if (f.name !== undefined && cleanStr(f.name, 60)) ch.name = cleanStr(f.name, 60);
      if (f.salary !== undefined) ch.salary = Math.max(0, Number(f.salary) || 0);
      return { id: ch.id };
    }
    if (t === 'channel.remove') {
      const c = findClient(cfg, op.clientId); if (!c) throw new Error('Client not found');
      c.channels = (c.channels || []).filter(x => String(x.id) !== String(op.channelId));
      return {};
    }
    if (t === 'settings.patch') {
      const c = findClient(cfg, op.clientId); if (!c) throw new Error('Client not found');
      const s = cfg.clientSettings[c.id] = cfg.clientSettings[c.id] || {};
      for (const [k, v] of Object.entries(op.patch || {})) {
        const kind = SETTINGS_KEYS[k]; if (!kind) continue;
        if (kind === 'bool') s[k] = v === true;
        else if (kind === 'int') s[k] = v === '' || v === null || v === undefined || isNaN(parseInt(v)) ? null : parseInt(v);
        else if (kind === 'str') s[k] = cleanStr(v, 60) || null;
        else if (kind === 'plats') { const p = (Array.isArray(v) ? v : []).filter(x => PLATS.includes(x)); s[k] = p.length ? p : ['instagram']; }
        else if (kind === 'webhook') {
          const w = cleanStr(v, 300);
          if (w && !WEBHOOK_RE.test(w)) throw new Error('This is not a Discord webhook link');
          s[k] = w || null;
        }
      }
      return {};
    }
    if (t === 'v2.set') {
      const p = (Array.isArray(op.path) ? op.path : []).map(x => String(x).replace(/[^\w.-]/g, '').slice(0, 60));
      if (!p.length || !V2_ROOTS.includes(p[0]) || p.some(x => !x || x === '__proto__' || x === 'constructor' || x === 'prototype')) throw new Error('Invalid path');
      if (JSON.stringify(op.value === undefined ? null : op.value).length > 200000) throw new Error('Value too big');
      let o = cfg.v2;
      for (const k of p.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; o = o[k]; }
      const last = p[p.length - 1];
      if (op.value === null || op.value === undefined) delete o[last]; else o[last] = op.value;
      return {};
    }
    if (t === 'views.set') {
      const week = cleanStr(op.week, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('Invalid week');
      const entries = (op.entries || []).map(e => ({ channelId: cleanId(e.channelId), channelName: cleanStr(e.channelName, 60), views: Math.max(0, parseInt(e.views) || 0) })).filter(e => e.channelId);
      cfg.views = Array.isArray(cfg.views) ? cfg.views : [];
      let w = cfg.views.find(x => x.week === week);
      if (!w) { w = { week, entries: [] }; cfg.views.push(w); cfg.views.sort((a, b) => a.week.localeCompare(b.week)); }
      for (const e of entries) {
        const i = w.entries.findIndex(x => x.channelId === e.channelId);
        if (e.views === 0) { if (i > -1) w.entries.splice(i, 1); }
        else if (i > -1) w.entries[i] = e; else w.entries.push(e);
      }
      cfg.views = cfg.views.filter(x => x.entries.length);
      return {};
    }
    if (t === 'topVideos.upsert' || t === 'testimonials.upsert') {
      const key = t.split('.')[0];
      const list = cfg[key] = Array.isArray(cfg[key]) ? cfg[key] : [];
      const v = op.item || {};
      const client = findClient(cfg, v.clientId);
      const base = key === 'topVideos'
        ? { title: cleanStr(v.title, 160), link: cleanStr(v.link, 400), platform: PLATS.includes(v.platform) ? v.platform : 'tiktok', views: Math.max(0, parseInt(v.views) || 0) }
        : { filename: cleanStr(v.filename, 160), description: cleanStr(v.description, 400) };
      Object.assign(base, { clientId: client ? client.id : '', clientName: client ? client.name : '' });
      const i = v.id ? list.findIndex(x => x.id === v.id) : -1;
      if (i > -1) list[i] = { ...list[i], ...base };
      else list.push({ id: Date.now().toString(), ...base, addedAt: new Date().toISOString() });
      if (key === 'topVideos') list.sort((a, b) => (b.views || 0) - (a.views || 0));
      return {};
    }
    if (t === 'topVideos.delete' || t === 'testimonials.delete') {
      const key = t.split('.')[0];
      cfg[key] = (cfg[key] || []).filter(x => x.id !== op.id);
      return {};
    }
    throw new Error('Unknown operation: ' + t);
  }

  /* ───────── infos Discord + salons ───────── */
  function guildInfo() {
    const guilds = {};
    const add = (id, patch) => { guilds[id] = Object.assign(guilds[id] || { id, name: null, channels: {} }, patch); };
    for (const f of fs.readdirSync(dataDir)) {
      const m = f.match(/^config-(\d+)\.json$/);
      if (!m) continue;
      const g = readJSON(path.join(dataDir, f), {}) || {};
      add(m[1], { config: { logChannel: g.log_channel_id || null, allowed: g.allowed_channel_ids || [], paused: g.paused_channels || [], modes: g.channel_modes || {} } });
    }
    if (discord && discord.guilds) {
      for (const g of discord.guilds.cache.values()) {
        const channels = {}, categories = {};
        for (const ch of g.channels.cache.values()) {
          if (ch.type === 0 || ch.type === 5) channels[ch.id] = { name: ch.name, parent: ch.parent ? ch.parent.name : null, parentId: ch.parentId || null, position: ch.rawPosition };
          if (ch.type === 4) categories[ch.id] = { name: ch.name, position: ch.rawPosition };
        }
        const me = g.members.me, perms = me && me.permissions;
        const has = f => { try { return !!(perms && perms.has(f)); } catch { return false; } };
        add(g.id, { name: g.name, icon: g.iconURL ? g.iconURL({ size: 64 }) : null, members: g.memberCount, channels, categories, botIn: true,
          perms: { manageChannels: has('ManageChannels'), manageMessages: has('ManageMessages') || has('PinMessages'), manageWebhooks: has('ManageWebhooks'), admin: has('Administrator') } });
      }
    }
    return guilds;
  }
  // salon → serveur, d'après les fichiers de posts (pour les salons que Discord ne liste pas)
  function channelGuildFromPosts() {
    const map = {};
    const main = process.env.GUILD_ID || null;
    for (const f of fs.readdirSync(dataDir)) {
      const m = f.match(/^posts-(?:(\d{6,})-)?\d{4}-\d{2}\.json$/);
      if (!m) continue;
      const g = m[1] || main;
      if (!g) continue;
      for (const p of (readJSON(path.join(dataDir, f), {}) || {}).posts || []) if (p.channel_id && !map[p.channel_id]) map[p.channel_id] = g;
    }
    return map;
  }

  function workflowSummary(cfg) {
    const out = {};
    for (const c of cfg.clients) {
      const id = String(c.id).replace(/[^\w-]/g, '');
      const f = path.join(dataDir, 'workflows', `${id}.json`);
      if (!fs.existsSync(f)) continue;
      const b = readJSON(f, null);
      if (!b || !Array.isArray(b.cards)) continue;
      out[c.id] = {
        rev: b.rev || 0, updatedAt: b.updatedAt || 0,
        counts: ['inspo', 'review', 'ready', 'posted'].reduce((o, col) => (o[col] = b.cards.filter(x => x.col === col).length, o), {}),
        review: b.cards.filter(x => x.col === 'review').map(x => {
          const fb = (x.feedback || []).slice(-1)[0] || null;
          return { id: x.id, title: x.title, status: x.status || null, hasVideo: !!x.video, version: x.version || 1, createdAt: x.createdAt, last: fb ? { by: fb.by, ts: fb.ts, system: !!fb.system } : null };
        }),
        pushDevices: (readJSON(path.join(dataDir, 'workflows', `${id}.push.json`), null) || {}).subs?.length || 0,
      };
    }
    return out;
  }

  function listBackups() {
    const snaps = fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).sort().reverse() : [];
    const daily = fs.existsSync(DAILY_DIR) ? fs.readdirSync(DAILY_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
    return {
      snapshots: snaps.slice(0, 60).map(n => ({ name: n, size: fs.statSync(path.join(SNAP_DIR, n)).size })),
      snapshotCount: snaps.length,
      daily: daily.map(d => ({ day: d })),
    };
  }

  /* ═════════ Routes ═════════ */
  app.get('/api/v2/state', auth, (req, res) => {
    try {
      const cfg = loadConfig();
      const editors = (readJSON(path.join(dataDir, 'workflows', '_editors.json'), null) || {}).editors || [];
      res.set('Cache-Control', 'no-store');
      res.json({
        config: cfg,
        rev: cfg.v2.rev || 0,
        guilds: guildInfo(),
        channelGuild: channelGuildFromPosts(),
        channelLast: (() => { try { const l = require('./alerts').lastPostByChannel(dataDir), o = {}; for (const [k, v] of Object.entries(l)) o[k] = v.t; return o; } catch { return {}; } })(),
        mainGuildId: process.env.GUILD_ID || null,
        botConnected: !!(discord && discord.isReady && discord.isReady()),
        workflows: workflowSummary(cfg),
        editors: editors.map(e => ({ id: e.id, name: e.name, clients: e.clients, active: e.active !== false })),
        backups: listBackups(),
        serverTime: Date.now(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v2/save', auth, async (req, res) => {
    const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops.slice(0, 50) : [];
    if (!ops.length) return res.status(400).json({ error: 'No changes' });
    try {
      // on vérifie d'abord sur une copie : si une opération est refusée, rien n'est écrit
      const test = loadConfig();
      for (const op of ops) applyOp(test, op);
    } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const { cfg, result } = await withConfig(cfg => ops.map(op => applyOp(cfg, op)));
      res.json({ ok: true, rev: cfg.v2.rev, results: result, config: cfg });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v2/history', auth, (req, res) => res.json(listBackups()));

  app.get('/api/v2/history/:name', auth, (req, res) => {
    const name = path.basename(String(req.params.name));
    const f = path.join(SNAP_DIR, name);
    if (!name.endsWith('.json') || !fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
    res.json(readJSON(f, {}));
  });

  app.post('/api/v2/history/restore', auth, async (req, res) => {
    const name = path.basename(String((req.body || {}).name || ''));
    const f = path.join(SNAP_DIR, name);
    if (!name.endsWith('.json') || !fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
    const data = readJSON(f, null);
    if (!data || !Array.isArray(data.clients)) return res.status(400).json({ error: 'This copy is not readable' });
    try {
      await serial(() => {
        const rev = loadConfig().v2.rev || 0;
        snapshotConfig('before-restore');
        data.v2 = data.v2 || {};
        data.v2.rev = rev + 1;
        writeJSON(CONFIG, data);
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v2/backup-now', auth, (req, res) => res.json(dailyBackup()));

  /* ═════════ Discord depuis le site (bot) ═════════ */
  const serverConfig = require('./server-config');
  const DOC_URL = 'https://docs.google.com/document/d/10Yg1iip60s9SyD9ytS3aa_w88Dtdj7qZVuKI4xKuFHQ/edit?tab=t.0';
  const ready = () => discord && discord.isReady && discord.isReady();
  const fail = (res, code, msg) => res.status(code).json({ error: msg });
  const channelName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 90);
  const guildFor = (cfg, c, want) => {
    if (want && discord.guilds.cache.has(String(want))) return discord.guilds.cache.get(String(want));
    if (c.guildId && discord.guilds.cache.has(String(c.guildId))) return discord.guilds.cache.get(String(c.guildId));
    const count = {};
    for (const ch of c.channels || []) for (const g of discord.guilds.cache.values()) if (g.channels.cache.has(String(ch.id))) count[g.id] = (count[g.id] || 0) + 1;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    return best ? discord.guilds.cache.get(best[0]) : null;
  };
  const instructions = () => [
    '**How to log your videos 📌**',
    '',
    'Every time you post a video, log it here with the bot:',
    '• `/posted` → 1 video: paste the **link** and pick the **platform**',
    '• `/posted2` → 2 videos on the same platform at once',
    '',
    'Forgot a day? Add the **day** option (e.g. `day: 18`) to log it for that date.',
    'Only post in **this** channel for this account. The guide is pinned above 👆',
  ].join('\n');

  app.post('/api/v2/discord/create-account', auth, async (req, res) => {
    if (!ready()) return fail(res, 503, 'Le bot n’est pas connecté à Discord pour l’instant.');
    const b = req.body || {}, cfg = loadConfig(), c = findClient(cfg, b.clientId);
    if (!c) return fail(res, 404, 'Client introuvable');
    const name = channelName(b.name);
    if (!name) return fail(res, 400, 'Nom du compte manquant');
    const guild = guildFor(cfg, c, b.guildId);
    if (!guild) return fail(res, 400, 'Choisis d’abord le serveur Discord du client (Réglages du client).');
    const cat = b.categoryId ? guild.channels.cache.get(String(b.categoryId)) : null;
    if (b.categoryId && (!cat || cat.type !== 4)) return fail(res, 400, 'Cette catégorie n’existe pas sur le serveur du client.');
    let ch;
    try {
      ch = await guild.channels.create({ name, type: 0, parent: cat ? cat.id : undefined, reason: 'Sollenzia admin: new account' });
    } catch (e) { return fail(res, 403, 'Discord refuse de créer le salon (le bot a-t-il « Gérer les salons » ?) : ' + e.message); }
    const warnings = [];
    const docUrl = String(get(cfg, ['v2', 'prefs', 'docUrl'], DOC_URL) || DOC_URL);
    try { const m = await ch.send(docUrl); try { await m.pin(); } catch (e) { warnings.push('Lien envoyé mais pas épinglé (droit « Gérer les messages » manquant).'); } }
    catch (e) { warnings.push('Impossible d’envoyer le lien du guide : ' + e.message); }
    try { await ch.send(instructions()); } catch (e) { warnings.push('Message d’explication non envoyé : ' + e.message); }
    // le bot doit accepter /posted dans ce salon
    try {
      const gc = serverConfig.loadConfig(guild.id);
      if ((gc.allowed_channel_ids || []).length) serverConfig.addAllowedChannel(guild.id, ch.id);
      const modes = Object.values(gc.channel_modes || {});
      if (modes.length && modes.filter(x => x === 'tracking-only').length > modes.length / 2) serverConfig.setChannelMode(guild.id, ch.id, 'tracking-only');
    } catch (e) { warnings.push('Config du bot : ' + e.message); }
    const { cfg: saved } = await withConfig(cfg2 => {
      applyOp(cfg2, { op: 'channel.add', clientId: c.id, channel: { id: ch.id, name: ch.name } });
      if (!c.guildId) { const cc = findClient(cfg2, c.id); if (cc) cc.guildId = guild.id; }
      cfg2.v2.channels = cfg2.v2.channels || {};
      cfg2.v2.channels[ch.id] = { ...(cfg2.v2.channels[ch.id] || {}), createdByBot: true, createdAt: Date.now() };
      if (cat) { cfg2.v2.prefs = cfg2.v2.prefs || {}; cfg2.v2.prefs.lastCategory = cfg2.v2.prefs.lastCategory || {}; cfg2.v2.prefs.lastCategory[c.id] = cat.id; }
    });
    console.log(`[ADMIN2] Channel #${ch.name} created for ${c.name}`);
    res.json({ ok: true, channel: { id: ch.id, name: ch.name }, warnings, config: saved });
  });

  app.post('/api/v2/discord/delete-channel', auth, async (req, res) => {
    if (!ready()) return fail(res, 503, 'Le bot n’est pas connecté à Discord pour l’instant.');
    const b = req.body || {}, cfg = loadConfig(), c = findClient(cfg, b.clientId);
    if (!c) return fail(res, 404, 'Client introuvable');
    const id = String(b.channelId || '');
    if (!(c.channels || []).some(x => String(x.id) === id)) return fail(res, 400, 'Ce salon n’est pas un compte de ce client.');
    let guildId = null;
    try {
      const ch = await discord.channels.fetch(id).catch(() => null);
      if (ch) {
        if (ch.type !== 0 && ch.type !== 5) return fail(res, 400, 'Ce n’est pas un salon texte.');
        guildId = ch.guildId;
        await ch.delete('Sollenzia admin: account deleted');
      }
    } catch (e) { return fail(res, 403, 'Discord refuse de supprimer le salon : ' + e.message); }
    if (guildId) { try { serverConfig.removeAllowedChannel(guildId, id); serverConfig.unpauseChannel(guildId, id); } catch {} }
    const { cfg: saved } = await withConfig(cfg2 => applyOp(cfg2, { op: 'channel.remove', clientId: c.id, channelId: id }));
    res.json({ ok: true, deletedOnDiscord: !!guildId, config: saved });
  });

  app.post('/api/v2/discord/pause', auth, async (req, res) => {
    const id = String((req.body || {}).channelId || ''), on = !!(req.body || {}).paused;
    let guildId = null;
    if (ready()) { const ch = await discord.channels.fetch(id).catch(() => null); if (ch) guildId = ch.guildId; }
    if (!guildId) guildId = channelGuildFromPosts()[id] || null;
    if (!guildId) return fail(res, 404, 'Serveur du salon introuvable');
    if (on) serverConfig.pauseChannel(guildId, id); else serverConfig.unpauseChannel(guildId, id);
    res.json({ ok: true, paused: on });
  });

  // Salon + webhook du client sur TON serveur de notifications (jamais de suppression)
  app.post('/api/v2/discord/notify-setup', auth, async (req, res) => {
    if (!ready()) return fail(res, 503, 'Le bot n’est pas connecté à Discord pour l’instant.');
    const cfg = loadConfig(), c = findClient(cfg, (req.body || {}).clientId);
    if (!c) return fail(res, 404, 'Client introuvable');
    const existing = get(cfg, ['v2', 'notify', 'clients', c.id, 'webhook'], '') || get(cfg, ['clientSettings', c.id, 'workflowWebhook'], '');
    if (existing && WEBHOOK_RE.test(existing)) return res.json({ ok: true, existing: true });
    const gid = get(cfg, ['v2', 'notify', 'guildId'], ''), guild = gid && discord.guilds.cache.get(String(gid));
    if (!guild) return fail(res, 400, 'Choisis ton serveur de notifications dans Réglages (le bot doit y être).');
    const catId = get(cfg, ['v2', 'notify', 'categoryId'], ''), cat = catId ? guild.channels.cache.get(String(catId)) : null;
    try {
      const ch = await guild.channels.create({ name: channelName(c.name) || 'client', type: 0, parent: cat && cat.type === 4 ? cat.id : undefined, reason: 'Sollenzia: notifications for ' + c.name });
      const hook = await ch.createWebhook({ name: 'Sollenzia', reason: 'Sollenzia notifications' });
      const { cfg: saved } = await withConfig(cfg2 => {
        cfg2.v2.notify = cfg2.v2.notify || {}; cfg2.v2.notify.clients = cfg2.v2.notify.clients || {};
        cfg2.v2.notify.clients[c.id] = { ...(cfg2.v2.notify.clients[c.id] || {}), webhook: hook.url, channelId: ch.id };
        const s = cfg2.clientSettings[c.id] = cfg2.clientSettings[c.id] || {};
        if (!s.workflowWebhook) s.workflowWebhook = hook.url;
      });
      res.json({ ok: true, channel: ch.name, config: saved });
    } catch (e) { fail(res, 403, 'Discord refuse (le bot a-t-il « Gérer les salons » et « Gérer les webhooks » sur ton serveur ?) : ' + e.message); }
  });

  /* ═════════ Alertes automatiques ═════════ */
  const alerts = require('./alerts');
  alerts.startAlerts({ dataDir, getConfig: loadConfig });
  app.get('/api/v2/alerts', auth, (req, res) => {
    try { res.json({ alerts: alerts.computeAlerts(dataDir, loadConfig()).map(a => ({ client: a.client.name, type: a.type, title: a.title })) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/v2/alerts/test', auth, async (req, res) => {
    const cfg = loadConfig(), c = findClient(cfg, (req.body || {}).clientId);
    if (!c) return fail(res, 404, 'Client introuvable');
    const hook = alerts.webhookFor(cfg, c);
    if (!hook) return fail(res, 400, 'Pas de webhook pour ce client.');
    const r = await alerts.postWebhook(hook, { username: 'Sollenzia · Alertes', embeds: [{ title: '✅ Les alertes arrivent ici', description: `Clippers inactifs, reviews en retard et paiements de **${c.name}**.`, color: 0x16823b }] });
    r.ok ? res.json({ ok: true }) : fail(res, 502, 'Discord a refusé : ' + (r.status || r.error));
  });

  exported.updateConfig = fn => withConfig(fn);
  return { snapshotConfig };
}

const exported = { updateConfig: null };
module.exports = { mountAdmin2, attachDiscord, updateConfig: (fn) => { if (!exported.updateConfig) throw new Error('admin2 not ready'); return exported.updateConfig(fn); } };
