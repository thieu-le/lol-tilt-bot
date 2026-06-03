// Tilt phrases. `{name}` -> pre-formatted display token (`<@id>` or `**Name**`).
// `{n}` -> streak length. Templates don't add their own bold markup; the
// caller controls the name token's formatting so Discord mention pills render.

// Loss message pools, escalating with streak length:
//   count = 1  -> FIRST_LOSS          (rotating)
//   count = 2  -> SECOND_LOSS
//   count = 3  -> LOSS_STREAK_ENTRY
//   count >= 4 -> LOSS_STREAK_DEEP
const FIRST_LOSS = [
  '{name} is fuming',
  '{name} just suffered a devastating lost',
  '{name} just got the LP ripped from them',
];

const SECOND_LOSS = [
  '{name} is tilted',
];

const LOSS_STREAK_ENTRY = [
  "{name} is tilted asf they DGAF THEY'RE TILTED",
  '{name} has entered losersQ',
];

const LOSS_STREAK_DEEP = [
  '{name} is extremely tilted. Someone stop them...',
];

// Appended on a loss when K/D >= 1 (kills ≥ deaths, assists excluded).
const POSITIVE_KDA_CURSE = 'Drew Levin cursed them with dog shit teammates';

// Win messages
const DEMOTION_LOSS = "{name} just demoted... They're tilted ASF icl";
const PROMOTION_WIN = '{name} has ascended LFG';
const WIN_STREAK_ENTRY = 'Is this winners queue? {name}'; // exactly 4
const WIN_STREAK_DEEP  = '{name} is hot 🔥 {n} game winstreak'; // 5+

// Vanilla wins — fires when there's no promotion and no 4+ winstreak. Keep
// these short and a little tongue-in-cheek so they don't drown out tilt
// messages on active days.
const REGULAR_WIN = [
  '{name} ate that 🍽️',
  '{name} cooked',
  '{name} got the dub',
  '{name} won a game (rare)',
  'yeah {name} won, calm down',
  '{name} +{lp_or_W}',
  '{name} farmed enemies for breakfast',
  '{name} did NOT tilt today',
];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function buildDetailLine(opts = {}) {
  const parts = [];
  if (opts.lpDelta) parts.push(opts.lpDelta);
  if (opts.today)   parts.push(`Today: ${opts.today.wins}-${opts.today.losses}`);
  if (opts.rankLabel) parts.push(opts.rankLabel);
  return parts.length > 0 ? `\n${parts.join(' • ')}` : '';
}

/**
 * Compute a 0-100 tilt meter score from a match summary. Returns null on a win
 * (no tilt) or when KDA/damage data is missing. The thresholds are tuned to
 * specific user-anchored points: 0/3/0 ≈ 40%, 0/4/0 ≈ 70%, 0/5/0 ≈ 75%.
 * Damage share is overlaid on top — dealing less than 20% (a fair share on a
 * 5-player team) drives the meter up; carrying drives it down.
 */
export function computeTiltMeter({ kills, deaths, assists, damageShare, won } = {}) {
  if (won) return null;
  if (!Number.isFinite(kills) || !Number.isFinite(deaths) || !Number.isFinite(assists)) {
    return null;
  }

  let base;
  if (kills + assists === 0) {
    if (deaths <= 2)       base = 25;
    else if (deaths === 3) base = 40;
    else if (deaths === 4) base = 70;
    else if (deaths === 5) base = 75;
    else                   base = 85;
  } else {
    const ratio = (kills + assists * 0.5) / Math.max(deaths, 1);
    if (ratio >= 1.5)      base = 0;
    else if (ratio >= 1.0) base = 5;
    else if (ratio >= 0.6) base = 20;
    else if (ratio >= 0.3) base = 40;
    else                   base = 55;
  }

  let dmgAdjust = 0;
  if (Number.isFinite(damageShare)) {
    dmgAdjust = (0.20 - damageShare) * 150;
  }

  return Math.max(0, Math.min(100, Math.round(base + dmgAdjust)));
}

/**
 * Render a 10-segment emoji bar for a 0-100 tilt percentage. The fill color
 * shifts with severity so a quick glance tells you whether someone's cooked.
 */
export function formatTiltBar(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  let fill;
  if (pct <= 30)      fill = '🟩';
  else if (pct <= 60) fill = '🟨';
  else                fill = '🟥';
  return fill.repeat(filled) + '⬛'.repeat(empty);
}

