/* ─────────────────────────────────────────────────────────────
   Sollenzia — Workflow API (tableau client : idées → review → prêt)

   GET  /api/workflow/:key               → infos client + tableau
   POST /api/workflow/:key/action        → { type, ... } une modification
   POST /api/workflow/:key/test-discord  → message de test (éditeur seulement)

   :key = la "Client URL Key" du client (même clé que le lien dashboard).
   Rôle : header x-api-key = API_SECRET → éditeur ("Sollenzia Editor"), sinon → client.
   Le rôle est décidé ici, jamais par la page.

   Variables Railway :
     WORKFLOW_DISCORD_WEBHOOK  webhook Discord pour les notifications (obligatoire pour Discord)
     SITE_URL                  défaut https://sollenzia.com (lien dans les messages Discord)
   Stockage : <volume>/workflows/<clientId>.json
   ───────────────────────────────────────────────────────────── */
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const core  = require('./workflow-core');

const EDITOR = 'Sollenzia Editor';

function mountWorkflow(app, { dataDir, secret }) {
  const dir = path.join(dataDir, 'workflows');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const SITE = (process.env.SITE_URL || 'https://sollenzia.com').replace(/\/+$/, '');

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-config.json'), 'utf8')); }
    catch { return {}; }
  }

  // Trouve le client par sa clé. Le nom ("will-silva") ne marche que si le client n'a pas de clé.
  function findClient(key) {
    key = String(key || '').trim();
    if (!key) return null;
    const cfg = readConfig();
    const c = (cfg.clients || []).find(c =>
      (c.clientSecret && c.clientSecret === key) ||
      (!c.clientSecret && (c.name || '').toLowerCase().replace(/\s+/g, '-') === key.toLowerCase()));
    if (!c) return null;
    const s = (cfg.clientSettings || {})[c.id] || {};
    const platforms = core.PLATS.filter(p => (s.workflowPlatforms || []).includes(p));
    return {
      id: String(c.id).replace(/[^\w-]/g, ''),
      key,
      name: c.name || 'Client',
      enabled: s.customWorkflow === true,
      mode: s.workflowMode || 'US Strategy Room',
      platforms: platforms.length ? platforms : ['instagram'],
    };
  }

  const fileFor = client => path.join(dir, `${client.id}.json`);
  function loadBoard(client) {
    try { const b = JSON.parse(fs.readFileSync(fileFor(client), 'utf8')); if (Array.isArray(b.cards)) return b; } catch {}
    return { cards: [], rev: 0, updatedAt: 0 };
  }
  function saveBoard(client, board) {
    const f = fileFor(client), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(board), 'utf8');
    fs.renameSync(tmp, f); // écriture atomique : jamais de fichier à moitié écrit
  }

  const roleOf = req => (secret && req.headers['x-api-key'] === secret ? 'editor' : 'client');
  const publicClient = c => ({ name: c.name, mode: c.mode, platforms: c.platforms, enabled: c.enabled });

  // ── Lecture du tableau ──
  app.get('/api/workflow/:key', (req, res) => {
    const client = findClient(req.params.key);
    if (!client) return res.status(404).json({ error: 'unknown_client' });
    const role = roleOf(req);
    const board = loadBoard(client);
    res.set('Cache-Control', 'no-store');
    res.json({ client: publicClient(client), role, board: { cards: board.cards, rev: board.rev || 0 } });
  });

  // ── Une modification ──
  app.post('/api/workflow/:key/action', (req, res) => {
    const client = findClient(req.params.key);
    if (!client) return res.status(404).json({ error: 'unknown_client' });
    const role = roleOf(req);
    if (!client.enabled && role !== 'editor') return res.status(403).json({ error: 'The workflow board is not enabled for this client.' });
    const board = loadBoard(client);
    let result;
    try {
      result = core.apply(board, req.body || {}, role, { platforms: client.platforms });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    board.rev = (board.rev || 0) + 1;
    board.updatedAt = Date.now();
    try { saveBoard(client, board); }
    catch (e) { console.error('[WORKFLOW] save failed:', e.message); return res.status(500).json({ error: 'Could not save, try again.' }); }

    res.json({ ok: true, role, board: { cards: board.cards, rev: board.rev } });

    // Notifications Discord après la réponse (la page n'attend pas Discord)
    for (const ev of result.events) {
      const card = board.cards.find(c => c.id === ev.cardId) || result.card;
      notify(ev.kind, client, card, role, ev.text).then(r => {
        if (r && !r.ok && !r.skipped) console.error('[WORKFLOW] Discord:', r.error);
      });
    }
  });

  // ── Test Discord (éditeur) ──
  app.post('/api/workflow/:key/test-discord', async (req, res) => {
    const client = findClient(req.params.key);
    if (!client) return res.status(404).json({ error: 'unknown_client' });
    if (roleOf(req) !== 'editor') return res.status(401).json({ error: 'Editor only' });
    const r = await notify('test', client, null, 'editor', `Notifications for ${client.name}'s board will arrive here.`);
    if (r.skipped) return res.status(400).json({ ok: false, error: 'WORKFLOW_DISCORD_WEBHOOK is not set in Railway → Variables.' });
    res.status(r.ok ? 200 : 502).json(r);
  });

  /* ───────── Discord ───────── */
  const KINDS = {
    idea:     { title: '💡 New idea',               color: 0x3b63f3 },
    cut:      { title: '🎬 New video to review',     color: 0x6c4ec1 },
    revision: { title: '✏️ Revision requested',      color: 0xb8710b },
    reopen:   { title: '↩️ Reopened for revisions',  color: 0xb8710b },
    test:     { title: '✅ Discord is connected',     color: 0x16823b },
  };
  const NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' };
  const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function notify(kind, client, card, role, text) {
    const url = process.env.WORKFLOW_DISCORD_WEBHOOK;
    const k = KINDS[kind];
    if (!k) return Promise.resolve({ ok: true, skipped: true }); // approvals, comments on ideas: no ping
    if (!url) return Promise.resolve({ ok: false, skipped: true });
    const fields = [
      { name: 'Client', value: cut(client.name, 100), inline: true },
      { name: 'By', value: role === 'editor' ? EDITOR : cut(client.name, 100), inline: true },
    ];
    if (card) {
      fields.push({ name: 'Platforms', value: core.cleanPlatforms(card.platforms, client.platforms).map(p => NAMES[p]).join(', '), inline: true });
      if (card.col !== 'inspo') fields.push({ name: 'Version', value: 'V' + (card.version || 1), inline: true });
      const l = card.col === 'inspo' ? card.link : card.video;
      if (/^https?:\/\//i.test(l || '')) fields.push({ name: card.col === 'inspo' ? 'Reference' : 'Video', value: cut(l, 1000) });
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
    return postJSON(url, { username: 'Sollenzia Workflow', embeds: [embed], allowed_mentions: { parse: [] } });
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

  console.log('[WORKFLOW] Routes ready' + (process.env.WORKFLOW_DISCORD_WEBHOOK ? ' (Discord on)' : ' (Discord off: set WORKFLOW_DISCORD_WEBHOOK)'));
}

module.exports = { mountWorkflow };
