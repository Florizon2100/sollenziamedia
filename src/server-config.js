const fs   = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function getConfigPath(guildId) {
  return path.join(dataDir, `config-${guildId}.json`);
}

function loadConfig(guildId) {
  const p = getConfigPath(guildId);
  if (!fs.existsSync(p)) return {
    guild_id:            guildId,
    log_channel_id:      null,
    allowed_channel_ids: [],
    alert_user_ids:      [],
    alert_usernames:     {},
    bot_admins:          {},
  };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveConfig(guildId, cfg) {
  fs.writeFileSync(getConfigPath(guildId), JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Fallback to .env for existing server ──────────────────────────────────────

function getLogChannel(guildId) {
  const cfg = loadConfig(guildId);
  if (cfg?.log_channel_id) return cfg.log_channel_id;
  // Fallback: use .env LOG_CHANNEL_ID only for the main guild
  if (guildId === process.env.GUILD_ID) return process.env.LOG_CHANNEL_ID || null;
  return null;
}

function setLogChannel(guildId, channelId) {
  const cfg = loadConfig(guildId);
  cfg.log_channel_id = channelId;
  saveConfig(guildId, cfg);
}

function getAllowedChannels(guildId) {
  const cfg = loadConfig(guildId);
  if (cfg?.allowed_channel_ids?.length) return cfg.allowed_channel_ids;
  // Fallback for main guild
  if (guildId === process.env.GUILD_ID) {
    return (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function addAllowedChannel(guildId, channelId) {
  const cfg = loadConfig(guildId);
  if (!cfg.allowed_channel_ids) cfg.allowed_channel_ids = [];
  if (!cfg.allowed_channel_ids.includes(channelId)) {
    cfg.allowed_channel_ids.push(channelId);
    saveConfig(guildId, cfg);
  }
}

function removeAllowedChannel(guildId, channelId) {
  const cfg = loadConfig(guildId);
  cfg.allowed_channel_ids = (cfg.allowed_channel_ids || []).filter(id => id !== channelId);
  saveConfig(guildId, cfg);
}

function getAlertUsers(guildId) {
  const cfg = loadConfig(guildId);
  if (cfg?.alert_user_ids?.length) return cfg.alert_user_ids;
  // Fallback for main guild
  if (guildId === process.env.GUILD_ID) {
    const adminId = process.env.ADMIN_USER_ID;
    return adminId ? [adminId] : [];
  }
  return [];
}

function getAlertUsernames(guildId) {
  return loadConfig(guildId)?.alert_usernames || {};
}

function addAlertUser(guildId, userId, username) {
  const cfg = loadConfig(guildId);
  if (!cfg.alert_user_ids) cfg.alert_user_ids = [];
  if (!cfg.alert_user_ids.includes(userId)) {
    cfg.alert_user_ids.push(userId);
    if (!cfg.alert_usernames) cfg.alert_usernames = {};
    cfg.alert_usernames[userId] = username;
    saveConfig(guildId, cfg);
    return true;
  }
  return false;
}

function removeAlertUser(guildId, userId) {
  const cfg    = loadConfig(guildId);
  const before = (cfg.alert_user_ids || []).length;
  cfg.alert_user_ids = (cfg.alert_user_ids || []).filter(id => id !== userId);
  if (cfg.alert_usernames) delete cfg.alert_usernames[userId];
  saveConfig(guildId, cfg);
  return (cfg.alert_user_ids.length < before);
}

// ── Bot admins ────────────────────────────────────────────────────────────────

function getBotAdmins(guildId) {
  return loadConfig(guildId)?.bot_admins || {};
}

function addBotAdmin(guildId, userId, username) {
  const cfg = loadConfig(guildId);
  if (!cfg.bot_admins) cfg.bot_admins = {};
  cfg.bot_admins[userId] = username;
  saveConfig(guildId, cfg);
}

function removeBotAdmin(guildId, userId) {
  const cfg = loadConfig(guildId);
  if (!cfg.bot_admins?.[userId]) return false;
  delete cfg.bot_admins[userId];
  saveConfig(guildId, cfg);
  return true;
}

function isBotAdmin(guildId, userId, memberPermissions) {
  const { PermissionFlagsBits } = require('discord.js');
  if (process.env.ADMIN_USER_ID && userId === process.env.ADMIN_USER_ID) return true;
  if (memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const admins = getBotAdmins(guildId);
  return !!admins[userId];
}

// ── Paused channels ───────────────────────────────────────────────────────────

function getPausedChannels(guildId) {
  return loadConfig(guildId).paused_channels || [];
}

function pauseChannel(guildId, channelId) {
  const cfg = loadConfig(guildId);
  if (!cfg.paused_channels) cfg.paused_channels = [];
  if (cfg.paused_channels.includes(channelId)) return false;
  cfg.paused_channels.push(channelId);
  saveConfig(guildId, cfg);
  return true;
}

function unpauseChannel(guildId, channelId) {
  const cfg = loadConfig(guildId);
  if (!cfg.paused_channels?.includes(channelId)) return false;
  cfg.paused_channels = cfg.paused_channels.filter(id => id !== channelId);
  saveConfig(guildId, cfg);
  return true;
}

// ── Guild list ────────────────────────────────────────────────────────────────

function getAllGuildIds() {
  try {
    return fs.readdirSync(dataDir)
      .filter(f => f.startsWith('config-') && f.endsWith('.json'))
      .map(f => f.replace('config-', '').replace('.json', ''));
  } catch { return []; }
}

module.exports = {
  loadConfig, saveConfig,
  getLogChannel, setLogChannel,
  getAllowedChannels, addAllowedChannel, removeAllowedChannel,
  getAlertUsers, getAlertUsernames, addAlertUser, removeAlertUser,
  getBotAdmins, addBotAdmin, removeBotAdmin, isBotAdmin,
  getPausedChannels, pauseChannel, unpauseChannel,
  getAllGuildIds,
};
