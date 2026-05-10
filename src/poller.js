// Polling loop: every POLL_INTERVAL_MS, walk every tracked player, see if their
// most recent match ID changed since we last looked, and if so figure out
// whether they won or lost. On a loss, post a tilt message to the configured
// channel. Update streak / win-loss counters on every finished match.
//
// Design notes:
//   - We iterate sequentially with a small delay between players. Bursting all
//     calls in parallel would lean on Riot's per-second rate limit.
//   - Errors in one player's tick never kill the loop — we log and move on.
//   - Bootstrap (first time we see a player) records their current latest
//     match ID without sending any message. That prevents notification spam
//     for matches that happened before they were added.

import * as storage from './storage.js';
import * as riot from './riotService.js';
import * as rank from './rank.js';
import { pickTiltMessage } from './messages.js';
import { logger } from './logger.js';
import { config } from './config.js';

const PER_PLAYER_DELAY_MS = 250;

let intervalHandle = null;
let running = false; // re-entrancy guard for overlapping ticks

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the new streak after observing a match outcome.
 *
 * @param {{ type: 'W'|'L'|null, count: number }} prev
 * @param {boolean} won
 */
function nextStreak(prev, won) {
  const type = won ? 'W' : 'L';
  if (prev?.type === type) return { type, count: prev.count + 1 };
  return { type, count: 1 };
}

/**
 * Compute today's record after one match, resetting on UTC date change.
 * Returns the new {date, wins, losses} object to persist.
 */
function nextToday(prev, won) {
  const today = rank.utcDateKey();
  const base = prev?.date === today ? prev : { date: today, wins: 0, losses: 0 };
  return {
    date: today,
    wins: base.wins + (won ? 1 : 0),
    losses: base.losses + (won ? 0 : 1),
  };
}

