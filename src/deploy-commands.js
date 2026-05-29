require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('posted')
    .setDescription('Log a video you just posted')
    .addStringOption(opt => opt.setName('link').setDescription('Full URL of the video').setRequired(true))
    .addStringOption(opt => opt.setName('platform').setDescription('Platform').setRequired(true)
      .addChoices(
        { name: '📸 Instagram', value: 'instagram' },
        { name: '🎵 TikTok',    value: 'tiktok'    },
        { name: '▶️  YouTube',   value: 'youtube'   },
        { name: '📘 Facebook',  value: 'facebook'  },
      ))
    .addIntegerOption(opt => opt.setName('day').setDescription('Day number if posting for a past day (e.g. 24)').setMinValue(1).setMaxValue(31)),

  new SlashCommandBuilder()
    .setName('posted2')
    .setDescription('Log 2 videos posted on the same platform')
    .addStringOption(opt => opt.setName('platform').setDescription('Platform').setRequired(true)
      .addChoices(
        { name: '📸 Instagram', value: 'instagram' },
        { name: '🎵 TikTok',    value: 'tiktok'    },
        { name: '▶️  YouTube',   value: 'youtube'   },
        { name: '📘 Facebook',  value: 'facebook'  },
      ))
    .addStringOption(opt => opt.setName('link1').setDescription('Link to first video').setRequired(true))
    .addStringOption(opt => opt.setName('link2').setDescription('Link to second video').setRequired(true))
    .addIntegerOption(opt => opt.setName('day').setDescription('Day number if posting for a past day (e.g. 24)').setMinValue(1).setMaxValue(31)),

  new SlashCommandBuilder()
    .setName('daystatus')
    .setDescription('See posting quota progress for a specific day')
    .addStringOption(opt => opt.setName('date').setDescription('Date to check (YYYY-MM-DD). Default: today.')),

  new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Day-by-day recap of videos posted in a month')
    .addUserOption(opt => opt.setName('user').setDescription('Specific user (leave empty for all)'))
    .addIntegerOption(opt => opt.setName('month').setDescription('Month (1-12)').setMinValue(1).setMaxValue(12))
    .addIntegerOption(opt => opt.setName('year').setDescription('Year').setMinValue(2020).setMaxValue(2100)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Monthly posting stats for all users')
    .addIntegerOption(opt => opt.setName('month').setDescription('Month (1-12)').setMinValue(1).setMaxValue(12))
    .addIntegerOption(opt => opt.setName('year').setDescription('Year').setMinValue(2020).setMaxValue(2100)),

  new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('Your personal posting stats')
    .addIntegerOption(opt => opt.setName('month').setDescription('Month (1-12)').setMinValue(1).setMaxValue(12))
    .addIntegerOption(opt => opt.setName('year').setDescription('Year').setMinValue(2020).setMaxValue(2100)),

  new SlashCommandBuilder()
    .setName('userstats')
    .setDescription('[Admin] View full stats for a specific user')
    .addUserOption(opt => opt.setName('user').setDescription('The user to inspect').setRequired(true))
    .addIntegerOption(opt => opt.setName('month').setDescription('Month (1-12)').setMinValue(1).setMaxValue(12))
    .addIntegerOption(opt => opt.setName('year').setDescription('Year').setMinValue(2020).setMaxValue(2100)),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top posters this month'),

  new SlashCommandBuilder()
    .setName('removepost')
    .setDescription('[Admin] Remove a video from the logs')
    .addStringOption(opt => opt.setName('date').setDescription('Date of the post (YYYY-MM-DD)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('[Admin] Set the log channel')
    .addChannelOption(opt => opt.setName('channel').setDescription('The channel to send post logs into').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setchannelmode')
    .setDescription('[Admin] Set a channel as quota or tracking-only')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to configure').setRequired(true))
    .addStringOption(opt => opt.setName('mode').setDescription('quota = counted in alerts | tracking-only = tracked but no alert').setRequired(true)
      .addChoices({ name: 'quota (default)', value: 'quota' }, { name: 'tracking-only (no alert)', value: 'tracking-only' })),

  new SlashCommandBuilder()
    .setName('addchannel')
    .setDescription('[Admin] Add an allowed posting channel')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to allow /posted in').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removechannel')
    .setDescription('[Admin] Remove an allowed posting channel')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('addadmin')
    .setDescription('[Admin] Grant bot-admin access to a user')
    .addUserOption(opt => opt.setName('user').setDescription('User to make bot admin').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removeadmin')
    .setDescription('[Admin] Remove bot-admin access from a user')
    .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('adminlist')
    .setDescription('[Admin] List all bot admins'),

  new SlashCommandBuilder()
    .setName('alertadd')
    .setDescription('[Admin] Add a user to the missed-post alert list')
    .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true)),

  new SlashCommandBuilder()
    .setName('alertremove')
    .setDescription('[Admin] Remove a user from the alert list')
    .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('alertlist')
    .setDescription('[Admin] Show users who get tagged for missed posts'),

  new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('[Admin] Send a @everyone announcement to all allowed channels')
    .addStringOption(opt => opt.setName('message').setDescription('The message to send').setRequired(true)),

].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Clearing old global commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('✅ Global commands cleared.');

    console.log('🔄 Registering slash commands on guild...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (err) { console.error('❌ Failed:', err); }
})();
