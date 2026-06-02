const path = require('path');
const fs   = require('fs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function getCurrentMonthYear() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

// Per-server per-month: posts-GUILDID-YYYY-MM.json
// Fallback (old): posts-YYYY-MM.json or posts.json
function getDBPath(guildId, year, month) {
  return path.join(dataDir, `posts-${guildId}-${year}-${String(month).padStart(2,'0')}.json`);
}

function loadDB(guildId, year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  const mm     = String(cm).padStart(2,'0');
  const prefix = `${cy}-${mm}`;

  // 1. Try old monthly file first (all existing data lives here)
  const oldMonthly = path.join(dataDir, `posts-${cy}-${mm}.json`);
  if (fs.existsSync(oldMonthly)) {
    try { return JSON.parse(fs.readFileSync(oldMonthly, 'utf8')); }
    catch {}
  }

  // 2. Try guild-specific monthly file (new format)
  const guildPath = getDBPath(guildId, cy, cm);
  if (fs.existsSync(guildPath)) {
    try { return JSON.parse(fs.readFileSync(guildPath, 'utf8')); }
    catch {}
  }

  // 3. Fallback: legacy posts.json filtered by month
  const legacyAll = path.join(dataDir, 'posts.json');
  if (fs.existsSync(legacyAll)) {
    try {
      const db = JSON.parse(fs.readFileSync(legacyAll, 'utf8'));
      return {
        posts:       (db.posts||[]).filter(p => p.date_key?.startsWith(prefix)),
        known_users: db.known_users || {},
      };
    } catch {}
  }

  return { posts: [], known_users: getKnownUsersGlobal(guildId) };
}

function saveDB(guildId, data, year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  const mm = String(cm).padStart(2,'0');
  // Always save to old format file so everything stays in one place
  const savePath = path.join(dataDir, `posts-${cy}-${mm}.json`);
  fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf8');
}

function getKnownUsersGlobal(guildId) {
  const known = {};
  const files = fs.readdirSync(dataDir).filter(f =>
    f.startsWith(`posts-${guildId}`) ||
    f.startsWith('posts-20') ||
    f === 'posts.json'
  );
  for (const file of files) {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      Object.assign(known, db.known_users || {});
    } catch {}
  }
  return known;
}

// ─── Insert ───────────────────────────────────────────────────────────────────

function insertPost({ guildId, userId, username, channelId, channelName, platform, videoUrl, dayOverride }) {
  const now = new Date();
  let postedAt = now.toISOString();
  let dateKey  = postedAt.slice(0, 10);

  if (dayOverride) {
    const cy = now.getFullYear(), cm = now.getMonth() + 1;
    dateKey  = `${cy}-${String(cm).padStart(2,'0')}-${String(dayOverride).padStart(2,'0')}`;
    postedAt = `${dateKey}T${now.toISOString().slice(11)}`;
  }

  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(guildId, year, month);
  const id   = (db.posts.length > 0 ? Math.max(...db.posts.map(p => p.id)) : 0) + 1;
  db.posts.push({ id, user_id: userId, username, channel_id: channelId, channel_name: channelName, platform, video_url: videoUrl, posted_at: postedAt, date_key: dateKey });
  db.known_users[userId] = { user_id: userId, username, updated_at: now.toISOString() };
  saveDB(guildId, db, year, month);
  return id;
}

function insertMultiplePosts({ guildId, userId, username, channelId, channelName, platform, videoUrls, dayOverride }) {
  const now = new Date();
  let postedAt = now.toISOString();
  let dateKey  = postedAt.slice(0, 10);

  if (dayOverride) {
    const cy = now.getFullYear(), cm = now.getMonth() + 1;
    dateKey  = `${cy}-${String(cm).padStart(2,'0')}-${String(dayOverride).padStart(2,'0')}`;
    postedAt = `${dateKey}T${now.toISOString().slice(11)}`;
  }

  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(guildId, year, month);
  let maxId  = db.posts.length > 0 ? Math.max(...db.posts.map(p => p.id)) : 0;
  for (const videoUrl of videoUrls) {
    maxId++;
    db.posts.push({ id: maxId, user_id: userId, username, channel_id: channelId, channel_name: channelName, platform, video_url: videoUrl, posted_at: postedAt, date_key: dateKey });
  }
  db.known_users[userId] = { user_id: userId, username, updated_at: now.toISOString() };
  saveDB(guildId, db, year, month);
}

function removePost(guildId, postId, year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  const db   = loadDB(guildId, cy, cm);
  const post = db.posts.find(p => p.id === postId);
  if (!post) return null;
  db.posts = db.posts.filter(p => p.id !== postId);
  saveDB(guildId, db, cy, cm);
  return post;
}

function getPostsForDate(guildId, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  return loadDB(guildId, year, month).posts
    .filter(p => p.date_key === dateKey)
    .sort((a,b) => a.posted_at.localeCompare(b.posted_at));
}

