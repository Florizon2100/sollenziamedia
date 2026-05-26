const path = require('path');
const fs   = require('fs');

// Use Railway persistent volume if available, otherwise local data/
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ─── Month-aware DB paths ─────────────────────────────────────────────────────
// data/posts-YYYY-MM.json per month, data/posts.json as legacy fallback

function getDBPath(year, month) {
  return path.join(dataDir, `posts-${year}-${String(month).padStart(2,'0')}.json`);
}

function getCurrentMonthYear() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function loadDB(year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  const p      = getDBPath(cy, cm);
  const legacy = path.join(dataDir, 'posts.json');

  if (!fs.existsSync(p)) {
    if (fs.existsSync(legacy)) {
      try {
        const db     = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        const prefix = `${cy}-${String(cm).padStart(2,'0')}`;
        return { posts: (db.posts||[]).filter(p => p.date_key?.startsWith(prefix)), known_users: db.known_users||{} };
      } catch {}
    }
    return { posts: [], known_users: getKnownUsersGlobal() };
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { posts: [], known_users: {} }; }
}

function saveDB(data, year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  fs.writeFileSync(getDBPath(cy, cm), JSON.stringify(data, null, 2), 'utf8');
}

function getKnownUsersGlobal() {
  const known = {};
  const files = fs.readdirSync(dataDir).filter(f => f.startsWith('posts-') || f === 'posts.json');
  for (const file of files) {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      Object.assign(known, db.known_users || {});
    } catch {}
  }
  return known;
}

// ─── Insert ───────────────────────────────────────────────────────────────────

function insertPost({ userId, username, channelId, channelName, platform, videoUrl, dayOverride }) {
  const now      = new Date();
  let   postedAt = now.toISOString();
  let   dateKey  = postedAt.slice(0, 10);

  if (dayOverride) {
    const cy = now.getFullYear(), cm = now.getMonth() + 1;
    dateKey  = `${cy}-${String(cm).padStart(2,'0')}-${String(dayOverride).padStart(2,'0')}`;
    postedAt = `${dateKey}T${now.toISOString().slice(11)}`;
  }

  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(year, month);
  const id   = (db.posts.length > 0 ? Math.max(...db.posts.map(p => p.id)) : 0) + 1;
  db.posts.push({ id, user_id: userId, username, channel_id: channelId, channel_name: channelName, platform, video_url: videoUrl, posted_at: postedAt, date_key: dateKey });
  db.known_users[userId] = { user_id: userId, username, updated_at: now.toISOString() };
  saveDB(db, year, month);
  return id;
}

function insertMultiplePosts({ userId, username, channelId, channelName, platform, videoUrls, dayOverride }) {
  const now = new Date();
  let postedAt = now.toISOString();
  let dateKey  = postedAt.slice(0, 10);

  if (dayOverride) {
    const cy = now.getFullYear(), cm = now.getMonth() + 1;
    dateKey  = `${cy}-${String(cm).padStart(2,'0')}-${String(dayOverride).padStart(2,'0')}`;
    postedAt = `${dateKey}T${now.toISOString().slice(11)}`;
  }

  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(year, month);
  let maxId  = db.posts.length > 0 ? Math.max(...db.posts.map(p => p.id)) : 0;
  for (const videoUrl of videoUrls) {
    maxId++;
    db.posts.push({ id: maxId, user_id: userId, username, channel_id: channelId, channel_name: channelName, platform, video_url: videoUrl, posted_at: postedAt, date_key: dateKey });
  }
  db.known_users[userId] = { user_id: userId, username, updated_at: now.toISOString() };
  saveDB(db, year, month);
}

// ─── Remove ───────────────────────────────────────────────────────────────────

function removePost(postId, year, month) {
  const { year: cy, month: cm } = (year && month) ? { year, month } : getCurrentMonthYear();
  const db   = loadDB(cy, cm);
  const post = db.posts.find(p => p.id === postId);
  if (!post) return null;
  db.posts = db.posts.filter(p => p.id !== postId);
  saveDB(db, cy, cm);
  return post;
}

