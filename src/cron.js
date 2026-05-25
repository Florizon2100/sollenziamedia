const cron = require('node-cron');
const { getUsersMissingOnDate } = require('./database');
const { getAlertUsers } = require('./youtube');
const { EmbedBuilder } = require('discord.js');

function scheduleDailyCheck(client) {
  const hour = parseInt(process.env.DAILY_CHECK_HOUR || '23', 10);
  cron.schedule(`0 ${hour} * * *`, async () => {
    console.log(`[CRON] Daily missed-user check — ${new Date().toISOString()}`);
    const logChannelId = process.env.LOG_CHANNEL_ID;
    const adminId      = process.env.ADMIN_USER_ID;
    const alertUsers   = getAlertUsers();
    if (!logChannelId) return;

    const today       = new Date().toISOString().slice(0, 10);
    const missedUsers = getUsersMissingOnDate(today);
    if (!missedUsers.length) { console.log('[CRON] All users posted today 🎉'); return; }

    try {
      const logChannel = await client.channels.fetch(logChannelId);
      if (!logChannel?.isTextBased()) return;
      const allTagIds = [...new Set([adminId, ...alertUsers].filter(Boolean))];
      const tags      = allTagIds.map(id => `<@${id}>`).join(' ');
      const embed     = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚠️ Users With No Posts Today')
        .setDescription(`${tags}\nThe following users posted **nothing** on **${today}**:`)
        .addFields({ name: '👤 Missing Users', value: missedUsers.map(u => `• **${u.username}**`).join('\n') })
        .setTimestamp();
      await logChannel.send({ embeds: [embed] });
    } catch (err) { console.error('[CRON]', err.message); }
  }, { timezone: 'UTC' });
  console.log(`[CRON] Daily check scheduled at ${hour}:00 UTC`);
}

module.exports = { scheduleDailyCheck };
