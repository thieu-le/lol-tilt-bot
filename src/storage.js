// JSON-file persistence for tracked players, last-processed match IDs, and
// streak counters. We use lowdb v7 (async, ESM) because:
//   - it requires zero schema setup
//   - writes are atomic (temp file + rename) so a crash mid-write won't corrupt
//   - SQLite would be overkill for a few dozen players
//
// One process, one file. If you ever need multi-process coordination, replace
// this module — the rest of the bot only sees the exported functions.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { JSONFilePreset } from 'lowdb/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

// Default DB shape — written on first boot.
// `souls` is keyed by Discord user ID → { balance, totalEarned }. It lives at
// the top level because curse payouts go to Discord users, not tracked players
// (the curser may not be a tracked LoL player).
// `bets` is an array of bet pools created automatically when a tracked player
// enters an active ranked game (detected via spectator-v5). Resolves when
// match-v5 surfaces the finished match.
const defaultData = { players: [], souls: {}, bets: [] };

let db = null;

/**
 * Initialize the JSON store. Creates the data directory + file if missing.
 * Must be called once during boot before any other storage method.
 */
export async function init() {
  await mkdir(DATA_DIR, { recursive: true });
  db = await JSONFilePreset(STORE_PATH, defaultData);
  // JSONFilePreset already loads on creation; this `read` is belt-and-braces.
  await db.read();
  db.data ||= structuredClone(defaultData);
  // Fill in any new top-level collections introduced after the file was first
  // written. Without this, an older store.json would be missing `souls` and
  // every getSouls call would NPE.
  db.data.players ||= [];
  db.data.souls ||= {};
  db.data.bets ||= [];
  await db.write();
}

function ensureReady() {
  if (!db) throw new Error('storage.init() was never called');
}

/**
 * Returns a copy of the tracked player list. Callers must not mutate.
 */
export function getPlayers() {
  ensureReady();
  return db.data.players.map((p) => ({ ...p }));
}

/**
 * Look up a player by Riot ID (case-insensitive on both parts).
 * Riot IDs are unique per region but the bot is single-region, so this is fine.
 */
export function findByRiotId(gameName, tagLine) {
  ensureReady();
  const g = gameName.toLowerCase();
  const t = tagLine.toLowerCase();
  const found = db.data.players.find(
    (p) =>
      p.riotId.gameName.toLowerCase() === g &&
      p.riotId.tagLine.toLowerCase() === t,
  );
  return found ? { ...found } : null;
}

export function findByPuuid(puuid) {
  ensureReady();
  const found = db.data.players.find((p) => p.puuid === puuid);
  return found ? { ...found } : null;
}

/**
 * Insert a new tracked player. Throws if puuid already exists — callers should
 * check first via findByPuuid / findByRiotId.
 */
export async function addPlayer(player) {
  ensureReady();
  if (db.data.players.some((p) => p.puuid === player.puuid)) {
    throw new Error(`Player with puuid ${player.puuid} is already tracked`);
  }
  db.data.players.push({
    puuid: player.puuid,
    riotId: {
      gameName: player.riotId.gameName,
      tagLine: player.riotId.tagLine,
    },
    lastProcessedMatchId: player.lastProcessedMatchId ?? null,
    discordUserId: player.discordUserId ?? null,
    streak: player.streak ?? { type: null, count: 0 },
    wins: player.wins ?? 0,
    losses: player.losses ?? 0,
    today: player.today ?? { date: null, wins: 0, losses: 0 },
    lastRank: player.lastRank ?? null,
    cursers: player.cursers ?? [],
    // Rolling window of the last 20 ranked match outcomes ('W' | 'L'), oldest
    // first. Used by the souls payout multiplier to gauge "recent form".
    recentResults: player.recentResults ?? [],
    addedAt: player.addedAt ?? new Date().toISOString(),
  });
  await db.write();
}

/**
 * Remove a player by puuid. Returns true if a record was removed.
 */
export async function removePlayer(puuid) {
  ensureReady();
  const before = db.data.players.length;
  db.data.players = db.data.players.filter((p) => p.puuid !== puuid);
  const removed = db.data.players.length !== before;
  if (removed) await db.write();
  return removed;
}

// --- Souls (Discord-user currency) -----------------------------------------

/**
 * Read a Discord user's soul balance. Returns the default zero record for
 * users who have never received souls.
 */
export function getSouls(discordUserId) {
  ensureReady();
  const entry = db.data.souls?.[discordUserId];
  if (!entry) return { balance: 0, totalEarned: 0 };
  return { ...entry };
}

/**
 * Credit a Discord user with `amount` souls. Updates both `balance` and the
 * lifetime `totalEarned` counter. Negative or zero amounts are no-ops.
 * Returns the new record.
 */
export async function awardSouls(discordUserId, amount) {
  ensureReady();
  if (!Number.isFinite(amount) || amount <= 0) {
    return getSouls(discordUserId);
  }
  db.data.souls ||= {};
  const prev = db.data.souls[discordUserId] ?? { balance: 0, totalEarned: 0 };
  const next = {
    balance: prev.balance + amount,
    totalEarned: prev.totalEarned + amount,
  };
  db.data.souls[discordUserId] = next;
  await db.write();
  return { ...next };
}