function getAllKnownUsers(guildId) {
  return Object.values(getKnownUsersGlobal(guildId)).sort((a,b) => a.username.localeCompare(b.username));
}

function getAllChannelsDailyStatus(guildId, allowedChannelIds, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(guildId, year, month);
  const result = {};
  for (const cid of allowedChannelIds) {
    result[cid] = { channelId: cid, channelName: cid, counts: { tiktok:0, instagram:0, youtube:0, facebook:0 } };
  }
  for (const p of db.posts.filter(p => p.date_key === dateKey && allowedChannelIds.includes(p.channel_id))) {
    if (result[p.channel_id]) {
      if (result[p.channel_id].counts[p.platform] !== undefined) result[p.channel_id].counts[p.platform]++;
      result[p.channel_id].channelName = p.channel_name;
    }
  }
  return Object.values(result);
}

function getMonthlyStats(guildId, year, month) {
  const db = loadDB(guildId, year, month), counts = {};
  for (const p of db.posts) {
    const key = `${p.username}__${p.platform}`;
    if (!counts[key]) counts[key] = { username: p.username, platform: p.platform, count: 0 };
    counts[key].count++;
  }
  return Object.values(counts).sort((a,b) => a.username.localeCompare(b.username) || a.platform.localeCompare(b.platform));
}

function getMonthlyStatsByUser(guildId, userId, year, month) {
  const db = loadDB(guildId, year, month), counts = {};
  for (const p of db.posts.filter(p => p.user_id === userId)) counts[p.platform] = (counts[p.platform]||0)+1;
  return Object.entries(counts).map(([platform,count]) => ({platform,count})).sort((a,b) => a.platform.localeCompare(b.platform));
}

function getTodayPostersByChannel(guildId, channelId, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db = loadDB(guildId, year, month), seen = {};
  for (const p of db.posts.filter(p => p.channel_id === channelId && p.date_key === dateKey)) {
    seen[p.user_id] = { user_id: p.user_id, username: p.username };
  }
  return Object.values(seen);
}

function getLeaderboard(guildId, year, month) {
  const db = loadDB(guildId, year, month), counts = {};
  for (const p of db.posts) {
    if (!counts[p.user_id]) counts[p.user_id] = { username: p.username, total: 0 };
    counts[p.user_id].total++;
  }
  return Object.values(counts).sort((a,b) => b.total-a.total).slice(0,10);
}

function getPostCountByPlatform(guildId, year, month) {
  const db = loadDB(guildId, year, month), counts = {};
  for (const p of db.posts) counts[p.platform] = (counts[p.platform]||0)+1;
  return Object.entries(counts).map(([platform,count]) => ({platform,count})).sort((a,b) => b.count-a.count);
}

function getUserDailyActivity(guildId, userId, year, month) {
  const db = loadDB(guildId, year, month), counts = {};
  for (const p of db.posts.filter(p => p.user_id === userId)) counts[p.date_key] = (counts[p.date_key]||0)+1;
  return Object.entries(counts).map(([date_key,count]) => ({date_key,count})).sort((a,b) => a.date_key.localeCompare(b.date_key));
}

function getMonthlyDailyPosts(guildId, year, month, userId = null) {
  const db = loadDB(guildId, year, month);
  return db.posts
    .filter(p => !userId || p.user_id === userId)
    .sort((a,b) => a.posted_at.localeCompare(b.posted_at))
    .map(p => ({ date_key: p.date_key, platform: p.platform, video_url: p.video_url, posted_at: p.posted_at, username: p.username }));
}

function getUsersMissingOnDate(guildId, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db      = loadDB(guildId, year, month);
  const posters = new Set(db.posts.filter(p => p.date_key === dateKey).map(p => p.user_id));
  return Object.values(db.known_users).filter(u => !posters.has(u.user_id)).sort((a,b) => a.username.localeCompare(b.username));
}

module.exports = {
  getWeekKey, saveAnalytics, getAnalytics,
  insertPost, insertMultiplePosts, removePost, getPostsForDate,
  getAllKnownUsers, getAllChannelsDailyStatus,
  getMonthlyStats, getMonthlyStatsByUser,
  getTodayPostersByChannel, getLeaderboard,
  getPostCountByPlatform, getUserDailyActivity,
  getMonthlyDailyPosts, getUsersMissingOnDate,
};

// ─── Analytics ────────────────────────────────────────────────────────────────

function getWeekKey(date) {
  const d = date ? new Date(date) : new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

function getAnalyticsPath(guildId, weekKey) {
  return path.join(dataDir, `analytics-${guildId}-${weekKey}.json`);
}

function saveAnalytics(guildId, channelId, channelName, userId, username, views, rawText, weekKey) {
  const p = getAnalyticsPath(guildId, weekKey);
  let data = {};
  if (fs.existsSync(p)) { try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} }
  data[channelId] = { channelId, channelName, userId, username, views, rawText, updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function getAnalytics(guildId, weekKey) {
  const p = getAnalyticsPath(guildId, weekKey);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
