/* ─────────────────────────────────────────────────────────────
   Formulaire "Apply" / "Join the waitlist" du site → Discord

   POST /api/apply   { name, email, phone, message, website, page }
   L'adresse du webhook Discord reste SECRÈTE ici, dans la variable Railway
   APPLY_WEBHOOK_URL. Le site ne la voit jamais.

   Protections : champ piège anti-robot, limite par IP, limite globale,
   vérification de l'origine (seulement le site), longueurs max,
   aucune mention @everyone / @here possible.
   ───────────────────────────────────────────────────────────── */
const { rateLimit } = require('./security');

const WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;

function allowedOrigins() {
  const site = (process.env.SITE_URL || 'https://sollenzia.com').replace(/\/+$/, '');
  const list = [site, 'https://sollenzia.com', 'https://www.sollenzia.com'];
  for (const o of String(process.env.APPLY_ALLOWED_ORIGINS || '').split(',')) if (o.trim()) list.push(o.trim().replace(/\/+$/, ''));
  return new Set(list);
}

// texte propre : pas de mentions Discord, longueur max
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/@(everyone|here)/gi, '@​$1').replace(/<@[!&]?\d+>/g, '[mention]').trim().slice(0, max);

function mountApply(app) {
  const perIp = rateLimit(3, 15 * 60 * 1000);   // 3 envois / 15 min / IP
  const origins = allowedOrigins();
  let hourCount = 0; setInterval(() => { hourCount = 0; }, 60 * 60 * 1000).unref();

  app.post('/api/apply', perIp, async (req, res) => {
    try {
      const hook = String(process.env.APPLY_WEBHOOK_URL || '').trim();
      if (!WEBHOOK_RE.test(hook)) { console.error('[APPLY] APPLY_WEBHOOK_URL manquant ou invalide sur Railway'); return res.status(503).json({ error: 'unavailable' }); }

      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return res.status(403).json({ error: 'forbidden' });

      const b = req.body || {};
      // robot : champ invisible rempli → on fait semblant que ça a marché
      if (b.website) return res.json({ ok: true });

      if (++hourCount > 60) return res.status(429).json({ error: 'Too many requests. Try again later.' });

      const name = clean(b.name, 100), email = clean(b.email, 200), phone = clean(b.phone, 40), message = clean(b.message, 2000), page = clean(b.page, 80);
      if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid' });

      const waitlist = message.startsWith('[WAITLIST]'), learn = message.startsWith('[LEARN]');
      const title = waitlist ? '📝 New waitlist signup (Sollenzia Learn)' : learn ? '📚 New "learn" request' : '📬 New Application Received';
      const admin = String(process.env.ADMIN_USER_ID || '').replace(/\D/g, '');

      const fields = [
        { name: '👤 Name', value: name || '-', inline: true },
        { name: '📧 Email', value: email, inline: true },
      ];
      if (!waitlist) {
        fields.push({ name: '📱 Phone', value: phone || '-', inline: false });
        fields.push({ name: '💬 Message', value: message.replace(/^\[(LEARN)\]\s*/, '') || '-', inline: false });
      }
      if (page) fields.push({ name: '🌐 Page', value: page, inline: true });

      const payload = {
        content: admin ? `<@${admin}> ${waitlist ? 'new waitlist signup' : 'new application just dropped'} 👇` : undefined,
        allowed_mentions: admin ? { users: [admin] } : { parse: [] },
        username: 'Sollenzia Applications',
        embeds: [{ title, color: waitlist ? 0x8e79cf : 0x00A3FF, fields, footer: { text: `Submitted on ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` } }],
      };

      const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) { console.error('[APPLY] Discord a répondu', r.status); return res.status(502).json({ error: 'send_failed' }); }
      res.json({ ok: true });
    } catch (e) {
      console.error('[APPLY]', e.message);
      res.status(500).json({ error: 'server_error' });
    }
  });
}

module.exports = { mountApply };
