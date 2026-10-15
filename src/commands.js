// Slash command definitions and runtime handlers.
//
// We expose the JSON payloads (`commandData`) so scripts/registerCommands.js
// can register them with Discord, and `handleInteraction()` so bot.js can
// dispatch incoming interactions to the right handler.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import * as storage from './storage.js';
import * as riot from './riotService.js';
import * as rank from './rank.js';
import { backfillTodayMatches } from './backfill.js';
import { findLastSquadMatch, loadSquadMatch, buildSquadAnalysis } from './analyze.js';
import {
  buildCurseAppliedMessage,
  computePayoutMultiplier,
  buildBetPoolMessage,
} from './messages.js';
import { config } from './config.js';
import { logger } from './logger.js';

// --- Definitions -----------------------------------------------------------

const trackCommand = new SlashCommandBuilder()
  .setName('track')
  .setDescription('Manage tracked League players')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Start tracking a player by Riot ID')
      .addStringOption((opt) =>
        opt.setName('gamename').setDescription('Riot ID game name (before #)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('tagline').setDescription('Riot ID tag line (after #)').setRequired(true),
      )
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription('Discord user to @-mention on losses (leave blank to skip pings)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop tracking a player')
      .addStringOption((opt) =>
        opt.setName('gamename').setDescription('Riot ID game name').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('tagline').setDescription('Riot ID tag line').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show every tracked player and their record'),
  );

const streakCommand = new SlashCommandBuilder()
  .setName('streak')
  .setDescription("Show a tracked player's current win/loss streak")
  .addStringOption((opt) =>
    opt.setName('gamename').setDescription('Riot ID game name').setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('tagline').setDescription('Riot ID tag line').setRequired(true),
  );

const historyCommand = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent match history for any Riot ID (sanity-check the Riot API)')
  .addStringOption((opt) =>
    opt.setName('gamename').setDescription('Riot ID game name').setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('tagline').setDescription('Riot ID tag line').setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription('How many recent matches to show (1-10, default 5)')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false),
  );

const curseCommand = new SlashCommandBuilder()
  .setName('curse')
  .setDescription('Curse a tracked player into LosersQ until they win a ranked game')
  .addStringOption((opt) =>
    opt.setName('gamename').setDescription("Target's Riot ID game name (before #)").setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('tagline').setDescription("Target's Riot ID tag line (after #)").setRequired(true),
  );

const uncurseCommand = new SlashCommandBuilder()
  .setName('uncurse')
  .setDescription('Lift your own curse on a tracked player (only removes your entry)')
  .addStringOption((opt) =>
    opt.setName('gamename').setDescription('Riot ID game name').setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('tagline').setDescription('Riot ID tag line').setRequired(true),
  );

const betCommand = new SlashCommandBuilder()
  .setName('bet')
  .setDescription('Live prediction pools — auto-opened when a tracked player enters ranked')
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('List active or pending prediction pools'),
  );

