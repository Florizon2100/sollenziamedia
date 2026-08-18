const { EmbedBuilder } = require('discord.js');

const PLATFORM_META = {
  instagram: { emoji: '📸', color: 0xE1306C, label: 'Instagram' },
  tiktok:    { emoji: '🎵', color: 0x010101, label: 'TikTok'    },
  youtube:   { emoji: '▶️',  color: 0xFF0000, label: 'YouTube'   },
  facebook:  { emoji: '📘', color: 0x1877F2, label: 'Facebook'  },
};

const REQUIRED_PLATFORMS = ['tiktok', 'instagram', 'youtube']; // facebook not required

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// ── /posted confirmation (ephemeral) ─────────────────────────────────────────
function buildPostedConfirm({ username, platform, videoUrl, channelName, day }) {
  const meta = PLATFORM_META[platform] || { emoji: '🎬', color: 0x5865F2, label: platform };
  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Post Logged!`)
    .setDescription(`Your ${meta.label} video has been recorded. Nice work, **${username}**!`)
    .addFields(
      { name: '🔗 Link',     value: videoUrl,             inline: false },
      { name: '📺 Platform', value: meta.label,           inline: true  },
      { name: '📌 Channel',  value: `#${channelName}`,   inline: true  },
      { name: '🕐 Time',     value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
    )
    .setFooter({ text: day ? `Posted for day ${day} of current month` : 'Keep it up! 🚀' });
}

// ── Log channel embed ─────────────────────────────────────────────────────────
function buildLogEmbed({ username, userId, channelName, channelId, platform, videoUrl, day }) {
  const meta = PLATFORM_META[platform] || { emoji: '🎬', color: 0x5865F2, label: platform };
  const ts   = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setAuthor({ name: `${meta.emoji} New ${meta.label} Post` })
    .addFields(
      { name: '👤 User',      value: `<@${userId}> (${username})`, inline: true  },
      { name: '📌 Channel',   value: `<#${channelId}>`,            inline: true  },
      { name: '⏰ Posted at', value: `<t:${ts}:F>`,               inline: false },
      { name: '🔗 Link',      value: videoUrl,                     inline: false },
    )
    .setTimestamp();
  if (day) embed.addFields({ name: '📅 Day Override', value: `Day ${day} of current month`, inline: true });
  return embed;
}

