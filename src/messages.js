// Tilt phrases. `{name}` -> pre-formatted display token (`<@id>` or `**Name**`).
// `{n}` -> loss-streak length. Templates don't add their own bold markup; the
// caller controls the name token's formatting so Discord mention pills render.

// Pool tiers, escalating with streak length:
//   count = 1  -> FIRST_LOSS          (rotating, no streak count yet)
//   count = 2  -> SECOND_LOSS         (a simple "is tilted")
//   count = 3  -> LOSS_STREAK_ENTRY   ("you crossed into losersQ" zone)
//   count >= 4 -> LOSS_STREAK_DEEP    ("send help")
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

// Appended on a loss when the player's K/D was still positive (kills >=
// deaths) — i.e., they individually played fine and the team dragged them
// under. Assists are intentionally excluded from the curse trigger.
const POSITIVE_KDA_CURSE = 'Drew Levin cursed them with dog shit teammates';

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Build a tilt message for a loss.
 *
 * @param {string} displayToken - Pre-formatted name token: either a Discord
 *   mention (`<@id>`) or a bolded Riot name (`**Faker**`).
 * @param {{ type: 'L'|'W'|null, count: number }} streak - Streak after this loss.
 * @param {{
 *   positiveKd?: boolean,
 *   lpDelta?: string | null,
 *   today?: { wins: number, losses: number } | null,
 *   rankLabel?: string | null,
 * }} [opts]
 * @returns {string} Message body to send to Discord.
 */
export function pickTiltMessage(displayToken, streak, opts = {}) {
  const count = streak?.count ?? 0;
  const onLossStreak = streak?.type === 'L';
  let pool;
  if (onLossStreak && count >= 4) pool = LOSS_STREAK_DEEP;
  else if (onLossStreak && count === 3) pool = LOSS_STREAK_ENTRY;
  else if (onLossStreak && count === 2) pool = SECOND_LOSS;
  else pool = FIRST_LOSS;
  const template = pickRandom(pool);
  let msg = template
    .replaceAll('{name}', displayToken)
    .replaceAll('{n}', String(streak?.count ?? 0));

  // Detail line: only include fields that are present so non-ranked / first-
  // snapshot scenarios don't render with empty placeholders.
  const detailParts = [];
  if (opts.lpDelta) detailParts.push(opts.lpDelta);
  if (opts.today) detailParts.push(`Today: ${opts.today.wins}-${opts.today.losses}`);
  if (opts.rankLabel) detailParts.push(opts.rankLabel);
  if (detailParts.length > 0) msg += `\n${detailParts.join(' • ')}`;

  if (opts.positiveKd) msg += `\n${POSITIVE_KDA_CURSE}`;
  return msg;
}
