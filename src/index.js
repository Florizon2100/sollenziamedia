require('dotenv').config();

const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ChannelType
} = require('discord.js');

const {
  insertPost, insertMultiplePosts, removePost, getPostsForDate,
  getMonthlyStats, getMonthlyStatsByUser, getLeaderboard,
  getPostCountByPlatform, getUserDailyActivity, getMonthlyDailyPosts,
  getWeekKey, saveAnalytics, getAnalytics,
} = require('./database');

const {
  buildPostedConfirm, buildLogEmbed, buildStatsEmbed,
  buildMyStatsEmbed, buildLeaderboardEmbed, buildRecapEmbeds,
} = require('./embeds');

const {
  isBotAdmin, getLogChannel, setLogChannel,
  getAllowedChannels, addAllowedChannel, removeAllowedChannel,
  getAlertUsers, getAlertUsernames, addAlertUser, removeAlertUser,
  getBotAdmins, addBotAdmin, removeBotAdmin,
  setChannelMode, getTrackingOnlyChannels,
} = require('./server-config');

const { scheduleDailyCheck } = require('./cron');
const { getChannelStatusEmbed } = require('./daily-check');

const { REST, Routes } = require('discord.js');
let startAPI = null;
try { startAPI = require('./api').startAPI; } catch(e) { console.error('[API] Failed to load:', e.message); }

const PLATFORM_META = {
  instagram: { emoji: '📸', label: 'Instagram', color: 0xE1306C },
  tiktok:    { emoji: '🎵', label: 'TikTok',    color: 0x010101 },
  youtube:   { emoji: '▶️',  label: 'YouTube',   color: 0xFF0000 },
  facebook:  { emoji: '📘', label: 'Facebook',  color: 0x1877F2 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDaysInMonth(year, month) {
  const now       = new Date();
  const isCurrent = now.getFullYear() === year && (now.getMonth() + 1) === month;
  const lastDay   = isCurrent ? now.getDate() : new Date(year, month, 0).getDate();
  const days = [];
  for (let d = 1; d <= lastDay; d++) {
    days.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  }
  return days;
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

function requireAdmin(interaction) {
  if (!isBotAdmin(interaction.guildId, interaction.user.id, interaction.memberPermissions)) {
    interaction.reply({ content: '❌ You need admin permissions to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

function isCESTNow() {
  const now = new Date(), y = now.getUTCFullYear();
  const s = lastSun(y,2), e = lastSun(y,9);
  return now >= s && now < e;
}
function lastSun(y, m) {
  const d = new Date(Date.UTC(y, m+1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

// ─── Crash prevention ─────────────────────────────────────────────────────────

process.on('unhandledRejection', err => console.error('[UNHANDLED]', err?.message || err));
process.on('uncaughtException',  err => console.error('[UNCAUGHT]',  err?.message || err));

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.on('error', err => console.error('[CLIENT ERROR]', err?.message || err));

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  try { scheduleDailyCheck(client); } catch(e) { console.error('[CRON ERROR]', e.message); }

  // Register commands on all existing guilds (instant, no 1h delay)
  const rest2 = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const guild of c.guilds.cache.values()) {
    try {
      const { getCommands } = require('./commands');
      await rest2.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: getCommands() });
      console.log(`[COMMANDS] Registered on ${guild.name}`);
    } catch(e) { console.error(`[COMMANDS] Failed on ${guild.name}:`, e.message); }
  }

  console.log('[BOT] Fully initialized and running');
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[NEW GUILD] ${guild.name} (${guild.id})`);

  // Register commands instantly on new guild
  try {
    const rest2 = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const { getCommands } = require('./commands');
    await rest2.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: getCommands() });
    console.log(`[COMMANDS] Registered on new guild ${guild.name}`);
  } catch(e) { console.error(`[COMMANDS] Failed on new guild:`, e.message); }
  const channel = guild.systemChannel ||
    guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'));
  if (channel) {
    await channel.send({ embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('👋 Video Tracker Bot')
      .setDescription('Thanks for adding me! Run these commands to set up:\n\n`/setup #channel` — Set log channel\n`/addchannel #channel` — Add posting channels\n`/alertadd @user` — Add alert users\n`/addadmin @user` — Add bot admins')
      .setTimestamp()
    ]}).catch(() => {});
  }
});

// ─── Router ───────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isStringSelectMenu()) return await handleSelectMenu(interaction);
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  try {
    if (commandName === 'posted')        return await handlePosted(interaction);
    if (commandName === 'posted2')       return await handlePosted2(interaction);
    if (commandName === 'daystatus')     return await handleDayStatus(interaction);
    if (commandName === 'recap')         return await handleRecap(interaction);
    if (commandName === 'stats')         return await handleStats(interaction);
    if (commandName === 'mystats')       return await handleMyStats(interaction);
    if (commandName === 'userstats')     return await handleUserStats(interaction);
    if (commandName === 'leaderboard')   return await handleLeaderboard(interaction);
    if (commandName === 'removepost')    return await handleRemovePost(interaction);
    if (commandName === 'setchannelmode') return await handleSetChannelMode(interaction);
    if (commandName === 'setup')         return await handleSetup(interaction);
    if (commandName === 'addchannel')    return await handleAddChannel(interaction);
    if (commandName === 'removechannel') return await handleRemoveChannel(interaction);
    if (commandName === 'addadmin')      return await handleAddAdmin(interaction);
    if (commandName === 'removeadmin')   return await handleRemoveAdmin(interaction);
    if (commandName === 'adminlist')     return await handleAdminList(interaction);
    if (commandName === 'alertadd')        return await handleAlertAdd(interaction);
    if (commandName === 'alertremove')     return await handleAlertRemove(interaction);
    if (commandName === 'alertlist')       return await handleAlertList(interaction);
    if (commandName === 'analytics')       return await handleAnalytics(interaction);
    if (commandName === 'leaderboard-week') return await handleWeeklyLeaderboard(interaction);
    if (commandName === 'announcement')    return await handleAnnouncement(interaction);
  } catch (err) {
    console.error(`[ERROR] /${commandName}:`, err?.message || err);
    try {
      const msg = { content: '❌ An error occurred.', ephemeral: true };
      interaction.replied || interaction.deferred ? await interaction.followUp(msg) : await interaction.reply(msg);
    } catch {}
  }
});