const hatewatchCommand = new SlashCommandBuilder()
  .setName('hatewatch')
  .setDescription('Watch random Riot IDs for demotions or loss streaks (lightweight tracking)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a Riot ID to HateWatch — bot publicly announces who added them')
      .addStringOption((opt) =>
        opt.setName('gamename').setDescription("Target's Riot ID game name (before #)").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('tagline').setDescription("Target's Riot ID tag line (after #)").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a Riot ID from HateWatch (only your own additions)')
      .addStringOption((opt) =>
        opt.setName('gamename').setDescription('Riot ID game name').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('tagline').setDescription('Riot ID tag line').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show all HateWatch entries and who added them'),
  );

const soulsCommand = new SlashCommandBuilder()
  .setName('souls')
  .setDescription('Tilted Souls — currency earned from successful curses')
  .addSubcommand((sub) =>
    sub
      .setName('balance')
      .setDescription('Check your (or another tracked player\'s) soul balance')
      .addStringOption((opt) =>
        opt.setName('gamename').setDescription('Tracked player\'s Riot game name (optional)').setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('tagline').setDescription('Tracked player\'s Riot tag line (optional)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('leaderboard').setDescription('Show the top 10 soul-holders in the server'),
  );

const analyze5sCommand = new SlashCommandBuilder()
  .setName('analyze5s')
  .setDescription('Break down the last ranked game where 3+ tracked players were on the same team')
  .addStringOption((opt) =>
    opt
      .setName('match')
      .setDescription('Specific match ID to analyze instead, e.g. NA1_5659600977')
      .setRequired(false),
  );

export const commandData = [
  trackCommand.toJSON(),
  streakCommand.toJSON(),
  historyCommand.toJSON(),
  curseCommand.toJSON(),
  uncurseCommand.toJSON(),
  soulsCommand.toJSON(),
  betCommand.toJSON(),
  hatewatchCommand.toJSON(),
  analyze5sCommand.toJSON(),
];

// --- Bet UI helpers (used by poller too) -----------------------------------

/**
 * Build the two-button row attached to a live prediction message.
 * customId format: `bet:stake:{gameId}:{side}` so the click handler can parse
 * out the gameId without any extra state lookup.
 */
export function buildStakeButtons(gameId) {
  const winBtn = new ButtonBuilder()
    .setCustomId(`bet:stake:${gameId}:win`)
    .setLabel('Bet WIN')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);
  const lossBtn = new ButtonBuilder()
    .setCustomId(`bet:stake:${gameId}:loss`)
    .setLabel('Bet LOSS')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(winBtn, lossBtn);
}

// Most common Riot queue IDs — anything not in here falls back to "Queue {id}".
// Full reference: https://static.developer.riotgames.com/docs/lol/queues.json
const QUEUE_NAMES = {
  400: 'Normal Draft',
  420: 'Ranked Solo/Duo',
  430: 'Normal Blind',
  440: 'Ranked Flex',
  450: 'ARAM',
  490: 'Quickplay',
  700: 'Clash',
  720: 'ARAM Clash',
  830: 'Co-op vs AI Intro',
  840: 'Co-op vs AI Beginner',
  850: 'Co-op vs AI Intermediate',
  900: 'URF',
  1020: 'One for All',
  1300: 'Nexus Blitz',
  1400: 'Ultimate Spellbook',
  1700: 'Arena',
  1900: 'Pick URF',
};

function queueName(id) {
  return QUEUE_NAMES[id] ?? `Queue ${id ?? '?'}`;
}

// "5m ago", "2h ago", "3d ago". Falls back to a date string for older matches.
function timeAgo(epochMs) {
  if (!epochMs) return 'unknown';
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

// --- Handlers --------------------------------------------------------------

function formatStreak(streak) {
  if (!streak || !streak.type || streak.count === 0) return 'no streak yet';
  const verb = streak.type === 'W' ? 'win' : 'loss';
  return `${streak.count}-${verb} streak`;
}

async function handleTrackAdd(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);
  const mentionUser = interaction.options.getUser('user');

  // Avoid double-tracking before we burn a Riot API call.
  const existing = storage.findByRiotId(gameName, tagLine);
  if (existing) {
    await interaction.editReply(`Already tracking **${gameName}#${tagLine}**.`);
    return;
  }

  let account;
  try {
    account = await riot.getAccountByRiotId(gameName, tagLine);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      await interaction.editReply(`Couldn't find Riot ID **${gameName}#${tagLine}**.`);
      return;
    }
    throw err;
  }

  // Add the player with no lastProcessedMatchId yet — backfill handles that.
  await storage.addPlayer({
    puuid: account.puuid,
    riotId: { gameName: account.gameName, tagLine: account.tagLine },
    lastProcessedMatchId: null,
    discordUserId: mentionUser?.id ?? null,
  });

  // Backfill today's ranked matches silently (no notifications), then set
  // lastProcessedMatchId to the current latest so the poller starts fresh.
  let backfilledCount = 0;
  try {
    backfilledCount = await backfillTodayMatches(account.puuid);
  } catch (err) {
    logger.warn(`Backfill failed for ${account.puuid}: ${err.message}`);
  }

  const linkNote = mentionUser ? ` — losses will ping <@${mentionUser.id}>` : '';
  const backfillNote =
    backfilledCount > 0
      ? ` Caught up ${backfilledCount} game(s) from today.`
      : '';
  await interaction.editReply(
    `Now tracking **${account.gameName}#${account.tagLine}**${linkNote}.${backfillNote} Lose a game to test 👀`,
  );
}

async function handleTrackRemove(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);
  const player = storage.findByRiotId(gameName, tagLine);
  if (!player) {
    await interaction.editReply(`Not tracking **${gameName}#${tagLine}**.`);
    return;
  }
  await storage.removePlayer(player.puuid);
  await interaction.editReply(`Stopped tracking **${gameName}#${tagLine}**.`);
}

