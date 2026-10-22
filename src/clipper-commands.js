const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const clippers = require('./clippers');
const { isBotAdmin } = require('./server-config');

const COMMAND_NAMES = new Set(['addclipper', 'removeclipper']);

function getClipperCommands() {
  return [
    new SlashCommandBuilder()
      .setName('addclipper')
      .setDescription('[Admin] Add a clipper (or update an existing one) — all fields are optional except the name')
      .addStringOption(o => o.setName('name').setDescription('Clipper name').setRequired(true).setAutocomplete(true).setMaxLength(50))
      .addStringOption(o => o.setName('youtube').setDescription('YouTube @handle or channel link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('tiktok').setDescription('TikTok @handle or profile link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('instagram').setDescription('Instagram @handle or profile link (- to clear)').setMaxLength(200))
      .addStringOption(o => o.setName('link').setDescription('Bio link, e.g. ClickMagick (- to clear)').setMaxLength(500)),

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

  if (interaction.commandName === 'addclipper') {
    const fields = {
      youtube:   interaction.options.getString('youtube'),
      tiktok:    interaction.options.getString('tiktok'),
      instagram: interaction.options.getString('instagram'),
      link:      interaction.options.getString('link'),
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

// Suggestions de noms pendant la frappe (utile pour /removeclipper et pour modifier un clipper existant).
async function handleClipperAutocomplete(interaction) {
  try {
    if (!interaction.guildId) return await interaction.respond([]);
    const focused = interaction.options.getFocused();
    const names = clippers.searchNames(interaction.guildId, focused);
    await interaction.respond(names.map(n => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  } catch {
    try { await interaction.respond([]); } catch {}
  }
}

module.exports = { getClipperCommands, isClipperCommand, handleClipperCommand, handleClipperAutocomplete };