/**
 * Deduct souls from a Discord user. Returns `{ ok: true, balance }` on
 * success or `{ ok: false, balance }` if they don't have enough. The
 * `totalEarned` counter is NOT touched (it's lifetime gross, not net).
 */
export async function spendSouls(discordUserId, amount) {
  ensureReady();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Spend amount must be a positive number');
  }
  db.data.souls ||= {};
  const prev = db.data.souls[discordUserId] ?? { balance: 0, totalEarned: 0 };
  if (prev.balance < amount) {
    return { ok: false, balance: prev.balance };
  }
  const next = { balance: prev.balance - amount, totalEarned: prev.totalEarned };
  db.data.souls[discordUserId] = next;
  await db.write();
  return { ok: true, balance: next.balance };
}

/**
 * Top-N souls leaderboard by current balance. Returns an array of
 * `{ discordUserId, balance, totalEarned }` sorted descending. Users with zero
 * balance are excluded.
 */
export function getSoulsLeaderboard(limit = 10) {
  ensureReady();
  const entries = Object.entries(db.data.souls ?? {})
    .map(([discordUserId, v]) => ({
      discordUserId,
      balance: v.balance ?? 0,
      totalEarned: v.totalEarned ?? 0,
    }))
    .filter((e) => e.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  return entries.slice(0, limit);
}

/**
 * Apply a partial update to a player record by puuid.
 */
export async function updatePlayer(puuid, patch) {
  ensureReady();
  const player = db.data.players.find((p) => p.puuid === puuid);
  if (!player) throw new Error(`No tracked player with puuid ${puuid}`);
  // Allow nested replacement for streak and today; everything else is a shallow merge.
  if (patch.streak) {
    player.streak = { ...player.streak, ...patch.streak };
    delete patch.streak;
  }
  if (patch.today) {
    // Full replace rather than merge — callers send the new {date, wins, losses}
    // as a complete object whenever today changes.
    player.today = { ...patch.today };
    delete patch.today;
  }
  Object.assign(player, patch);
  await db.write();
}

// --- Bets (live in-game prediction pools) ----------------------------------

/**
 * Create a new bet pool. Caller is responsible for the bet shape:
 *   { gameId, puuid, riotIdSnapshot, displayName, targetDiscordId,
 *     status: 'open' | 'awaiting_resolve' | 'resolved' | 'refunded',
 *     openedAt, channelMessageId,
 *     pools: { win, loss }, stakes: { [discordUserId]: { win, loss } },
 *     resolvedSide, resolvedAt }
 * Returns a copy of the stored bet.
 */
export async function createBet(bet) {
  ensureReady();
  db.data.bets ||= [];
  db.data.bets.push({ ...bet });
  await db.write();
  return { ...bet };
}

export function getBetByGameId(gameId) {
  ensureReady();
  const b = db.data.bets?.find((x) => x.gameId === gameId);
  return b ? { ...b } : null;
}

export function getBetByMessageId(messageId) {
  ensureReady();
  const b = db.data.bets?.find((x) => x.channelMessageId === messageId);
  return b ? { ...b } : null;
}

export function getOpenBetsForPuuid(puuid) {
  ensureReady();
  return (db.data.bets ?? [])
    .filter((b) => b.puuid === puuid && (b.status === 'open' || b.status === 'awaiting_resolve'))
    .map((b) => ({ ...b }));
}

export function getBetsByStatus(...statuses) {
  ensureReady();
  const set = new Set(statuses);
  return (db.data.bets ?? []).filter((b) => set.has(b.status)).map((b) => ({ ...b }));
}

/**
 * Add (or top up) a Discord user's stake on a bet. Mutates pools and the
 * user's stakes entry. Returns the updated bet copy.
 *
 * Caller must verify the bet is open and the user has sufficient soul balance
 * before calling this — souls are deducted by the curse-side logic in awardSouls.
 * This function only records the stake against the bet.
 */
export async function addStake(gameId, discordUserId, side, amount) {
  ensureReady();
  if (side !== 'win' && side !== 'loss') {
    throw new Error(`Invalid bet side ${side}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Stake amount must be a positive number');
  }
  const bet = db.data.bets?.find((x) => x.gameId === gameId);
  if (!bet) throw new Error(`No bet for gameId ${gameId}`);

  bet.pools = bet.pools ?? { win: 0, loss: 0 };
  bet.stakes = bet.stakes ?? {};
  bet.pools[side] += amount;
  const prior = bet.stakes[discordUserId] ?? { win: 0, loss: 0 };
  bet.stakes[discordUserId] = {
    win: prior.win + (side === 'win' ? amount : 0),
    loss: prior.loss + (side === 'loss' ? amount : 0),
  };
  await db.write();
  return { ...bet };
}

/**
 * Apply a shallow patch to a bet by gameId. Used for status transitions
 * (open → awaiting_resolve → resolved/refunded) and to store the
 * channelMessageId after the first post.
 */
export async function updateBet(gameId, patch) {
  ensureReady();
  const bet = db.data.bets?.find((x) => x.gameId === gameId);
  if (!bet) throw new Error(`No bet for gameId ${gameId}`);
  Object.assign(bet, patch);
  await db.write();
  return { ...bet };
}
