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
  pickRegularWinMessage,
  computeTiltMeter,
  buildCurseBrokenMessage,
  buildCurseLossMessage,
  computeFraudScore,
  buildFraudWatchMessage,
  computeGodModeScore,
  buildGodModeMessage,
  FLOW_STATE_THRESHOLD,
  buildBetPoolMessage,
  buildBetResolvedMessage,
  buildBetRefundedMessage,
  computeBetPayouts,
  computeBetMultiplier,
} from './messages.js';
import { analyzeTimeline, buildReportSeries } from './timeline.js';
import { buildMatchReport } from './report.js';
import { buildStakeButtons } from './commands.js';
import { logger } from './logger.js';
import { config } from './config.js';

const PER_PLAYER_DELAY_MS = 250;

// Spectator polling cadence — independent from the match-v5 tick so game
// starts get noticed within seconds rather than waiting on the slower loop.
const SPECTATOR_TICK_MS = 20_000;
const SPECTATOR_PER_PLAYER_DELAY_MS = 100;

let intervalHandle = null;
let spectatorIntervalHandle = null;
let running = false; // re-entrancy guard for overlapping match ticks
let spectatorRunning = false; // re-entrancy guard for overlapping spectator ticks

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

  // Remakes don't count: no streak/record change, no tilt or win message, no
  // souls, curses untouched. Any open bet on the game is voided and refunded.
  if (summary.remake) {
    logger.info(
      `Match ${matchId} for ${player.riotId.gameName}#${player.riotId.tagLine} was a remake — not counted`,
    );
    await storage.updatePlayer(player.puuid, { lastProcessedMatchId: matchId });
    const remakeBet = storage.getBetByGameId(String(matchId).split('_').pop());
    if (
      remakeBet &&
      (remakeBet.status === 'open' || remakeBet.status === 'awaiting_resolve') &&
      !silent
    ) {
      await lockBetMessage(remakeBet, channel);
      await refundBet(remakeBet, 'game was remade', channel);
    }
    return;
  }

  const newStreak = nextStreak(player.streak, won);
  const newToday = nextToday(player.today, won, config.timezone);

  let lpDeltaStr = null;
  let lpDeltaNum = null;
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
        lpDeltaNum = rank.computeLpDelta(player.lastRank, snapshot);
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

  // Timeline feeds the post-match report chart plus the Fraud Watch / God Mode
  // signals (fall-off, tower deaths, fights, deathless stretches). One extra
  // request per live match; on failure the report is embed-only and the
  // detectors run on end-of-game stats alone.
  let timeline = null;
  let reportSeries = null;
  if (!silent) {
    try {
      const rawTimeline = await riot.getMatchTimeline(matchId);
      timeline = analyzeTimeline(rawTimeline, player.puuid);
      reportSeries = buildReportSeries(rawTimeline, match, player.puuid);
    } catch (err) {
      logger.warn(`Failed to fetch timeline for ${matchId}: ${err.message}`);
    }
  }

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
    } else {
      // Vanilla win — always fire something so wins are tracked, not silent.
      text = pickRegularWinMessage(displayToken, detailOpts);
    }
  }

  // Everything this game produces (result, Aegis, Fraud Watch, God Mode,
  // curses, bet payouts) goes into ONE post, sent at the end of this function.
  const sections = [text];

  // Participation payout — +100 souls every ranked match played. Gated by
  // !silent so backfill / catch-up after restart don't retroactively mint
  // souls (otherwise re-adding via /track add becomes a soul farm).
  if (!silent && player.discordUserId) {
    try {
      await storage.awardSouls(player.discordUserId, 100);
    } catch (err) {
      logger.warn(`Failed to award participation souls: ${err.message}`);
    }
  }

  // Aegis Double LP — the +38/+40 LP blessing event. Anything above the
  // normal 20-28 LP range almost always means an Aegis or first-win bonus.
  if (!silent && won && Number.isFinite(lpDeltaNum) && lpDeltaNum >= 30) {
    sections.push(
      `🛡️ The Tilt Gods have blessed ${displayToken} with double LP — **${lpDeltaStr}** from Aegis 🙏`,
    );
  }

  const performance = {
    kills,
    deaths,
    assists,
    damageShare,
    damageRankOnTeam: summary.damageRankOnTeam,
    teamSize: summary.teamSize,
    killParticipation,
    turretDamageShare,
    timeline,
  };

  // Fraud Watch — independent of the standard win message. Only fires when a
  // win is statistically suspicious (low damage share, low KP, bad KDA, etc.).
  if (!silent && won) {
    const fraudScore = computeFraudScore({ won, ...performance });
    if (Number.isFinite(fraudScore) && fraudScore >= 50) {
      sections.push(buildFraudWatchMessage(displayToken, fraudScore, summary, timeline));
    }
  }

  // God Mode / Flow State — the opposite of Fraud Watch. Fires on wins and
  // losses when the player genuinely popped off.
  if (!silent) {
    const godScore = computeGodModeScore(performance);
    if (Number.isFinite(godScore) && godScore >= FLOW_STATE_THRESHOLD) {
      sections.push(buildGodModeMessage(displayToken, godScore, summary, timeline));
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

    sections.push(curseText);

    if (won) {
      await storage.updatePlayer(player.puuid, { cursers: [] });
    }
  }

  // Bet resolution — match-v5's matchId is "PLATFORM_GAMEID"; spectator gameId
  // is just the numeric tail. Look up any open bet for this game and pay out.
  const gameIdForBet = String(matchId).split('_').pop();
  const bet = storage.getBetByGameId(gameIdForBet);
  if (bet && (bet.status === 'open' || bet.status === 'awaiting_resolve') && !silent) {
    sections.push(await resolveBet(bet, won ? 'win' : 'loss', channel));
  }

  if (!silent) {
    await postGameReport(player, summary, {
      channel,
      content: sections.filter(Boolean).join('\n\n'),
      allowedMentions,
      report: buildMatchReport(summary, reportSeries, logger),
      lpDelta: lpDeltaStr,
    });
  }
}