async function handleTrackList(interaction) {
  const players = storage.getPlayers();
  if (players.length === 0) {
    await interaction.editReply('No players tracked yet. Try `/track add`.');
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('Tracked players')
    .setColor(0x5865f2)
    .setDescription(
      players
        .map((p) => {
          const id = `**${p.riotId.gameName}#${p.riotId.tagLine}**`;
          const record = `${p.wins}W – ${p.losses}L`;
          const link = p.discordUserId ? ` → <@${p.discordUserId}>` : '';
          return `${id}${link} • ${record} • ${formatStreak(p.streak)}`;
        })
        .join('\n'),
    );
  // allowedMentions.parse: [] prevents the embed's <@id> from pinging linked
  // users every time someone runs /track list.
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleHistory(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);
  const count = interaction.options.getInteger('count') ?? 5;

  // 1. Resolve Riot ID -> PUUID. Works for *any* Riot ID, not just tracked
  //    players — this command exists specifically to sanity-check that the
  //    Riot API key is live and the region is correct.
  let account;
  try {
    account = await riot.getAccountByRiotId(gameName, tagLine);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      await interaction.editReply(`Couldn't find Riot ID **${gameName}#${tagLine}**.`);
      return;
    }
    throw err;
  }

  // 2. Fetch the N most recent match IDs.
  const ids = await riot.getRecentMatchIds(account.puuid, count);
  if (ids.length === 0) {
    await interaction.editReply(
      `No matches found for **${account.gameName}#${account.tagLine}** in this region.`,
    );
    return;
  }

  // 3. Sequentially pull match details with a small delay between calls to
  //    stay polite under the Riot rate limit (20 req/sec).
  const summaries = [];
  for (const id of ids) {
    try {
      const match = await riot.getMatch(id);
      const summary = riot.extractMatchSummary(match, account.puuid);
      if (summary) summaries.push(summary);
    } catch (err) {
      logger.warn(`Failed to fetch match ${id}: ${err.message}`);
    }
    // Small pause to avoid bursting against Riot's per-second limit.
    await new Promise((r) => setTimeout(r, 150));
  }

  if (summaries.length === 0) {
    await interaction.editReply(
      `Found ${ids.length} match ID(s) but couldn't fetch any details. Riot API might be flaky right now.`,
    );
    return;
  }

  const lines = summaries.map((s) => {
    const result = s.remake ? '🔁 Remake' : s.won ? '✅ W' : '❌ L';
    const kda = `${s.kills}/${s.deaths}/${s.assists}`;
    const ratio = ((s.kills + s.assists) / Math.max(s.deaths, 1)).toFixed(2);
    const dur = s.gameDuration ? `${Math.floor(s.gameDuration / 60)}m` : '';
    return `${result} • **${s.championName}** • ${kda} (${ratio} KDA) • ${queueName(s.queueId)} • ${dur} • ${timeAgo(s.gameStartTimestamp)}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Recent matches — ${account.gameName}#${account.tagLine}`)
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${summaries.length} match(es) • Riot API OK ✓` });

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCurse(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);

  const target = storage.findByRiotId(gameName, tagLine);
  if (!target) {
    await interaction.editReply(
      `Not tracking **${gameName}#${tagLine}** — add them with \`/track add\` first.`,
    );
    return;
  }

  const curserDiscordId = interaction.user.id;
  const existing = target.cursers ?? [];

  if (existing.some((c) => c.curserDiscordId === curserDiscordId)) {
    await interaction.editReply(
      `You've already cursed **${target.riotId.gameName}#${target.riotId.tagLine}**. They need to win a ranked game to break it.`,
    );
    return;
  }

  // Lock the payout odds at curse time, Twitch-Predictions style. The target
  // can go on a heater later — your multiplier stays at what it was when you
  // committed.
  const recentResults = target.recentResults ?? [];
  const payoutMultiplier = computePayoutMultiplier(recentResults);
  const wins = recentResults.filter((r) => r === 'W').length;
  const recentWinRate = recentResults.length > 0 ? wins / recentResults.length : null;

  const next = [
    ...existing,
    {
      curserDiscordId,
      curserDisplayName: interaction.user.username,
      cursedAt: new Date().toISOString(),
      payoutMultiplier,
      recentWinRate,
      lossesAccrued: 0,
    },
  ];
  await storage.updatePlayer(target.puuid, { cursers: next });

  const targetMention = target.discordUserId
    ? `<@${target.discordUserId}>`
    : `**${target.riotId.gameName}**`;
  const curserMention = `<@${curserDiscordId}>`;
  const targetMentionIds = target.discordUserId ? [target.discordUserId] : [];

  try {
    const channel = await interaction.client.channels.fetch(config.discord.channelId);
    await channel.send({
      content: buildCurseAppliedMessage(targetMention, curserMention, next.length, {
        recentResults,
        payoutMultiplier,
      }),
      allowedMentions:
        targetMentionIds.length > 0 ? { users: targetMentionIds } : { parse: [] },
    });
  } catch (err) {
    logger.error(`Failed to post curse-applied message: ${err.message}`);
  }

  await interaction.editReply(
    `Curse applied to **${target.riotId.gameName}#${target.riotId.tagLine}** at ${payoutMultiplier.toFixed(1)}x payout — now cursed by ${next.length} player(s). 🪦`,
  );
}

