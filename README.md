# LoL Tilt Bot

[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![Riot API](https://img.shields.io/badge/Riot_API-match--v5%20%7C%20league--v4%20%7C%20spectator--v5-D13639)](https://developer.riotgames.com/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Discord bot that watches a list of League of Legends players and turns their
ranked results into a running group bit — loss callouts, LP tracking, a curse
economy, and live prediction pools that open the moment someone queues up.

It started as a loss notifier. It is now a small event-driven service: a polling
loop over Riot's API, a persisted currency ledger, and a betting system that has
to settle correctly even if the process restarts mid-game.

> Track a player → the bot detects the moment they enter a ranked game → a
> prediction pool opens automatically → the channel bets Tilted Souls on win or
> loss → the match resolves and payouts settle. Nobody runs a command during a game.

---

## Features

**Match tracking**
- Track players by Riot ID (`gameName#tagLine`), optionally tied to a Discord user for @-mentions.
- Loss detection by polling `match-v5`, with randomized tilt copy on every loss.
- Win/loss records, daily totals, and streak tracking (timezone-aware, so late-night games land on the right day).
- A rolling 20-match outcome window used as a "recent form" signal.
- LP and rank movement via `league-v4`, including an **Aegis double-LP** callout when a gain lands well above the normal 20–28 LP band.

**Tilted Souls — the curse economy**
- `/curse` a tracked player into LosersQ until they win a ranked game.
- Each loss while cursed pays the curser on an exponential curve (`100 × 2^lossesAccrued`, scaled by a form-based multiplier), so a long losing streak pays out steeply.
- Every ranked match played earns a flat participation payout, so passive trackers still accrue a balance.
- Soul balances, lifetime earnings, and a server leaderboard persist across restarts.

**Live prediction pools**
- `/bet` pools open automatically when `spectator-v5` shows a tracked player in a ranked game — detected on a dedicated 20-second tick.
- Betting closes 2 minutes after `gameStartTime`, so nobody bets on a game that's already decided.
- Hybrid odds: payouts blend pool split with the player's recent form rather than being a flat 2×.
- Pools with no backers on the winning side refund rather than pocketing the stakes, and pools stuck past a 2-hour timeout are force-refunded.

**HateWatch**
- Lightweight tracking for Riot IDs you don't want in the main list — announces demotions and loss streaks only.
- The bot publicly announces who added a target, which is the entire point.

## Slash commands

| Command | What it does |
|---|---|
| `/track add <gameName> <tagLine> [user]` | Resolve a Riot ID to a PUUID and start tracking. Optionally @-mention a Discord user on losses. |
| `/track remove <gameName> <tagLine>` | Stop tracking a player. |
| `/track list` | Every tracked player with their record. |
| `/streak <gameName> <tagLine>` | One player's current win/loss streak. |
| `/history <gameName> <tagLine> [count]` | Recent match history for any Riot ID (1–10). Useful for sanity-checking the Riot API. |
| `/curse <gameName> <tagLine>` | Curse a tracked player into LosersQ until they win a ranked game. |
| `/uncurse <gameName> <tagLine>` | Lift **your own** curse — other cursers' entries stay. |
| `/souls balance` | Your Tilted Souls balance and lifetime earnings. |
| `/souls leaderboard` | Top 10 soul-holders in the server. |
| `/bet status` | Active or pending prediction pools. |
| `/hatewatch add <gameName> <tagLine>` | Add a Riot ID to HateWatch. |
| `/hatewatch remove <gameName> <tagLine>` | Remove one of your own HateWatch entries. |

The first match after `/track add` is recorded silently, so adding a player never
replays their history into the channel.

## Setup

**Prerequisites:** Node.js 20+, a Discord application, and a Riot API key.

```bash
git clone https://github.com/thieu-le/lol-tilt-bot.git
cd lol-tilt-bot
npm install
```

**1. Create your Discord application** at <https://discord.com/developers/applications>.
Under *Bot*, reset and copy the token. Copy the *Application ID* from *General
Information*. Under *OAuth2 → URL Generator*, select the `bot` and
`applications.commands` scopes plus `Send Messages`, `Embed Links`, `Attach Files`
(post-match chart images) and `Read Message History` (editing squad and bet posts),
and use the generated URL to invite the bot. Enable Developer Mode in Discord
(*Settings → Advanced*) to copy your target channel's ID.

**2. Get a Riot API key** at <https://developer.riotgames.com/>. Development keys
expire every 24 hours; request a personal key for anything long-running.

**3. Configure.**

```bash
cp .env.example .env
```

`.env.example` documents every variable inline, including the distinction between
**regional routing** (`americas`/`europe`/`asia`/`sea` — for `account-v1` and
`match-v5`) and **platform routing** (`na1`, `euw1`, `kr`, … — the specific shard
`league-v4` needs for LP queries). Getting these two confused is the most common
setup failure.

**4. Register slash commands and run.**

```bash
npm run register-commands
npm start
```

Set `DISCORD_GUILD_ID` first if you want commands to appear instantly in one test
server; global registration can take up to an hour to propagate.

## Running it permanently

The bot is meant to sit in the background, so it ships with autostart installers
for both platforms:

```bash
npm run install-autostart      # Windows (scheduled task, launches hidden)
./scripts/install-autostart-mac.sh    # macOS (launchd agent)
```

Both have matching `uninstall-autostart` counterparts.

## Project structure

```
src/
├── index.js         # Entry point — boot order, signal handling
├── bot.js           # Discord client + interaction routing
├── poller.js        # Match polling, spectator tick, curse payouts, bet settlement
├── riotService.js   # account-v1, match-v5, league-v4, spectator-v5 client
├── rank.js          # Pure ranked-tier/LP helpers — no I/O, trivially testable
├── storage.js       # lowdb persistence: players, souls ledger, bets, HateWatch
├── commands.js      # Slash command definitions + handlers
├── messages.js      # Rotating tilt copy and embed builders
├── backfill.js      # Backfill historical results for a newly tracked player
├── config.js        # Env loading + validation
└── logger.js        # Timestamped console logger
scripts/             # Command registration + autostart installers
data/                # store.json (gitignored)
```

`rank.js` is deliberately I/O-free: it takes `league-v4` entry shapes and returns
plain values, so tier/LP comparison logic can be tested without touching the network.

## Rate limits

A Riot development key allows 20 requests/second and 100 requests/2 minutes per
region. The match poller uses at most 2 calls per player per cycle and spaces
players 250 ms apart; the spectator tick runs separately every 20 seconds with a
100 ms per-player delay. Ten tracked players sit comfortably inside the limit.
Raise `POLL_INTERVAL_MS` if you track substantially more. A 429 triggers a
one-shot retry that honors the `Retry-After` header.

## Troubleshooting

- **Slash commands don't appear** — confirm the `applications.commands` scope was included in the invite, and run `npm run register-commands`. Set `DISCORD_GUILD_ID` for instant guild-scoped propagation.
- **`403 Forbidden` from Riot** — your development key expired (they last 24 hours). Generate a new one and update `.env`.
- **`Riot ID not found`** — check `gameName` and `tagLine` separately (the tag line is the part *after* the `#`). Case-insensitive, but must otherwise be exact.
- **LP/rank features return nothing** — `RIOT_PLATFORM_ROUTING` is probably set to a regional value. It needs a shard like `na1`, not `americas`.
- **Bot connects but never posts** — expected. It stays silent until a tracked player finishes a *new* match after being added.

## License

[MIT](LICENSE)