// Discord's hard cap on message content.
const MAX_CONTENT = 2000;
// How many earlier games to list in the "Earlier today" line before "+N more".
const EARLIER_TODAY_SHOWN = 8;

function formatEarlierToday(games) {
  if (!games.length) return null;
  const shown = games.slice(-EARLIER_TODAY_SHOWN).map(
    (g) => `${g.won ? '✅' : '❌'} ${g.champion} ${g.kda}${g.lp ? ` (${g.lp})` : ''}`,
  );
  const hidden = games.length - shown.length;
  return `📅 Earlier today: ${hidden > 0 ? `+${hidden} more • ` : ''}${shown.join(' • ')}`;
}

/**
 * Post the single per-game message, keeping the channel to ONE live post per
 * player per day: the player's previous post from today is deleted and the
 * new one carries an "Earlier today" line, so nothing is lost but grinding
 * ten games doesn't bury the channel.
 */
async function postGameReport(player, summary, { channel, content, allowedMentions, report, lpDelta }) {
  const todayKey = rank.dateKey(config.timezone);
  const prev = player.dayPosts?.date === todayKey ? player.dayPosts : null;
  const earlierGames = prev?.games ?? [];

  const earlierLine = formatEarlierToday(earlierGames);
  let fullContent = earlierLine ? `${content}\n\n${earlierLine}` : content;
  if (fullContent.length > MAX_CONTENT) fullContent = `${fullContent.slice(0, MAX_CONTENT - 1)}…`;

  let sent = null;
  try {
    sent = await channel.send({ content: fullContent, allowedMentions, ...report });
  } catch (err) {
    logger.error(`Failed to post game report: ${err.message}`);
  }

  // Only remove the old post once the new one is safely up.
  if (sent && prev?.messageId) {
    try {
      await channel.messages.delete(prev.messageId);
    } catch (err) {
      logger.warn(`Failed to delete previous post ${prev.messageId}: ${err.message}`);
    }
  }

  await storage.updatePlayer(player.puuid, {
    dayPosts: {
      date: todayKey,
      messageId: sent?.id ?? prev?.messageId ?? null,
      games: [
        ...earlierGames,
        {
          won: summary.won,
          champion: summary.championName,
          kda: `${summary.kills}/${summary.deaths}/${summary.assists}`,
          lp: lpDelta ?? null,
        },
      ],
    },
  });
}

