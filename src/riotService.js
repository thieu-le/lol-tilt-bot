// Riot Games API client. Three endpoints we use:
//   - account-v1   (regional): resolve `gameName#tagLine` -> PUUID
//   - match-v5     (regional): list a player's recent match IDs + match details
//   - league-v4    (platform): current rank, division, LP per ranked queue
//
// Regional and platform routes live on DIFFERENT hosts. We keep one axios
// instance per host so each can have its own baseURL but share auth + retry.

import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Attach the shared Retry-After-aware retry policy to any axios instance.
function attachRetryInterceptor(instance, label) {
  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const cfg = error.config;
      const status = error.response?.status;
      if (!cfg || cfg.__retried) throw error;

      if (status === 429) {
        const retryAfterSec = Number.parseInt(
          error.response.headers?.['retry-after'] ?? '1',
          10,
        );
        const waitMs = Math.max(1, retryAfterSec) * 1000;
        logger.warn(`Riot ${label} 429 — retrying in ${waitMs}ms (${cfg.url})`);
        await sleep(waitMs);
        cfg.__retried = true;
        return instance.request(cfg);
      }

      if (status >= 500 && status < 600) {
        logger.warn(`Riot ${label} ${status} — retrying once in 1500ms (${cfg.url})`);
        await sleep(1500);
        cfg.__retried = true;
        return instance.request(cfg);
      }

      throw error;
    },
  );
}

const sharedHeaders = {
  'X-Riot-Token': config.riot.apiKey,
  Accept: 'application/json',
};

const http = axios.create({
  baseURL: `https://${config.riot.regionalRouting}.api.riotgames.com`,
  timeout: 10_000,
  headers: sharedHeaders,
});
attachRetryInterceptor(http, 'regional');

const platformHttp = axios.create({
  baseURL: `https://${config.riot.platformRouting}.api.riotgames.com`,
  timeout: 10_000,
  headers: sharedHeaders,
});
attachRetryInterceptor(platformHttp, 'platform');

/**
 * Resolve a Riot ID (gameName + tagLine) to a PUUID.
 * Riot IDs are case-insensitive; the API normalizes them server-side.
 *
 * Throws an Error with `code: 'NOT_FOUND'` when the Riot ID doesn't exist —
 * callers (slash commands) translate that into a friendly user message.
 */
export async function getAccountByRiotId(gameName, tagLine) {
  const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
    gameName,
  )}/${encodeURIComponent(tagLine)}`;
  try {
    const { data } = await http.get(path);
    return {
      puuid: data.puuid,
      gameName: data.gameName,
      tagLine: data.tagLine,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      const e = new Error(`Riot ID ${gameName}#${tagLine} not found`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    throw err;
  }
}

/**
 * Get the most recent match IDs for a player, newest first. Returns an empty
 * array for brand new accounts or accounts with no matches in the shard's
 * retention window.
 *
 * @param {string} puuid
 * @param {number} count - 1..100
 * @param {{ type?: 'ranked'|'normal'|'tourney'|'tutorial', queue?: number }} [opts]
 *   `type` filters at the Riot API level — e.g. `type:'ranked'` returns only
 *   Solo/Duo + Flex matches, so non-ranked games never hit our pipeline.
 */
export async function getRecentMatchIds(puuid, count = 1, opts = {}) {
  const path = `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids`;
  const params = { start: 0, count };
  if (opts.type) params.type = opts.type;
  if (opts.queue) params.queue = opts.queue;
  const { data } = await http.get(path, { params });
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch full match details by match ID.
 */
export async function getMatch(matchId) {
  const path = `/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const { data } = await http.get(path);
  return data;
}

/**
 * Extract the fields we care about for a given player out of a match payload.
 * Returns null if the player isn't a participant — shouldn't happen for
 * matches surfaced by their own match-id list, but we guard rather than throw.
 *
 * Used by both the poller (won + K/D/A for tilt + KDA-curse logic) and the
 * /history command (everything else).
 */
export function extractMatchSummary(match, puuid) {
  const p = match?.info?.participants?.find((x) => x.puuid === puuid);
  if (!p) return null;

  // Damage share = this player's champ-damage / their team's total champ-damage.
  // Used by the tilt meter to weight "carry vs. AFK" beyond raw KDA.
  const participants = match.info?.participants ?? [];
  const sameTeam = participants.filter((x) => x.teamId === p.teamId);
  const teamDamage = sameTeam.reduce(
    (sum, x) => sum + (x.totalDamageDealtToChampions ?? 0),
    0,
  );
  const playerDamage = p.totalDamageDealtToChampions ?? 0;
  const damageShare = teamDamage > 0 ? playerDamage / teamDamage : null;

  return {
    matchId: match.metadata?.matchId ?? null,
    won: Boolean(p.win),
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
    championName: p.championName ?? 'Unknown',
    queueId: match.info?.queueId ?? null,
    gameStartTimestamp: match.info?.gameStartTimestamp ?? null,
    gameEndTimestamp: match.info?.gameEndTimestamp ?? null,
    gameDuration: match.info?.gameDuration ?? null,
    totalDamageDealtToChampions: playerDamage,
    damageShare,
  };
}

/**
 * Fetch the player's ranked entries (one per ranked queue they've played) via
 * the platform-routed league-v4 endpoint. Returns [] for unranked accounts.
 * Each entry has: queueType, tier, rank (division), leaguePoints, wins, losses.
 */
export async function getRankedEntries(puuid) {
  const path = `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  const { data } = await platformHttp.get(path);
  return Array.isArray(data) ? data : [];
}