// ─── /posted ──────────────────────────────────────────────────────────────────

async function handlePosted(interaction) {
  const guildId    = interaction.guildId;
  const allowedIds = getAllowedChannels(guildId);
  if (allowedIds.length > 0 && !allowedIds.includes(interaction.channelId)) {
    return interaction.reply({ content: '❌ You can only use `/posted` in designated channels.', ephemeral: true });
  }
  const videoUrl = interaction.options.getString('link');
  const platform = interaction.options.getString('platform');
  const day      = interaction.options.getInteger('day');
  if (!isValidUrl(videoUrl)) {
    return interaction.reply({ content: '❌ Invalid URL.', ephemeral: true });
  }
  const user    = interaction.user;
  const channel = interaction.channel;
  insertPost({ guildId, userId: user.id, username: user.username, channelId: channel.id, channelName: channel.name, platform, videoUrl, dayOverride: day });
  await interaction.reply({ embeds: [buildPostedConfirm({ username: user.username, platform, videoUrl, channelName: channel.name, day })], ephemeral: true });
  await sendToLog(guildId, buildLogEmbed({ username: user.username, userId: user.id, channelName: channel.name, channelId: channel.id, platform, videoUrl, day }));
}

// ─── /posted2 ─────────────────────────────────────────────────────────────────

