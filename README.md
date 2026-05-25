# 🎬 Video Tracker Discord Bot

A Discord bot that tracks video posts across platforms, logs them to a dedicated channel, and alerts you when someone misses a posting day.

---

## ✨ Features

| Feature | Description |
|---|---|
| `/posted [link] [platform]` | Log a video post (Instagram, TikTok, YouTube, Facebook) |
| `/stats [month] [year]` | Monthly stats for all users, with platform breakdown |
| `/mystats [month] [year]` | Personal stats with a daily activity chart |
| `/leaderboard` | Top 10 posters this month |
| `/setup #channel` | (Admin) Set the log channel |
| 🔔 Daily missed-post alert | Auto-tags you if any channel had zero posts today |

---

## 🚀 Setup Guide

### 1. Create a Discord Bot

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it — this is your `DISCORD_TOKEN`
5. Scroll down to **Privileged Gateway Intents** → enable **Server Members Intent** and **Message Content Intent**
6. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`
7. Copy the generated URL and open it to invite the bot to your server

### 2. Get Your IDs

Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode), then:

| ID | How to get it |
|---|---|
| `CLIENT_ID` | Developer Portal → your app → **Application ID** |
| `GUILD_ID` | Right-click your server name → **Copy Server ID** |
| `LOG_CHANNEL_ID` | Right-click your log channel → **Copy Channel ID** |
| `ADMIN_USER_ID` | Right-click your own profile → **Copy User ID** |
| `ALLOWED_CHANNEL_IDS` | Right-click each allowed channel → **Copy Channel ID** |

### 3. Install & Configure

```bash
# Clone / download this folder
cd discord-bot

# Install dependencies
npm install

# Copy and fill in your .env
cp .env.example .env
# Then edit .env with your values
```

Your `.env` should look like:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=123456789012345678
GUILD_ID=987654321098765432
LOG_CHANNEL_ID=111122223333444455
ADMIN_USER_ID=555566667777888899
ALLOWED_CHANNEL_IDS=aaa111,bbb222,ccc333,ddd444,eee555
DAILY_CHECK_HOUR=23
```

> **ALLOWED_CHANNEL_IDS**: comma-separated list of channel IDs where `/posted` is usable. Add up to 13. Leave empty to allow everywhere.

### 4. Register Slash Commands

```bash
npm run deploy
```

This registers all slash commands to your server. Only needs to be done once (or when you add new commands).

### 5. Start the Bot

```bash
npm start
```

---

## 📋 Command Reference

### `/posted`
```
/posted link:<url> platform:<instagram|tiktok|youtube|facebook>
```
- Logs the post silently (ephemeral reply — only you see it)
- Sends a detailed embed to the log channel automatically

### `/stats [month] [year]`
```
/stats
/stats month:5 year:2024
```
- Shows all users' posts for the month, grouped by platform
- Defaults to current month/year

### `/mystats [month] [year]`
- Your personal stats: per-platform counts + daily activity bar chart
- Reply is private (only you see it)

### `/leaderboard`
- Top 10 posters for the current month with medal emojis

### `/setup #channel`
- Admins only — sets where the bot logs posts
- For permanence, update `LOG_CHANNEL_ID` in `.env`

---

## 🔔 Missed Post Alert

Every day at `DAILY_CHECK_HOUR` (UTC), the bot checks each allowed channel.

If **any channel had zero posts** that day, it sends an alert embed to the log channel tagging `ADMIN_USER_ID`.

---

## 🗄️ Data Storage

All data is stored locally in `data/posts.db` (SQLite). No external database required.

To back up your data, just copy `data/posts.db`.

---

## 🛠️ Keeping the Bot Online

For 24/7 uptime, use a process manager:

```bash
# With PM2
npm install -g pm2
pm2 start src/index.js --name "video-tracker"
pm2 save
pm2 startup
```

Or run on a VPS / Raspberry Pi with the above PM2 setup.

---

## 📁 File Structure

```
discord-bot/
├── src/
│   ├── index.js           # Main bot + command handlers
│   ├── database.js        # SQLite DB layer
│   ├── embeds.js          # Embed builders
│   ├── cron.js            # Daily missed-post scheduler
│   └── deploy-commands.js # Run once to register slash commands
├── data/
│   └── posts.db           # Auto-created on first run
├── .env.example           # Config template
├── .env                   # Your config (never commit this!)
└── package.json
```
