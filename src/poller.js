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
import { nextStreak, nextToday } from './rank.js';
import {
  pickTiltMessage,
  pickDemotionMessage,
  pickPromotionMessage,
  pickWinStreakMessage,
} from './messages.js';
import { logger } from './logger.js';
import { config } from './config.js';

const PER_PLAYER_DELAY_MS = 250;

let intervalHandle = null;
let running = false; // re-entrancy guard for overlapping ticks

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// How many recent match IDs to fetch per tick. 20 covers any realistic offline
// gap (most players don't play 20 ranked games between bot restarts).
const GAP_FETCH_COUNT = 20;

/**
 * Process a single match for a player: update stats and optionally notify.
 * `player` must be the freshly-read record from storage before this call.
 */
async function processMatch(player, matchId, channel, { silent = false } = {}) {
  const match = await riot.getMatch(matchId);
  const summary = riot.extractMatchSummary(match, player.puuid);
  if (!summary) {
    logger.warn(
      `Match ${matchId} did not contain participant ${player.puuid} — skipping notification`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: matchId });
    return;
  }

  const { won, kills, deaths, queueId, gameEndTimestamp, gameStartTimestamp } = summary;

  if (!rank.isRankedQueue(queueId)) {
    logger.debug(
      `Match ${matchId} for ${player.riotId.gameName}#${player.riotId.tagLine} was non-ranked (queue ${queueId}) — skipping`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: matchId });
    return;
  }

  // Stale-match guard: matches from previous UTC days update no counters and
  // send no notifications. Prevents old games from warping today's record when
  // the bot was offline overnight.
  const matchDate = rank.dateKeyForTimestamp(gameEndTimestamp ?? gameStartTimestamp);
  const todayKey = rank.utcDateKey();
  if (matchDate && matchDate !== todayKey) {
    logger.info(
      `Match ${matchId} for ${player.riotId.gameName}#${player.riotId.tagLine} ended ${matchDate} (not today ${todayKey}) — historical, no notification`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: matchId });
    return;
  }

  const newStreak = nextStreak(player.streak, won);
  const newToday = nextToday(player.today, won);

  let lpDeltaStr = null;
  let rankLabel = null;
  let newLastRank = player.lastRank ?? null;
  let rankChange = null;
  try {
    const entries = await riot.getRankedEntries(player.puuid);
    const entry = rank.findEntryForQueue(entries, queueId);
    if (entry) {
      const snapshot = rank.entryToSnapshot(entry);
      rankChange = rank.getRankChange(player.lastRank, snapshot);
      if (player.lastRank && player.lastRank.queueType === snapshot.queueType) {
        const lpDeltaNum = rank.computeLpDelta(player.lastRank, snapshot);
        lpDeltaStr = rank.formatLpDelta(lpDeltaNum);
        if (lpDeltaNum !== null) newToday.lpDelta = (newToday.lpDelta ?? 0) + lpDeltaNum;
      }
      rankLabel = rank.formatRank(snapshot);
      newLastRank = snapshot;
    }
  } catch (err) {
    logger.warn(`Failed to fetch ranked entries for ${player.puuid}: ${err.message}`);
  }

  await storage.updatePlayer(player.puuid, {
    lastProcessedMatchId: matchId,
    streak: newStreak,
    today: newToday,
    lastRank: newLastRank,
    wins: player.wins + (won ? 1 : 0),
    losses: player.losses + (won ? 0 : 1),
  });

  logger.info(
    `Match ${matchId} for ${player.riotId.gameName}#${player.riotId.tagLine}: ${
      won ? 'WIN' : 'LOSS'
    } ${kills}/${deaths} q${queueId} (streak ${newStreak.type}${newStreak.count}, today ${newToday.wins}-${newToday.losses}, lp ${lpDeltaStr ?? 'n/a'}${rankChange ? ` [${rankChange}]` : ''})`,
  );

  const displayToken = player.discordUserId
    ? `<@${player.discordUserId}>`
    : `**${player.riotId.gameName}**`;
  const allowedMentions = player.discordUserId
    ? { users: [player.discordUserId] }
    : { parse: [] };
  const detailOpts = { lpDelta: lpDeltaStr, today: newToday, rankLabel };

  let text = null;

  if (!won) {
    const kd = kills / Math.max(deaths, 1);
    if (rankChange === 'demoted') {
      text = pickDemotionMessage(displayToken, detailOpts);
    } else {
      text = pickTiltMessage(displayToken, newStreak, {
        ...detailOpts,
        positiveKd: kd >= 1.0,
      });
    }
  } else {
    if (rankChange === 'promoted') {
      text = pickPromotionMessage(displayToken, detailOpts);
    } else if (newStreak.type === 'W' && newStreak.count >= 4) {
      text = pickWinStreakMessage(displayToken, newStreak, detailOpts);
    }
  }

  if (text && !silent) {
    try {
      await channel.send({ content: text, allowedMentions });
    } catch (err) {
      logger.error(`Failed to post message: ${err.message}`);
    }
  }
}

