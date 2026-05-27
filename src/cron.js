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
          .addFields({ name: '👤 Missing Users', value: missedUsers.map(u => `• **${u.username}**`).join('\n') })
          .setTimestamp();
        await logChannel.send({ embeds: [embed] });
      } catch (err) {
        console.error(`[CRON] Guild ${guildId}:`, err.message);
      }
    }
  }, { timezone: 'UTC' });
  console.log(`[CRON] Daily check scheduled at ${hour}:00 UTC`);
}

module.exports = { scheduleDailyCheck };