function buildTiltMeterLine(opts = {}) {
  if (!Number.isFinite(opts.tiltMeter)) return '';
  const bar = formatTiltBar(opts.tiltMeter);
  const stats = [];
  if (Number.isFinite(opts.kills) && Number.isFinite(opts.deaths) && Number.isFinite(opts.assists)) {
    stats.push(`${opts.kills}/${opts.deaths}/${opts.assists}`);
  }
  if (Number.isFinite(opts.damageShare)) {
    stats.push(`${Math.round(opts.damageShare * 100)}% dmg`);
  }
  const detail = stats.length > 0 ? ` (${stats.join(' • ')})` : '';
  return `\n${bar} ${opts.tiltMeter}% Tilt${detail}`;
}

function formatCurserList(curserMentions) {
  if (curserMentions.length === 1) return curserMentions[0];
  if (curserMentions.length === 2) return `${curserMentions[0]} and ${curserMentions[1]}`;
  const head = curserMentions.slice(0, -1).join(', ');
  const tail = curserMentions[curserMentions.length - 1];
  return `${head}, and ${tail}`;
}

/**
 * Locked-at-open multiplier for a prediction-pool side. Designed for the
 * hybrid payout: stake × multiplier (floor) + share of losing pool (bonus).
 * Mirror logic to curse multiplier: betting against form pays more.
 *
 *   side='win'  → high mult when target's recent form is BAD (upset to win)
 *   side='loss' → high mult when target's recent form is GOOD (upset to lose)
 */
export function computeBetMultiplier(recentResults, side) {
  const fallback = 1.5;
  if (!recentResults || recentResults.length === 0) return fallback;
  const wins = recentResults.filter((r) => r === 'W').length;
  const wr = wins / recentResults.length;

  if (side === 'loss') {
    if (wr >= 0.80) return 3.0;
    if (wr >= 0.60) return 2.0;
    if (wr >= 0.40) return 1.5;
    if (wr >= 0.20) return 1.2;
    return 1.1;
  }
  // 'win' side
  if (wr <= 0.20) return 3.0;
  if (wr <= 0.40) return 2.0;
  if (wr <= 0.60) return 1.5;
  if (wr <= 0.80) return 1.2;
  return 1.1;
}

/**
 * Map a recent-results array (W/L outcomes) into a Tilted Souls payout
 * multiplier. Higher win rate = harder curse = bigger reward when it lands.
 */
export function computePayoutMultiplier(recentResults) {
  if (!recentResults || recentResults.length === 0) return 1.0; // no data → base
  const wins = recentResults.filter((r) => r === 'W').length;
  const wr = wins / recentResults.length;
  if (wr >= 0.80) return 3.0;  // gambler's dream
  if (wr >= 0.60) return 2.0;
  if (wr >= 0.40) return 1.0;  // base
  if (wr >= 0.20) return 0.5;
  return 0.25;                  // cursing a known troll — minimal reward
}

/**
 * "Recent form: 12W-8L (60% wr → 2.0x payout)" footer used on curse-applied
 * messages so the curser sees their odds.
 */
function formatCurseOddsLine(recentResults, multiplier) {
  if (!recentResults || recentResults.length === 0) {
    return `Recent form unknown — payout locked at ${multiplier.toFixed(1)}x.`;
  }
  const wins = recentResults.filter((r) => r === 'W').length;
  const losses = recentResults.length - wins;
  const wrPct = Math.round((wins / recentResults.length) * 100);
  return `Recent form: ${wins}W-${losses}L (${wrPct}% wr → ${multiplier.toFixed(1)}x payout).`;
}

/**
 * Channel announcement when /curse is applied. `count` is the post-append size
 * of the cursers array (1 = first curser, 2+ = stacking).
 *
 * `opts.recentResults` and `opts.payoutMultiplier` drive the odds footer. Both
 * are stored on the curser entry at curse time so the multiplier is locked.
 */
export function buildCurseAppliedMessage(targetMention, curserMention, count, opts = {}) {
  const oddsLine = formatCurseOddsLine(opts.recentResults, opts.payoutMultiplier ?? 1.0);
  if (count <= 1) {
    return `${targetMention}, you've been cursed to suffer through LosersQ by ${curserMention}.\n${oddsLine} Win a game to break LosersQ. 🪦`;
  }
  return `${curserMention} has joined the curse on ${targetMention}.\n${targetMention} is now cursed by ${count} players. ${oddsLine} 🪦`;
}

