const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const clippers = require('./clippers');
const { isBotAdmin } = require('./server-config');
const { clicksFor } = require('./clickmagick');

const COMMAND_NAMES = new Set(['addclipper', 'removeclipper', 'clipperstats']);

function getClipperCommands() {
  return [
    new SlashCommandBuilder()
      .setName('addclipper')
      .setDescription('[Admin] Add a clipper (or update an existing one) — all fields are optional except the name')
      .addStringOption(o => o.setName('name').setDescription('Clipper name').setRequired(true).setAutocomplete(true).setMaxLength(50))
      .addStringOption(o => o.setName('youtube').setDescription('YouTube @handle or channel link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('tiktok').setDescription('TikTok @handle or profile link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('instagram').setDescription('Instagram @handle or profile link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('link').setDescription('Bio link, e.g. ClickMagick (- to clear)').setMaxLength(500))
      .addStringOption(o => o.setName('client').setDescription('Client this clipper works for (- to clear)').setAutocomplete(true).setMaxLength(100)),

    new SlashCommandBuilder()
      .setName('clipperstats')
      .setDescription('[Admin] Valid ClickMagick clicks per clipper (today / 7 days / 30 days)')
      .addStringOption(o => o.setName('name').setDescription('One clipper (leave empty for all)').setAutocomplete(true).setMaxLength(50))
      .addStringOption(o => o.setName('client').setDescription('Only the clippers of this client').setAutocomplete(true).setMaxLength(100)),

    new SlashCommandBuilder()
      .setName('removeclipper')
      .setDescription('[Admin] Remove a clipper from the list')
      .addStringOption(o => o.setName('name').setDescription('Clipper name').setRequired(true).setAutocomplete(true).setMaxLength(50)),
  ].map(c => c.toJSON());
}

const isClipperCommand = name => COMMAND_NAMES.has(name);

function accountLine(label, acc) {
  return `${label}: ${acc ? `[@${acc.handle}](${acc.url})` : '—'}`;
}

function clipperEmbed(c, color, title) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription([
      `**${c.name}**`,
      accountLine('▶️ YouTube', c.youtube),
      accountLine('🎵 TikTok', c.tiktok),
      accountLine('📸 Instagram', c.instagram),
      `🔗 Link: ${c.link ? c.link : '—'}`,
      `🏢 Client: ${c.clientName || '—'}`,
    ].join('\n'))
    .setTimestamp();
}

async function handleClipperCommand(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
  }
  if (!isBotAdmin(interaction.guildId, interaction.user.id, interaction.memberPermissions)) {
    return interaction.reply({ content: '❌ You need admin permissions to use this command.', ephemeral: true });
  }
  const g = interaction.guildId;
  const name = interaction.options.getString('name');

  if (interaction.commandName === 'clipperstats') return handleStats(interaction, g, name);

  if (interaction.commandName === 'addclipper') {
    const fields = {
      youtube:   interaction.options.getString('youtube'),
      tiktok:    interaction.options.getString('tiktok'),
      instagram: interaction.options.getString('instagram'),
      link:      interaction.options.getString('link'),
      client:    interaction.options.getString('client'),
    };
    const r = clippers.upsertClipper(g, name, fields, interaction.user.id);
    if (r.error) return interaction.reply({ content: `❌ ${r.error}`, ephemeral: true });

    if (!r.created && r.changed === 0) {
      return interaction.reply({ content: `ℹ️ **${r.clipper.name}** already exists and you didn't give anything to update.`, embeds: [clipperEmbed(r.clipper, 0x5865F2, '👤 Clipper')], ephemeral: true });
    }
    return interaction.reply({
      embeds: [clipperEmbed(r.clipper, r.created ? 0x57F287 : 0xFEE75C, r.created ? '✅ Clipper added' : '✏️ Clipper updated')],
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'removeclipper') {
    const removed = clippers.removeClipper(g, name);
    if (!removed) {
      const known = clippers.listClippers(g).map(c => c.name);
      return interaction.reply({ content: `❌ Clipper **${name}** not found.${known.length ? ` Known clippers: ${known.join(', ')}` : ' The list is empty.'}`, ephemeral: true });
    }
    return interaction.reply({ embeds: [clipperEmbed(removed, 0xED4245, '🗑️ Clipper removed')], ephemeral: true });
  }
}

async function handleStats(interaction, g, name) {
  const clientQ = interaction.options.getString('client');
  let list = clippers.getAllClippers(g);
  if (name)    list = list.filter(c => c.id === name.trim().toLowerCase());
  if (clientQ) list = list.filter(c => (c.clientName || '').toLowerCase() === clientQ.trim().toLowerCase());
  if (!list.length) return interaction.reply({ content: '❌ No clipper matches.', ephemeral: true });

  const lines = list.slice(0, 25).map(c => {
    const k = clicksFor(c);
    const who = `**${c.name}**${c.clientName ? ` · ${c.clientName}` : ''}`;
    if (k.status === 'disabled') return `${who} — click tracking not enabled (CLICKMAGICK_API_KEY missing)`;
    if (k.status === 'nolink')   return `${who} — no link`;
    if (k.status === 'unmatched') return `${who} — link \`${k.slug}\` not found in ClickMagick`;
    if (k.status !== 'ok')       return `${who} — loading…`;
    return `${who} — today **${k.today.valid}** · 7d **${k.d7.valid}** · 30d **${k.d30.valid}** valid clicks _(30d total ${k.d30.total}, flagged ${k.d30.flagged})_`;
  });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🖱️ Valid clicks per clipper').setDescription(lines.join('\n').slice(0, 4000)).setFooter({ text: 'Refreshed every 30 min · valid = unique, non-flagged clicks' }).setTimestamp()],
    ephemeral: true,
  });
}

// Suggestions de noms pendant la frappe (utile pour /removeclipper et pour modifier un clipper existant).
async function handleClipperAutocomplete(interaction) {
  try {
    if (!interaction.guildId) return await interaction.respond([]);
    const f = interaction.options.getFocused(true);
    const names = f.name === 'client' ? clippers.searchClients(f.value) : clippers.searchNames(interaction.guildId, f.value);
    await interaction.respond(names.map(n => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  } catch {
    try { await interaction.respond([]); } catch {}
  }
}

module.exports = { getClipperCommands, isClipperCommand, handleClipperCommand, handleClipperAutocomplete };