// ── Monthly stats embed ───────────────────────────────────────────────────────
function buildStatsEmbed(rows, year, month, platformBreakdown) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📊 Stats — ${MONTH_NAMES[month - 1]} ${year}`)
    .setTimestamp();

  const byUser = {};
  for (const row of rows) {
    if (!byUser[row.username]) byUser[row.username] = {};
    byUser[row.username][row.platform] = row.count;
  }

  if (Object.keys(byUser).length === 0) {
    embed.setDescription('No posts recorded this month yet.');
    return embed;
  }

  const lines = [];
  for (const [user, platforms] of Object.entries(byUser)) {
    const parts = Object.entries(platforms)
      .map(([p, c]) => `${PLATFORM_META[p]?.emoji || '🎬'} ${c}`)
      .join('  ');
    const total = Object.values(platforms).reduce((a, b) => a + b, 0);
    lines.push(`**${user}** — ${parts}  *(${total} total)*`);
  }
  embed.addFields({ name: '👥 Per User', value: lines.join('\n'), inline: false });

  if (platformBreakdown.length) {
    const ptLines = platformBreakdown
      .map(r => `${PLATFORM_META[r.platform]?.emoji || '🎬'} **${PLATFORM_META[r.platform]?.label || r.platform}**: ${r.count}`)
      .join('\n');
    embed.addFields({ name: '📺 By Platform', value: ptLines, inline: false });
  }

  return embed;
}

// ── My stats embed ────────────────────────────────────────────────────────────
// posts: full post objects for the month [{ date_key, platform, video_url, posted_at }]
function buildMyStatsEmbed(username, userId, rows, dailyActivity, year, month, monthPosts = []) {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`📈 Stats — ${username} — ${MONTH_NAMES[month - 1]} ${year}`)
    .setTimestamp();

  // ── Platform totals ──
  const ALL_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'facebook'];
  const countMap = {};
  for (const r of rows) countMap[r.platform] = r.count;
  const total     = rows.reduce((a, r) => a + r.count, 0);
  const platLines = ALL_PLATFORMS.map(p => {
    const meta  = PLATFORM_META[p];
    const count = countMap[p] || 0;
    return `${meta.emoji} **${meta.label}**: ${count} video${count !== 1 ? 's' : ''}`;
  }).join('\n');

  if (total === 0) {
    embed.setDescription(`No posts recorded for **${username}** this month.`);
    return [embed];
  }

  embed.addFields(
    { name: '📊 Per Platform', value: platLines,             inline: true },
    { name: '🏆 Total',        value: `**${total}** videos`, inline: true },
  );

  // ── Day-by-day with links ──
  const now         = new Date();
  const isCurrent   = now.getFullYear() === year && (now.getMonth() + 1) === month;
  const lastDay     = isCurrent ? now.getDate() : new Date(year, month, 0).getDate();
  const allDays     = [];
  for (let d = 1; d <= lastDay; d++) {
    allDays.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  }

  // Group posts by date
  const byDay = {};
  for (const p of monthPosts) {
    if (!byDay[p.date_key]) byDay[p.date_key] = [];
    byDay[p.date_key].push(p);
  }

  const lines = [];
  for (const day of allDays) {
    const dd       = day.slice(8);
    const mm       = day.slice(5, 7);
    const label    = `**${dd}/${mm}**`;
    const dayPosts = byDay[day];

    if (!dayPosts || dayPosts.length === 0) {
      // Check which required platforms are missing
      const missingStr = REQUIRED_PLATFORMS.map(p => PLATFORM_META[p].emoji + ' ' + PLATFORM_META[p].label).join('  ');
      lines.push(`${label} — ❌ No posts  *(missing: ${missingStr})*`);
    } else {
      const counts  = {};
      for (const p of dayPosts) counts[p.platform] = (counts[p.platform] || 0) + 1;
      const missing = REQUIRED_PLATFORMS.filter(p => (counts[p] || 0) < 2);
      const emoji   = missing.length === 0 ? (dayPosts.length >= 6 ? '🔥' : '✅') : '⚠️';

      let header = `${label} — ${emoji} **${dayPosts.length}** video${dayPosts.length !== 1 ? 's' : ''}`;
      if (missing.length > 0) {
        const missingStr = missing.map(p => `${PLATFORM_META[p].emoji} ${PLATFORM_META[p].label} (${counts[p]||0}/2)`).join('  ');
        header += `  *(missing: ${missingStr})*`;
      }
      lines.push(header);

      for (const p of dayPosts) {
        const meta    = PLATFORM_META[p.platform] || { emoji: '🎬', label: p.platform };
        const timeStr = new Date(p.posted_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
        lines.push(`　${meta.emoji} [${meta.label} — ${timeStr} UTC](${p.video_url})`);
      }
    }
  }

  // Split into pages (4000 char chunks)
  const CHUNK  = 3800;
  const chunks = [];
  let   buf    = '';
  for (const line of lines) {
    if ((buf + '\n' + line).length > CHUNK && buf.length > 0) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) chunks.push(buf);

  const embeds = chunks.map((chunk, idx) => {
    const e = new EmbedBuilder().setColor(0x57F287).setDescription(chunk).setTimestamp();
    if (idx === 0) e.setTitle(`📈 Stats — ${username} — ${MONTH_NAMES[month - 1]} ${year}`);
    return e;
  });

  // Prepend the summary embed
  const summaryEmbed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`📈 Stats — ${username} — ${MONTH_NAMES[month - 1]} ${year}`)
    .addFields(
      { name: '📊 Per Platform', value: platLines,             inline: true },
      { name: '🏆 Total',        value: `**${total}** videos`, inline: true },
    )
    .setTimestamp();

  return [summaryEmbed, ...embeds];
}

// ── Leaderboard embed ─────────────────────────────────────────────────────────
function buildLeaderboardEmbed(rows, year, month) {
  const medals = ['🥇','🥈','🥉'];
  const embed  = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle(`🏆 Leaderboard — ${MONTH_NAMES[month - 1]} ${year}`)
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription('No posts this month yet. Be the first!');
    return embed;
  }

  const lines = rows.map((r, i) => {
    const rank = medals[i] || `**#${i + 1}**`;
    return `${rank} **${r.username}** — ${r.total} posts`;
  });
  embed.setDescription(lines.join('\n'));
  return embed;
}

// ── Old missed-post alert (channel-based, kept for compat) ────────────────────
function buildMissedAlertEmbed(missedByChannel, adminId, dateKey) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚠️ Missed Post Alert')
    .setDescription(`<@${adminId}> — Some channels had **no posts** on **${dateKey}**:`)
    .setTimestamp();

  for (const { channelId, channelName, posters } of missedByChannel) {
    const posterText = posters.length
      ? posters.map(p => `• ${p.username}`).join('\n')
      : '*No one posted*';
    embed.addFields({
      name:   `📌 #${channelName}`,
      value:  posters.length ? `Posted:\n${posterText}` : posterText,
      inline: true,
    });
  }
  return embed;
}