async function handlePosted2(interaction) {
  const guildId    = interaction.guildId;
  const allowedIds = getAllowedChannels(guildId);
  if (allowedIds.length > 0 && !allowedIds.includes(interaction.channelId)) {
    return interaction.reply({ content: '❌ You can only use `/posted2` in designated channels.', ephemeral: true });
  }
  const platform = interaction.options.getString('platform');
  const link1    = interaction.options.getString('link1');
  const link2    = interaction.options.getString('link2');
  const day      = interaction.options.getInteger('day');
  if (!isValidUrl(link1) || !isValidUrl(link2)) {
    return interaction.reply({ content: '❌ Invalid URL(s).', ephemeral: true });
  }
  const user    = interaction.user;
  const channel = interaction.channel;
  const meta    = PLATFORM_META[platform];
  insertMultiplePosts({ guildId, userId: user.id, username: user.username, channelId: channel.id, channelName: channel.name, platform, videoUrls: [link1, link2], dayOverride: day });

  const now       = new Date();
  const dateLabel = day ? `${String(day).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}` : 'Today';
  const ts        = Math.floor(Date.now() / 1000);

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.emoji} 2 ${meta.label} Videos Logged!`)
      .setDescription(`Both videos recorded for **${user.username}**${day ? ` for **${dateLabel}**` : ''}`)
      .addFields(
        { name: '🔗 Video 1', value: link1, inline: false },
        { name: '🔗 Video 2', value: link2, inline: false },
        { name: '🕐 Time',    value: `<t:${ts}:F>`, inline: false },
      ).setFooter({ text: 'Keep it up! 🚀' })],
    ephemeral: true,
  });

  await sendToLog(guildId, new EmbedBuilder()
    .setColor(meta.color)
    .setAuthor({ name: `${meta.emoji} 2x ${meta.label} Posts${day ? ` (day ${dateLabel})` : ''}` })
    .addFields(
      { name: '👤 User',      value: `<@${user.id}> (${user.username})`, inline: true  },
      { name: '📌 Channel',   value: `<#${channel.id}>`,                 inline: true  },
      { name: '⏰ Posted at', value: `<t:${ts}:F>`,                      inline: false },
      { name: '🔗 Video 1',   value: link1,                              inline: false },
      { name: '🔗 Video 2',   value: link2,                              inline: false },
    ).setTimestamp());
}

// ─── /daystatus ───────────────────────────────────────────────────────────────

async function handleDayStatus(interaction) {
  if (!requireAdmin(interaction)) return;
  await interaction.reply({ content: '⏳ Loading...', ephemeral: true });

  const guildId   = interaction.guildId;
  const dateInput = interaction.options.getString('date');
  let dateKey;
  if (dateInput) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return interaction.editReply({ content: '❌ Use YYYY-MM-DD.' });
    dateKey = dateInput;
  } else {
    const now    = new Date();
    const offset = isCESTNow() ? 2 : 1;
    dateKey      = new Date(now.getTime() + offset*3600*1000).toISOString().slice(0,10);
  }

  const allowedIds = getAllowedChannels(guildId);
  const embeds     = await getChannelStatusEmbed(guildId, allowedIds, client, dateKey);
  const arr        = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.editReply({ content: null, embeds: arr.slice(0,10) });
  for (let i=10; i<arr.length; i+=10) await interaction.followUp({ embeds: arr.slice(i,i+10), ephemeral: true });
}

// ─── /recap ───────────────────────────────────────────────────────────────────

async function handleRecap(interaction) {
  if (!requireAdmin(interaction)) return;
  const guildId = interaction.guildId;
  const now     = new Date();
  const month   = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year    = interaction.options.getInteger('year')  ?? now.getFullYear();
  const target  = interaction.options.getUser('user');
  await interaction.reply({ content: '⏳ Loading recap...', ephemeral: false });
  const posts  = getMonthlyDailyPosts(guildId, year, month, target?.id ?? null);
  const embeds = buildRecapEmbeds(posts, getDaysInMonth(year, month), year, month, target?.username ?? null);
  await interaction.editReply({ content: null, embeds: embeds.slice(0,10) });
  for (let i=10; i<embeds.length; i+=10) await interaction.followUp({ embeds: embeds.slice(i,i+10) });
}

