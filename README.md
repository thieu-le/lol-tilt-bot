# LoL Tilt Bot

A Discord bot that quietly watches a list of League of Legends players and pipes
up in your channel whenever one of them loses a match. Built with Node.js,
discord.js v14, and the Riot Games API.

## Features

- Track multiple players by Riot ID (`gameName#tagLine`).
- Detect losses by polling Riot's `match-v5` API on a safe interval.
- Post a randomized tilt message to a Discord channel on every loss.
- Win/loss streak tracking per player (e.g. surface "3-loss streak" copy).
- Slash commands to add, remove, list, and inspect tracked players.
- JSON-file persistence so restarts don't re-spam old matches.
- Rate-limit aware: honors Riot's `Retry-After` headers and paces requests.

## Project structure

```
lol-tilt-bot/
├── src/
│   ├── index.js           # Entry point — boot order, signal handling
│   ├── bot.js             # Discord client + interaction routing
│   ├── poller.js          # Polling loop + loss-detection logic
│   ├── riotService.js     # Riot account-v1 + match-v5 client
│   ├── storage.js         # lowdb (JSON file) persistence
│   ├── commands.js        # Slash command definitions + handlers
│   ├── messages.js        # Rotating tilt phrases
│   ├── config.js          # Env loading + validation
│   └── logger.js          # Tiny timestamped console logger
├── scripts/
│   └── registerCommands.js  # One-shot slash command registration
├── data/                  # store.json lives here (gitignored)
├── .env.example
├── .gitignore
└── package.json
```

## Setup

1. **Install dependencies**
   ```bash
   cd /Users/thieule/lol-tilt-bot
   npm install
   ```

2. **Create your Discord application**
   - Go to <https://discord.com/developers/applications> and create a new app.
   - Under *Bot*, click *Reset Token* and copy the token.
   - Copy the *Application ID* from *General Information*.
   - Under *OAuth2 → URL Generator*, select scopes `bot` + `applications.commands`
     and the `Send Messages` + `Embed Links` permissions. Use the URL to invite
     the bot to your server.
   - In Discord, enable Developer Mode (*Settings → Advanced*), right-click the
     target channel, and *Copy Channel ID*.

3. **Get a Riot API key**
   - Sign in at <https://developer.riotgames.com/> and copy a development key
     (24-hour expiry). For longer-running deployments, request a personal key.

4. **Configure environment**
   ```bash
   cp .env.example .env
   # then edit .env with your real values
   ```

5. **Register slash commands**
   ```bash
   npm run register-commands
   ```
   Set `DISCORD_GUILD_ID` in `.env` first if you want them to appear instantly
   in a single test server. Without it, global commands can take up to an hour
   to propagate.

6. **Run the bot**
   ```bash
   npm start
   ```
   You should see `Logged in as <bot-name>` followed by `Polling 0 players`.

## Slash commands

| Command | What it does |
|---|---|
| `/track add gameName tagLine` | Resolve a Riot ID to a PUUID and start tracking. The first match is recorded silently — no false alarms from history. |
| `/track remove gameName tagLine` | Stop tracking a player. |
| `/track list` | Show all tracked players with current W/L and streak. |
| `/streak gameName tagLine` | Show one player's current streak detail. |

Example:
```
/track add gameName: Faker tagLine: KR1
```

## Tilt notification

When a tracked player finishes a losing match, the bot posts something like:

> **Faker** is tilted 😭

If they're on a 3+ loss streak, you'll get a streak-aware variant:

> **Faker** is on a 4-loss streak 🪦 send help

## Rate limits

Riot's development key allows **20 requests / 1 second** and **100 requests /
2 minutes** per region. The poller uses at most 2 calls per player per cycle
and spaces players 250ms apart, so 10 tracked players generate ~10–20 calls per
minute — well inside the limit. If you track many more players, raise
`POLL_INTERVAL_MS` accordingly.

A 429 response triggers a one-shot retry that respects the `Retry-After` header.

## Troubleshooting

- **Slash commands don't appear**: confirm the bot was invited with the
  `applications.commands` scope and that you ran `npm run register-commands`.
  Set `DISCORD_GUILD_ID` for instant guild-scoped propagation.
- **`403 Forbidden` from Riot**: your dev key likely expired (24h). Generate a
  new one and update `.env`.
- **`Riot ID not found`**: double-check `gameName` and `tagLine` (the part after
  `#`). They are case-insensitive but must be exact.
- **Bot connects but never posts**: it deliberately stays silent until a tracked
  player finishes a *new* match after being added. Play and lose to confirm.

## License

MIT