async function handleUncurse(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);

  const target = storage.findByRiotId(gameName, tagLine);
  if (!target) {
    await interaction.editReply(`Not tracking **${gameName}#${tagLine}**.`);
    return;
  }

  const userId = interaction.user.id;
  const existing = target.cursers ?? [];
  const filtered = existing.filter((c) => c.curserDiscordId !== userId);

  if (filtered.length === existing.length) {
    await interaction.editReply(
      `You haven't cursed **${target.riotId.gameName}#${target.riotId.tagLine}**.`,
    );
    return;
  }

  await storage.updatePlayer(target.puuid, { cursers: filtered });

  if (filtered.length === 0) {
    await interaction.editReply(
      `Your curse on **${target.riotId.gameName}#${target.riotId.tagLine}** is lifted — they're no longer cursed.`,
    );
  } else {
    await interaction.editReply(
      `Your curse on **${target.riotId.gameName}#${target.riotId.tagLine}** is lifted. Still cursed by ${filtered.length} other player(s).`,
    );
  }
}

async function handleSoulsBalance(interaction) {
  const gameName = interaction.options.getString('gamename');
  const tagLine = interaction.options.getString('tagline');

  if ((gameName && !tagLine) || (!gameName && tagLine)) {
    await interaction.editReply(
      'Provide both `gamename` and `tagline` to look up another player, or neither to see your own balance.',
    );
    return;
  }

  let targetUserId;
  let label;

  if (gameName && tagLine) {
    const target = storage.findByRiotId(gameName, tagLine);
    if (!target) {
      await interaction.editReply(`Not tracking **${gameName}#${tagLine}**.`);
      return;
    }
    if (!target.discordUserId) {
      await interaction.editReply(
        `**${target.riotId.gameName}#${target.riotId.tagLine}** isn't linked to a Discord user — they can't hold souls.`,
      );
      return;
    }
    targetUserId = target.discordUserId;
    label = `<@${targetUserId}>`;
  } else {
    targetUserId = interaction.user.id;
    label = 'You';
  }

  const souls = storage.getSouls(targetUserId);
  await interaction.editReply({
    content: `${label} have **${souls.balance.toLocaleString()}** Tilted Souls 🪦 (lifetime: ${souls.totalEarned.toLocaleString()}).`,
    allowedMentions: { parse: [] },
  });
}

