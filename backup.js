/* ─────────────────────────────────────────────────────────────
   Sollenzia — sauvegarde complète (LECTURE SEULE)

   GET /api/backup   (header x-api-key = API_SECRET)
   → télécharge un fichier JSON avec TOUS les fichiers du volume Railway
     (posts, clippers, analytics, configs, workflow, monteurs, téléphones…).
   Ne modifie et n'écrase jamais rien : il copie, c'est tout.
   ───────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const MAX_TOTAL = 300 * 1024 * 1024; // sécurité : 300 Mo max

function mountBackup(app, { dataDir, secret }) {
  app.get('/api/backup', (req, res) => {
    if (!secret || req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const files = {};
    let total = 0, count = 0, skipped = [];

    const walk = (dir, rel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'lost+found') walk(abs, r); continue; }
        if (!e.isFile() || e.name.endsWith('.tmp')) continue;
        let buf;
        try { buf = fs.readFileSync(abs); } catch { skipped.push(r); continue; }
        if (total + buf.length > MAX_TOTAL) { skipped.push(r + ' (too big)'); continue; }
        total += buf.length; count++;
        const text = buf.toString('utf8');
        const isText = Buffer.from(text, 'utf8').equals(buf);
        files[r] = isText
          ? { encoding: 'utf8', size: buf.length, modified: fs.statSync(abs).mtime.toISOString(), data: text }
          : { encoding: 'base64', size: buf.length, modified: fs.statSync(abs).mtime.toISOString(), data: buf.toString('base64') };
      }
    };
    walk(dataDir, '');

    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sollenzia-railway-backup-${day}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify({ type: 'sollenzia-railway-backup', createdAt: new Date().toISOString(), dataDir, fileCount: count, totalBytes: total, skipped, files }));
    console.log(`[BACKUP] Downloaded: ${count} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
  });
}

module.exports = { mountBackup };