// ─── /stats ───────────────────────────────────────────────────────────────────

async function handleStats(interaction) {
  if (!requireAdmin(interaction)) return;
  const guildId = interaction.guildId;
  const now     = new Date();
  const month   = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year    = interaction.options.getInteger('year')  ?? now.getFullYear();
  await interaction.reply({ embeds: [buildStatsEmbed(getMonthlyStats(guildId, year, month), year, month, getPostCountByPlatform(guildId, year, month))] });
}

// ─── /mystats ─────────────────────────────────────────────────────────────────

async function handleMyStats(interaction) {
  const guildId = interaction.guildId;
  const now     = new Date();
  const month   = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year    = interaction.options.getInteger('year')  ?? now.getFullYear();
  const user    = interaction.user;
  const monthPosts = getMonthlyDailyPosts(guildId, year, month, user.id);
  const embeds     = buildMyStatsEmbed(user.username, user.id, getMonthlyStatsByUser(guildId, user.id, year, month), getUserDailyActivity(guildId, user.id, year, month), year, month, monthPosts);
  const arr        = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.reply({ embeds: arr.slice(0,10), ephemeral: true });
  for (let i=10; i<arr.length; i+=10) await interaction.followUp({ embeds: arr.slice(i,i+10), ephemeral: true });
}

// ─── /userstats ───────────────────────────────────────────────────────────────

async function handleUserStats(interaction) {
  if (!requireAdmin(interaction)) return;
  const guildId = interaction.guildId;
  const now     = new Date();
  const month   = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year    = interaction.options.getInteger('year')  ?? now.getFullYear();
  const target  = interaction.options.getUser('user');
  const monthPosts = getMonthlyDailyPosts(guildId, year, month, target.id);
  const embeds     = buildMyStatsEmbed(target.username, target.id, getMonthlyStatsByUser(guildId, target.id, year, month), getUserDailyActivity(guildId, target.id, year, month), year, month, monthPosts);
  const arr        = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.reply({ embeds: arr.slice(0,10), ephemeral: true });
  for (let i=10; i<arr.length; i+=10) await interaction.followUp({ embeds: arr.slice(i,i+10), ephemeral: true });
}

// ─── /leaderboard ─────────────────────────────────────────────────────────────

async function handleLeaderboard(interaction) {
  if (!requireAdmin(interaction)) return;
  const guildId = interaction.guildId;
  const now     = new Date();
  await interaction.reply({ embeds: [buildLeaderboardEmbed(getLeaderboard(guildId, now.getFullYear(), now.getMonth()+1), now.getFullYear(), now.getMonth()+1)] });
}

// ─── /removepost ──────────────────────────────────────────────────────────────

async function handleRemovePost(interaction) {
  if (!requireAdmin(interaction)) return;
  const guildId = interaction.guildId;
  const dateStr = interaction.options.getString('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return interaction.reply({ content: '❌ Use YYYY-MM-DD.', ephemeral: true });
  }
  const posts = getPostsForDate(guildId, dateStr);
  if (!posts.length) return interaction.reply({ content: `❌ No posts for **${dateStr}**.`, ephemeral: true });
  const options = posts.slice(0,25).map(p => {
    const meta = PLATFORM_META[p.platform] || { emoji: '🎬', label: p.platform };
    const time = new Date(p.posted_at).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' });
    return { label: `${meta.label} — ${p.username} — ${time}`.slice(0,100), description: p.video_url.slice(0,100), value: String(p.id) };
  });
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`removepost_${guildId}_${dateStr}`).setPlaceholder('Select a video...').addOptions(options)
  );
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xED4245).setTitle(`🗑️ Remove Post — ${dateStr}`).setDescription(`**${posts.length}** post(s) found.`).setTimestamp()],
    components: [row], ephemeral: true,
  });
}