async function handleSoulsLeaderboard(interaction) {
  const top = storage.getSoulsLeaderboard(10);
  if (top.length === 0) {
    await interaction.editReply('Nobody has earned souls yet. Cast the first curse with `/curse`.');
    return;
  }

  const lines = top.map((entry, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} <@${entry.discordUserId}> — **${entry.balance.toLocaleString()}** souls (lifetime: ${entry.totalEarned.toLocaleString()})`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🪦 Tilted Souls Leaderboard')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n'));

  // Post publicly to the configured tilt channel so the whole group sees it,
  // then ephemeral-ack the invoker. Same pattern as /curse.
  try {
    const channel = await interaction.client.channels.fetch(config.discord.channelId);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.error(`Failed to post souls leaderboard: ${err.message}`);
    await interaction.editReply('Failed to post the leaderboard to the channel.');
    return;
  }
  await interaction.editReply('Leaderboard posted. 🪦');
}

async function handleSouls(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'balance') return handleSoulsBalance(interaction);
  if (sub === 'leaderboard') return handleSoulsLeaderboard(interaction);
  await interaction.editReply(`Unknown /souls subcommand: ${sub}`);
}

async function handleBetStatus(interaction) {
  const bets = storage.getBetsByStatus('open', 'awaiting_resolve');
  if (bets.length === 0) {
    await interaction.editReply(
      'No active prediction pools right now. Bets auto-open when a tracked player enters a ranked game.',
    );
    return;
  }
  const lines = bets.map((b) => {
    const target = b.targetDiscordId ? `<@${b.targetDiscordId}>` : `**${b.displayName}**`;
    const total = (b.pools?.win ?? 0) + (b.pools?.loss ?? 0);
    const tag = b.status === 'open' ? '🎲 open' : '🔒 locked (awaiting result)';
    return `${target} — ${total.toLocaleString()} souls staked — ${tag}`;
  });
  await interaction.editReply({
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
  });
}

async function handleBet(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'status') return handleBetStatus(interaction);
  await interaction.editReply(`Unknown /bet subcommand: ${sub}`);
}

// --- /hatewatch -----------------------------------------------------------

async function handleHatewatchAdd(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);

  const existing = storage.findHatewatchByRiotId(gameName, tagLine);
  if (existing) {
    await interaction.editReply(
      `**${gameName}#${tagLine}** is already on HateWatch (added by <@${existing.addedBy}>).`,
    );
    return;
  }

  let account;
  try {
    account = await riot.getAccountByRiotId(gameName, tagLine);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      await interaction.editReply(`Couldn't find Riot ID **${gameName}#${tagLine}**.`);
      return;
    }
    throw err;
  }

  // Snapshot the current latest match + rank so the poller has a baseline and
  // doesn't fire "loss streak" alerts for matches that happened before they
  // were added to HateWatch.
  let lastProcessedMatchId = null;
  let lastRank = null;
  try {
    const ids = await riot.getRecentMatchIds(account.puuid, 1, { type: 'ranked' });
    if (ids.length) lastProcessedMatchId = ids[0];
  } catch (err) {
    logger.warn(`Failed to bootstrap hatewatch latest match: ${err.message}`);
  }
  try {
    const entries = await riot.getRankedEntries(account.puuid);
    const soloEntry = rank.findEntryForQueue(entries, 420);
    const flexEntry = rank.findEntryForQueue(entries, 440);
    const entry = soloEntry ?? flexEntry;
    if (entry) lastRank = rank.entryToSnapshot(entry);
  } catch (err) {
    logger.warn(`Failed to bootstrap hatewatch rank snapshot: ${err.message}`);
  }

  await storage.addHatewatch({
    puuid: account.puuid,
    riotId: { gameName: account.gameName, tagLine: account.tagLine },
    addedBy: interaction.user.id,
    addedByDisplayName: interaction.user.username,
    lastProcessedMatchId,
    lastRank,
  });

  // Public announcement so the whole server sees who's hating.
  try {
    const channel = await interaction.client.channels.fetch(config.discord.channelId);
    await channel.send({
      content: `🎯 <@${interaction.user.id}> has added **${account.gameName}#${account.tagLine}** to their HateWatch. Hoping for the worst 🪦`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.error(`Failed to post HateWatch add announcement: ${err.message}`);
  }

  await interaction.editReply(
    `Added **${account.gameName}#${account.tagLine}** to HateWatch. The bot will announce demotions and 3+ loss streaks.`,
  );
}

async function handleHatewatchRemove(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);

  const entry = storage.findHatewatchByRiotId(gameName, tagLine);
  if (!entry) {
    await interaction.editReply(`**${gameName}#${tagLine}** isn't on HateWatch.`);
    return;
  }

  const result = await storage.removeHatewatch(entry.puuid, interaction.user.id);
  if (result.ok) {
    await interaction.editReply(`Removed **${gameName}#${tagLine}** from HateWatch.`);
    return;
  }
  if (result.reason === 'not_owner') {
    await interaction.editReply(
      `You can only remove HateWatch entries you added. <@${result.addedBy}> added this one.`,
    );
    return;
  }
  await interaction.editReply(`Couldn't remove — entry not found.`);
}

