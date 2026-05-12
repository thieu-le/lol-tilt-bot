// Pure helpers for ranked-queue logic. No I/O — input is league-v4 entry
// shapes, output is plain values. Kept separate from riotService so it's easy
// to unit-test in isolation if/when we add a test framework.

// Riot's tier strings (lowest to highest).
export const TIER_ORDER = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
];

// Riot returns roman numeral divisions; lowest-to-highest within a tier.
export const DIVISION_ORDER = ['IV', 'III', 'II', 'I'];

const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

// Queue ID -> Riot queueType string used in league-v4 entries.
const QUEUE_ID_TO_TYPE = {
  420: 'RANKED_SOLO_5x5',
  440: 'RANKED_FLEX_SR',
};

export function isRankedQueue(queueId) {
  return Object.prototype.hasOwnProperty.call(QUEUE_ID_TO_TYPE, queueId);
}

/**
 * Given the array of entries from league-v4, pick the one matching the queue
 * the player just played. Returns the raw entry or null if not found.
 */
export function findEntryForQueue(entries, queueId) {
  const wantedType = QUEUE_ID_TO_TYPE[queueId];
  if (!wantedType || !Array.isArray(entries)) return null;
  return entries.find((e) => e.queueType === wantedType) ?? null;
}

/**
 * Convert a league-v4 entry into the snapshot shape we persist.
 */
export function entryToSnapshot(entry) {
  return {
    queueType: entry.queueType,
    tier: entry.tier,
    division: entry.rank, // league-v4 calls the division "rank"; we rename to avoid confusion
    leaguePoints: entry.leaguePoints,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Compose a human-readable rank label: "Silver II 12 LP" / "Master 312 LP".
 */
export function formatRank(snapshot) {
  if (!snapshot) return null;
  const tierTitle = snapshot.tier.charAt(0) + snapshot.tier.slice(1).toLowerCase();
  if (APEX_TIERS.has(snapshot.tier)) {
    return `${tierTitle} ${snapshot.leaguePoints} LP`;
  }
  return `${tierTitle} ${snapshot.division} ${snapshot.leaguePoints} LP`;
}

/**
 * Numeric "ladder index" used to order rank snapshots. Apex tiers all collapse
 * to the same division (I); their LP value carries the ordering.
 * Returns a number where higher = more impressive rank.
 */
function ladderIndex(snapshot) {
  const tierIdx = TIER_ORDER.indexOf(snapshot.tier);
  if (APEX_TIERS.has(snapshot.tier)) {
    // Push apex tiers past every regular tier × division combination.
    return TIER_ORDER.length * DIVISION_ORDER.length + tierIdx;
  }
  const divIdx = DIVISION_ORDER.indexOf(snapshot.division);
  return tierIdx * DIVISION_ORDER.length + divIdx;
}

/**
 * Best-effort signed LP delta between two snapshots of the same queue.
 *
 * Riot does not expose the per-match LP change. We approximate:
 *   - Same tier & division: trivial subtraction.
 *   - Promotion (curr ladder > prev ladder): treated as if prev went from
 *     prev.lp -> 100 (across the tier line) and then 0 -> curr.lp.
 *   - Demotion (curr ladder < prev ladder): symmetric — prev.lp -> 0 then 100
 *     -> curr.lp, reported as negative.
 *   - Apex-to-apex (both in Master/GM/Challenger): just `curr.lp - prev.lp`,
 *     since LP is uncapped and division is meaningless.
 *
 * Returns null if either snapshot is missing or queues don't match.
 */
export function computeLpDelta(prev, curr) {
  if (!prev || !curr) return null;
  if (prev.queueType !== curr.queueType) return null;

  const bothApex = APEX_TIERS.has(prev.tier) && APEX_TIERS.has(curr.tier);
  if (bothApex) return curr.leaguePoints - prev.leaguePoints;

  if (prev.tier === curr.tier && prev.division === curr.division) {
    return curr.leaguePoints - prev.leaguePoints;
  }

  const prevIdx = ladderIndex(prev);
  const currIdx = ladderIndex(curr);
  if (currIdx > prevIdx) {
    // Promotion: assume one rung crossed (Riot rarely promotes multiple in a single match).
    return 100 - prev.leaguePoints + curr.leaguePoints;
  }
  if (currIdx < prevIdx) {
    // Demotion.
    return -(prev.leaguePoints + (100 - curr.leaguePoints));
  }
  // Shouldn't reach — tier+div equal handled above.
  return curr.leaguePoints - prev.leaguePoints;
}

/**
 * Format an LP delta as a signed string with units, or null if not computable.
 */
export function formatLpDelta(delta) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return null;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta} LP`;
}

/**
 * Detect whether a rank change between two snapshots of the same queue was a
 * promotion, demotion, or neither. Returns null if either snapshot is missing
 * or the queues don't match.
 *
 * @returns {'promoted' | 'demoted' | null}
 */
export function getRankChange(prev, curr) {
  if (!prev || !curr) return null;
  if (prev.queueType !== curr.queueType) return null;
  const prevIdx = ladderIndex(prev);
  const currIdx = ladderIndex(curr);
  if (currIdx > prevIdx) return 'promoted';
  if (currIdx < prevIdx) return 'demoted';
  return null;
}

/**
 * Compute the new streak after observing a match outcome.
 *
 * @param {{ type: 'W'|'L'|null, count: number }} prev
 * @param {boolean} won
 */
export function nextStreak(prev, won) {
  const type = won ? 'W' : 'L';
  if (prev?.type === type) return { type, count: prev.count + 1 };
  return { type, count: 1 };
}

/**
 * Compute today's record after one match, resetting on UTC date change.
 */
export function nextToday(prev, won) {
  const today = utcDateKey();
  const base = prev?.date === today ? prev : { date: today, wins: 0, losses: 0, lpDelta: 0 };
  return {
    date: today,
    wins: base.wins + (won ? 1 : 0),
    losses: base.losses + (won ? 0 : 1),
    lpDelta: base.lpDelta ?? 0, // caller adds this match's numeric delta after
  };
}

/**
 * Current UTC date in YYYY-MM-DD form. Used as the bucket key for today's record.
 */
export function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * UTC date (YYYY-MM-DD) of an epoch-millisecond timestamp. Returns null when
 * the input isn't a valid number — caller decides how to handle missing data.
 */
export function dateKeyForTimestamp(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  return new Date(epochMs).toISOString().slice(0, 10);
}
