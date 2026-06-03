const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');

function startAPI() {
  const app    = express();
  const PORT   = process.env.PORT || process.env.API_PORT || 3000;
  const SECRET = process.env.API_SECRET || 'changeme';

  app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['x-api-key','Content-Type'] }));
  app.options('*', cors());
  app.use(express.json({ limit: '2mb' }));

  function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/posts', auth, (req, res) => {
    try {
      const monthParam = req.query.month || new Date().toISOString().slice(0, 7);
      const [year, month] = monthParam.split('-').map(Number);
      const monthlyPath = path.join(dataDir, `posts-${year}-${String(month).padStart(2,'0')}.json`);
      const legacyPath  = path.join(dataDir, 'posts.json');
      let db;
      if (fs.existsSync(monthlyPath)) {
        db = JSON.parse(fs.readFileSync(monthlyPath, 'utf8'));
      } else if (fs.existsSync(legacyPath)) {
        db = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        const prefix = `${year}-${String(month).padStart(2,'0')}`;
        db.posts = (db.posts || []).filter(p => p.date_key?.startsWith(prefix));
      } else {
        db = { posts: [], known_users: {} };
      }
      res.json({ month: monthParam, posts: db.posts || [], known_users: db.known_users || {} });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/posts/all', auth, (req, res) => {
    try {
      const allPosts = [], knownUsers = {};
      const files = fs.readdirSync(dataDir).filter(f => f.startsWith('posts-') || f === 'posts.json');
      for (const file of files) {
        try {
          const db = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
          allPosts.push(...(db.posts || []));
          Object.assign(knownUsers, db.known_users || {});
        } catch {}
      }
      const seen = new Set();
      const unique = allPosts.filter(p => {
        const key = `${p.date_key}|${p.video_url}|${p.user_id}`;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      res.json({ posts: unique, known_users: knownUsers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/config', auth, (req, res) => {
    try {
      const configPath = path.join(dataDir, 'admin-config.json');
      if (!fs.existsSync(configPath)) return res.json({ clients: [], views: [] });
      res.json(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/config', auth, (req, res) => {
    try {
      const configPath = path.join(dataDir, 'admin-config.json');
      // Merge with existing config to not lose data
      let existing = {};
      if (fs.existsSync(configPath)) {
        try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }
      const merged = { ...existing, ...req.body };
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`[API] Running on port ${PORT}`);
  });
}

module.exports = { startAPI };
