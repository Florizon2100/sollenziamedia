require('dotenv').config();

const {
  Client, GatewayIntentBits, Events, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder
} = require('discord.js');

const {
  insertPost, insertMultiplePosts, removePost, getPostsForDate,
  getMonthlyStats, getMonthlyStatsByUser, getLeaderboard,
  getPostCountByPlatform, getUserDailyActivity, getMonthlyDailyPosts,
} = require('./database');

const {
  buildPostedConfirm, buildLogEmbed, buildStatsEmbed,
  buildMyStatsEmbed, buildLeaderboardEmbed, buildRecapEmbeds,
} = require('./embeds');

const { scheduleDailyCheck }         = require('./cron');
let startAPI = null;
try {
  startAPI = require('./api').startAPI;
} catch(e) {
  console.error('[API] Failed to load api.js:', e.message);
}
const { scheduleDailyPlatformCheck, getChannelStatusEmbed } = require('./daily-check');

const PLATFORM_META = {
  instagram: { emoji: '📸', label: 'Instagram', color: 0xE1306C },
  tiktok:    { emoji: '🎵', label: 'TikTok',    color: 0x010101 },
  youtube:   { emoji: '▶️',  label: 'YouTube',   color: 0xFF0000 },
  facebook:  { emoji: '📘', label: 'Facebook',  color: 0x1877F2 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAllowedChannelIds() {
  return (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function getLogChannelId() {
  return process.env.LOG_CHANNEL_ID || null;
}

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

function isAdmin(interaction) {
  if (interaction.user.id === process.env.ADMIN_USER_ID) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  // Check bot admins list
  const admins = (process.env.BOT_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return admins.includes(interaction.user.id);
}

function requireAdmin(interaction) {
  if (!isAdmin(interaction)) {
    interaction.reply({ content: '❌ You need admin permissions to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

// ─── Prevent crashes ──────────────────────────────────────────────────────────

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.on('error', (err) => {
  console.error('[CLIENT ERROR]', err?.message || err);
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  scheduleDailyCheck(client);
  scheduleDailyPlatformCheck(client);
  if (startAPI) {
    try {
      startAPI();
    } catch(e) {
      console.error('[API] Failed to start:', e.message);
    }
  } else {
    console.error('[API] API module not loaded — express/cors may be missing');
  }
});

// ─── Router ───────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isStringSelectMenu()) return await handleSelectMenu(interaction);
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  try {
    if (commandName === 'posted')       return await handlePosted(interaction);
    if (commandName === 'posted2')      return await handlePosted2(interaction);
    if (commandName === 'daystatus')    return await handleDayStatus(interaction);
    if (commandName === 'recap')        return await handleRecap(interaction);
    if (commandName === 'stats')        return await handleStats(interaction);
    if (commandName === 'mystats')      return await handleMyStats(interaction);
    if (commandName === 'userstats')    return await handleUserStats(interaction);
    if (commandName === 'leaderboard')  return await handleLeaderboard(interaction);
    if (commandName === 'removepost')   return await handleRemovePost(interaction);
    if (commandName === 'setup')        return await handleSetup(interaction);
    if (commandName === 'addadmin')     return await handleAddAdmin(interaction);
    if (commandName === 'removeadmin')  return await handleRemoveAdmin(interaction);
    if (commandName === 'adminlist')    return await handleAdminList(interaction);
    if (commandName === 'alertadd')     return await handleAlertAdd(interaction);
    if (commandName === 'alertremove')  return await handleAlertRemove(interaction);
    if (commandName === 'alertlist')    return await handleAlertList(interaction);
  } catch (err) {
    console.error(`[ERROR] /${commandName}:`, err?.message || err);
    try {
      const msg = { content: '❌ An error occurred. Please try again.', ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
    } catch {}
  }
});

// ─── /posted ──────────────────────────────────────────────────────────────────

async function handlePosted(interaction) {
  const allowedIds = getAllowedChannelIds();
  if (allowedIds.length > 0 && !allowedIds.includes(interaction.channelId)) {
    return interaction.reply({ content: '❌ You can only use `/posted` in designated channels.', ephemeral: true });
  }
  const videoUrl = interaction.options.getString('link');
  const platform = interaction.options.getString('platform');
  const day      = interaction.options.getInteger('day');
  if (!isValidUrl(videoUrl)) {
    return interaction.reply({ content: '❌ Invalid URL. Make sure it starts with `https://`.', ephemeral: true });
  }
  const user    = interaction.user;
  const channel = interaction.channel;
  insertPost({ userId: user.id, username: user.username, channelId: channel.id, channelName: channel.name, platform, videoUrl, dayOverride: day });
  await interaction.reply({ embeds: [buildPostedConfirm({ username: user.username, platform, videoUrl, channelName: channel.name, day })], ephemeral: true });
  await sendToLog(buildLogEmbed({ username: user.username, userId: user.id, channelName: channel.name, channelId: channel.id, platform, videoUrl, day }));
}

// ─── /posted2 ─────────────────────────────────────────────────────────────────

async function handlePosted2(interaction) {
  const allowedIds = getAllowedChannelIds();
  if (allowedIds.length > 0 && !allowedIds.includes(interaction.channelId)) {
    return interaction.reply({ content: '❌ You can only use `/posted2` in designated channels.', ephemeral: true });
  }
  const platform = interaction.options.getString('platform');
  const link1    = interaction.options.getString('link1');
  const link2    = interaction.options.getString('link2');
  const day      = interaction.options.getInteger('day');
  if (!isValidUrl(link1) || !isValidUrl(link2)) {
    return interaction.reply({ content: '❌ One or both URLs are invalid.', ephemeral: true });
  }
  const user    = interaction.user;
  const channel = interaction.channel;
  const meta    = PLATFORM_META[platform];
  insertMultiplePosts({ userId: user.id, username: user.username, channelId: channel.id, channelName: channel.name, platform, videoUrls: [link1, link2], dayOverride: day });

  const now       = new Date();
  const dateLabel = day ? `${String(day).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}` : 'Today';
  const ts        = Math.floor(Date.now() / 1000);

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.emoji} 2 ${meta.label} Videos Logged!`)
      .setDescription(`Both videos recorded for **${user.username}** in **#${channel.name}**${day ? ` for **${dateLabel}**` : ''}`)
      .addFields(
        { name: '🔗 Video 1', value: link1, inline: false },
        { name: '🔗 Video 2', value: link2, inline: false },
        { name: '🕐 Time',    value: `<t:${ts}:F>`, inline: false },
      ).setFooter({ text: 'Keep it up! 🚀' })],
    ephemeral: true,
  });

  await sendToLog(new EmbedBuilder()
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
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: '❌ You need admin permissions.', ephemeral: true });
  }
  // Reply instantly to avoid Discord timeout, then send real data
  await interaction.reply({ content: '⏳ Loading status...', ephemeral: true });

  const dateInput = interaction.options.getString('date');
  let   dateKey;
  if (dateInput) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.editReply({ content: '❌ Invalid date. Use `YYYY-MM-DD`.' });
    }
    dateKey = dateInput;
  } else {
    const now    = new Date();
    const offset = isCESTNow() ? 2 : 1;
    const cet    = new Date(now.getTime() + offset * 3600 * 1000);
    dateKey      = cet.toISOString().slice(0, 10);
  }

  const allowedIds = getAllowedChannelIds();
  const embeds     = await getChannelStatusEmbed(allowedIds, client, dateKey);
  const embedArr   = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.editReply({ content: null, embeds: embedArr.slice(0, 10) });
  for (let i = 10; i < embedArr.length; i += 10) {
    await interaction.followUp({ embeds: embedArr.slice(i, i + 10), ephemeral: true });
  }
}