async function processPlayer(player, channel, { startup = false } = {}) {
  // Fetch enough IDs to cover any realistic offline gap. This is still one
  // HTTP call — the payload is just larger than count=1.
  const ids = await riot.getRecentMatchIds(player.puuid, GAP_FETCH_COUNT, { type: 'ranked' });

  if (!ids.length) {
    logger.debug(`No ranked matches yet for ${player.riotId.gameName}#${player.riotId.tagLine}`);
    return null;
  }

  // First-time bootstrap — record the latest without notifying.
  if (player.lastProcessedMatchId === null) {
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: ids[0] });
    logger.info(
      `Bootstrapped ${player.riotId.gameName}#${player.riotId.tagLine} at match ${ids[0]}`,
    );
    return null;
  }

  // Collect every ID that arrived after the last one we processed.
  // ids is newest-first; we stop the moment we hit the known ID.
  const newIds = [];
  for (const id of ids) {
    if (id === player.lastProcessedMatchId) break;
    newIds.push(id);
  }

  if (!newIds.length) return null;

  // Process oldest-first so streak/today/W-L accumulate in the right order.
  newIds.reverse();

  if (newIds.length > 1) {
    logger.info(
      `${player.riotId.gameName}#${player.riotId.tagLine}: catching up ${newIds.length} missed match(es)`,
    );
  }

  // Capture rank snapshot BEFORE processing so we can compute net LP delta for
  // the startup report (pre vs post across all missed games).
  const preRank = player.lastRank ?? null;

  for (const matchId of newIds) {
    // Re-read player state before each match so streak/today/rank are current.
    const current = storage.findByPuuid(player.puuid);
    await processMatch(current, matchId, channel, { silent: startup });
  }

  if (!startup) return null;

  // Build the per-player summary for the startup report.
  const post = storage.findByPuuid(player.puuid);

  // Only include in the report if at least one game was processed for today.
  const todayKey = rank.utcDateKey();
  if (post.today?.date !== todayKey) return null;

  const rankLabel = post.lastRank ? rank.formatRank(post.lastRank) : null;
  const netLpDelta = rank.computeLpDelta(preRank, post.lastRank);
  const lpDeltaStr = rank.formatLpDelta(netLpDelta);

  return {
    riotId: post.riotId,
    discordUserId: post.discordUserId,
    today: post.today,
    rankLabel,
    lpDeltaStr,
  };
}

async function postStartupReport(channel, summaries) {
  const lines = summaries.map((s) => {
    const token = s.discordUserId ? `<@${s.discordUserId}>` : `**${s.riotId.gameName}**`;
    const record = `${s.today?.wins ?? 0}-${s.today?.losses ?? 0}`;
    const parts = [record];
    if (s.lpDeltaStr) parts.push(s.lpDeltaStr);
    if (s.rankLabel) parts.push(s.rankLabel);
    return `${token} ${parts.join(' • ')}`;
  });

  const mentionedIds = summaries
    .filter((s) => s.discordUserId)
    .map((s) => s.discordUserId);

  try {
    await channel.send({
      content: `It is a good day for Tilt!\nDaily Reports for Tiltwatch:\n${lines.join('\n')}`,
      allowedMentions: mentionedIds.length > 0 ? { users: mentionedIds } : { parse: [] },
    });
  } catch (err) {
    logger.error(`Failed to post startup report: ${err.message}`);
  }
}

