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
const defaultData = { players: [], souls: {} };

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