async function processPlayer(player, channel) {
  // 1. Cheapest call first: latest RANKED match ID only. Filtering server-side
  //    means ARAMs and normals never enter the pipeline.
  const [latestId] = await riot.getRecentMatchIds(player.puuid, 1, { type: 'ranked' });

  if (!latestId) {
    logger.debug(`No ranked matches yet for ${player.riotId.gameName}#${player.riotId.tagLine}`);
    return;
  }

  // 2. First-time bootstrap — record the current latest WITHOUT notifying. The
  //    bot only ever talks about matches that finish after a player was added.
  if (player.lastProcessedMatchId === null) {
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: latestId });
    logger.info(
      `Bootstrapped ${player.riotId.gameName}#${player.riotId.tagLine} at match ${latestId}`,
    );
    return;
  }

  // 3. Nothing new since last tick.
  if (latestId === player.lastProcessedMatchId) return;

  // 4. New match. Fetch details and decide W/L + K/D/A.
  const match = await riot.getMatch(latestId);
  const summary = riot.extractMatchSummary(match, player.puuid);
  if (!summary) {
    // Defensive: shouldn't happen, but don't lose data if Riot returns an odd
    // shape — record the match ID so we don't reprocess it forever.
    logger.warn(
      `Match ${latestId} did not contain participant ${player.puuid} — skipping notification`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: latestId });
    return;
  }

  const { won, kills, deaths, queueId, gameEndTimestamp, gameStartTimestamp } = summary;

  // Safety net: even with the API-level type=ranked filter, refuse to process
  // anything that isn't queue 420 or 440. Keeps non-ranked games entirely out
  // of streak/today/W-L counters.
  if (!rank.isRankedQueue(queueId)) {
    logger.debug(
      `Match ${latestId} for ${player.riotId.gameName}#${player.riotId.tagLine} was non-ranked (queue ${queueId}) — skipping`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: latestId });
    return;
  }

  // Stale-match guard: if the match's UTC date predates today, treat it as
  // history we just hadn't ingested yet — no notification, no counter changes,
  // just record the ID so we don't reprocess it forever. Prevents yesterday's
  // game from showing up as "today's loss" after a restart or first deploy.
  const matchDate = rank.dateKeyForTimestamp(gameEndTimestamp ?? gameStartTimestamp);
  const todayKey = rank.utcDateKey();
  if (matchDate && matchDate !== todayKey) {
    logger.info(
      `Match ${latestId} for ${player.riotId.gameName}#${player.riotId.tagLine} ended ${matchDate} (not today ${todayKey}) — recording as historical, no notification`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: latestId });
    return;
  }

  const newStreak = nextStreak(player.streak, won);
  const newToday = nextToday(player.today, won);

  // 5. For ranked matches, fetch the current league entry, diff against the
  //    previous snapshot to compute LP delta, and persist the new snapshot.
  //    Skipped entirely for non-ranked queues to avoid wasting API calls.
  let lpDeltaStr = null;
  let rankLabel = null;
  let newLastRank = player.lastRank ?? null;
  if (rank.isRankedQueue(queueId)) {
    try {
      const entries = await riot.getRankedEntries(player.puuid);
      const entry = rank.findEntryForQueue(entries, queueId);
      if (entry) {
        const snapshot = rank.entryToSnapshot(entry);
        // Only compute a delta when we have a prior snapshot of the SAME queue.
        // Otherwise this is just the first time we see this queue for them.
        if (player.lastRank && player.lastRank.queueType === snapshot.queueType) {
          lpDeltaStr = rank.formatLpDelta(rank.computeLpDelta(player.lastRank, snapshot));
        }
        rankLabel = rank.formatRank(snapshot);
        newLastRank = snapshot;
      }
    } catch (err) {
      logger.warn(`Failed to fetch ranked entries for ${player.puuid}: ${err.message}`);
    }
  } else if (player.lastRank) {
    // Non-ranked match — still display the previously-known rank for context.
    rankLabel = rank.formatRank(player.lastRank);
  }

  await storage.updatePlayer(player.puuid, {
    lastProcessedMatchId: latestId,
    streak: newStreak,
    today: newToday,
    lastRank: newLastRank,
    wins: player.wins + (won ? 1 : 0),
    losses: player.losses + (won ? 0 : 1),
  });

  logger.info(
    `Match ${latestId} for ${player.riotId.gameName}#${player.riotId.tagLine}: ${
      won ? 'WIN' : 'LOSS'
    } ${kills}/${deaths} q${queueId} (streak ${newStreak.type}${newStreak.count}, today ${newToday.wins}-${newToday.losses}, lp ${lpDeltaStr ?? 'n/a'})`,
  );

  // 6. Only losses get a Discord ping.
  if (!won) {
    // KD ratio (assists deliberately excluded). Positive KD on a loss means
    // they got more kills than deaths individually — earns the Drew Levin curse.
    const kd = kills / Math.max(deaths, 1);
    const positiveKd = kd >= 1.0;

    // If the player is linked to a Discord user, use a real mention so they
    // actually get notified. Otherwise fall back to a bolded Riot name.
    const displayToken = player.discordUserId
      ? `<@${player.discordUserId}>`
      : `**${player.riotId.gameName}**`;
    const text = pickTiltMessage(displayToken, newStreak, {
      positiveKd,
      lpDelta: lpDeltaStr,
      today: newToday,
      rankLabel,
    });
    try {
      await channel.send({
        content: text,
        // Whitelist only the linked user — never expand @everyone / @here
        // even if a future message template happens to include them.
        allowedMentions: player.discordUserId
          ? { users: [player.discordUserId] }
          : { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post tilt message: ${err.message}`);
    }
  }
}

async function tick(channel) {
  if (running) {
    logger.debug('Skipping tick — previous tick still running');
    return;
  }
  running = true;
  try {
    const players = storage.getPlayers();
    if (players.length === 0) {
      logger.debug('No tracked players this tick');
      return;
    }
    logger.debug(`Polling ${players.length} player(s)`);
    for (const player of players) {
      try {
        await processPlayer(player, channel);
      } catch (err) {
        logger.error(
          `Error polling ${player.riotId.gameName}#${player.riotId.tagLine}: ${err.message}`,
        );
      }
      await sleep(PER_PLAYER_DELAY_MS);
    }
  } finally {
    running = false;
  }
}

/**
 * Start the polling loop. Runs an immediate tick, then on an interval.
 *
 * @param {{ client: import('discord.js').Client }} args
 */
export async function startPoller({ client }) {
  if (intervalHandle) {
    logger.warn('Poller already running');
    return;
  }
  const channel = await client.channels.fetch(config.discord.channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(
      `DISCORD_CHANNEL_ID ${config.discord.channelId} did not resolve to a text channel`,
    );
  }
  logger.info(`Poller started (interval ${config.pollIntervalMs}ms)`);
  // Fire-and-forget the first tick so startup logs aren't blocked by a slow
  // Riot response.
  tick(channel);
  intervalHandle = setInterval(() => tick(channel), config.pollIntervalMs);
}

export function stopPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Poller stopped');
  }
}