/**
 * Channel announcement when a cursed player wins and breaks the curse. No
 * payouts on a break — cursers come up empty.
 */
export function buildCurseBrokenMessage(targetMention, curserMentions) {
  if (curserMentions.length === 1) {
    return `${targetMention} has broken LosersQ. ${curserMentions[0]}'s curse is shattered. 🎉\n(No souls awarded — the curser came up empty.)`;
  }
  return `${targetMention} has broken LosersQ. Freed from: ${formatCurserList(curserMentions)}. 🎉\n(No souls awarded — the cursers came up empty.)`;
}

/**
 * Channel announcement when a cursed player loses. `awards` is the per-curser
 * payout record after `lossesAccrued` has been incremented for this match:
 *   [{ mention, payout, balance }, ...]
 *
 * Single-curser format goes inline; multi-curser format goes vertical.
 */
export function buildCurseLossMessage(targetMention, awards) {
  if (awards.length === 1) {
    const a = awards[0];
    return `${a.mention} has doomed ${targetMention} to LosersQ — +${a.payout} souls (balance: ${a.balance}). 🪦`;
  }
  const lines = awards.map(
    (a) => `  • ${a.mention} +${a.payout} souls (balance: ${a.balance})`,
  );
  return `${targetMention} has been doomed to LosersQ by:\n${lines.join('\n')}\n🪦`;
}

// --- Bets (live in-game prediction pools) ---------------------------------

/**
 * Render the live bet pool message. Same content is used for the initial post
 * and every update as new stakes come in. Pool totals + a per-side payout
 * multiplier let backers see odds shift in real time.
 *
 * Returns a string (the content). Caller attaches the buttons row separately.
 */
export function buildBetPoolMessage(bet, { locked = false } = {}) {
  const winPool = bet.pools?.win ?? 0;
  const lossPool = bet.pools?.loss ?? 0;
  const totalPool = winPool + lossPool;
  const stakes = bet.stakes ?? {};
  const winBackers = Object.values(stakes).filter((s) => (s?.win ?? 0) > 0).length;
  const lossBackers = Object.values(stakes).filter((s) => (s?.loss ?? 0) > 0).length;

  function multiplierLine(side, sidePool, backers, sideKey) {
    const baseMult = bet.multipliers?.[sideKey];
    const stakeLabel = `${sidePool.toLocaleString()} souls`;
    const backerLabel = backers === 1 ? '1 backer' : `${backers} backers`;
    if (baseMult === undefined || baseMult === null) {
      // Legacy bets created before multipliers were stored.
      return `${side} ${stakeLabel} • ${backerLabel}`;
    }
    return `${side} ${baseMult.toFixed(1)}x base • ${stakeLabel} • ${backerLabel}`;
  }

  const status = locked
    ? '🔒 PREDICTION LOCKED — awaiting match result'
    : '🎲 PREDICTION OPEN';

  const target = bet.targetDiscordId ? `<@${bet.targetDiscordId}>` : `**${bet.displayName}**`;

  // Discord renders <t:UNIX:R> as a live "in 1 minute" / "30 seconds ago"
  // countdown that updates client-side. No bot edits needed for the timer.
  let callToBet;
  if (locked) {
    callToBet = 'No more bets — payouts settle when the match resolves.';
  } else if (bet.bettingClosesAt) {
    const closeSec = Math.floor(Date.parse(bet.bettingClosesAt) / 1000);
    callToBet = `Stake your Tilted Souls below. Betting closes <t:${closeSec}:R>.`;
  } else {
    callToBet = 'Stake your Tilted Souls below.';
  }

  return [
    status,
    `${target} is live in ranked.`,
    callToBet,
    '',
    multiplierLine('✅ WIN  ', winPool, winBackers, 'win'),
    multiplierLine('❌ LOSS ', lossPool, lossBackers, 'loss'),
    '',
    `Total pool: ${totalPool.toLocaleString()} souls — winners get base × stake + share of losing pool.`,
  ].join('\n');
}

/**
 * Twitch-Predictions-style proportional payout math.
 *
 * Returns `{ payouts: [{discordUserId, amount, kind}], totalPaid, refund }`.
 *  - `kind: 'win'` — proportional cut of the total pool
 *  - `kind: 'refund'` — stake-back when the winning side had no backers
 *  - `refund: true` means all stakes go back to their original owners
 */