// ─── /setchannelmode ─────────────────────────────────────────────────────────

async function handleSetChannelMode(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  const mode    = interaction.options.getString('mode');
  setChannelMode(interaction.guildId, channel.id, mode);
  const label = mode === 'tracking-only' ? '📊 Tracking only (no quota alert)' : '✅ Quota (included in daily alerts)';
  await interaction.reply({ content: `Updated <#${channel.id}>: **${label}**`, ephemeral: true });
}

// ─── /setup ───────────────────────────────────────────────────────────────────

async function handleSetup(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  setLogChannel(interaction.guildId, channel.id);
  await interaction.reply({ content: `✅ Log channel set to <#${channel.id}>.`, ephemeral: true });
}

// ─── /addchannel ──────────────────────────────────────────────────────────────

async function handleAddChannel(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  addAllowedChannel(interaction.guildId, channel.id);
  await interaction.reply({ content: `✅ <#${channel.id}> added to allowed channels.`, ephemeral: true });
}

// ─── /removechannel ───────────────────────────────────────────────────────────

async function handleRemoveChannel(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  removeAllowedChannel(interaction.guildId, channel.id);
  await interaction.reply({ content: `✅ <#${channel.id}> removed from allowed channels.`, ephemeral: true });
}

// ─── /addadmin ────────────────────────────────────────────────────────────────

async function handleAddAdmin(interaction) {
  if (!requireAdmin(interaction)) return;
  const target = interaction.options.getUser('user');
  addBotAdmin(interaction.guildId, target.id, target.username);
  await interaction.reply({ content: `✅ **${target.username}** is now a bot admin on this server.`, ephemeral: true });
}

// ─── /removeadmin ─────────────────────────────────────────────────────────────

async function handleRemoveAdmin(interaction) {
  if (!requireAdmin(interaction)) return;
  const target  = interaction.options.getUser('user');
  const removed = removeBotAdmin(interaction.guildId, target.id);
  await interaction.reply({ content: removed ? `✅ **${target.username}** removed.` : `❌ Not found.`, ephemeral: true });
}

// ─── /adminlist ───────────────────────────────────────────────────────────────

async function handleAdminList(interaction) {
  if (!requireAdmin(interaction)) return;
  const admins = getBotAdmins(interaction.guildId);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2).setTitle('🛡️ Bot Admins')
      .setDescription(Object.keys(admins).length
        ? Object.entries(admins).map(([id,name]) => `• <@${id}> (${name})`).join('\n')
        : 'No extra admins. Discord server admins always have access.')
      .setTimestamp()],
    ephemeral: true,
  });
}

// ─── /alertadd ────────────────────────────────────────────────────────────────

async function handleAlertAdd(interaction) {
  if (!requireAdmin(interaction)) return;
  const target = interaction.options.getUser('user');
  const added  = addAlertUser(interaction.guildId, target.id, target.username);
  await interaction.reply({ content: added ? `✅ **${target.username}** added to alerts.` : `ℹ️ Already in list.`, ephemeral: true });
}

// ─── /alertremove ─────────────────────────────────────────────────────────────

async function handleAlertRemove(interaction) {
  if (!requireAdmin(interaction)) return;
  const target  = interaction.options.getUser('user');
  const removed = removeAlertUser(interaction.guildId, target.id);
  await interaction.reply({ content: removed ? `✅ **${target.username}** removed.` : `❌ Not found.`, ephemeral: true });
}

// ─── /alertlist ───────────────────────────────────────────────────────────────

async function handleAlertList(interaction) {
  if (!requireAdmin(interaction)) return;
  const users     = getAlertUsers(interaction.guildId);
  const usernames = getAlertUsernames(interaction.guildId);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xFEE75C).setTitle('🔔 Alert Users')
      .setDescription(users.length ? users.map(id=>`• <@${id}> (${usernames[id]||id})`).join('\n') : 'No alert users set.')
      .setTimestamp()],
    ephemeral: true,
  });
}

