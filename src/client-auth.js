/* ─────────────────────────────────────────────────────────────
   Sollenzia — connexion des clients à l'espace client (client.html)

   Chaque client a un identifiant + un mot de passe, créés depuis admin2.html.
   Le mot de passe n'est JAMAIS enregistré en clair : seulement une empreinte
   (scrypt + sel aléatoire), dans le fichier client-passwords.json du volume Railway.

   Routes
     POST   /api/client-login            { user, password }   → { key, name, workflow }
     GET    /api/client-auth             (clé owner)          → liste des accès (sans mot de passe)
     POST   /api/client-auth             (clé owner)          { clientId, user, password }
     DELETE /api/client-auth/:clientId   (clé owner)

   Protections : 10 erreurs en 15 min → blocage 15 min (par adresse IP et par identifiant),
   réponse identique si l'identifiant ou le mot de passe est faux, comparaison à temps constant.
   ───────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clientIp } = require('./security');

const FAIL_MAX = 10, WINDOW = 15 * 60 * 1000;
const normUser = u => String(u || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, 40);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function mountClientAuth(app, auth, dataDir) {
  const FILE = path.join(dataDir, 'client-passwords.json');
  const CFG = path.join(dataDir, 'admin-config.json');
  const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const load = () => readJSON(FILE, {}) || {};
  const store = data => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, FILE); };
  const clients = () => (readJSON(CFG, {}) || {}).clients || [];

  // compteurs d'erreurs (IP et identifiant)
  const fails = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now) fails.delete(k); }, 60 * 1000).unref();
  const blocked = k => { const f = fails.get(k); return f && f.n >= FAIL_MAX && f.until > Date.now(); };
  const fail = k => { const f = fails.get(k), n = f && f.until > Date.now() ? f.n + 1 : 1; fails.set(k, { n, until: Date.now() + WINDOW }); };

  // ── connexion client ──
  app.post('/api/client-login', (req, res) => {
    const ip = 'ip:' + clientIp(req);
    const user = normUser(req.body && req.body.user), password = String((req.body && req.body.password) || '');
    const uk = 'user:' + user;
    if (blocked(ip) || blocked(uk)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });

    const all = load();
    const entry = Object.entries(all).find(([, a]) => a.user === user);
    // on calcule toujours une empreinte, même si l'identifiant n'existe pas (même temps de réponse)
    const ref = entry ? entry[1] : { salt: '00', hash: '00'.repeat(64) };
    const test = hashPassword(password.slice(0, 200), ref.salt).hash;
    const ok = !!entry && password.length > 0 && crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(ref.hash, 'hex'));
    if (!ok) { fail(ip); if (user) fail(uk); return res.status(401).json({ error: 'Wrong username or password.' }); }

    const c = clients().find(x => x.id === entry[0]);
    if (!c || !c.clientSecret) return res.status(403).json({ error: 'Your access is not ready yet. Contact Sollenzia.' });
    fails.delete(uk);
    const s = (readJSON(CFG, {}).clientSettings || {})[c.id] || {};
    res.json({ key: c.clientSecret, name: c.name, workflow: s.customWorkflow === true });
  });

  // ── gestion par l'owner (admin2.html) ──
  app.get('/api/client-auth', auth, (req, res) => {
    const all = load();
    res.json(Object.entries(all).map(([clientId, a]) => ({ clientId, user: a.user, updatedAt: a.updatedAt })));
  });

  app.post('/api/client-auth', auth, (req, res) => {
    const b = req.body || {};
    const clientId = String(b.clientId || ''), user = normUser(b.user), password = String(b.password || '');
    if (!clients().some(c => c.id === clientId)) return res.status(404).json({ error: 'Client introuvable.' });
    if (user.length < 3) return res.status(400).json({ error: 'Identifiant trop court (3 caractères minimum).' });
    if (password.length < 10) return res.status(400).json({ error: 'Mot de passe trop court (10 caractères minimum).' });
    const all = load();
    if (Object.entries(all).some(([id, a]) => a.user === user && id !== clientId)) return res.status(409).json({ error: 'Cet identifiant est déjà pris par un autre client.' });
    all[clientId] = { user, ...hashPassword(password), updatedAt: new Date().toISOString() };
    store(all);
    res.json({ ok: true, user });
  });

  app.delete('/api/client-auth/:clientId', auth, (req, res) => {
    const all = load();
    delete all[String(req.params.clientId)];
    store(all);
    res.json({ ok: true });
  });
}

module.exports = { mountClientAuth };
