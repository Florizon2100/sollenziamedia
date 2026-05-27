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

  // Allow requests from your OVH website
  app.use(cors({
    origin: process.env.WEBSITE_URL || '*',
    methods: ['GET'],
  }));

  // Auth middleware
  function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  // ── GET /api/posts?month=2026-05 ──
  // Returns all posts for a given month (or current month if not specified)
  app.get('/api/posts', auth, (req, res) => {
    try {
      const monthParam = req.query.month || new Date().toISOString().slice(0, 7);
      const [year, month] = monthParam.split('-').map(Number);

      // Try monthly file first, then legacy posts.json
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

      res.json({
        month: monthParam,
        posts: db.posts || [],
        known_users: db.known_users || {},
      });
    } catch (err) {
      console.error('[API] /api/posts error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/posts/all ──
  // Returns posts from all available monthly files
  app.get('/api/posts/all', auth, (req, res) => {
    try {
      const allPosts = [];
      const knownUsers = {};

      const files = fs.readdirSync(dataDir).filter(f =>
        f.startsWith('posts-') || f === 'posts.json'
      );

      for (const file of files) {
        try {
          const db = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
          allPosts.push(...(db.posts || []));
          Object.assign(knownUsers, db.known_users || {});
        } catch {}
      }

      // Deduplicate by id
      const seen = new Set();
      const unique = allPosts.filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

      res.json({ posts: unique, known_users: knownUsers });
    } catch (err) {
      console.error('[API] /api/posts/all error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/health ── (no auth, just to check if API is running)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.listen(PORT, () => {
    console.log(`[API] Running on port ${PORT}`);
  });
}

module.exports = { startAPI };

  // ── GET /api/config ── get clients config
  app.get('/api/config', auth, (req, res) => {
    try {
      const configPath = path.join(dataDir, 'admin-config.json');
      if (!fs.existsSync(configPath)) return res.json({ clients: [], views: [] });
      res.json(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/config ── save clients config
  app.use(express.json({ limit: '2mb' }));
  app.post('/api/config', auth, (req, res) => {
    try {
      const configPath = path.join(dataDir, 'admin-config.json');
      fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
