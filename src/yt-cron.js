const cron = require('node-cron');
const {
  getAllLinkedChannels,
  getAlertUsers,
  checkTodayVideos,
} = require('./youtube');
const { EmbedBuilder } = require('discord.js');

/**
 * Every 2 hours: check all linked YT channels.
 * At 23:00 CET specifically: final check — tag alert users for any channel with no video today.
 */
function scheduleYouTubeChecks(client) {
  // Every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    await runYouTubeCheck(client, false);
  }, { timezone: 'UTC' });

  // Final alert at 22:00 UTC = 23:00 CET (winter) / but we check DST dynamically inside
  cron.schedule('0 22 * * *', async () => {
    await runYouTubeCheck(client, true);
  }, { timezone: 'UTC' });

  console.log('[YT-CRON] YouTube checks scheduled (every 2h + final alert at 23:00 CET)');
}

async function runYouTubeCheck(client, isFinalCheck) {
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId) return;

  const channels    = getAllLinkedChannels();
  const alertUsers  = getAlertUsers();
  if (!channels.length) return;

  console.log(`[YT-CRON] Checking ${channels.length} YouTube channel(s)... (final=${isFinalCheck})`);

  let logChannel;
  try {
    logChannel = await client.channels.fetch(logChannelId);
    if (!logChannel?.isTextBased()) return;
  } catch { return; }

  const missed = [];

  for (const ch of channels) {
    try {
      const { posted, videos } = await checkTodayVideos(ch.yt_channel_id);

      if (posted && !isFinalCheck) {
        // Notify that a video was found (only on routine checks, not the final alert)
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('▶️ New YouTube Video Detected!')
          .addFields(
            { name: '📺 Channel',         value: ch.yt_channel_name,       inline: true },
            { name: '📌 Discord Channel', value: `<#${ch.discord_channel_id}>`, inline: true },
          )
          .setTimestamp();

        for (const v of videos) {
          embed.addFields({ name: `🎬 ${v.title}`, value: v.url, inline: false });
        }
        await logChannel.send({ embeds: [embed] });
      }

      if (!posted) {
        missed.push(ch);
      }
    } catch (err) {
      console.error(`[YT-CRON] Error checking ${ch.yt_channel_name}:`, err.message);
    }
  }

  // On final check (23:00 CET): tag alert users for every missed channel
  if (isFinalCheck && missed.length > 0) {
    const tags = alertUsers.map(id => `<@${id}>`).join(' ');
    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('⚠️ YouTube — No Video Posted Today!')
      .setDescription(`${tags}\nThe following YouTube channels have **not posted any video** today before 11 PM CET:`)
      .setTimestamp();

    for (const ch of missed) {
      embed.addFields({
        name:   `▶️ ${ch.yt_channel_name}`,
        value:  `Linked to <#${ch.discord_channel_id}>\n[Channel Link](${ch.yt_channel_url})`,
        inline: true,
      });
    }
    await logChannel.send({ embeds: [embed] });
  }
}

module.exports = { scheduleYouTubeChecks };