function isCESTNow() {
  const now = new Date(), y = now.getUTCFullYear();
  const s = lastSun(y, 2), e = lastSun(y, 9);
  return now >= s && now < e;
}
function lastSun(y, m) {
  const d = new Date(Date.UTC(y, m+1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

// ─── /recap ───────────────────────────────────────────────────────────────────

async function handleRecap(interaction) {
  if (!requireAdmin(interaction)) return;
  const now    = new Date();
  const month  = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year   = interaction.options.getInteger('year')  ?? now.getFullYear();
  const target = interaction.options.getUser('user');
  await interaction.deferReply();
  const posts  = getMonthlyDailyPosts(year, month, target?.id ?? null);
  const embeds = buildRecapEmbeds(posts, getDaysInMonth(year, month), year, month, target?.username ?? null);
  await interaction.editReply({ content: null, embeds: embeds.slice(0, 10) });
  for (let i = 10; i < embeds.length; i += 10) {
    await interaction.followUp({ embeds: embeds.slice(i, i+10) });
  }
}

// ─── /stats ───────────────────────────────────────────────────────────────────

async function handleStats(interaction) {
  if (!requireAdmin(interaction)) return;
  const now   = new Date();
  const month = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year  = interaction.options.getInteger('year')  ?? now.getFullYear();
  await interaction.deferReply();
  await interaction.editReply({ embeds: [buildStatsEmbed(getMonthlyStats(year, month), year, month, getPostCountByPlatform(year, month))] });
}

// ─── /mystats ─────────────────────────────────────────────────────────────────

async function handleMyStats(interaction) {
  const now   = new Date();
  const month = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year  = interaction.options.getInteger('year')  ?? now.getFullYear();
  const user  = interaction.user;
  const monthPosts = getMonthlyDailyPosts(year, month, user.id);
  const embeds     = buildMyStatsEmbed(user.username, user.id, getMonthlyStatsByUser(user.id, year, month), getUserDailyActivity(user.id, year, month), year, month, monthPosts);
  const embedArr   = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.reply({ embeds: embedArr.slice(0, 10), ephemeral: true });
  for (let i = 10; i < embedArr.length; i += 10) await interaction.followUp({ embeds: embedArr.slice(i, i+10), ephemeral: true });
}

// ─── /userstats ───────────────────────────────────────────────────────────────

async function handleUserStats(interaction) {
  if (!requireAdmin(interaction)) return;
  const now    = new Date();
  const month  = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
  const year   = interaction.options.getInteger('year')  ?? now.getFullYear();
  const target = interaction.options.getUser('user');
  const monthPosts = getMonthlyDailyPosts(year, month, target.id);
  const embeds     = buildMyStatsEmbed(target.username, target.id, getMonthlyStatsByUser(target.id, year, month), getUserDailyActivity(target.id, year, month), year, month, monthPosts);
  const embedArr   = Array.isArray(embeds) ? embeds : [embeds];
  await interaction.reply({ embeds: embedArr.slice(0, 10), ephemeral: true });
  for (let i = 10; i < embedArr.length; i += 10) await interaction.followUp({ embeds: embedArr.slice(i, i+10), ephemeral: true });
}

// ─── /leaderboard ─────────────────────────────────────────────────────────────

async function handleLeaderboard(interaction) {
  if (!requireAdmin(interaction)) return;
  const now = new Date();
  await interaction.deferReply();
  await interaction.editReply({ embeds: [buildLeaderboardEmbed(getLeaderboard(now.getFullYear(), now.getMonth()+1), now.getFullYear(), now.getMonth()+1)] });
}

// ─── /removepost ──────────────────────────────────────────────────────────────

async function handleRemovePost(interaction) {
  if (!requireAdmin(interaction)) return;
  const dateStr = interaction.options.getString('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return interaction.reply({ content: '❌ Invalid date format. Use `YYYY-MM-DD`.', ephemeral: true });
  }
  const posts = getPostsForDate(dateStr);
  if (!posts.length) {
    return interaction.reply({ content: `❌ No posts found for **${dateStr}**.`, ephemeral: true });
  }
  const options = posts.slice(0, 25).map(p => {
    const meta = PLATFORM_META[p.platform] || { emoji: '🎬', label: p.platform };
    const time = new Date(p.posted_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return {
      label:       `${meta.label} — ${p.username} — ${time} UTC`.slice(0, 100),
      description: p.video_url.slice(0, 100),
      value:       String(p.id),
    };
  });
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`removepost_${dateStr}`)
      .setPlaceholder('Select a video to remove...')
      .addOptions(options)
  );
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xED4245).setTitle(`🗑️ Remove a Post — ${dateStr}`).setDescription(`Found **${posts.length}** post(s). Select one to remove:`).setTimestamp()],
    components: [row],
    ephemeral: true,
  });
}

