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
 * Channel announcement when /curse is applied. `count` is the post-append size
 * of the cursers array (1 = first curser, 2+ = stacking).
 */
export function buildCurseAppliedMessage(targetMention, curserMention, count) {
  if (count <= 1) {
    return `${targetMention}, you've been cursed to suffer through LosersQ by ${curserMention}. Win a game to break LosersQ. 🪦`;
  }
  return `${curserMention} has joined the curse on ${targetMention}.\n${targetMention} is now cursed by ${count} players. Win a game to break LosersQ. 🪦`;
}

/**
 * Channel announcement when a cursed player wins and breaks the curse.
 */
export function buildCurseBrokenMessage(targetMention, curserMentions) {
  if (curserMentions.length === 1) {
    return `${targetMention} has broken LosersQ. ${curserMentions[0]}'s curse is shattered. 🎉`;
  }
  return `${targetMention} has broken LosersQ. Freed from: ${formatCurserList(curserMentions)}. 🎉`;
}

/**
 * Channel announcement when a cursed player loses and the curse holds.
 */
export function buildCurseLossMessage(targetMention, curserMentions) {
  if (curserMentions.length === 1) {
    return `${curserMentions[0]} has doomed ${targetMention} to LosersQ. 🪦`;
  }
  return `${targetMention} has been doomed to LosersQ by ${formatCurserList(curserMentions)}. 🪦`;
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
