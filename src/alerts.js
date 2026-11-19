/* ─────────────────────────────────────────────────────────────
   Sollenzia — alertes automatiques sur Discord (ton serveur de notifications)

   Toutes les 30 min, Railway regarde la même chose que l'Accueil de admin2 :
     • compte inactif récent (seuil par compte, 30 h par défaut ; pas les comptes en pause,
       alerte coupée ou complètement inactifs)
     • vidéo en retard dans Review (le client a demandé des modifs / pas de vidéo)
     • paiement client à redemander (X jours avant) puis en retard
   Chaque alerte part UNE seule fois. Une alerte « Ignorée » dans l'admin ne part pas.
   Destination : webhook « alertes » du client (Réglages → Notifications), sinon son webhook workflow.
   Au tout premier lancement, les alertes déjà en cours sont notées comme envoyées (pas d'avalanche).
   ───────────────────────────────────────────────────────────── */
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const HOUR = 36e5, DAY = 864e5;
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;
const SITE = () => (process.env.SITE_URL || 'https://sollenzia.com').replace(/\/+$/, '');

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const get = (o, p, fb) => { for (const k of p) { if (o == null) return fb; o = o[k]; } return o === undefined ? fb : o; };
const parisKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysUntil = s => Math.round((Date.parse(s + 'T12:00:00Z') - Date.parse(parisKey() + 'T12:00:00Z')) / DAY);
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && +v.slice(0, 4) >= 2000 && +v.slice(0, 4) <= 2100;
const keyOf = (kind, id) => `${kind}_${String(id).replace(/[^\w-]/g, '')}`;
const dateFR = s => new Date(s + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function addCycle(d, cyc, anchor) {
  if (cyc !== 'month') return addDays(d, +cyc || 30);
  const [y, m] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(Math.min(anchor || +d.slice(8), last)).padStart(2, '0')}`;
}
function nextPayment(f) {
  if (validDate(f.nextPayment)) return f.nextPayment;
  if (!validDate(f.startDate)) return null;
  const cyc = f.cycleDays === 'month' ? 'month' : (+f.cycleDays || 30), anchor = +f.startDate.slice(8);
  let d = f.startDate, i = 0;
  while (daysUntil(d) < 0 && i++ < 1000) d = addCycle(d, cyc, anchor);
  return d;
}
function revenueFor(cfg, cid, m) {
  const h = get(cfg, ['v2', 'finance', 'revenueHistory', cid], null);
  if (h) { const k = Object.keys(h).filter(x => /^\d{4}-\d{2}$/.test(x) && x <= m).sort().pop(); if (k) return +h[k] || 0; }
  return +get(cfg, ['v2', 'finance', 'clients', cid, 'revenue'], 0) || 0;
}

/* Dernier post de chaque salon, avec l'heure RÉELLE du /posted */
function lastPostByChannel(dataDir) {
  const last = {};
  const main = process.env.GUILD_ID || '';
  const files = fs.readdirSync(dataDir).filter(f => /^posts-(?:\d{6,}-)?\d{4}-\d{2}\.json$/.test(f));
  for (const f of files) {
    const db = readJSON(path.join(dataDir, f), null);
    if (!db || !Array.isArray(db.posts)) continue;
    const ku = db.known_users || {};
    const latestByUser = {};
    for (const p of db.posts) if (!p.logged_at && (!latestByUser[p.user_id] || (+p.id || 0) > (+latestByUser[p.user_id].id || 0))) latestByUser[p.user_id] = p;
    for (const p of db.posts) {
      let t = Date.parse(p.logged_at || '') || Date.parse(p.posted_at) || 0;
      if (!p.logged_at && latestByUser[p.user_id] === p) {
        const ua = get(ku, [p.user_id, 'updated_at'], ''), u = Date.parse(ua) || 0;
        if (u > t && u - t < 40 * DAY && String(ua).slice(11) === String(p.posted_at).slice(11)) t = u;
      }
      const id = String(p.channel_id || '');
      if (!id) continue;
      if (!last[id] || t > last[id].t) last[id] = { t, user: p.username, guild: (f.match(/^posts-(\d{6,})-/) || [])[1] || main };
    }
  }
  return last;
}
function pausedChannels(dataDir) {
  const set = new Set();
  for (const f of fs.readdirSync(dataDir)) if (/^config-\d+\.json$/.test(f)) for (const id of (readJSON(path.join(dataDir, f), {}) || {}).paused_channels || []) set.add(String(id));
  return set;
}

/* Liste des alertes actuelles, par client */
function computeAlerts(dataDir, cfg) {
  const v2 = cfg.v2 || {};
  const D = {
    inactiveHours: +get(v2, ['notify', 'inactiveHours'], 30) || 30,
    reviewLateHours: +get(v2, ['notify', 'reviewLateHours'], 24) || 24,
    paymentDays: +get(v2, ['notify', 'paymentDays'], 5) || 5,
    dormantDays: +get(v2, ['notify', 'dormantDays'], 14) || 14,
  };
  const last = lastPostByChannel(dataDir), paused = pausedChannels(dataDir), now = Date.now();
  const ignored = (k, v) => { const x = get(v2, ['prefs', 'ignore', k], null); return !!x && String(x.v) === String(v); };
  const out = [];
  for (const c of cfg.clients || []) {
    const types = get(v2, ['notify', 'clients', c.id, 'types'], {}) || {};
    const push = a => { if (!ignored(a.ikey, a.ival)) out.push({ client: c, ...a }); };
    if (types.inactive !== false) for (const ch of c.channels || []) {
      const id = String(ch.id), lp = last[id], a = get(v2, ['channels', id], {}) || {};
      if (!lp || paused.has(id) || a.alerts === false) continue;
      const h = (now - lp.t) / HOUR, limit = +a.alertHours || D.inactiveHours;
      if (h < limit || h >= D.dormantDays * 24) continue;
      push({ type: 'inactive', ikey: keyOf('inactive', id), ival: lp.t, color: 0xb8710b,
        title: `⏱️ ${ch.name} n’a rien posté depuis ${Math.floor(h)} h`,
        desc: `Dernier post par **${lp.user || '?'}** · seuil ${limit} h`, link: `#/client/${c.id}/comptes` });
    }
    if (types.reviewLate !== false) {
      const b = readJSON(path.join(dataDir, 'workflows', `${String(c.id).replace(/[^\w-]/g, '')}.json`), null);
      for (const x of (b && b.cards || []).filter(x => x.col === 'review')) {
        const fb = (x.feedback || []).slice(-1)[0];
        const needsTeam = x.status === 'changes' || (fb && fb.by === 'client' && !fb.system) || !x.video;
        const since = (fb && fb.ts) || x.createdAt || 0;
        if (!needsTeam || (now - since) / HOUR < D.reviewLateHours) continue;
        push({ type: 'reviewLate', ikey: keyOf('review', x.id), ival: since, color: 0x6c4ec1,
          title: `🎬 « ${x.title} » en retard dans Review`,
          desc: `${!x.video ? 'Pas encore de vidéo' : 'Le client a demandé des modifs'} · depuis ${Math.floor((now - since) / HOUR)} h`, link: `#/client/${c.id}/workflow` });
      }
    }
    if (types.payment !== false) {
      const f = get(v2, ['finance', 'clients', c.id], {}) || {}, np = nextPayment(f);
      if (np) {
        const n = daysUntil(np), amt = revenueFor(cfg, c.id, np.slice(0, 7));
        if (n <= D.paymentDays) push({ type: 'payment', ikey: keyOf('payment', c.id), ival: np, sendKey: n < 0 ? 'late' : 'soon', color: n < 0 ? 0xe64343 : 0x3b63f3,
          title: n < 0 ? `💸 Paiement en retard de ${-n} j` : n === 0 ? '💸 Paiement à redemander aujourd’hui' : `💸 Paiement à redemander dans ${n} j`,
          desc: `Échéance du ${dateFR(np)}${amt ? ` · ${amt.toLocaleString('fr-FR')} ${get(v2, ['finance', 'currency'], 'USD')}` : ''}`, link: `#/client/${c.id}/finances` });
      }
    }
  }
  return out;
}