// ─── Select menu ──────────────────────────────────────────────────────────────

async function handleSelectMenu(interaction) {
  if (interaction.customId.startsWith('removepost_')) {
    const parts   = interaction.customId.split('_');
    const guildId = parts[1];
    const dateStr = parts[2];
    const postId  = parseInt(interaction.values[0]);
    const year    = parseInt(dateStr.slice(0,4));
    const month   = parseInt(dateStr.slice(5,7));
    const removed = removePost(guildId, postId, year, month);
    if (!removed) return interaction.update({ content: '❌ Not found.', embeds: [], components: [] });
    const meta = PLATFORM_META[removed.platform] || { emoji: '🎬', label: removed.platform };
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🗑️ Post Removed')
        .addFields(
          { name: '👤 User', value: removed.username, inline: true },
          { name: '📺 Platform', value: meta.label, inline: true },
          { name: '📅 Date', value: removed.date_key, inline: true },
          { name: '🔗 Link', value: removed.video_url, inline: false },
        ).setTimestamp()],
      components: [],
    });
  }
}


// ─── View parsing helpers ─────────────────────────────────────────────────────

function parseViewsText(text) {
  const t = text.toLowerCase().replace(/\s*:\s*/g, ':');
  const platforms = {};
  const platRegex = /(tiktok|youtube|yt|insta|instagram|ig|facebook|fb):([0-9.,]+\s*[kmb]?)/gi;
  let match;
  while ((match = platRegex.exec(t)) !== null) {
    let plat = match[1];
    if (plat === 'yt') plat = 'youtube';
    if (plat === 'insta' || plat === 'ig') plat = 'instagram';
    if (plat === 'fb') plat = 'facebook';
    platforms[plat] = parseViewNumber(match[2]);
  }
  if (Object.keys(platforms).length > 0) {
    return { total: Object.values(platforms).reduce((s,v)=>s+v,0), platforms };
  }
  const single = t.match(/([0-9.,]+[kmb]?)/i);
  if (single) return { total: parseViewNumber(single[1]), platforms: {} };
  return { total: 0, platforms: {} };
}

function parseViewNumber(str) {
  const s = str.toString().trim().toLowerCase().replace(/,/g,'').replace(/\s/g,'');
  if (s.endsWith('b')) return Math.round(parseFloat(s) * 1000000000);
  if (s.endsWith('m')) return Math.round(parseFloat(s) * 1000000);
  if (s.endsWith('k')) return Math.round(parseFloat(s) * 1000);
  return parseInt(s) || 0;
}

function fmtViews(n) {
  if (n >= 1000000000) return (n/1000000000).toFixed(2).replace(/\.?0+$/,'') + 'B';
  if (n >= 1000000)    return (n/1000000).toFixed(3).replace(/\.?0+$/,'') + 'M';
  if (n >= 1000)       return (n/1000).toFixed(0) + 'K';
  return n.toLocaleString();
}

// ─── /analytics ───────────────────────────────────────────────────────────────

async function handleAnalytics(interaction) {
  await interaction.deferReply();
  const guildId     = interaction.guildId;
  const channelId   = interaction.channelId;
  const channelName = interaction.channel.name;
  const userId      = interaction.user.id;
  const username    = interaction.user.username;
  const rawText     = interaction.options.getString('views');
  const weekKey     = getWeekKey();
  const { total, platforms } = parseViewsText(rawText);

  if (total === 0) {
    return interaction.editReply({ content: '❌ Could not parse views. Try: `tiktok:1.2M youtube:500k insta:300k` or just `2M`' });
  }

  saveAnalytics(guildId, channelId, channelName, userId, username, total, rawText, weekKey);

  const emojis = { tiktok:'🎵', youtube:'▶️', instagram:'📸', facebook:'📘' };
  const breakdown = Object.keys(platforms).length > 0
    ? Object.entries(platforms).map(([p,v]) => `${emojis[p]||'📊'} ${p.charAt(0).toUpperCase()+p.slice(1)}: **${fmtViews(v)}**`).join('\n')
    : null;

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0xc9a96e)
      .setTitle('📊 Analytics Submitted')
      .setDescription(`**#${channelName}** — ${weekKey}`)
      .addFields(
        { name: '👤 Submitted by', value: `<@${userId}>`, inline: true },
        { name: '📈 Total Views',  value: `**${fmtViews(total)}**`, inline: true },
        ...(breakdown ? [{ name: 'Breakdown', value: breakdown, inline: false }] : []),
      )
      .setFooter({ text: 'Use /leaderboard-week to post the full ranking' })
      .setTimestamp()],
  });
}

