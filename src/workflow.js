/* ─────────────────────────────────────────────────────────────
   Sollenzia — Workflow API (tableau client : idées → review → prêt → posté)

   Tableau
     GET  /api/workflow/:key               → infos client + tableau + ton rôle
     POST /api/workflow/:key/action        → { type, ... } une modification
     POST /api/workflow/:key/test-discord  → message de test (propriétaire)
       :key = "Client URL Key" du client (lien client)
            ou "id:<clientId>" pour un monteur (jamais la clé du client)

   Notifications téléphone (web push, pour le client)
     POST /api/workflow/:key/push/subscribe    → { subscription } ce téléphone reçoit les notifs
     POST /api/workflow/:key/push/unsubscribe  → { endpoint }
     POST /api/workflow/:key/push/test         → { endpoint } notif de test sur ce téléphone
     Le client est notifié quand l'équipe met une vidéo en review (nouvelle vidéo, idée → review, nouvelle version).
     Les clés sont créées toutes seules dans le volume (workflows/_vapid.json).

   Monteurs
     GET  /api/workflow-editor/me          → nom du monteur + ses clients   (header x-editor-token)
     GET  /api/workflow-admin/editors      → liste                          (header x-api-key)
     POST /api/workflow-admin/editors      → { name, clients: [ids] | 'all' } crée un monteur
     POST /api/workflow-admin/editors/:id  → { name?, clients?, regenerate?, delete? }

   Captures d'écran (dans un message, une demande de changements ou une nouvelle idée)
     POST /api/workflow/:key/action  avec  shots: [{ data: "<base64 jpeg/png/webp>" }]   (4 max, réduites par la page)
       → l'image est postée sur Discord (webhook du client, sinon celui par défaut) avec le message,
         la carte ne garde que la référence du message Discord. Rien n'est écrit sur le volume.
     GET  /api/workflow-shot/:clientId/:channel/:message/:attachment/:sig
       → redirige vers l'image sur Discord. Les liens Discord expirent (~24 h) : on en redemande un frais,
         au webhook qui l'a postée (ou au bot si le webhook a changé). Le message reste dans le salon pour toujours.

   Rôles (décidés ici, jamais par la page)
     x-api-key = API_SECRET              → owner  (toi)
     x-editor-token valide + client lié  → editor (monteur)
     sinon, avec la clé client           → client

   Variables Railway
     WORKFLOW_DISCORD_WEBHOOK  webhook Discord par défaut (seules les actions du CLIENT envoient un message)
                               Chaque client peut avoir le sien : Admin → client → Settings → "Discord webhook".
     SITE_URL                  défaut https://sollenzia.com
   Stockage : <volume>/workflows/<clientId>.json, <clientId>.push.json, _editors.json, _vapid.json
   ───────────────────────────────────────────────────────────── */
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const core   = require('./workflow-core');
let webpush = null;
try { webpush = require('web-push'); } catch { /* pas installé → pas de notifs téléphone */ }

