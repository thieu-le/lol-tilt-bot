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
  computeTiltMeter,
  buildCurseBrokenMessage,
  buildCurseLossMessage,
  computeFraudScore,
  buildFraudWatchMessage,
  buildBetPoolMessage,
  buildBetResolvedMessage,
  buildBetRefundedMessage,
  computeBetPayouts,
} from './messages.js';
import { buildStakeButtons } from './commands.js';
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

  const {
    won,
    kills,
    deaths,
    assists,
    queueId,
    gameEndTimestamp,
    gameStartTimestamp,
    damageShare,
    killParticipation,
    turretDamageShare,
  } = summary;

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
  const matchDate = rank.dateKeyForTimestamp(gameEndTimestamp ?? gameStartTimestamp, config.timezone);
  const todayKey = rank.dateKey(config.timezone);
  if (matchDate && matchDate !== todayKey) {
    logger.info(
      `Match ${matchId} for ${player.riotId.gameName}#${player.riotId.tagLine} ended ${matchDate} (not today ${todayKey}) — historical, no notification`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: matchId });
    return;
  }

  const newStreak = nextStreak(player.streak, won);
  const newToday = nextToday(player.today, won, config.timezone);

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

  // Rolling 20-match outcome window powers the souls payout multiplier.
  // Trimmed by slice(-20) so it never grows past the cap.
  const newRecentResults = [...(player.recentResults ?? []), won ? 'W' : 'L'].slice(-20);

  await storage.updatePlayer(player.puuid, {
    lastProcessedMatchId: matchId,
    streak: newStreak,
    today: newToday,
    lastRank: newLastRank,
    wins: player.wins + (won ? 1 : 0),
    losses: player.losses + (won ? 0 : 1),
    recentResults: newRecentResults,
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
  const tiltMeter = computeTiltMeter({ kills, deaths, assists, damageShare, won });
  const detailOpts = {
    lpDelta: lpDeltaStr,
    today: newToday,
    rankLabel,
    tiltMeter,
    kills,
    deaths,
    assists,
    damageShare,
  };

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

  // Fraud Watch — independent of the standard win message. Only fires when a
  // win is statistically suspicious (low damage share, low KP, bad KDA, etc.).
  if (!silent && won) {
    const fraudScore = computeFraudScore({
      won,
      kills,
      deaths,
      assists,
      damageShare,
      killParticipation,
      turretDamageShare,
    });
    if (Number.isFinite(fraudScore) && fraudScore >= 50) {
      try {
        await channel.send({
          content: buildFraudWatchMessage(displayToken, fraudScore, summary),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        logger.error(`Failed to post fraud watch message: ${err.message}`);
      }
    }
  }

  // Curse broadcast — independent of tilt/promotion messages. Cursers ping the
  // target only (not each other). A win shatters every active curse on this
  // player. A loss awards souls per curser (base 100 × 2^lossesAccrued ×
  // payoutMultiplier) and increments each curser's lossesAccrued counter.
  const cursers = player.cursers ?? [];
  if (cursers.length > 0 && !silent) {
    let curseText;

    if (won) {
      const curserMentions = cursers.map((c) => `<@${c.curserDiscordId}>`);
      curseText = buildCurseBrokenMessage(displayToken, curserMentions);
    } else {
      const updatedCursers = [];
      const awards = [];
      for (const c of cursers) {
        const lossesAccrued = c.lossesAccrued ?? 0;
        const multiplier = c.payoutMultiplier ?? 1.0;
        const payout = Math.round(100 * Math.pow(2, lossesAccrued) * multiplier);
        const next = await storage.awardSouls(c.curserDiscordId, payout);
        awards.push({
          mention: `<@${c.curserDiscordId}>`,
          payout,
          balance: next.balance,
        });
        updatedCursers.push({ ...c, lossesAccrued: lossesAccrued + 1 });
      }
      await storage.updatePlayer(player.puuid, { cursers: updatedCursers });
      curseText = buildCurseLossMessage(displayToken, awards);
    }

    const targetMentions = player.discordUserId ? [player.discordUserId] : [];
    try {
      await channel.send({
        content: curseText,
        allowedMentions: targetMentions.length > 0
          ? { users: targetMentions }
          : { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post curse message: ${err.message}`);
    }

    if (won) {
      await storage.updatePlayer(player.puuid, { cursers: [] });
    }
  }

  // Bet resolution — match-v5's matchId is "PLATFORM_GAMEID"; spectator gameId
  // is just the numeric tail. Look up any open bet for this game and pay out.
  const gameIdForBet = String(matchId).split('_').pop();
  const bet = storage.getBetByGameId(gameIdForBet);
  if (bet && (bet.status === 'open' || bet.status === 'awaiting_resolve') && !silent) {
    await resolveBet(bet, won ? 'win' : 'loss', channel);
  }
}

/**
 * Pay out a bet and lock its channel message. Awards souls to each winner via
 * the existing storage.awardSouls path so totalEarned counts these too.
 */
async function resolveBet(bet, winningSide, channel) {
  const { payouts, refund } = computeBetPayouts(bet, winningSide);
  for (const p of payouts) {
    await storage.awardSouls(p.discordUserId, p.amount);
  }
  await storage.updateBet(bet.gameId, {
    status: 'resolved',
    resolvedSide: winningSide,
    resolvedAt: new Date().toISOString(),
  });

  // Lock the original message (strip buttons, swap to locked content).
  if (bet.channelMessageId) {
    try {
      const msg = await channel.messages.fetch(bet.channelMessageId);
      await msg.edit({
        content: buildBetPoolMessage(bet, { locked: true }),
        components: [],
      });
    } catch (err) {
      logger.warn(`Failed to lock bet message ${bet.channelMessageId}: ${err.message}`);
    }
  }

  // Post the resolution announcement.
  try {
    const text = refund
      ? buildBetRefundedMessage(bet, 'no one backed the winning side', payouts)
      : buildBetResolvedMessage(bet, winningSide, payouts);
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    logger.error(`Failed to post bet resolved message: ${err.message}`);
  }

  const totalPaid = payouts.reduce((s, p) => s + p.amount, 0);
  logger.info(
    `Bet ${bet.gameId} resolved as ${winningSide} — ${payouts.length} payout(s) totaling ${totalPaid} souls${refund ? ' (refunded)' : ''}`,
  );
}

/**
 * Spectator-v5 check. If the player is in an active ranked game and we don't
 * already have an open bet for it, post a new prediction pool to the channel.
 */
async function maybeOpenBet(player, channel) {
  let active;
  try {
    active = await riot.getActiveGame(player.puuid);
  } catch (err) {
    logger.warn(
      `Spectator check failed for ${player.riotId.gameName}#${player.riotId.tagLine}: ${err.message}`,
    );
    return;
  }

  if (!active || !rank.isRankedQueue(active.gameQueueConfigId)) {
    // Not in a ranked game right now. Transition any 'open' bet for this
    // player to 'awaiting_resolve' so no more stakes are accepted while we
    // wait for match-v5 to surface the finished match.
    const openOnly = storage
      .getOpenBetsForPuuid(player.puuid)
      .filter((b) => b.status === 'open');
    for (const b of openOnly) {
      await storage.updateBet(b.gameId, { status: 'awaiting_resolve' });
      if (b.channelMessageId) {
        try {
          const msg = await channel.messages.fetch(b.channelMessageId);
          const refreshed = storage.getBetByGameId(b.gameId);
          await msg.edit({
            content: buildBetPoolMessage(refreshed, { locked: true }),
            components: [],
          });
        } catch (err) {
          logger.warn(`Failed to lock awaiting-resolve message: ${err.message}`);
        }
      }
    }
    return;
  }

  const gameId = String(active.gameId);
  if (storage.getBetByGameId(gameId)) {
    return; // bet already exists for this game
  }

  const newBet = {
    gameId,
    puuid: player.puuid,
    riotIdSnapshot: { gameName: player.riotId.gameName, tagLine: player.riotId.tagLine },
    displayName: `${player.riotId.gameName}#${player.riotId.tagLine}`,
    targetDiscordId: player.discordUserId ?? null,
    status: 'open',
    openedAt: new Date().toISOString(),
    channelMessageId: null,
    pools: { win: 0, loss: 0 },
    stakes: {},
    resolvedSide: null,
    resolvedAt: null,
  };
  await storage.createBet(newBet);

  try {
    const message = await channel.send({
      content: buildBetPoolMessage(newBet),
      components: [buildStakeButtons(gameId)],
      allowedMentions: { parse: [] },
    });
    await storage.updateBet(gameId, { channelMessageId: message.id });
    logger.info(
      `Opened bet for ${player.riotId.gameName}#${player.riotId.tagLine} game ${gameId}`,
    );
  } catch (err) {
    logger.error(`Failed to post bet open message for game ${gameId}: ${err.message}`);
  }
}

/**
 * Refund bets stuck in 'awaiting_resolve' for too long. Riot's match-v5 has
 * usually surfaced a finished match within ~5 minutes; if 2 hours pass with
 * nothing, the game probably crashed (remake, server issue) and we void.
 */
const STUCK_BET_TIMEOUT_MS = 2 * 60 * 60 * 1000;

async function refundStuckBets(channel) {
  const stuck = storage.getBetsByStatus('awaiting_resolve');
  const now = Date.now();
  for (const bet of stuck) {
    const opened = Date.parse(bet.openedAt ?? 0);
    if (!Number.isFinite(opened) || now - opened < STUCK_BET_TIMEOUT_MS) continue;

    // Build refund list: every stake returns to its owner.
    const payouts = Object.entries(bet.stakes ?? {})
      .map(([userId, s]) => ({
        discordUserId: userId,
        amount: (s.win ?? 0) + (s.loss ?? 0),
        kind: 'refund',
      }))
      .filter((p) => p.amount > 0);

    for (const p of payouts) {
      await storage.awardSouls(p.discordUserId, p.amount);
    }
    await storage.updateBet(bet.gameId, {
      status: 'refunded',
      resolvedAt: new Date().toISOString(),
    });
    try {
      await channel.send({
        content: buildBetRefundedMessage(bet, 'match never resolved (timeout)', payouts),
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post bet refund message: ${err.message}`);
    }
    logger.info(`Bet ${bet.gameId} refunded after timeout — ${payouts.length} refund(s)`);
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

  // After catch-up, peek at spectator-v5 to detect a fresh in-game session
  // and open a bet for it. Skipped during startup to avoid spam on boot.
  if (!startup) {
    const refreshed = storage.findByPuuid(player.puuid);
    await maybeOpenBet(refreshed, channel);
  }

  if (!startup) return null;

  // Build the per-player summary for the startup report.
  const post = storage.findByPuuid(player.puuid);

  // Only include in the report if at least one game was processed for today.
  const todayKey = rank.dateKey(config.timezone);
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
  const todayKey = rank.dateKey(config.timezone);

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
  // Fire at 23:59 LOCAL time in the configured timezone, not 23:59 UTC.
  // nextLocalEodInstant guarantees the result is > now, so no setTimeout(0)
  // loop is possible even if we're rescheduling right after firing.
  const triggerAt = rank.nextLocalEodInstant(now, config.timezone);
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

    // Sweep any bets that have been awaiting resolution past the timeout
    // (game crashed, server issue, anything that prevented match-v5 from
    // surfacing the result). Skipped on the startup tick — give the boot
    // sequence a clean log first.
    if (!startup) {
      try {
        await refundStuckBets(channel);
      } catch (err) {
        logger.error(`Failed to sweep stuck bets: ${err.message}`);
      }
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