/** Strip the stake buttons from a bet's channel message and show it locked. */
async function lockBetMessage(bet, channel) {
  if (!bet.channelMessageId) return;
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

/**
 * Pay out a bet. Awards souls to each winner via the existing
 * storage.awardSouls path so totalEarned counts these too. Stakes on the
 * losing side are forfeited — including when nobody backed the winning side.
 *
 * Returns the result text for the caller to fold into the game post, and
 * deletes the now-finished pool post so it doesn't linger in the channel.
 */
async function resolveBet(bet, winningSide, channel) {
  const { payouts, losers, totalPaid } = computeBetPayouts(bet, winningSide);
  for (const p of payouts) {
    await storage.awardSouls(p.discordUserId, p.amount);
  }
  await storage.updateBet(bet.gameId, {
    status: 'resolved',
    resolvedSide: winningSide,
    resolvedAt: new Date().toISOString(),
  });

  if (bet.channelMessageId) {
    try {
      await channel.messages.delete(bet.channelMessageId);
    } catch (err) {
      logger.warn(`Failed to delete bet pool post ${bet.channelMessageId}: ${err.message}`);
    }
  }

  logger.info(
    `Bet ${bet.gameId} resolved as ${winningSide} — ${payouts.length} payout(s) totaling ${totalPaid} souls, ${losers.length} stake(s) forfeited`,
  );
  return buildBetResolvedMessage(bet, winningSide, payouts, losers);
}

/**
 * Void a bet: every stake returns to its owner. Used for remakes and for
 * matches that never resolve.
 */
async function refundBet(bet, reason, channel) {
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
      content: buildBetRefundedMessage(bet, reason, payouts),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.error(`Failed to post bet refund message: ${err.message}`);
  }
  logger.info(`Bet ${bet.gameId} refunded (${reason}) — ${payouts.length} refund(s)`);
}

// Betting closes 2 minutes after the in-game gameStartTime — measured from
// Riot's clock, not from when the bot first noticed the game. This prevents
// late-detected games from getting a fresh 2-min window where bettors might
// already know the outcome.
const BETTING_WINDOW_MS = 2 * 60 * 1000;

/**
 * Lock a bet's status to 'awaiting_resolve' and strip the buttons from its
 * channel message. Idempotent — safe to call concurrently from spectator and
 * time-based close paths.
 */
async function transitionToAwaitingResolve(bet, channel) {
  if (bet.status !== 'open') return;
  await storage.updateBet(bet.gameId, { status: 'awaiting_resolve' });
  if (!bet.channelMessageId) return;
  try {
    const msg = await channel.messages.fetch(bet.channelMessageId);
    const refreshed = storage.getBetByGameId(bet.gameId);
    await msg.edit({
      content: buildBetPoolMessage(refreshed, { locked: true }),
      components: [],
    });
  } catch (err) {
    logger.warn(`Failed to lock bet message ${bet.channelMessageId}: ${err.message}`);
  }
}

