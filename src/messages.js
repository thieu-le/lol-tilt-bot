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

  msg += buildDetailLine(opts);
  if (opts.positiveKd) msg += `\n${POSITIVE_KDA_CURSE}`;
  return msg;
}

/**
 * Build a demotion message (replaces the regular tilt message when the player
 * dropped a division/tier on this loss).
 */
export function pickDemotionMessage(displayToken, opts = {}) {
  return DEMOTION_LOSS.replaceAll('{name}', displayToken) + buildDetailLine(opts);
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
