// Loads .env, validates required vars, freezes the config object.
// Fails fast on startup if anything required is missing — far better than
// hitting a cryptic 401 from Discord or Riot mid-flight.

import dotenv from 'dotenv';

dotenv.config();

const REQUIRED = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CHANNEL_ID',
  'RIOT_API_KEY',
];

const VALID_REGIONS = ['americas', 'europe', 'asia', 'sea'];

// Platform codes for league-v4 (ranked) endpoints. Distinct from regional
// routing: regional aggregates several platforms, league-v4 talks to one.
const VALID_PLATFORMS = [
  'na1', 'br1', 'la1', 'la2', 'oc1',
  'euw1', 'eun1', 'tr1', 'ru',
  'kr', 'jp1',
  'ph2', 'sg2', 'th2', 'tw2', 'vn2',
];

function readRequired(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function readOptional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

// Validate everything at module load so a misconfigured deploy never gets past
// `node src/index.js`.
for (const name of REQUIRED) readRequired(name);

const regionalRouting = readOptional('RIOT_REGIONAL_ROUTING', 'americas').toLowerCase();
if (!VALID_REGIONS.includes(regionalRouting)) {
  throw new Error(
    `RIOT_REGIONAL_ROUTING must be one of ${VALID_REGIONS.join(', ')} (got "${regionalRouting}")`,
  );
}

const platformRouting = readOptional('RIOT_PLATFORM_ROUTING', 'na1').toLowerCase();
if (!VALID_PLATFORMS.includes(platformRouting)) {
  throw new Error(
    `RIOT_PLATFORM_ROUTING must be one of ${VALID_PLATFORMS.join(', ')} (got "${platformRouting}")`,
  );
}

const pollIntervalMs = Number.parseInt(readOptional('POLL_INTERVAL_MS', '60000'), 10);
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 10_000) {
  // Below 10s would burn through the 100 req / 2min Riot limit fast.
  throw new Error('POLL_INTERVAL_MS must be a number >= 10000 (10 seconds)');
}

// IANA timezone used for the "today" boundary, end-of-day report scheduling,
// and the stale-match guard. UTC was wrong for anyone east or west of zero
// because games crossing UTC midnight got dropped as "historical".
const timezone = readOptional('BOT_TIMEZONE', 'America/Chicago');
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
} catch {
  throw new Error(
    `BOT_TIMEZONE "${timezone}" is not a valid IANA timezone (e.g. America/New_York, America/Chicago, Europe/London)`,
  );
}

export const config = Object.freeze({
  discord: {
    token: readRequired('DISCORD_TOKEN'),
    clientId: readRequired('DISCORD_CLIENT_ID'),
    channelId: readRequired('DISCORD_CHANNEL_ID'),
    guildId: readOptional('DISCORD_GUILD_ID', null),
  },
  riot: {
    apiKey: readRequired('RIOT_API_KEY'),
    regionalRouting: regionalRouting,
    platformRouting: platformRouting,
  },
  pollIntervalMs,
  timezone,
});
