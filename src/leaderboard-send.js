/* ─────────────────────────────────────────────────────────────
   /leaderboardsend client:<client> views:<vues> [week:<AAAA-MM-JJ>]
   Met le total des vues de la semaine du client sur le site (dashboard → Views),
   comme « Ajouter une semaine » dans l'admin. Réservé aux admins du bot.
   La semaine = le samedi de la semaine en cours (comme l'admin), sauf si tu donnes une date.
   ───────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const { isBotAdmin } = require('./server-config');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const readClients = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-config.json'), 'utf8')).clients || []; } catch { return []; } };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const parisKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function thisSaturday() {
  const today = parisKey(), d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const command = new SlashCommandBuilder()
  .setName('leaderboardsend')
  .setDescription('[Admin] Put a client\'s total views of the week on the website')
  .addStringOption(o => o.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
  .addIntegerOption(o => o.setName('views').setDescription('Total views of the week (all accounts)').setRequired(true).setMinValue(0))
  .addStringOption(o => o.setName('week').setDescription('Week date YYYY-MM-DD (default: this week\'s Saturday)'));

function findClient(input) {
  const q = norm(input), list = readClients();
  return list.find(c => String(c.id) === String(input)) || list.find(c => norm(c.name) === q) || list.find(c => norm(c.name).includes(q)) || null;
}

async function autocomplete(interaction) {
  try {
    const q = norm(interaction.options.getFocused());
    await interaction.respond(readClients().filter(c => !q || norm(c.name).includes(q)).slice(0, 25).map(c => ({ name: String(c.name).slice(0, 100), value: String(c.id) })));
  } catch { try { await interaction.respond([]); } catch {} }
}

async function handle(interaction) {
  if (!isBotAdmin(interaction.guildId, interaction.user.id, interaction.memberPermissions))
    return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
  const client = findClient(interaction.options.getString('client'));
  if (!client) return interaction.reply({ content: '❌ Client not found.', ephemeral: true });
  const views = interaction.options.getInteger('views');
  let week = (interaction.options.getString('week') || '').trim();
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) return interaction.reply({ content: '❌ Week must look like 2026-11-21.', ephemeral: true });
  week = week || thisSaturday();
  const chIds = new Set((client.channels || []).map(c => String(c.id)));
  let replaced = 0;
  try {
    await require('./admin2').updateConfig(cfg => {
      cfg.views = Array.isArray(cfg.views) ? cfg.views : [];
      let w = cfg.views.find(x => x.week === week);
      if (!w) { w = { week, entries: [] }; cfg.views.push(w); cfg.views.sort((a, b) => a.week.localeCompare(b.week)); }
      // le total remplace les vues par compte de cette semaine (sinon elles seraient comptées deux fois)
      const before = w.entries.length;
      w.entries = w.entries.filter(e => String(e.channelId) !== String(client.id) && !chIds.has(String(e.channelId)));
      replaced = before - w.entries.length;
      if (views > 0) w.entries.push({ channelId: String(client.id), channelName: client.name, views });
      cfg.views = cfg.views.filter(x => x.entries.length);
    });
  } catch (e) { return interaction.reply({ content: '❌ Could not save: ' + e.message, ephemeral: true }); }
  const d = new Date(week + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return interaction.reply({ content: `✅ **${client.name}** — week of **${d}**: **${views.toLocaleString('en-US')}** views saved on the website.${replaced ? ` (replaced ${replaced} previous entr${replaced > 1 ? 'ies' : 'y'})` : ''}`, ephemeral: true });
}

module.exports = { command: command.toJSON(), handle, autocomplete };
