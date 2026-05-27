const fs   = require('fs');
const path = require('path');

const dataDir2 = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : require('path').join(__dirname, '..', 'data');
const CONFIG_PATH = require('path').join(dataDir2, 'yt-config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { alert_users: [], alert_usernames: {} };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { alert_users: [], alert_usernames: {} }; }
}

function saveConfig(cfg) {
  const dataDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function getAlertUsers() {
  return loadConfig().alert_users || [];
}

function addAlertUser(userId, username) {
  const cfg = loadConfig();
  if (!cfg.alert_users) cfg.alert_users = [];
  if (!cfg.alert_users.includes(userId)) {
    cfg.alert_users.push(userId);
    if (!cfg.alert_usernames) cfg.alert_usernames = {};
    cfg.alert_usernames[userId] = username;
    saveConfig(cfg);
    return true;
  }
  return false;
}

function removeAlertUser(userId) {
  const cfg = loadConfig();
  if (!cfg.alert_users) return false;
  const before = cfg.alert_users.length;
  cfg.alert_users = cfg.alert_users.filter(id => id !== userId);
  if (cfg.alert_usernames) delete cfg.alert_usernames[userId];
  saveConfig(cfg);
  return cfg.alert_users.length < before;
}

function getAlertUsernames() {
  return loadConfig().alert_usernames || {};
}

module.exports = { getAlertUsers, addAlertUser, removeAlertUser, getAlertUsernames };