// ── Per-user missed alert ─────────────────────────────────────────────────────
function buildUserMissedAlertEmbed(missedUsers, adminId, dateKey) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚠️ Users With No Posts Today')
    .setDescription(`<@${adminId}> — The following users posted **nothing** on **${dateKey}**:`)
    .setTimestamp();

  const lines = missedUsers.map(u => `• **${u.username}**`).join('\n');
  embed.addFields({ name: '👤 Missing Users', value: lines || 'None' });
  return embed;
}

// ── Daily recap embeds ────────────────────────────────────────────────────────
// Returns an array of EmbedBuilder (auto-splits if content > 4000 chars)
// posts: [{ date_key, platform, video_url, posted_at, username }]
// allDaysInMonth: ['YYYY-MM-DD', ...] for every day up to today in the month
function buildRecapEmbeds(posts, allDaysInMonth, year, month, targetUsername = null) {
  const title = targetUsername
    ? `📅 Daily Recap — ${targetUsername} — ${MONTH_NAMES[month - 1]} ${year}`
    : `📅 Daily Recap — All Users — ${MONTH_NAMES[month - 1]} ${year}`;

  // Group posts by date
  const byDay = {};
  for (const p of posts) {
    if (!byDay[p.date_key]) byDay[p.date_key] = [];
    byDay[p.date_key].push(p);
  }

  const lines = [];
  for (const day of allDaysInMonth) {
    const dd       = day.slice(8);
    const mm       = day.slice(5, 7);
    const label    = `**${dd}/${mm}**`;
    const dayPosts = byDay[day] || [];

    if (dayPosts.length === 0) {
      // Nothing posted — list all required platforms as missing
      const missingAll = REQUIRED_PLATFORMS.map(p => {
        const meta = PLATFORM_META[p];
        return `${meta.emoji} ${meta.label}`;
      }).join('  ');
      lines.push(`${label} — ❌ No videos posted  *(missing: ${missingAll})*`);
    } else {
      // Count per platform
      const counts = {};
      for (const p of dayPosts) counts[p.platform] = (counts[p.platform] || 0) + 1;

      // Find missing required platforms (less than 2)
      const missing = REQUIRED_PLATFORMS.filter(p => (counts[p] || 0) < 2);

      const allDone = missing.length === 0;
      const emoji   = allDone ? (dayPosts.length >= 6 ? '🔥' : '✅') : '⚠️';

      let header = `${label} — ${emoji} **${dayPosts.length}** video${dayPosts.length > 1 ? 's' : ''} posted`;
      if (!allDone) {
        const missingStr = missing.map(p => {
          const meta  = PLATFORM_META[p];
          const count = counts[p] || 0;
          return `${meta.emoji} ${meta.label} (${count}/2)`;
        }).join('  ');
        header += `  ⚠️ *missing: ${missingStr}*`;
      }
      lines.push(header);

      for (const p of dayPosts) {
        const meta    = PLATFORM_META[p.platform] || { emoji: '🎬', label: p.platform };
        const who     = targetUsername ? '' : ` *(${p.username})*`;
        const timeStr = new Date(p.posted_at).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
        });
        lines.push(`　${meta.emoji} [${meta.label} — ${timeStr} UTC](${p.video_url})${who}`);
      }
    }
  }

  // Split into 3500-char chunks to stay well under Discord's 6000 limit
  const CHUNK  = 3500;
  const chunks = [];
  let   buf    = '';
  for (const line of lines) {
    const safeLine = line.length > 300 ? line.slice(0, 297) + '...' : line;
    if ((buf + '\n' + safeLine).length > CHUNK && buf.length > 0) {
      chunks.push(buf);
      buf = safeLine;
    } else {
      buf = buf ? buf + '\n' + safeLine : safeLine;
    }
  }
  if (buf) chunks.push(buf);

  if (chunks.length === 0) {
    return [new EmbedBuilder().setColor(0x5865F2).setTitle(title)
      .setDescription('No posts found for this period.').setTimestamp()];
  }

  return chunks.map((chunk, idx) => {
    const e = new EmbedBuilder().setColor(0x5865F2).setDescription(chunk).setTimestamp();
    e.setTitle(idx === 0 ? title.slice(0, 256) : `${title.slice(0, 200)} (${idx + 1})`);
    return e;
  });
}

module.exports = {
  PLATFORM_META,
  buildPostedConfirm,
  buildLogEmbed,
  buildStatsEmbed,
  buildMyStatsEmbed,
  buildLeaderboardEmbed,
  buildMissedAlertEmbed,
  buildUserMissedAlertEmbed,
  buildRecapEmbeds,
};