function postWebhook(url, body) {
  return new Promise(resolve => {
    try {
      const u = new URL(url), data = Buffer.from(JSON.stringify(body));
      const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + '?wait=true', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 10000 }, res => {
        res.resume(); res.on('end', () => resolve({ ok: res.statusCode < 300, status: res.statusCode }));
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.end(data);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}
const webhookFor = (cfg, c) => {
  const w = [get(cfg, ['v2', 'notify', 'clients', c.id, 'webhook'], ''), get(cfg, ['clientSettings', c.id, 'workflowWebhook'], '')].map(x => String(x || '').trim()).find(x => WEBHOOK_RE.test(x));
  return w || null;
};
const embedOf = a => ({ title: a.title, description: a.desc, color: a.color, url: `${SITE()}/admin2${a.link}`, footer: { text: `${a.client.name} · Sollenzia` }, timestamp: new Date().toISOString() });

function startAlerts({ dataDir, getConfig }) {
  const SENT = path.join(dataDir, 'alerts-sent.json');
  async function run() {
    try {
      const cfg = getConfig();
      if (get(cfg, ['v2', 'notify', 'enabled'], true) === false) return;
      const alerts = computeAlerts(dataDir, cfg);
      const first = !fs.existsSync(SENT);
      const sent = readJSON(SENT, {}) || {};
      let n = 0;
      for (const a of alerts) {
        const k = a.ikey + (a.sendKey ? ':' + a.sendKey : ''), v = String(a.ival);
        if (sent[k] === v) continue;
        if (!first) {
          const hook = webhookFor(cfg, a.client);
          if (!hook) continue;                                   // pas de webhook : on réessaiera plus tard
          const r = await postWebhook(hook, { username: 'Sollenzia · Alertes', embeds: [embedOf(a)] });
          if (!r.ok) { console.error(`[ALERTS] ${a.client.name}: Discord ${r.status || r.error}`); continue; }
          n++;
          await new Promise(r => setTimeout(r, 600));
        }
        sent[k] = v;
      }
      fs.writeFileSync(SENT + '.tmp', JSON.stringify(sent)); fs.renameSync(SENT + '.tmp', SENT);
      if (first) console.log(`[ALERTS] First run: ${alerts.length} current alerts noted (not sent)`);
      else if (n) console.log(`[ALERTS] ${n} alert(s) sent`);
    } catch (e) { console.error('[ALERTS]', e.message); }
  }
  setTimeout(run, 60 * 1000);
  setInterval(run, 30 * 60 * 1000);
  return { run };
}

module.exports = { startAlerts, computeAlerts, lastPostByChannel, postWebhook, webhookFor, WEBHOOK_RE };
