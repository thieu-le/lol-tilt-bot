// Slash command definitions and runtime handlers.
//
// We expose the JSON payloads (`commandData`) so scripts/registerCommands.js
// can register them with Discord, and `handleInteraction()` so bot.js can
// dispatch incoming interactions to the right handler.

import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import * as storage from './storage.js';
import * as riot from './riotService.js';
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

export const commandData = [
  trackCommand.toJSON(),
  streakCommand.toJSON(),
  historyCommand.toJSON(),
];

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

  // Bootstrap with current latest RANKED match so we don't fire on historical
  // games. We only track ranked, so the filter matches the poller's behavior.
  let lastProcessedMatchId = null;
  try {
    const [latest] = await riot.getRecentMatchIds(account.puuid, 1, { type: 'ranked' });
    lastProcessedMatchId = latest ?? null;
  } catch (err) {
    logger.warn(`Could not fetch latest match for bootstrap: ${err.message}`);
  }

  await storage.addPlayer({
    puuid: account.puuid,
    riotId: { gameName: account.gameName, tagLine: account.tagLine },
    lastProcessedMatchId,
    discordUserId: mentionUser?.id ?? null,
  });

  const linkNote = mentionUser ? ` — losses will ping <@${mentionUser.id}>` : '';
  await interaction.editReply(
    `Now tracking **${account.gameName}#${account.tagLine}**${linkNote}. Lose a game to test 👀`,
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
    const result = s.won ? '✅ W' : '❌ L';
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

/**
 * Top-level dispatcher invoked from bot.js for every slash interaction.
 */
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // Defer immediately — we may do network work and the 3s ack window is tight.
  // Use ephemeral so tracked-player chatter doesn't clutter the channel.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (interaction.commandName === 'track') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') return await handleTrackAdd(interaction);
      if (sub === 'remove') return await handleTrackRemove(interaction);
      if (sub === 'list') return await handleTrackList(interaction);
    }
    if (interaction.commandName === 'streak') {
      return await handleStreak(interaction);
    }
    if (interaction.commandName === 'history') {
      return await handleHistory(interaction);
    }
    await interaction.editReply(`Unknown command: ${interaction.commandName}`);
  } catch (err) {
    logger.error(`Slash command failed: ${err.stack ?? err.message}`);
    const detail = err.message ?? 'Unknown error';
    // editReply works whether we deferred or replied — safer than reply().
    await interaction.editReply(`Something broke: ${detail}`).catch(() => {});
  }
}