/**
 * Spectator-v5 check. Opens a fresh bet when the player is in an active
 * ranked game AND the game started less than 2 minutes ago. Late detections
 * (Riot's spectator API can lag 30–90s) are skipped so we don't post a
 * "prediction open" message in the middle of a game.
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
    return;
  }

  const gameId = String(active.gameId);
  if (storage.getBetByGameId(gameId)) {
    return; // bet already exists for this game
  }

  // Skip stale game detections — the betting window has already closed.
  const startedAt = Number.isFinite(active.gameStartTime) && active.gameStartTime > 0
    ? active.gameStartTime
    : Date.now();
  const ageMs = Date.now() - startedAt;
  if (ageMs > BETTING_WINDOW_MS) {
    logger.info(
      `Game ${gameId} for ${player.riotId.gameName}#${player.riotId.tagLine} is ${Math.round(ageMs / 1000)}s in — past the 2min window, skipping bet`,
    );
    return;
  }

  const bettingClosesAtMs = startedAt + BETTING_WINDOW_MS;
  // Lock the base multipliers at bet-open time using the target's recent
  // 20-game form. Stored on the bet so the math is reproducible even after
  // recentResults updates mid-game.
  const recent = player.recentResults ?? [];
  const multipliers = {
    win: computeBetMultiplier(recent, 'win'),
    loss: computeBetMultiplier(recent, 'loss'),
  };
  const newBet = {
    gameId,
    puuid: player.puuid,
    riotIdSnapshot: { gameName: player.riotId.gameName, tagLine: player.riotId.tagLine },
    displayName: `${player.riotId.gameName}#${player.riotId.tagLine}`,
    targetDiscordId: player.discordUserId ?? null,
    status: 'open',
    openedAt: new Date().toISOString(),
    gameStartTime: startedAt,
    bettingClosesAt: new Date(bettingClosesAtMs).toISOString(),
    channelMessageId: null,
    pools: { win: 0, loss: 0 },
    stakes: {},
    multipliers,
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
    const secsLeft = Math.max(0, Math.round((bettingClosesAtMs - Date.now()) / 1000));
    logger.info(
      `Opened bet for ${player.riotId.gameName}#${player.riotId.tagLine} game ${gameId} — ${secsLeft}s of betting left`,
    );
  } catch (err) {
    logger.error(`Failed to post bet open message for game ${gameId}: ${err.message}`);
  }
}

/**
 * Scan every 'open' bet and transition any past its bettingClosesAt to
 * 'awaiting_resolve'. Time-driven so the close fires even when spectator
 * polling lags. Bets stay alive — they resolve on the match-v5 outcome.
 */