async function postEndOfDayReport(channel) {
  const players = storage.getPlayers();
  const todayKey = rank.utcDateKey();

  // If nobody played ranked today at all, stay silent.
  const playedToday = players.filter((p) => p.today?.date === todayKey);
  if (!playedToday.length) return;

  // Only losers go on the leaderboard.
  const entries = playedToday
    .map((p) => ({
      riotId: p.riotId,
      discordUserId: p.discordUserId,
      lpDelta: p.today.lpDelta ?? 0,
    }))
    .filter((e) => e.lpDelta < 0)
    .sort((a, b) => a.lpDelta - b.lpDelta); // most LP lost first

  // Players played but nobody lost LP — acknowledge the rare good day.
  if (!entries.length) {
    try {
      await channel.send({
        content: 'No tilt today 🙏 the Tilt Gods are unsatisfied.',
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post no-tilt report: ${err.message}`);
    }
    return;
  }

  // Total LP surrendered to the Tilt Gods (all entries are negative now).
  const totalSacrificed = Math.abs(
    entries.reduce((sum, e) => sum + e.lpDelta, 0),
  );

  const lines = entries.map((e, i) => {
    const token = e.discordUserId ? `<@${e.discordUserId}>` : `**${e.riotId.gameName}**`;
    const lpStr = rank.formatLpDelta(e.lpDelta) ?? '+0 LP';
    return `${i + 1}. ${token} ${lpStr}`;
  });

  const mentionedIds = entries.filter((e) => e.discordUserId).map((e) => e.discordUserId);

  try {
    await channel.send({
      content: `Thus ends another day of tilt. ${totalSacrificed} LP has been sacrificed to the Tilt Gods.\nTilt Patreon Leaderboard:\n${lines.join('\n')}`,
      allowedMentions: mentionedIds.length > 0 ? { users: mentionedIds } : { parse: [] },
    });
  } catch (err) {
    logger.error(`Failed to post end-of-day report: ${err.message}`);
  }
}

function scheduleEndOfDayReport(channel) {
  const now = Date.now();
  // Next UTC midnight, minus 1 minute → 23:59 UTC.
  const d = new Date();
  const nextMidnightUTC = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
  );
  // If we're already inside the 23:59 minute (or rescheduling right after
  // firing), nextMidnightUTC - 60_000 resolves to a moment <= now and the
  // setTimeout would fire immediately, looping for ~60s. Push forward 24h.
  let triggerAt = nextMidnightUTC - 60_000;
  if (triggerAt <= now) triggerAt += 24 * 60 * 60 * 1000;
  const delay = triggerAt - now;

  setTimeout(async () => {
    await postEndOfDayReport(channel);
    scheduleEndOfDayReport(channel); // reschedule for the next day
  }, delay);

  const fireTime = new Date(triggerAt).toISOString();
  logger.info(`End-of-day report scheduled for ${fireTime}`);
}

async function tick(channel, { startup = false } = {}) {
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

    const startupSummaries = [];
    for (const player of players) {
      try {
        const result = await processPlayer(player, channel, { startup });
        if (startup && result) startupSummaries.push(result);
      } catch (err) {
        logger.error(
          `Error polling ${player.riotId.gameName}#${player.riotId.tagLine}: ${err.message}`,
        );
      }
      await sleep(PER_PLAYER_DELAY_MS);
    }

    if (startup && startupSummaries.length > 0) {
      await postStartupReport(channel, startupSummaries);
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
  tick(channel, { startup: true });
  intervalHandle = setInterval(() => tick(channel), config.pollIntervalMs);
  scheduleEndOfDayReport(channel);
}

export function stopPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Poller stopped');
  }
}
