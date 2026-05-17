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
const defaultData = { players: [] };

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