// ─── /setup ───────────────────────────────────────────────────────────────────

async function handleSetup(interaction) {
  if (!requireAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  process.env.LOG_CHANNEL_ID = channel.id;
  await interaction.reply({ content: `✅ Log channel set to <#${channel.id}>.\n⚠️ Update \`LOG_CHANNEL_ID\` in your \`.env\` to persist after restart.`, ephemeral: true });
}

// ─── /addadmin ────────────────────────────────────────────────────────────────

async function handleAddAdmin(interaction) {
  if (!requireAdmin(interaction)) return;
  const target  = interaction.options.getUser('user');
  const admins  = (process.env.BOT_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.includes(target.id)) {
    admins.push(target.id);
    process.env.BOT_ADMINS = admins.join(',');
  }
  await interaction.reply({ content: `✅ **${target.username}** is now a bot admin.\n⚠️ Add their ID \`${target.id}\` to \`BOT_ADMINS\` in your \`.env\` to persist after restart.`, ephemeral: true });
}

// ─── /removeadmin ─────────────────────────────────────────────────────────────

async function handleRemoveAdmin(interaction) {
  if (!requireAdmin(interaction)) return;
  const target = interaction.options.getUser('user');
  const admins = (process.env.BOT_ADMINS || '').split(',').map(s => s.trim()).filter(id => id !== target.id);
  process.env.BOT_ADMINS = admins.join(',');
  await interaction.reply({ content: `✅ **${target.username}** removed from bot admins.`, ephemeral: true });
}

// ─── /adminlist ───────────────────────────────────────────────────────────────

async function handleAdminList(interaction) {
  if (!requireAdmin(interaction)) return;
  const admins = (process.env.BOT_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🛡️ Bot Admins')
      .setDescription(admins.length ? admins.map(id => `• <@${id}>`).join('\n') : 'No extra admins set. Discord server admins always have access.')
      .setTimestamp()],
    ephemeral: true,
  });
}

