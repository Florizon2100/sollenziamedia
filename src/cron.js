const cron = require('node-cron');
const { getUsersMissingOnDate, getAllChannelsDailyStatus, loadDB } = require('./database');
const { getAlertUsers, getAllGuildIds, getLogChannel, getAllowedChannels, getPausedChannels, getTrackingOnlyChannels } = require('./server-config');
const { EmbedBuilder } = require('discord.js');

const REQUIRED = { tiktok: 2, instagram: 2, youtube: 2 };
const PLATFORM_META = {
  tiktok:    { emoji: '🎵', label: 'TikTok'    },
  instagram: { emoji: '📸', label: 'Instagram' },
  youtube:   { emoji: '▶️',  label: 'YouTube'   },
  facebook:  { emoji: '📘', label: 'Facebook'  },
};

function isCESTNow() {
  const now = new Date(), y = now.getUTCFullYear();
  const lastSun = (m) => { const d = new Date(Date.UTC(y, m+1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; };
  return now >= lastSun(2) && now < lastSun(9);
}

function getYesterdayCET() {
  const now = new Date();
  const offset = isCESTNow() ? 2 : 1;
  const cet = new Date(now.getTime() + offset * 3600 * 1000);
  cet.setUTCDate(cet.getUTCDate() - 1);
  return cet.toISOString().slice(0, 10);
}

function scheduleDailyCheck(client) {
  const hour = parseInt(process.env.DAILY_CHECK_HOUR || '23', 10);

  // ── 23:00 UTC: who posted nothing today ──────────────────────────────────
  cron.schedule(`0 ${hour} * * *`, async () => {
    console.log(`[CRON] Daily missed-user check — ${new Date().toISOString()}`);
    const today    = new Date().toISOString().slice(0, 10);
    const guildIds = new Set(getAllGuildIds());
    if (process.env.GUILD_ID) guildIds.add(process.env.GUILD_ID);

    for (const guildId of guildIds) {
      const logChannelId = getLogChannel(guildId);
      const alertUsers   = getAlertUsers(guildId);
      if (!logChannelId) continue;

      const missedUsers = getUsersMissingOnDate(guildId, today);
      if (!missedUsers.length) continue;

      try {
        const logChannel = await client.channels.fetch(logChannelId);
        if (!logChannel?.isTextBased()) continue;
        const allTagIds = [...new Set([process.env.ADMIN_USER_ID, ...alertUsers].filter(Boolean))];
        const tags      = allTagIds.map(id => `<@${id}>`).join(' ');
        const embed     = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('⚠️ Users With No Posts Today')
          .setDescription(`${tags}\nThe following users posted **nothing** on **${today}**:`)
          .addFields({ name: '👤 Missing Users', value: missedUsers.map(u => `• <@${u.user_id}>`).join('\n') })
          .setTimestamp();
        await logChannel.send({ embeds: [embed], allowedMentions: { users: missedUsers.map(u => u.user_id).filter(Boolean) } });
      } catch (err) {
        console.error(`[CRON] Guild ${guildId}:`, err.message);
      }
    }
  }, { timezone: 'UTC' });

  // ── 1:00 CET: detailed missing platforms for YESTERDAY ───────────────────
  // 1:00 CET = 00:00 UTC (winter) / 23:00 UTC previous day (summer) — use 00:00 UTC
  cron.schedule('0 0 * * *', async () => {
    console.log(`[CRON] 1AM CET detailed check — ${new Date().toISOString()}`);
    const yesterday = getYesterdayCET();
    const year      = parseInt(yesterday.slice(0,4));
    const month     = parseInt(yesterday.slice(5,7));
    const guildIds  = new Set(getAllGuildIds());
    if (process.env.GUILD_ID) guildIds.add(process.env.GUILD_ID);

    for (const guildId of guildIds) {
      const logChannelId = getLogChannel(guildId);
      const alertUsers   = getAlertUsers(guildId);
      
      const allowedIds     = getAllowedChannels(guildId);
      const trackingOnlyIds = new Set(getTrackingOnlyChannels(guildId));
      const quotaChannelIds = allowedIds.filter(id => !trackingOnlyIds.has(id));
      if (!logChannelId || !allowedIds.length) continue;

      // Get all posts for yesterday
      const db = loadDB(guildId, year, month);
      const yesterdayPosts = db.posts.filter(p => p.date_key === yesterday);

      // Find users who posted nothing yesterday
      const allUsers = Object.values(db.known_users);
      const posterIds = new Set(yesterdayPosts.map(p => p.user_id));
      const missingUsers = allUsers.filter(u => !posterIds.has(u.user_id));

      // Find channels with missing platforms
      const channelStats = {};
      for (const post of yesterdayPosts) {
        if (!channelStats[post.channel_id]) channelStats[post.channel_id] = { name: post.channel_name, platforms: {} };
        channelStats[post.channel_id].platforms[post.platform] = (channelStats[post.channel_id].platforms[post.platform] || 0) + 1;
      }

      // "tracking-only" channels are excluded from the quota alert
      const incompleteChannels = quotaChannelIds
        .map(id => {
          const stats = channelStats[id];
          const missing = Object.entries(REQUIRED)
            .filter(([p, req]) => (stats?.platforms[p] || 0) < req)
            .map(([p]) => `${PLATFORM_META[p].emoji} ${PLATFORM_META[p].label}`);
          return stats && missing.length ? { name: stats.name, missing } : null;
        })
        .filter(Boolean);

      if (!missingUsers.length && !incompleteChannels.length) continue;

      try {
        const logChannel = await client.channels.fetch(logChannelId);
        if (!logChannel?.isTextBased()) continue;
        const allTagIds = [...new Set([process.env.ADMIN_USER_ID, ...alertUsers].filter(Boolean))];
        const tags      = allTagIds.map(id => `<@${id}>`).join(' ');

        const embed = new EmbedBuilder()
          .setColor(0xFF6B00)
          .setTitle(`📋 Yesterday's Summary — ${yesterday}`)
          .setDescription(`${tags}`);

        if (missingUsers.length) {
          embed.addFields({
            name: '👤 Users who posted nothing',
            value: missingUsers.map(u => `• <@${u.user_id}>`).join('\n')
          });
        }

        if (incompleteChannels.length) {
          embed.addFields({
            name: '📌 Channels with missing platforms',
            value: incompleteChannels.map(c => `• **#${c.name}** — missing: ${c.missing.join(', ')}`).join('\n')
          });
        }

        embed.setTimestamp();
        await logChannel.send({ embeds: [embed], allowedMentions: { users: missingUsers.map(u => u.user_id).filter(Boolean) } });
      } catch (err) {
        console.error(`[CRON] 1AM Guild ${guildId}:`, err.message);
      }
    }
  }, { timezone: 'UTC' });

  console.log(`[CRON] Daily check scheduled at ${hour}:00 UTC`);
  console.log(`[CRON] 1AM CET detailed summary scheduled at 00:00 UTC`);
}

module.exports = { scheduleDailyCheck };