async function handleHatewatchList(interaction) {
  const entries = storage.getHatewatch();
  if (entries.length === 0) {
    await interaction.editReply('HateWatch is empty. Use `/hatewatch add` to start cooking.');
    return;
  }
  const lines = entries.map((e) => {
    const rankStr = e.lastRank ? ` • ${rank.formatRank(e.lastRank)}` : '';
    return `• **${e.riotId.gameName}#${e.riotId.tagLine}**${rankStr} — added by <@${e.addedBy}>`;
  });
  const embed = new EmbedBuilder()
    .setTitle('HateWatch')
    .setColor(0xa83232)
    .setDescription(lines.join('\n'));
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleHatewatch(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleHatewatchAdd(interaction);
  if (sub === 'remove') return handleHatewatchRemove(interaction);
  if (sub === 'list') return handleHatewatchList(interaction);
  await interaction.editReply(`Unknown /hatewatch subcommand: ${sub}`);
}

/**
 * Button click on a bet message. customId = `bet:stake:{gameId}:{side}`.
 * Opens a modal asking how many souls to stake.
 */
async function handleBetButton(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('bet:stake:')) return;
  const parts = customId.split(':');
  const gameId = parts[2];
  const side = parts[3];

  const bet = storage.getBetByGameId(gameId);
  if (!bet) {
    await interaction.reply({
      content: 'This prediction no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (bet.status !== 'open') {
    await interaction.reply({
      content: 'Betting is closed on this prediction.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Time-based gate: even if the poller hasn't transitioned status yet, refuse
  // stakes that would land after the 2-minute window. Closes the race window.
  const closeAt = bet.bettingClosesAt ? Date.parse(bet.bettingClosesAt) : null;
  if (Number.isFinite(closeAt) && Date.now() > closeAt) {
    await interaction.reply({
      content: 'Betting window has closed (2 min after game start).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const userSouls = storage.getSouls(interaction.user.id);
  const modal = new ModalBuilder()
    .setCustomId(`bet:modal:${gameId}:${side}`)
    .setTitle(`Bet ${side === 'win' ? 'WIN ✅' : 'LOSS ❌'}`);

  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel(`Souls to stake (balance: ${userSouls.balance.toLocaleString()})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('e.g. 500');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

/**
 * Modal submit for placing a stake. customId = `bet:modal:{gameId}:{side}`.
 * Deducts souls, records the stake, and refreshes the channel message.
 */
async function handleBetModal(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('bet:modal:')) return;
  const parts = customId.split(':');
  const gameId = parts[2];
  const side = parts[3];

  const raw = interaction.fields.getTextInputValue('amount');
  const amount = Number.parseInt(String(raw).replace(/[,_ ]/g, ''), 10);

  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({
      content: `"${raw}" isn't a valid positive number of souls.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bet = storage.getBetByGameId(gameId);
  if (!bet || bet.status !== 'open') {
    await interaction.reply({
      content: 'Betting is closed on this prediction.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const closeAt = bet.bettingClosesAt ? Date.parse(bet.bettingClosesAt) : null;
  if (Number.isFinite(closeAt) && Date.now() > closeAt) {
    await interaction.reply({
      content: 'Betting window has closed (2 min after game start).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const spend = await storage.spendSouls(interaction.user.id, amount);
  if (!spend.ok) {
    await interaction.reply({
      content: `Not enough souls. You have ${spend.balance.toLocaleString()}, you tried to stake ${amount.toLocaleString()}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updated = await storage.addStake(gameId, interaction.user.id, side, amount);

  // Refresh the pool message so everyone sees the new odds.
  if (updated.channelMessageId) {
    try {
      const channel = await interaction.client.channels.fetch(config.discord.channelId);
      const msg = await channel.messages.fetch(updated.channelMessageId);
      await msg.edit({
        content: buildBetPoolMessage(updated),
        components: [buildStakeButtons(gameId)],
      });
    } catch (err) {
      logger.warn(`Failed to refresh bet pool message: ${err.message}`);
    }
  }

  await interaction.reply({
    content: `Staked ${amount.toLocaleString()} on ${side === 'win' ? '✅ WIN' : '❌ LOSS'}. Balance: ${spend.balance.toLocaleString()} souls.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStreak(interaction) {
  const gameName = interaction.options.getString('gamename', true);
  const tagLine = interaction.options.getString('tagline', true);
  const player = storage.findByRiotId(gameName, tagLine);
  if (!player) {
    await interaction.editReply(
      `Not tracking **${gameName}#${tagLine}** — add them with \`/track add\` first.`,
    );
    return;
  }
  await interaction.editReply(
    `**${player.riotId.gameName}#${player.riotId.tagLine}** — ${player.wins}W / ${player.losses}L, currently on a ${formatStreak(player.streak)}.`,
  );
}

async function handleAnalyze5s(interaction) {
  const players = storage.getPlayers();
  const requested = interaction.options.getString('match')?.trim().toUpperCase();

  let found;
  if (requested) {
    try {
      found = await loadSquadMatch(requested, players);
    } catch (err) {
      if (err.response?.status === 404) {
        await interaction.editReply(`Couldn't find match \`${requested}\`.`);
        return;
      }
      throw err;
    }
    if (!found) {
      await interaction.editReply(
        `\`${requested}\` wasn't a squad game (needs 3+ tracked players on one team, and no remake).`,
      );
      return;
    }
  } else {
    found = await findLastSquadMatch(players);
    if (!found) {
      await interaction.editReply(
        'No ranked game with 3+ tracked players on the same team in everyone\'s last 20 ranked games.',
      );
      return;
    }
  }

  const { match, squad } = found;
  let rawTimeline = null;
  try {
    rawTimeline = await riot.getMatchTimeline(match.metadata.matchId);
  } catch (err) {
    logger.warn(`analyze5s: timeline fetch failed for ${match.metadata.matchId}: ${err.message}`);
  }

  const [first, ...rest] = buildSquadAnalysis(match, rawTimeline, squad, logger);
  // Command output is on-demand — show the mentions, don't ping anyone.
  const allowedMentions = { parse: [] };
  await interaction.editReply({ ...first, allowedMentions });
  for (const msg of rest) {
    await interaction.followUp({ ...msg, allowedMentions });
  }
}

/**
 * Top-level dispatcher invoked from bot.js for every Discord interaction.
 * Routes slash commands, button clicks, and modal submits separately because
 * each has a different ack pattern (deferReply vs showModal vs reply).
 */
export async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      // Defer ephemeral so tracked-player chatter doesn't clutter the channel —
      // except /analyze5s, which is meant for the whole squad to see.
      if (interaction.commandName === 'analyze5s') {
        await interaction.deferReply();
        return await handleAnalyze5s(interaction);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (interaction.commandName === 'track') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') return await handleTrackAdd(interaction);
        if (sub === 'remove') return await handleTrackRemove(interaction);
        if (sub === 'list') return await handleTrackList(interaction);
      }
      if (interaction.commandName === 'streak') return await handleStreak(interaction);
      if (interaction.commandName === 'history') return await handleHistory(interaction);
      if (interaction.commandName === 'curse') return await handleCurse(interaction);
      if (interaction.commandName === 'uncurse') return await handleUncurse(interaction);
      if (interaction.commandName === 'souls') return await handleSouls(interaction);
      if (interaction.commandName === 'bet') return await handleBet(interaction);
      if (interaction.commandName === 'hatewatch') return await handleHatewatch(interaction);
      await interaction.editReply(`Unknown command: ${interaction.commandName}`);
      return;
    }

    if (interaction.isButton()) {
      // Button click. showModal/reply are how we ack — do NOT deferReply.
      if (interaction.customId?.startsWith('bet:stake:')) {
        return await handleBetButton(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId?.startsWith('bet:modal:')) {
        return await handleBetModal(interaction);
      }
      return;
    }
  } catch (err) {
    logger.error(`Interaction failed: ${err.stack ?? err.message}`);
    const detail = err.message ?? 'Unknown error';
    // Best-effort error surface that works regardless of ack state.
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Something broke: ${detail}`);
      } else {
        await interaction.reply({ content: `Something broke: ${detail}`, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // give up — already noisy enough
    }
  }
}