// ─── /alertadd ────────────────────────────────────────────────────────────────

async function handleAlertAdd(interaction) {
  if (!requireAdmin(interaction)) return;
  const { addAlertUser } = require('./youtube');
  const target = interaction.options.getUser('user');
  const added  = addAlertUser(target.id, target.username);
  await interaction.reply({ content: added ? `✅ **${target.username}** added to alert list.` : `ℹ️ **${target.username}** is already in the alert list.`, ephemeral: true });
}

// ─── /alertremove ─────────────────────────────────────────────────────────────

async function handleAlertRemove(interaction) {
  if (!requireAdmin(interaction)) return;
  const { removeAlertUser } = require('./youtube');
  const target  = interaction.options.getUser('user');
  const removed = removeAlertUser(target.id);
  await interaction.reply({ content: removed ? `✅ **${target.username}** removed from alert list.` : `❌ **${target.username}** was not in the alert list.`, ephemeral: true });
}

// ─── /alertlist ───────────────────────────────────────────────────────────────

async function handleAlertList(interaction) {
  if (!requireAdmin(interaction)) return;
  const { getAlertUsers, getAlertUsernames } = require('./youtube');
  const users     = getAlertUsers();
  const usernames = getAlertUsernames();
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('🔔 Alert Users')
      .setDescription(users.length ? users.map(id => `• <@${id}> (${usernames[id] || id})`).join('\n') : 'No alert users set.')
      .setTimestamp()],
    ephemeral: true,
  });
}

// ─── Select menu ──────────────────────────────────────────────────────────────

async function handleSelectMenu(interaction) {
  if (interaction.customId.startsWith('removepost_')) {
    const dateStr = interaction.customId.replace('removepost_', '');
    const postId  = parseInt(interaction.values[0]);
    const year    = parseInt(dateStr.slice(0,4));
    const month   = parseInt(dateStr.slice(5,7));
    const removed = removePost(postId, year, month);
    if (!removed) {
      return interaction.update({ content: '❌ Post not found.', embeds: [], components: [] });
    }
    const meta = PLATFORM_META[removed.platform] || { emoji: '🎬', label: removed.platform };
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287).setTitle('🗑️ Post Removed')
        .addFields(
          { name: '👤 User',     value: removed.username,  inline: true },
          { name: '📺 Platform', value: meta.label,        inline: true },
          { name: '📅 Date',     value: removed.date_key,  inline: true },
          { name: '🔗 Link',     value: removed.video_url, inline: false },
        ).setTimestamp()],
      components: [],
    });
  }
}

// ─── Log helper ───────────────────────────────────────────────────────────────

async function sendToLog(embed) {
  const logChannelId = getLogChannelId();
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (err) { console.error('[log]', err.message); }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
try { execSync('node src/deploy-commands.js', { stdio: 'inherit' }); } catch(e) {}

client.login(process.env.DISCORD_TOKEN);