export function computeBetPayouts(bet, winningSide) {
  if (winningSide !== 'win' && winningSide !== 'loss') {
    throw new Error(`Invalid winning side ${winningSide}`);
  }
  const losingSide = winningSide === 'win' ? 'loss' : 'win';
  const winningPool = bet.pools?.[winningSide] ?? 0;
  const losingPool = bet.pools?.[losingSide] ?? 0;
  const totalPool = winningPool + losingPool;
  const stakes = bet.stakes ?? {};

  // Nobody backed the winning side → refund everyone their stake.
  if (winningPool === 0) {
    const payouts = [];
    for (const [userId, s] of Object.entries(stakes)) {
      const refund = (s.win ?? 0) + (s.loss ?? 0);
      if (refund > 0) {
        payouts.push({ discordUserId: userId, amount: refund, kind: 'refund' });
      }
    }
    return {
      payouts,
      totalPaid: payouts.reduce((sum, p) => sum + p.amount, 0),
      refund: true,
    };
  }

  // Hybrid: stake × locked base multiplier (floor) + proportional share of
  // losing pool (bonus). Solo voters still come out ahead via the base mult.
  const baseMult = bet.multipliers?.[winningSide] ?? 1.0;
  const payouts = [];
  for (const [userId, s] of Object.entries(stakes)) {
    const stakeOnWinner = s?.[winningSide] ?? 0;
    if (stakeOnWinner === 0) continue;
    const base = stakeOnWinner * baseMult;
    const bonus = losingPool > 0 ? (stakeOnWinner / winningPool) * losingPool : 0;
    const payout = Math.round(base + bonus);
    payouts.push({ discordUserId: userId, amount: payout, kind: 'win' });
  }
  return {
    payouts,
    totalPaid: payouts.reduce((sum, p) => sum + p.amount, 0),
    refund: false,
  };
}

/**
 * Channel message when a bet resolves. Lists the winners' payouts inline.
 */
export function buildBetResolvedMessage(bet, winningSide, payouts) {
  const target = bet.targetDiscordId ? `<@${bet.targetDiscordId}>` : `**${bet.displayName}**`;
  const verdict = winningSide === 'win' ? '✅ WIN' : '❌ LOSS';
  const totalPool = (bet.pools?.win ?? 0) + (bet.pools?.loss ?? 0);

  if (payouts.length === 0) {
    return `🎲 Prediction resolved: ${target} → ${verdict}\nNobody had a stake. The void claims ${totalPool.toLocaleString()} souls.`;
  }

  const lines = payouts.map(
    (p) => `  • <@${p.discordUserId}> +${p.amount.toLocaleString()} souls`,
  );
  return `🎲 Prediction resolved: ${target} → ${verdict}\n${lines.join('\n')}`;
}

/**
 * Channel message when a bet is refunded (no winners, or game crashed / timed out).
 */
export function buildBetRefundedMessage(bet, reason, payouts) {
  const target = bet.targetDiscordId ? `<@${bet.targetDiscordId}>` : `**${bet.displayName}**`;
  if (payouts.length === 0) {
    return `🎲 Prediction void: ${target} — ${reason}. No stakes to refund.`;
  }
  const lines = payouts.map(
    (p) => `  • <@${p.discordUserId}> refunded ${p.amount.toLocaleString()} souls`,
  );
  return `🎲 Prediction void: ${target} — ${reason}.\n${lines.join('\n')}`;
}

// --- Fraud Watch ----------------------------------------------------------

/**
 * 0-100 "undeserved win" score. Returns null on losses or when essential
 * inputs are missing — caller should treat null as "no fraud signal".
 *
 * Composite of four signals capped at 100:
 *   - damage share (max 30)
 *   - kill participation (max 30)
 *   - KDA (max 25)
 *   - turret damage share (max 15)
 */
export function computeFraudScore({
  won,
  kills,
  deaths,
  assists,
  damageShare,
  killParticipation,
  turretDamageShare,
} = {}) {
  if (!won) return null;
  if (!Number.isFinite(kills) || !Number.isFinite(deaths) || !Number.isFinite(assists)) {
    return null;
  }

  let score = 0;

  if (damageShare !== null && damageShare !== undefined) {
    if (damageShare < 0.08)      score += 30;
    else if (damageShare < 0.12) score += 22;
    else if (damageShare < 0.16) score += 12;
    else if (damageShare < 0.20) score += 5;
  }

  if (killParticipation !== null && killParticipation !== undefined) {
    if (killParticipation < 0.20)      score += 30;
    else if (killParticipation < 0.30) score += 20;
    else if (killParticipation < 0.40) score += 10;
  }

  const kda = (kills + assists) / Math.max(deaths, 1);
  if (kda < 0.5)      score += 25;
  else if (kda < 1.0) score += 15;
  else if (kda < 1.5) score += 5;

  if (turretDamageShare !== null && turretDamageShare !== undefined) {
    if (turretDamageShare < 0.03)      score += 15;
    else if (turretDamageShare < 0.08) score += 7;
  }

  return Math.min(100, score);
}