// ─── /leaderboard-week ────────────────────────────────────────────────────────

async function handleWeeklyLeaderboard(interaction) {
  if (!requireAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  const guildId     = interaction.guildId;
  const weekOverride = interaction.options.getInteger('week');
  const monthNum    = interaction.options.getInteger('month_number');
  const weekOfMonth = interaction.options.getInteger('week_of_month');
  const now         = new Date();
  const weekKey     = weekOverride
    ? `${now.getFullYear()}-W${String(weekOverride).padStart(2,'0')}`
    : getWeekKey();

  const data    = getAnalytics(guildId, weekKey);
  const entries = Object.values(data).sort((a,b) => b.views - a.views);

  if (!entries.length) {
    return interaction.editReply({ content: `❌ No analytics for ${weekKey} yet. Ask your team to use /analytics first.` });
  }

  const totalViews = entries.reduce((s,e) => s+e.views, 0);

  const header = monthNum && weekOfMonth
    ? `**Month #${monthNum} - Week ${weekOfMonth} Leaderboard:**`
    : `**Weekly Leaderboard — ${weekKey}:**`;

  const lines = entries.map((e, i) => {
    const views = e.views.toLocaleString('en-US').replace(/,/g,'.');
    return `#${i+1} ${e.channelName} → ${views} views 🎯 @${e.username}`;
  });

  const total = totalViews.toLocaleString('en-US').replace(/,/g,'.');

  const msg = [
    header,
    '',
    ...lines,
    '',
    `🚀 Total → **${total}** views`,
    '',
    '@everyone'
  ].join('\n');

  await interaction.editReply({
    content: `📋 **Texte à copier-coller :**\n\`\`\`\n${msg}\n\`\`\``,
  });
}

// ─── /announcement ───────────────────────────────────────────────────────────

async function handleAnnouncement(interaction) {
  if (!requireAdmin(interaction)) return;
  await interaction.deferReply({ ephemeral: true });
  const guildId    = interaction.guildId;
  const message    = interaction.options.getString('message');
  const allowedIds = getAllowedChannels(guildId);
  if (!allowedIds.length) {
    return interaction.editReply({ content: '❌ No allowed channels configured. Use `/addchannel` first.' });
  }
  let sent = 0, failed = 0;
  for (const channelId of allowedIds) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.isTextBased()) continue;
      await ch.send({ content: `<@&1509909999743275008> ${message}`, allowedMentions: { roles: ['1509909999743275008'] } });
      sent++;
    } catch (err) {
      console.error(`[announcement] Failed ${channelId}:`, err.message);
      failed++;
    }
  }
  await interaction.editReply({
    content: `✅ Sent to **${sent}** channel(s)${failed ? ` (⚠️ ${failed} failed)` : ''}.`
  });
}

// ─── Log helper ───────────────────────────────────────────────────────────────

async function sendToLog(guildId, embed) {
  const logChannelId = getLogChannel(guildId);
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (err) { console.error('[log]', err.message); }
}

// ─── Start ────────────────────────────────────────────────────────────────────

if (startAPI) {
  try { startAPI(); } catch(e) { console.error('[API] Failed to start:', e.message); }
}



client.login(process.env.DISCORD_TOKEN);
