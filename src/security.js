/* ─────────────────────────────────────────────────────────────
   Sollenzia — protections communes de l'API

   - vraie adresse IP du visiteur derrière le proxy Railway
   - en-têtes de sécurité
   - anti force brute : trop de clés refusées depuis une même IP → blocage 15 min
   - comparaison de clé à temps constant
   - vérification que API_SECRET est bien défini et assez long
   ───────────────────────────────────────────────────────────── */
const crypto = require('crypto');

// Clé owner. Si API_SECRET manque ou est trop court, on met une valeur aléatoire
// impossible à deviner : l'admin ne marche pas, mais personne ne peut entrer avec "changeme".
function ownerSecret() {
  const s = String(process.env.API_SECRET || '');
  if (s.length >= 16 && s !== 'changeme') return s;
  console.error('[SECURITY] API_SECRET manquant ou trop court (16 caractères minimum). Accès owner désactivé tant que ce n\'est pas corrigé sur Railway.');
  return crypto.randomBytes(32).toString('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

const clientIp = req => String(req.ip || req.socket?.remoteAddress || '');

function harden(app) {
  // Railway = 1 proxy devant l'app → req.ip est la vraie IP du visiteur (non falsifiable via X-Forwarded-For)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // Anti force brute sur les clés (x-api-key / x-editor-token)
  const FAIL_MAX = 15, WINDOW = 15 * 60 * 1000;
  const fails = new Map(); // ip -> { n, until }
  setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (f.until < now) fails.delete(ip); }, 60 * 1000).unref();

  app.use((req, res, next) => {
    const ip = clientIp(req), f = fails.get(ip);
    if (f && f.n >= FAIL_MAX && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const triedKey = req.headers['x-api-key'] || req.headers['x-editor-token'] || req.query.key;
    if (triedKey) {
      res.on('finish', () => {
        if (res.statusCode !== 401 && res.statusCode !== 403) return;
        const cur = fails.get(ip);
        const n = cur && cur.until > Date.now() ? cur.n + 1 : 1;
        fails.set(ip, { n, until: Date.now() + WINDOW });
        if (n === FAIL_MAX) console.warn(`[SECURITY] ${ip} bloquée 15 min (trop de clés refusées)`);
      });
    }
    next();
  });
}

// Petit limiteur par IP : max `max` requêtes par `windowMs`
function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip); }, windowMs).unref();
  return (req, res, next) => {
    const ip = clientIp(req), now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(ip, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    next();
  };
}

module.exports = { ownerSecret, safeEqual, harden, rateLimit, clientIp };
