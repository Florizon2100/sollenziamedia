const cron = require('node-cron');
const { getUsersMissingOnDate } = require('./database');
const { getAlertUsers, getAllGuildIds, getLogChannel } = require('./server-config');
const { EmbedBuilder } = require('discord.js');

function scheduleDailyCheck(client) {
  const hour = parseInt(process.env.DAILY_CHECK_HOUR || '23', 10);
  cron.schedule(`0 ${hour} * * *`, async () => {
    console.log(`[CRON] Daily missed-user check — ${new Date().toISOString()}`);
    const today    = new Date().toISOString().slice(0, 10);
    // Check all known guilds + main guild from .env
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
          .addFields({ name: '👤 Missing Users', value: missedUsers.map(u => `• <@${u.userId}>`).join('\n') })
          .setTimestamp();
        await logChannel.send({ embeds: [embed], allowedMentions: { users: missedUsers.map(u => u.userId).filter(Boolean) } });
      } catch (err) {
        console.error(`[CRON] Guild ${guildId}:`, err.message);
      }
    }
  }, { timezone: 'UTC' });
  console.log(`[CRON] Daily check scheduled at ${hour}:00 UTC`);
}


function scheduleAnalyticsReminder(client) {
  // Saturday 8:00 CET = 7:00 UTC (winter) / 6:00 UTC (summer)
  // We use 7:00 UTC as default
  cron.schedule('0 7 * * 6', async () => {
    console.log('[CRON] Saturday analytics reminder');
    const { getAllGuildIds, getAllowedChannels } = require('./server-config');
    const guildIds = new Set(getAllGuildIds());
    if (process.env.GUILD_ID) guildIds.add(process.env.GUILD_ID);
    for (const guildId of guildIds) {
      const allowedIds = getAllowedChannels(guildId);
      for (const channelId of allowedIds) {
        try {
          const ch = await client.channels.fetch(channelId);
          if (!ch?.isTextBased()) continue;
          await ch.send({ content: `📊 **Weekly Analytics Time!**\n\nHey! It's Saturday — please submit your weekly views with:\n\`/analytics tiktok:1.2M youtube:500k insta:300k\`\n\nSubmit total views for **this channel** across all platforms this week 🙏` });
        } catch(err) { console.error('[CRON] Analytics reminder:', err.message); }
      }
    }
  }, { timezone: 'UTC' });
  console.log('[CRON] Saturday analytics reminder at 07:00 UTC');
}

module.exports = { scheduleDailyCheck };