function getPostsForDate(dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  return loadDB(year, month).posts.filter(p => p.date_key === dateKey).sort((a,b) => a.posted_at.localeCompare(b.posted_at));
}

// ─── Known users ──────────────────────────────────────────────────────────────

function getAllKnownUsers() {
  return Object.values(getKnownUsersGlobal()).sort((a,b) => a.username.localeCompare(b.username));
}

// ─── Daily status ─────────────────────────────────────────────────────────────

function getAllChannelsDailyStatus(allowedChannelIds, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db   = loadDB(year, month);
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

// ─── Stats ────────────────────────────────────────────────────────────────────

function getMonthlyStats(year, month) {
  const db = loadDB(year, month), counts = {};
  for (const p of db.posts) {
    const key = `${p.username}__${p.platform}`;
    if (!counts[key]) counts[key] = { username: p.username, platform: p.platform, count: 0 };
    counts[key].count++;
  }
  return Object.values(counts).sort((a,b) => a.username.localeCompare(b.username) || a.platform.localeCompare(b.platform));
}

function getMonthlyStatsByUser(userId, year, month) {
  const db = loadDB(year, month), counts = {};
  for (const p of db.posts.filter(p => p.user_id === userId)) counts[p.platform] = (counts[p.platform]||0)+1;
  return Object.entries(counts).map(([platform,count]) => ({platform,count})).sort((a,b) => a.platform.localeCompare(b.platform));
}

function getTodayPostersByChannel(channelId, dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db = loadDB(year, month), seen = {};
  for (const p of db.posts.filter(p => p.channel_id === channelId && p.date_key === dateKey)) seen[p.user_id] = { user_id: p.user_id, username: p.username };
  return Object.values(seen);
}

function getLeaderboard(year, month) {
  const db = loadDB(year, month), counts = {};
  for (const p of db.posts) {
    if (!counts[p.user_id]) counts[p.user_id] = { username: p.username, total: 0 };
    counts[p.user_id].total++;
  }
  return Object.values(counts).sort((a,b) => b.total-a.total).slice(0,10);
}

function getPostCountByPlatform(year, month) {
  const db = loadDB(year, month), counts = {};
  for (const p of db.posts) counts[p.platform] = (counts[p.platform]||0)+1;
  return Object.entries(counts).map(([platform,count]) => ({platform,count})).sort((a,b) => b.count-a.count);
}

function getUserDailyActivity(userId, year, month) {
  const db = loadDB(year, month), counts = {};
  for (const p of db.posts.filter(p => p.user_id === userId)) counts[p.date_key] = (counts[p.date_key]||0)+1;
  return Object.entries(counts).map(([date_key,count]) => ({date_key,count})).sort((a,b) => a.date_key.localeCompare(b.date_key));
}

function getMonthlyDailyPosts(year, month, userId = null) {
  const db = loadDB(year, month);
  return db.posts
    .filter(p => !userId || p.user_id === userId)
    .sort((a,b) => a.posted_at.localeCompare(b.posted_at))
    .map(p => ({ date_key: p.date_key, platform: p.platform, video_url: p.video_url, posted_at: p.posted_at, username: p.username }));
}

function getUsersMissingOnDate(dateKey) {
  const year = parseInt(dateKey.slice(0,4)), month = parseInt(dateKey.slice(5,7));
  const db      = loadDB(year, month);
  const posters = new Set(db.posts.filter(p => p.date_key === dateKey).map(p => p.user_id));
  return Object.values(db.known_users).filter(u => !posters.has(u.user_id)).sort((a,b) => a.username.localeCompare(b.username));
}

module.exports = {
  insertPost, insertMultiplePosts, removePost, getPostsForDate,
  getAllKnownUsers, getAllChannelsDailyStatus,
  getMonthlyStats, getMonthlyStatsByUser,
  getTodayPostersByChannel, getLeaderboard,
  getPostCountByPlatform, getUserDailyActivity,
  getMonthlyDailyPosts, getUsersMissingOnDate,
};