async function closeBetsPastWindow(channel) {
  const open = storage.getBetsByStatus('open');
  const now = Date.now();
  for (const bet of open) {
    const closeAt = bet.bettingClosesAt ? Date.parse(bet.bettingClosesAt) : null;
    if (Number.isFinite(closeAt) && now > closeAt) {
      await transitionToAwaitingResolve(bet, channel);
    }
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
    await refundBet(bet, 'match never resolved (timeout)', channel);
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

  // Spectator detection now lives in its own faster tick (SPECTATOR_TICK_MS)
  // so the betting window catches game starts within seconds, not minutes.

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

  const allEntries = playedToday.map((p) => ({
    riotId: p.riotId,
    discordUserId: p.discordUserId,
    lpDelta: p.today.lpDelta ?? 0,
  }));

  const losers = allEntries
    .filter((e) => e.lpDelta < 0)
    .sort((a, b) => a.lpDelta - b.lpDelta); // most LP lost first
  const winners = allEntries
    .filter((e) => e.lpDelta > 0)
    .sort((a, b) => b.lpDelta - a.lpDelta); // most LP gained first

  // --- Tilt leaderboard (losers) ---
  if (losers.length === 0) {
    try {
      await channel.send({
        content: 'No tilt today 🙏 the Tilt Gods are unsatisfied.',
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post no-tilt report: ${err.message}`);
    }
  } else {
    const totalSacrificed = Math.abs(losers.reduce((sum, e) => sum + e.lpDelta, 0));
    const lines = losers.map((e, i) => {
      const token = e.discordUserId ? `<@${e.discordUserId}>` : `**${e.riotId.gameName}**`;
      const lpStr = rank.formatLpDelta(e.lpDelta) ?? '+0 LP';
      return `${i + 1}. ${token} ${lpStr}`;
    });
    const mentioned = losers.filter((e) => e.discordUserId).map((e) => e.discordUserId);
    try {
      await channel.send({
        content: `Thus ends another day of tilt. ${totalSacrificed} LP has been sacrificed to the Tilt Gods.\nTilt Patreon Leaderboard:\n${lines.join('\n')}`,
        allowedMentions: mentioned.length > 0 ? { users: mentioned } : { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post end-of-day report: ${err.message}`);
    }
  }

  // --- Tilt God's Greatest Warriors (winners) ---
  if (winners.length > 0) {
    const totalGained = winners.reduce((sum, e) => sum + e.lpDelta, 0);
    const lines = winners.map((e, i) => {
      const token = e.discordUserId ? `<@${e.discordUserId}>` : `**${e.riotId.gameName}**`;
      const lpStr = rank.formatLpDelta(e.lpDelta) ?? '+0 LP';
      return `${i + 1}. ${token} ${lpStr}`;
    });
    const mentioned = winners.filter((e) => e.discordUserId).map((e) => e.discordUserId);
    try {
      await channel.send({
        content: `⚔️ **Tilt God's Greatest Warriors** today (+${totalGained} LP combined):\n${lines.join('\n')}`,
        allowedMentions: mentioned.length > 0 ? { users: mentioned } : { parse: [] },
      });
    } catch (err) {
      logger.error(`Failed to post Greatest Warriors report: ${err.message}`);
    }
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

/**
 * Spectator-only tick. Detects new in-game ranked sessions and closes any
 * bets whose 2-min window has expired. Runs on its own short interval
 * (SPECTATOR_TICK_MS) so detection isn't gated by the slower match poll.
 */
async function spectatorTick(channel) {
  if (spectatorRunning) {
    logger.debug('Skipping spectator tick — previous still running');
    return;
  }
  spectatorRunning = true;
  try {
    const players = storage.getPlayers();
    for (const player of players) {
      try {
        await maybeOpenBet(player, channel);
      } catch (err) {
        logger.warn(
          `Spectator tick error for ${player.riotId.gameName}#${player.riotId.tagLine}: ${err.message}`,
        );
      }
      await sleep(SPECTATOR_PER_PLAYER_DELAY_MS);
    }
    try {
      await closeBetsPastWindow(channel);
    } catch (err) {
      logger.error(`Failed to close bets past window: ${err.message}`);
    }
  } finally {
    spectatorRunning = false;
  }
}

/**
 * HateWatch processing — light per-entry tick. Watches the entry for
 * loss-streak milestones (3, then every loss after 5) and rank demotions,
 * then posts a public announcement crediting whoever added them.
 *
 * No today-tracking, no tilt meter, no curses, no souls — just the bare
 * loss-detection signal.
 */
async function processHatewatchEntry(entry, channel, { silent = false } = {}) {
  let ids;
  try {
    ids = await riot.getRecentMatchIds(entry.puuid, 20, { type: 'ranked' });
  } catch (err) {
    logger.warn(`HateWatch fetch error for ${entry.riotId.gameName}: ${err.message}`);
    return;
  }
  if (!ids.length) return;

  // First-time bootstrap: pin to the latest, no announcements for historical games.
  if (entry.lastProcessedMatchId === null) {
    await storage.updateHatewatch(entry.puuid, { lastProcessedMatchId: ids[0] });
    return;
  }

  const newIds = [];
  for (const id of ids) {
    if (id === entry.lastProcessedMatchId) break;
    newIds.push(id);
  }
  if (!newIds.length) return;
  newIds.reverse(); // oldest first

  let streak = entry.streak ?? { type: null, count: 0 };
  let lastRank = entry.lastRank ?? null;
  let lastProcessed = entry.lastProcessedMatchId;

  for (const matchId of newIds) {
    let match;
    try {
      match = await riot.getMatch(matchId);
    } catch (err) {
      logger.warn(`HateWatch match fetch error: ${err.message}`);
      continue;
    }
    const summary = riot.extractMatchSummary(match, entry.puuid);
    if (!summary) {
      lastProcessed = matchId;
      continue;
    }
    if (!rank.isRankedQueue(summary.queueId) || summary.remake) {
      lastProcessed = matchId;
      continue;
    }

    const won = summary.won;
    streak = nextStreak(streak, won);

    // Pull current ranked entries to detect demotions. One extra request per
    // processed match — acceptable since HateWatch is opt-in and small.
    let rankChange = null;
    let newRank = lastRank;
    try {
      const entries = await riot.getRankedEntries(entry.puuid);
      const queueEntry = rank.findEntryForQueue(entries, summary.queueId);
      if (queueEntry) {
        const snapshot = rank.entryToSnapshot(queueEntry);
        rankChange = rank.getRankChange(lastRank, snapshot);
        newRank = snapshot;
      }
    } catch (err) {
      logger.warn(`HateWatch rank fetch error: ${err.message}`);
    }

    if (!silent) {
      const target = `**${entry.riotId.gameName}#${entry.riotId.tagLine}**`;
      let announcement = null;
      if (rankChange === 'demoted') {
        const rankStr = newRank ? ` to ${rank.formatRank(newRank)}` : '';
        announcement = `🪦 HateWatch: ${target} just **demoted**${rankStr} — added by <@${entry.addedBy}>`;
      } else if (streak.type === 'L' && streak.count === 3) {
        announcement = `🪦 HateWatch: ${target} is on a **3-loss streak** — added by <@${entry.addedBy}>`;
      } else if (streak.type === 'L' && streak.count >= 5) {
        announcement = `🪦 HateWatch: ${target} is on a **${streak.count}-loss streak** 💀 — added by <@${entry.addedBy}>`;
      }
      if (announcement) {
        try {
          await channel.send({
            content: announcement,
            allowedMentions: { parse: [] }, // never ping the adder for these
          });
        } catch (err) {
          logger.error(`Failed to post HateWatch announcement: ${err.message}`);
        }
      }
    }

    lastProcessed = matchId;
    lastRank = newRank;
  }

  await storage.updateHatewatch(entry.puuid, {
    lastProcessedMatchId: lastProcessed,
    streak,
    lastRank,
  });
}

async function tick(channel, { startup = false } = {}) {
  if (running) {
    logger.debug('Skipping tick — previous tick still running');
    return;
  }
  running = true;
  try {
    const players = storage.getPlayers();
    const hatewatch = storage.getHatewatch();
    if (players.length === 0 && hatewatch.length === 0) {
      logger.debug('No tracked players or hatewatch entries this tick');
      return;
    }
    logger.debug(`Polling ${players.length} player(s), ${hatewatch.length} hatewatch entry(s)`);

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

    // HateWatch — re-read on every tick since /hatewatch add can land between
    // ticks. Pass `silent: startup` so we don't fire announcements during the
    // boot catch-up.
    for (const entry of storage.getHatewatch()) {
      try {
        await processHatewatchEntry(entry, channel, { silent: startup });
      } catch (err) {
        logger.error(
          `Error processing hatewatch ${entry.riotId.gameName}#${entry.riotId.tagLine}: ${err.message}`,
        );
      }
      await sleep(PER_PLAYER_DELAY_MS);
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
  logger.info(
    `Poller started (match-v5 every ${config.pollIntervalMs}ms, spectator every ${SPECTATOR_TICK_MS}ms)`,
  );
  // Fire-and-forget the first tick so startup logs aren't blocked by a slow
  // Riot response.
  tick(channel, { startup: true });
  intervalHandle = setInterval(() => tick(channel), config.pollIntervalMs);

  // Dedicated spectator loop — runs much more frequently than the match-v5
  // loop so live game starts land in the 2-min betting window.
  spectatorTick(channel);
  spectatorIntervalHandle = setInterval(() => spectatorTick(channel), SPECTATOR_TICK_MS);

  scheduleEndOfDayReport(channel);
}

export function stopPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (spectatorIntervalHandle) {
    clearInterval(spectatorIntervalHandle);
    spectatorIntervalHandle = null;
  }
  logger.info('Poller stopped');
}
