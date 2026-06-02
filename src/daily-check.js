const { getAllChannelsDailyStatus } = require('./database');
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
  const s = lastSun(y,2), e = lastSun(y,9);
  return now >= s && now < e;
}
function lastSun(y, m) {
  const d = new Date(Date.UTC(y, m+1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
function getTodayCET() {
  const now    = new Date();
  const offset = isCESTNow() ? 2 : 1;
  return new Date(now.getTime() + offset*3600*1000).toISOString().slice(0,10);
}

async function getChannelStatusEmbed(guildId, allowedIds, client, dateOverride = null) {
  const today    = dateOverride || getTodayCET();
  const statuses = getAllChannelsDailyStatus(guildId, allowedIds, today);

  await Promise.all(statuses.map(async s => {
    try {
      const dc = client.channels.cache.get(s.channelId) || await client.channels.fetch(s.channelId).catch(()=>null);
      if (dc) s.channelName = dc.name;
    } catch {}
  }));

  const isToday   = today === getTodayCET();
  const dateLabel = isToday ? `Today — ${today}` : today;
  const lines     = statuses.map(s => {
    const tk=s.counts.tiktok||0, ig=s.counts.instagram||0, yt=s.counts.youtube||0, fb=s.counts.facebook||0;
    const fmt = (v,r) => v>=r?`${v}/${r} ✅`:v>0?`${v}/${r} ⏳`:`${v}/${r} ❌`;
    return `${tk>=2&&ig>=2&&yt>=2?'🟢':'🔴'} **#${s.channelName}**\n\`TK\` ${fmt(tk,2)}  \`IG\` ${fmt(ig,2)}  \`YT\` ${fmt(yt,2)}  \`FB\` ${fb}`;
  });

  const PAGE_SIZE=6, pages=[];
  for (let i=0; i<lines.length; i+=PAGE_SIZE) pages.push(lines.slice(i,i+PAGE_SIZE));

  if (!pages.length) return [new EmbedBuilder().setColor(0x2B2D31).setTitle(`Daily Status — ${dateLabel}`).setDescription('No channels configured.')];

  return pages.map((page,idx) => {
    const e = new EmbedBuilder().setColor(0x2B2D31).setDescription(page.join('\n\n')).setTimestamp();
    if (idx===0) e.setTitle(`Daily Status — ${dateLabel}`).setDescription(
      '**Legend:** `TK` TikTok  `IG` Instagram  `YT` YouTube  `FB` Facebook *(no quota)*\n🟢 Done  🔴 Incomplete\n\n' + page.join('\n\n')
    );
    return e;
  });
}

module.exports = { getChannelStatusEmbed };
