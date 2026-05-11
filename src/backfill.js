// Backfill today's ranked matches when a player is first added to tracking.
// Called once from /track add. Processes any ranked games that finished today
// (UTC) before the bot started watching, updating streak/wins/losses/rank in
// storage without sending any Discord notifications.

import * as storage from './storage.js';
import * as riot from './riotService.js';
import * as rank from './rank.js';
import { nextStreak, nextToday } from './rank.js';
import { logger } from './logger.js';

// Fetch up to this many recent ranked IDs. Most players play <15 ranked games/day.
const MAX_BACKFILL_MATCHES = 20;

export async function backfillTodayMatches(puuid) {
  const player = storage.findByPuuid(puuid);
  if (!player) return 0;

  const todayKey = rank.utcDateKey();

  const ids = await riot.getRecentMatchIds(puuid, MAX_BACKFILL_MATCHES, { type: 'ranked' });
  if (!ids.length) return 0;

  // Always record the latest ID so the poller doesn't re-notify on the next tick.
  const latestId = ids[0];

  // Walk newest→oldest; stop the moment we leave today.
  // Matches are returned newest-first by Riot, so the first non-today match
  // means everything after it is also outside today.
  const todayMatches = [];
  for (const id of ids) {
    const match = await riot.getMatch(id);
    const summary = riot.extractMatchSummary(match, puuid);
    if (!summary) continue;

    const { gameEndTimestamp, gameStartTimestamp } = summary;
    const matchDate = rank.dateKeyForTimestamp(gameEndTimestamp ?? gameStartTimestamp);

    if (matchDate !== todayKey) break;
    todayMatches.push(summary);
  }

  // Reverse to chronological order so streak/today accumulate correctly.
  todayMatches.reverse();

  let { streak, today, wins, losses, lastRank } = player;

  for (const summary of todayMatches) {
    const { won } = summary;
    streak = nextStreak(streak, won);
    today = nextToday(today, won);
    wins += won ? 1 : 0;
    losses += won ? 0 : 1;
  }

  // Snapshot current rank from the most recent today-match queue (one API call).
  const mostRecent = todayMatches[todayMatches.length - 1];
  if (mostRecent && rank.isRankedQueue(mostRecent.queueId)) {
    try {
      const entries = await riot.getRankedEntries(puuid);
      const entry = rank.findEntryForQueue(entries, mostRecent.queueId);
      if (entry) lastRank = rank.entryToSnapshot(entry);
    } catch (err) {
      logger.warn(`Backfill: failed to fetch rank for ${puuid}: ${err.message}`);
    }
  }

  await storage.updatePlayer(puuid, {
    lastProcessedMatchId: latestId,
    streak,
    today,
    wins,
    losses,
    lastRank,
  });

  logger.info(
    `Backfilled ${todayMatches.length} today match(es) for ${player.riotId.gameName}#${player.riotId.tagLine} (lastMatch=${latestId})`,
  );
  return todayMatches.length;
}