/**
 * Build the 🚨 FRAUD WATCH 🚨 channel message for a win that crossed the
 * fraud threshold. Includes the score and the underlying stats so the chat
 * can roast them with evidence.
 */
export function buildFraudWatchMessage(displayToken, fraudScore, summary) {
  const { kills, deaths, assists, damageShare, killParticipation, turretDamageShare } = summary;
  const kda = `${kills}/${deaths}/${assists}`;
  const stats = [kda];
  if (Number.isFinite(damageShare)) stats.push(`${Math.round(damageShare * 100)}% dmg`);
  if (Number.isFinite(killParticipation)) stats.push(`${Math.round(killParticipation * 100)}% KP`);
  if (Number.isFinite(turretDamageShare)) stats.push(`${Math.round(turretDamageShare * 100)}% turret dmg`);
  return `🚨 FRAUD WATCH 🚨\n${displayToken} got carried this game — Fraud Score: ${fraudScore}%\n${stats.join(' • ')}`;
}

/**
 * Build a tilt message for a loss.
 *
 * @param {string} displayToken
 * @param {{ type: 'L'|'W'|null, count: number }} streak
 * @param {{ positiveKd?: boolean, lpDelta?: string|null, today?: object|null, rankLabel?: string|null }} [opts]
 */
export function pickTiltMessage(displayToken, streak, opts = {}) {
  const count = streak?.count ?? 0;
  const onLossStreak = streak?.type === 'L';
  let pool;
  if (onLossStreak && count >= 4) pool = LOSS_STREAK_DEEP;
  else if (onLossStreak && count === 3) pool = LOSS_STREAK_ENTRY;
  else if (onLossStreak && count === 2) pool = SECOND_LOSS;
  else pool = FIRST_LOSS;

  let msg = pickRandom(pool)
    .replaceAll('{name}', displayToken)
    .replaceAll('{n}', String(streak?.count ?? 0));

  msg += buildTiltMeterLine(opts);
  msg += buildDetailLine(opts);
  if (opts.positiveKd) msg += `\n${POSITIVE_KDA_CURSE}`;
  return msg;
}

/**
 * Build a demotion message (replaces the regular tilt message when the player
 * dropped a division/tier on this loss).
 */
export function pickDemotionMessage(displayToken, opts = {}) {
  return (
    DEMOTION_LOSS.replaceAll('{name}', displayToken) +
    buildTiltMeterLine(opts) +
    buildDetailLine(opts)
  );
}

/**
 * Build a promotion message for a win that pushed the player into a new tier.
 */
export function pickPromotionMessage(displayToken, opts = {}) {
  return PROMOTION_WIN.replaceAll('{name}', displayToken) + buildDetailLine(opts);
}

/**
 * Build a "vanilla" win message — called when the player won but didn't
 * promote and isn't on a 4+ streak. Detail line still gets appended.
 */
export function pickRegularWinMessage(displayToken, opts = {}) {
  const template = pickRandom(REGULAR_WIN);
  const lpOrW = opts.lpDelta ?? '1W';
  const msg = template
    .replaceAll('{name}', displayToken)
    .replaceAll('{lp_or_W}', lpOrW);
  return msg + buildDetailLine(opts);
}

/**
 * Build a win-streak message. Only called when streak.count >= 4.
 *   count === 4  → "Is this winners queue? {name}"
 *   count >= 5   → "{name} is hot 🔥 {n} game winstreak"
 */
export function pickWinStreakMessage(displayToken, streak, opts = {}) {
  const count = streak?.count ?? 0;
  const template = count >= 5 ? WIN_STREAK_DEEP : WIN_STREAK_ENTRY;
  const msg = template
    .replaceAll('{name}', displayToken)
    .replaceAll('{n}', String(count));
  return msg + buildDetailLine(opts);
}