// Services de notification des navigateurs (Apple, Google, Mozilla, Microsoft) — rien d'autre
const PUSH_HOSTS = ['web.push.apple.com', 'push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const isPushEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };

// Seuls les vrais webhooks Discord sont acceptés (jamais une autre adresse)
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

const clientAuth = require('./client-auth');

function mountWorkflow(app, { dataDir, secret }) {
  const dir = path.join(dataDir, 'workflows');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const SITE = (process.env.SITE_URL || 'https://sollenzia.com').replace(/\/+$/, '');

  /* ───────── fichiers ───────── */
  function readJSON(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
  function writeJSON(f, data) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data), 'utf8'); fs.renameSync(tmp, f); }
  const readConfig = () => readJSON(path.join(dataDir, 'admin-config.json'), {});

  /* ───────── clients ───────── */
  function clientInfo(cfg, c) {
    const s = (cfg.clientSettings || {})[c.id] || {};
    const platforms = core.PLATS.filter(p => (s.workflowPlatforms || []).includes(p));
    return {
      id: String(c.id).replace(/[^\w-]/g, ''),
      rawId: String(c.id),
      key: c.clientSecret || (c.name || '').toLowerCase().replace(/\s+/g, '-'),
      name: c.name || 'Client',
      enabled: s.customWorkflow === true,
      mode: s.workflowMode || 'US Strategy Room',
      platforms: platforms.length ? platforms : ['instagram'],
      webhook: WEBHOOK_RE.test(String(s.workflowWebhook || '').trim()) ? String(s.workflowWebhook).trim() : null,
    };
  }
  // Clé client (lien client). Le nom ("will-silva") ne marche que si le client n'a pas de clé.
  function clientByKey(key) {
    key = String(key || '').trim();
    if (!key) return null;
    const cfg = readConfig();
    const c = (cfg.clients || []).find(c =>
      (c.clientSecret && c.clientSecret === key) ||
      (!c.clientSecret && (c.name || '').toLowerCase().replace(/\s+/g, '-') === key.toLowerCase()));
    return c ? clientInfo(cfg, c) : null;
  }
  function clientById(id) {
    const cfg = readConfig();
    const c = (cfg.clients || []).find(c => String(c.id) === String(id));
    return c ? clientInfo(cfg, c) : null;
  }

  /* ───────── monteurs ───────── */
  const EDITORS_FILE = path.join(dir, '_editors.json');
  const loadEditors = () => { const d = readJSON(EDITORS_FILE, null); return d && Array.isArray(d.editors) ? d : { editors: [] }; };
  const saveEditors = d => writeJSON(EDITORS_FILE, d);
  const newToken = () => crypto.randomBytes(18).toString('base64url');
  const sameToken = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  function editorByToken(token) {
    if (!token || String(token).length < 16) return null;
    return loadEditors().editors.find(e => e.active !== false && sameToken(e.token, token)) || null;
  }
  const editorHasClient = (ed, client) => ed && (ed.clients === 'all' || (Array.isArray(ed.clients) && ed.clients.map(String).includes(client.rawId)));
  const isOwner = req => !!secret && require('./security').safeEqual(req.headers['x-api-key'], secret);

  /* Qui fait la requête, et sur quel client ? */
  function resolve(req) {
    const key = String(req.params.key || '');
    const owner = isOwner(req);
    const ed = owner ? null : editorByToken(req.headers['x-editor-token']);
    if (key.startsWith('id:')) {
      const client = clientById(key.slice(3));
      if (!client) return { error: [404, 'unknown_client'] };
      if (owner) return { client, role: 'owner', name: 'Sollenzia' };
      if (ed && editorHasClient(ed, client)) return { client, role: 'editor', name: ed.name };
      return { error: [403, 'This editor link has no access to this client. Ask Sollenzia.'] };
    }
    // ?c=sz_… = session ouverte avec identifiant + mot de passe (Client panel)
    const sessionId = clientAuth.sessionClientId(key);
    const client = sessionId ? clientById(sessionId) : clientByKey(key);
    if (!client) return { error: [404, 'unknown_client'] };
    if (owner) return { client, role: 'owner', name: 'Sollenzia' };
    if (ed && editorHasClient(ed, client)) return { client, role: 'editor', name: ed.name };
    // client protégé par mot de passe : sa clé / son nom ne suffisent plus, il faut se connecter
    if (!sessionId && clientAuth.hasPassword(client.rawId)) return { error: [401, 'login_required'] };
    return { client, role: 'client' };
  }

  const fileFor = client => path.join(dir, `${client.id}.json`);
  function loadBoard(client) {
    const b = readJSON(fileFor(client), null);
    return b && Array.isArray(b.cards) ? b : { cards: [], rev: 0, updatedAt: 0 };
  }
  const saveBoard = (client, board) => writeJSON(fileFor(client), board);
  const publicClient = c => ({ name: c.name, mode: c.mode, platforms: c.platforms, enabled: c.enabled });
  /* ───────── captures d'écran ───────── */
  const SHOT_KEY_FILE = path.join(dir, '_shots.key');
  let shotKeyCache = null;
  function shotKey() {
    if (shotKeyCache) return shotKeyCache;
    let k = process.env.SHOT_SECRET || (fs.existsSync(SHOT_KEY_FILE) ? fs.readFileSync(SHOT_KEY_FILE, 'utf8').trim() : '');
    if (!k) { k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SHOT_KEY_FILE, k); }
    return (shotKeyCache = k);
  }
  const shotSig = (cid, s) => crypto.createHmac('sha256', shotKey()).update(`${cid}.${s.ch}.${s.m}.${s.a}`).digest('base64url').slice(0, 24);
  const shotPath = (client, s) => `/api/workflow-shot/${encodeURIComponent(client.rawId)}/${s.ch}/${s.m}/${s.a}/${shotSig(client.rawId, s)}`;
  // Ajoute le lien d'affichage (p) aux captures, seulement dans la réponse (jamais dans le fichier)
  function withShotLinks(client, cards) {
    const add = list => list.map(s => (s && s.m ? { n: s.n, p: shotPath(client, s) } : s));
    return cards.map(c => {
      if (!c.shots && !(c.feedback || []).some(f => f.shots)) return c;
      const x = { ...c };
      if (Array.isArray(c.shots)) x.shots = add(c.shots);
      if (Array.isArray(c.feedback)) x.feedback = c.feedback.map(f => (f.shots ? { ...f, shots: add(f.shots) } : f));
      return x;
    });
  }
  const MAGIC = [
    { mime: 'image/jpeg', ext: 'jpg', ok: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mime: 'image/png', ext: 'png', ok: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mime: 'image/webp', ext: 'webp', ok: b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  ];
  const MAX_SHOT_BYTES = 4 * 1024 * 1024;
  // Lit les images envoyées par la page. Erreur claire si quelque chose ne va pas.
  function readShots(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw Object.assign(new Error('Screenshots were sent in a wrong format.'), { status: 400 });
    if (list.length > core.MAX_SHOTS) throw Object.assign(new Error(`${core.MAX_SHOTS} screenshots max per message.`), { status: 400 });
    return list.map((x, i) => {
      const b64 = String((x && x.data) || '').replace(/^data:[\w/+.-]+;base64,/, '');
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw Object.assign(new Error('A screenshot could not be read. Try another image.'), { status: 400 });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > MAX_SHOT_BYTES) throw Object.assign(new Error('A screenshot is too large (4 MB max).'), { status: 400 });
      const t = MAGIC.find(m => m.ok(buf));
      if (!t) throw Object.assign(new Error('Only images (JPG, PNG, WEBP) can be sent.'), { status: 400 });
      return { buf, mime: t.mime, name: `screenshot-${i + 1}.${t.ext}` };
    });
  }
  const counts = cards => core.COLS.reduce((o, col) => (o[col] = cards.filter(c => c.col === col).length, o), {});

  /* ═════════ Tableau ═════════ */
  app.get('/api/workflow/:key', (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    const board = loadBoard(r.client);
    res.set('Cache-Control', 'no-store');
    const v = vapid();
    const hook = r.client.webhook || process.env.WORKFLOW_DISCORD_WEBHOOK;
    res.json({ client: publicClient(r.client), role: r.role, me: r.name || null, features: { push: v ? v.publicKey : null, shots: !!hook }, board: { cards: withShotLinks(r.client, board.cards), rev: board.rev || 0 } });
  });

  app.post('/api/workflow/:key/action', async (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    const { client, role } = r;
    if (!client.enabled && role === 'client') return res.status(403).json({ error: 'The workflow board is not enabled for this client.' });
    const action = { ...(req.body || {}) };
    const now = Date.now();
    const opts = { platforms: client.platforms, name: r.name, now };

    // Captures : d'abord sur Discord (c'est Discord qui garde l'image), ensuite seulement on enregistre la carte
    let files = [], sentWith = null;
    try { files = readShots(action.shots); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    delete action.shots;
    if (files.length) {
      if (!['comment', 'add'].includes(action.type)) return res.status(400).json({ error: 'Screenshots can only be added to a message or a new idea.' });
      const hook = client.webhook || process.env.WORKFLOW_DISCORD_WEBHOOK;
      if (!hook) return res.status(400).json({ error: 'Screenshots are not set up for this board yet. Ask Sollenzia to connect Discord.' });
      let dry;
      try { dry = core.apply(JSON.parse(JSON.stringify(loadBoard(client))), action, role, { ...opts, shots: files.map(() => ({ ch: '10000', m: '10000', a: '10000' })) }); }
      catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      const ev = dry.events.find(x => ['idea', 'revision', 'comment'].includes(x.kind)) || {};
      const card = dry.board.cards.find(c => c.id === (ev.cardId || (dry.card && dry.card.id))) || dry.card;
      const kind = role === 'client' && KINDS[ev.kind] && ev.kind !== 'test' ? ev.kind : 'shot';
      const text = ev.text || (action.type === 'comment' ? action.text : (action.card || {}).note) || '';
      const sent = await postFiles(hook, { username: 'Sollenzia Workflow', embeds: [embedFor(kind, client, card, text, role === 'client' ? client.name : r.name)], allowed_mentions: { parse: [] } }, files);
      if (!sent.ok) { console.error('[WORKFLOW] screenshot → Discord:', sent.error); return res.status(502).json({ error: 'The screenshot could not be sent to Discord. Try again in a moment.' }); }
      const msg = sent.message || {};
      const wid = (hook.match(/\/webhooks\/(\d+)\//) || [])[1] || '';
      opts.shots = (msg.attachments || []).map(a => ({ w: wid, ch: String(msg.channel_id), m: String(msg.id), a: String(a.id), n: a.filename }));
      if (!opts.shots.length) return res.status(502).json({ error: 'Discord did not keep the screenshot. Try again.' });
      for (const s of opts.shots) urlCache.set(`${s.m}.${s.a}`, cacheEntry((msg.attachments || []).find(a => String(a.id) === s.a).url));
      sentWith = ev.kind || null;
    }

    const board = loadBoard(client);
    let result;
    try {
      result = core.apply(board, action, role, opts);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    board.rev = (board.rev || 0) + 1;
    board.updatedAt = Date.now();
    try { saveBoard(client, board); }
    catch (e) { console.error('[WORKFLOW] save failed:', e.message); return res.status(500).json({ error: 'Could not save, try again.' }); }

    res.json({ ok: true, role, board: { cards: withShotLinks(client, board.cards), rev: board.rev } });

    // Discord : uniquement ce que fait le CLIENT (jamais toi ni tes monteurs)
    // Téléphone du client : quand l'ÉQUIPE met une vidéo en review
    for (const ev of result.events) {
      const card = board.cards.find(c => c.id === ev.cardId) || result.card;
      if (role === 'client') {
        if (sentWith && ev.kind === sentWith) { sentWith = null; continue; }   // déjà envoyé avec les captures
        notify(ev.kind, client, card, ev.text).then(x => { if (x && !x.ok && !x.skipped) console.error('[WORKFLOW] Discord:', x.error); });
      } else if (ev.kind === 'cut' && card && card.col === 'review') {
        pushToClient(client, {
          title: card.version > 1 ? `🎬 New version to review (V${card.version})` : '🎬 New video to review',
          body: card.title,
          url: `/workflow?c=${encodeURIComponent(client.key)}&card=${encodeURIComponent(card.id)}`,
          tag: card.id,
        });
      }
    }
  });

  /* ═════════ Notifications téléphone (web push) ═════════ */
  const VAPID_FILE = path.join(dir, '_vapid.json');
  let vapidCache = null;
  function vapid() {
    if (!webpush) return null;
    if (vapidCache) return vapidCache;
    let v = process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY
      ? { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY }
      : readJSON(VAPID_FILE, null);
    if (!v || !v.publicKey || !v.privateKey) { v = webpush.generateVAPIDKeys(); writeJSON(VAPID_FILE, v); console.log('[WORKFLOW] Push keys created'); }
    webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT || SITE, v.publicKey, v.privateKey);
    return (vapidCache = v);
  }
  const pushFile = client => path.join(dir, `${client.id}.push.json`);
  const loadSubs = client => { const d = readJSON(pushFile(client), null); return d && Array.isArray(d.subs) ? d : { subs: [] }; };

  async function sendPush(sub, payload) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 86400, urgency: 'high', topic: String(payload.tag || 'sollenzia').replace(/[^\w-]/g, '').slice(0, 32) || undefined });
      return { ok: true };
    } catch (e) {
      return { ok: false, gone: e.statusCode === 404 || e.statusCode === 410, error: e.statusCode ? `Push service answered ${e.statusCode}` : e.message };
    }
  }
  function forgetSubs(client, endpoints) {
    if (!endpoints.length) return;
    const d = loadSubs(client);                       // relu : on ne perd pas un abonnement ajouté entre-temps
    d.subs = d.subs.filter(x => !endpoints.includes(x.endpoint));
    writeJSON(pushFile(client), d);
  }
  async function pushToClient(client, payload) {
    if (!vapid()) return;
    const targets = loadSubs(client).subs.filter(x => x.role === 'client');
    if (!targets.length) return;
    const results = await Promise.all(targets.map(x => sendPush(x, payload)));
    const gone = targets.filter((x, i) => results[i].gone).map(x => x.endpoint);
    results.forEach((r, i) => { if (!r.ok && !r.gone) console.error('[WORKFLOW] push', client.name, r.error); });
    forgetSubs(client, gone);                          // téléphone désinstallé / notifs coupées
  }

  app.post('/api/workflow/:key/push/subscribe', (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    if (!vapid()) return res.status(501).json({ error: 'Phone notifications are not installed on Railway yet.' });
    const sub = (req.body || {}).subscription || {};
    const keys = sub.keys || {};
    if (!isPushEndpoint(sub.endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return res.status(400).json({ error: 'This browser sent an invalid subscription.' });
    }
    const d = loadSubs(r.client);
    d.subs = d.subs.filter(x => x.endpoint !== sub.endpoint);
    d.subs.push({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, role: r.role, name: r.name || null, createdAt: Date.now() });
    if (d.subs.length > 30) d.subs = d.subs.slice(-30);
    writeJSON(pushFile(r.client), d);
    res.json({ ok: true });
  });

  app.post('/api/workflow/:key/push/unsubscribe', (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    forgetSubs(r.client, [String((req.body || {}).endpoint || '')]);
    res.json({ ok: true });
  });

  app.post('/api/workflow/:key/push/test', async (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    if (!vapid()) return res.status(501).json({ error: 'Phone notifications are not installed on Railway yet.' });
    const endpoint = String((req.body || {}).endpoint || '');
    const sub = loadSubs(r.client).subs.find(x => x.endpoint === endpoint);
    if (!sub) return res.status(404).json({ error: 'This phone is not registered. Turn notifications on again.' });
    const x = await sendPush(sub, {
      title: '✅ Notifications are on',
      body: `You'll get a notification here when a new video is ready to review.`,
      url: `/workflow?c=${encodeURIComponent(r.client.key)}`,
      tag: 'test',
    });
    if (x.gone) forgetSubs(r.client, [endpoint]);
    res.status(x.ok ? 200 : 502).json(x);
  });

  app.post('/api/workflow/:key/test-discord', async (req, res) => {
    const r = resolve(req);
    if (r.error) return res.status(r.error[0]).json({ error: r.error[1] });
    if (r.role !== 'owner') return res.status(401).json({ error: 'Owner only' });
    const x = await notify('test', r.client, null, `Notifications for ${r.client.name}'s board will arrive here.`);
    if (x.skipped) return res.status(400).json({ ok: false, error: 'No webhook for this client. Add one in Admin → client Settings, or set WORKFLOW_DISCORD_WEBHOOK in Railway.' });
    res.status(x.ok ? 200 : 502).json({ ...x, source: r.client.webhook ? 'client' : 'default' });
  });

  /* ═════════ Monteur : ses clients ═════════ */
  app.get('/api/workflow-editor/me', (req, res) => {
    const ed = editorByToken(req.headers['x-editor-token']);
    if (!ed) return res.status(401).json({ error: 'This editor link is not valid anymore. Ask Sollenzia for a new one.' });
    const cfg = readConfig();
    const list = (cfg.clients || [])
      .map(c => clientInfo(cfg, c))
      .filter(c => editorHasClient(ed, c))
      .map(c => {
        const cards = loadBoard(c).cards;
        const needs = cards.filter(x => x.col === 'review' && x.status === 'changes').length;
        return { id: c.rawId, name: c.name, counts: counts(cards), changes: needs };
      });
    res.set('Cache-Control', 'no-store');
    res.json({ name: ed.name, clients: list });
  });

  /* ═════════ Admin : gérer les monteurs (propriétaire) ═════════ */
  const ownerOnly = (req, res) => { if (isOwner(req)) return true; res.status(401).json({ error: 'Unauthorized' }); return false; };
  const cleanClients = v => (v === 'all' ? 'all' : (Array.isArray(v) ? [...new Set(v.map(String))].slice(0, 200) : []));
  const publicEditor = e => ({ id: e.id, name: e.name, token: e.token, clients: e.clients, active: e.active !== false, createdAt: e.createdAt, url: `${SITE}/workflow?e=${e.token}` });

  app.get('/api/workflow-admin/editors', (req, res) => {
    if (!ownerOnly(req, res)) return;
    res.json({ editors: loadEditors().editors.map(publicEditor) });
  });

  app.post('/api/workflow-admin/editors', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const name = String((req.body || {}).name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const d = loadEditors();
    const e = { id: 'ed_' + crypto.randomBytes(5).toString('hex'), name, token: newToken(), clients: cleanClients(req.body.clients), active: true, createdAt: Date.now() };
    d.editors.push(e);
    saveEditors(d);
    res.json({ editor: publicEditor(e) });
  });

  app.post('/api/workflow-admin/editors/:id', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const d = loadEditors();
    const e = d.editors.find(x => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: 'Editor not found' });
    const b = req.body || {};
    if (b.delete) { d.editors = d.editors.filter(x => x !== e); saveEditors(d); return res.json({ ok: true, deleted: true }); }
    if (typeof b.name === 'string' && b.name.trim()) e.name = b.name.trim().slice(0, 60);
    if (b.clients !== undefined) e.clients = cleanClients(b.clients);
    if (typeof b.active === 'boolean') e.active = b.active;
    if (b.regenerate) e.token = newToken(); // l'ancien lien ne marche plus
    saveEditors(d);
    res.json({ editor: publicEditor(e) });
  });

  /* ═════════ Captures : afficher l'image gardée par Discord ═════════ */
  const urlCache = new Map();   // "message.attachment" → { url, until }   (en mémoire seulement)
  function cacheEntry(url) {
    let until = Date.now() + 6 * 3600e3;
    try { const ex = parseInt(new URL(url).searchParams.get('ex'), 16); if (ex) until = ex * 1000 - 15 * 60e3; } catch {}
    if (urlCache.size > 2000) urlCache.delete(urlCache.keys().next().value);
    return { url, until };
  }
  async function freshShotUrl(client, s) {
    const hit = urlCache.get(`${s.m}.${s.a}`);
    if (hit && hit.until > Date.now()) return hit.url;
    const pick = m => { const a = m && (m.attachments || []).find(x => String(x.id) === s.a); return a && a.url; };
    let url = null;
    // 1) le webhook qui l'a postée (pas besoin de droits pour le bot)
    for (const h of [client.webhook, process.env.WORKFLOW_DISCORD_WEBHOOK]) {
      if (url || !h || !s.w || !h.includes(`/webhooks/${s.w}/`)) continue;
      const g = await getJSON(`${h.replace(/\/+$/, '')}/messages/${s.m}`);
      url = g.ok ? pick(g.data) : null;
    }
    // 2) le bot (si le webhook du client a changé depuis)
    if (!url && process.env.DISCORD_TOKEN) {
      const g = await getJSON(`https://discord.com/api/v10/channels/${s.ch}/messages/${s.m}`, { Authorization: `Bot ${process.env.DISCORD_TOKEN}` });
      url = g.ok ? pick(g.data) : null;
    }
    if (url) urlCache.set(`${s.m}.${s.a}`, cacheEntry(url));
    return url;
  }
  app.get('/api/workflow-shot/:cid/:ch/:m/:a/:sig', async (req, res) => {
    const { cid, ch, m, a, sig } = req.params;
    if (![ch, m, a].every(x => /^\d{5,25}$/.test(x))) return res.status(404).end();
    const client = clientById(cid);
    const good = client && shotSig(client.rawId, { ch, m, a });
    if (!good || good.length !== String(sig).length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(String(sig)))) return res.status(404).end();
    let s = null;
    for (const c of loadBoard(client).cards) {
      for (const x of [...(c.shots || []), ...(c.feedback || []).flatMap(f => f.shots || [])]) if (x && x.m === m && x.a === a) { s = x; break; }
      if (s) break;
    }
    if (!s) return res.status(404).type('text').send('This screenshot was removed.');
    const url = await freshShotUrl(client, s);
    if (!url) return res.status(404).type('text').send('Discord no longer has this screenshot (message deleted?).');
    res.set('Cache-Control', 'private, max-age=1800');
    res.redirect(302, url);
  });

  function getJSON(url, headers = {}) {
    return new Promise(resolve => {
      try {
        const req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'User-Agent': 'SollenziaWorkflow (sollenzia.com, 1.0)', ...headers } }, res => {
          let d = ''; res.on('data', c => { d += c; });
          res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve(res.statusCode < 300 && j ? { ok: true, data: j } : { ok: false, status: res.statusCode }); });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      } catch { resolve({ ok: false }); }
    });
  }
  // Message Discord avec fichiers joints (multipart). ?wait=true → Discord renvoie le message (avec les pièces jointes).
  function postFiles(url, payload, files) {
    return new Promise(resolve => {
      try {
        const u = new URL(url);
        u.searchParams.set('wait', 'true');
        const boundary = '----sollenzia' + crypto.randomBytes(8).toString('hex');
        payload = { ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) };
        const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`)];
        files.forEach((f, i) => {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`), f.buf, Buffer.from('\r\n'));
        });
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const body = Buffer.concat(parts);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
          hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        }, res => {
          let d = '';
          res.on('data', c => { d += c; });
          res.on('end', () => {
            if (res.statusCode >= 300) return resolve({ ok: false, error: `Discord answered ${res.statusCode} ${d.slice(0, 200)}`.trim() });
            try { resolve({ ok: true, message: JSON.parse(d) }); } catch { resolve({ ok: false, error: 'Discord sent an unreadable answer' }); }
          });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.setTimeout(20000, () => req.destroy(new Error('Discord did not answer in 20s')));
        req.end(body);
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  /* ═════════ Discord ═════════ */
  // Seules ces actions du client envoient un message (approbation, "posté", commentaires sur une idée : rien)
  const KINDS = {
    idea:         { title: '💡 New idea',            color: 0x3b63f3 },
    revision:     { title: '💬 New review',          color: 0x6c4ec1 },
    idea_deleted: { title: '🗑️ Idea deleted',        color: 0xe64343 },
    test:         { title: '✅ Discord is connected', color: 0x16823b },
    comment:      null,                                                    // commentaire sur une idée : pas de message… sauf avec une capture
    shot:         { title: '📎 Screenshot',          color: 0x7c3aed },
  };
  const NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' };
  const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function notify(kind, client, card, text) {
    const url = client.webhook || process.env.WORKFLOW_DISCORD_WEBHOOK;   // webhook du client, sinon celui par défaut
    const k = KINDS[kind];
    if (!k || kind === 'shot') return Promise.resolve({ ok: true, skipped: true });
    if (!url) return Promise.resolve({ ok: false, skipped: true });
    return postJSON(url, { username: 'Sollenzia Workflow', embeds: [embedFor(kind, client, card, text, client.name)], allowed_mentions: { parse: [] } });
  }
  function embedFor(kind, client, card, text, by) {
    const k = KINDS[kind] || KINDS.shot;
    const fields = [
      { name: 'Client', value: cut(client.name, 100), inline: true },
      { name: 'By', value: cut(by || client.name, 100), inline: true },
    ];
    if (card) {
      fields.push({ name: 'Platforms', value: core.cleanPlatforms(card.platforms, client.platforms).map(p => NAMES[p]).join(', '), inline: true });
      if (card.col !== 'inspo') fields.push({ name: 'Version', value: 'V' + (card.version || 1), inline: true });
      const l = card.col === 'inspo' ? card.link : card.video;
      if (kind !== 'idea_deleted' && /^https?:\/\//i.test(l || '')) fields.push({ name: card.col === 'inspo' ? 'Reference' : 'Video', value: cut(l, 1000) });
    }
    const embed = {
      title: cut(`${k.title} · ${card ? card.title : client.name}`, 256),
      color: k.color,
      url: `${SITE}/workflow?c=${encodeURIComponent(client.key)}&role=agency`,
      fields,
      footer: { text: `Sollenzia Workflow · ${client.mode}` },
      timestamp: new Date().toISOString(),
    };
    const desc = text || (card && (card.col === 'inspo' ? card.note : ((card.notes || [])[0] || {}).text));
    if (desc) embed.description = cut(desc, 2000);
    return embed;
  }

  function postJSON(url, payload) {
    return new Promise(resolve => {
      try {
        const u = new URL(url);
        const body = Buffer.from(JSON.stringify(payload));
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
          hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, res => {
          let d = '';
          res.on('data', c => { d += c; });
          res.on('end', () => resolve(res.statusCode < 300
            ? { ok: true }
            : { ok: false, error: `Discord answered ${res.statusCode}${res.statusCode === 404 ? ' (webhook deleted or URL wrong)' : ''} ${d.slice(0, 200)}`.trim() }));
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.setTimeout(10000, () => req.destroy(new Error('Discord did not answer in 10s')));
        req.end(body);
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  console.log('[WORKFLOW] Routes ready' + (process.env.WORKFLOW_DISCORD_WEBHOOK ? ' · default Discord webhook on' : ' · no default Discord webhook (per-client webhooks still work)')
    + (vapid() ? ' · phone notifications on' : ' · phone notifications off (web-push not installed)'));
}

module.exports = { mountWorkflow };
