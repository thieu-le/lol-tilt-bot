// Match-v5 timeline analysis. The timeline endpoint returns one snapshot per
// minute per player (cumulative damageStats, gold, xp) plus every event
// (kills with full death-recap damage breakdowns, items, objectives).
//
// Everything here is pure: takes a timeline payload, returns plain numbers.
// Callers treat a null result as "no timeline signal" and fall back to the
// end-of-game stats from match-v5.

// Damage after this mark counts as "late game" for fall-off detection.
const LATE_GAME_MS = 20 * 60 * 1000;
// Games shorter than this don't have enough late game to judge a fall-off.
const MIN_GAME_FOR_LATE_MS = 25 * 60 * 1000;
// A death counts as a tower death when turrets dealt at least this share of
// the damage in the death recap.
const TOWER_DEATH_SHARE = 0.5;
// Kills chained with gaps of at most this long belong to the same fight.
const FIGHT_GAP_MS = 20_000;
// A fight needs at least this many kills (either team) to count as "big".
const BIG_FIGHT_MIN_KILLS = 4;

/**
 * Was the player in this kill? Killer, assister or victim — or they show up
 * in the victim's teamfight damage recap, either hitting the victim or being
 * hit by them. The recap catches players who were in the fight but didn't
 * land the kill or an assist.
 */
function involvedInKill(kill, pid) {
  if (kill.killerId === pid || kill.victimId === pid) return true;
  if ((kill.assistingParticipantIds ?? []).includes(pid)) return true;
  const received = kill.victimTeamfightDamageReceived ?? kill.victimDamageReceived ?? [];
  const dealt = kill.victimTeamfightDamageDealt ?? kill.victimDamageDealt ?? [];
  return received.some((d) => d.participantId === pid) || dealt.some((d) => d.participantId === pid);
}

/** Group kills (sorted by time) into fights by chaining kills ≤20s apart. */
function groupFights(kills) {
  const fights = [];
  let current = [];
  for (const k of kills) {
    if (current.length && k.timestamp - current[current.length - 1].timestamp > FIGHT_GAP_MS) {
      fights.push(current);
      current = [];
    }
    current.push(k);
  }
  if (current.length) fights.push(current);
  return fights;
}

function champDamageAt(frame, participantId) {
  return frame?.participantFrames?.[String(participantId)]?.damageStats?.totalDamageDoneToChampions ?? 0;
}

/** Last frame at or before `ms`, or null. */
function frameAtOrBefore(frames, ms) {
  let found = null;
  for (const f of frames) {
    if (f.timestamp <= ms) found = f;
    else break;
  }
  return found;
}

/**
 * Pull the timeline signals Fraud Watch and God Mode care about for one player.
 *
 * Returns null when the player isn't in the timeline. Fields:
 *   - lateDamageShare: player's share of team champion damage dealt after
 *     20:00 (0..1), or null for games under 25 min / no late damage at all
 *   - damageAt20, lateDamage: raw champion damage before / after 20:00
 *   - towerDeaths: deaths where turrets dealt the majority of the damage
 *   - flow: longest deathless stretch — { minutes, takedowns }
 *   - bigFights / bigFightsJoined: fights with 4+ kills, and how many of
 *     those the player was actually in
 */
export function analyzeTimeline(timeline, puuid) {
  const info = timeline?.info;
  const frames = info?.frames ?? [];
  const pid = info?.participants?.find((x) => x.puuid === puuid)?.participantId;
  if (!pid || frames.length === 0) return null;

  // Participants 1-5 are blue side, 6-10 red side.
  const teamIds = pid <= 5 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];
  const events = frames.flatMap((f) => f.events ?? []);
  const gameEndMs =
    events.find((e) => e.type === 'GAME_END')?.timestamp ?? frames[frames.length - 1].timestamp;

  // --- Late-game fall-off ---------------------------------------------------
  let lateDamageShare = null;
  let damageAt20 = null;
  let lateDamage = null;
  const lastFrame = frames[frames.length - 1];
  const frame20 = frameAtOrBefore(frames, LATE_GAME_MS);
  if (gameEndMs >= MIN_GAME_FOR_LATE_MS && frame20) {
    damageAt20 = champDamageAt(frame20, pid);
    lateDamage = champDamageAt(lastFrame, pid) - damageAt20;
    const teamLate = teamIds.reduce(
      (sum, id) => sum + champDamageAt(lastFrame, id) - champDamageAt(frame20, id),
      0,
    );
    lateDamageShare = teamLate > 0 ? lateDamage / teamLate : null;
  }

  // --- Deaths, tower deaths, takedowns --------------------------------------
  const kills = events.filter((e) => e.type === 'CHAMPION_KILL');
  const deaths = kills.filter((e) => e.victimId === pid);
  const takedownTimes = kills
    .filter((e) => e.killerId === pid || (e.assistingParticipantIds ?? []).includes(pid))
    .map((e) => e.timestamp);

  let towerDeaths = 0;
  for (const d of deaths) {
    const recap = d.victimDamageReceived ?? [];
    let total = 0;
    let tower = 0;
    for (const hit of recap) {
      const dmg = (hit.physicalDamage ?? 0) + (hit.magicDamage ?? 0) + (hit.trueDamage ?? 0);
      total += dmg;
      if (hit.type === 'TOWER') tower += dmg;
    }
    if (total > 0 && tower / total >= TOWER_DEATH_SHARE) towerDeaths += 1;
  }

  // --- Flow state: longest stretch without dying ----------------------------
  const boundaries = [0, ...deaths.map((d) => d.timestamp), gameEndMs];
  let flow = { minutes: 0, takedowns: 0 };
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const minutes = (end - start) / 60_000;
    const takedowns = takedownTimes.filter((t) => t > start && t <= end).length;
    if (minutes > flow.minutes || (minutes === flow.minutes && takedowns > flow.takedowns)) {
      flow = { minutes, takedowns };
    }
  }
  flow.minutes = Math.floor(flow.minutes);

  // --- Big fight attendance -------------------------------------------------
  const bigFights = groupFights(kills).filter((f) => f.length >= BIG_FIGHT_MIN_KILLS);
  const bigFightsJoined = bigFights.filter((f) => f.some((k) => involvedInKill(k, pid))).length;

  return {
    lateDamageShare,
    damageAt20,
    lateDamage,
    towerDeaths,
    flow,
    bigFights: bigFights.length,
    bigFightsJoined,
  };
}

// Phase boundaries for the post-match report's K/D/A breakdown.
const EARLY_END_MS = 14 * 60 * 1000;
const MID_END_MS = 25 * 60 * 1000;

function goldAt(frame, participantId) {
  return frame?.participantFrames?.[String(participantId)]?.totalGold ?? 0;
}

/**
 * Per-minute series for the post-match report chart. Needs the match payload
 * too, to find the lane opponent (same teamPosition on the enemy team).
 *
 * Returns null when the player isn't in the timeline. Fields:
 *   - minutes: x axis, one entry per frame
 *   - damage: { player, teammates, opponent } cumulative champion damage;
 *     teammates is the average of the other four, opponent null if unknown
 *   - goldDiff: player gold − opponent gold per frame, null if no opponent
 *   - events: [{ t (ms), kind: 'kill'|'death'|'assist' }] in time order
 *   - phases: { early, mid, late } each { kills, deaths, assists }
 *   - opponentChampion, gameEndMs
 *   - trivia: computeTrivia() output
 */
export function buildReportSeries(timeline, match, puuid) {
  const info = timeline?.info;
  const frames = info?.frames ?? [];
  const tlParticipants = info?.participants ?? [];
  const pidFor = (p) => tlParticipants.find((x) => x.puuid === p)?.participantId;
  const pid = pidFor(puuid);
  if (!pid || frames.length === 0) return null;

  const matchParticipants = match?.info?.participants ?? [];
  const me = matchParticipants.find((x) => x.puuid === puuid);
  const opp = me?.teamPosition
    ? matchParticipants.find((x) => x.teamId !== me.teamId && x.teamPosition === me.teamPosition)
    : null;
  const oppPid = opp ? pidFor(opp.puuid) : null;
  const teammatePids = (pid <= 5 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10]).filter((x) => x !== pid);

  const events = frames.flatMap((f) => f.events ?? []);
  const gameEndMs =
    events.find((e) => e.type === 'GAME_END')?.timestamp ?? frames[frames.length - 1].timestamp;

  const minutes = frames.map((f) => Math.min(f.timestamp, gameEndMs) / 60_000);
  const damage = {
    player: frames.map((f) => champDamageAt(f, pid)),
    teammates: frames.map(
      (f) => teammatePids.reduce((sum, id) => sum + champDamageAt(f, id), 0) / teammatePids.length,
    ),
    opponent: oppPid ? frames.map((f) => champDamageAt(f, oppPid)) : null,
  };
  const goldDiff = oppPid ? frames.map((f) => goldAt(f, pid) - goldAt(f, oppPid)) : null;

  const kdaEvents = [];
  for (const e of events) {
    if (e.type !== 'CHAMPION_KILL') continue;
    if (e.killerId === pid) kdaEvents.push({ t: e.timestamp, kind: 'kill' });
    else if (e.victimId === pid) kdaEvents.push({ t: e.timestamp, kind: 'death' });
    else if ((e.assistingParticipantIds ?? []).includes(pid)) kdaEvents.push({ t: e.timestamp, kind: 'assist' });
  }

  const phases = {};
  for (const name of ['early', 'mid', 'late']) phases[name] = { kills: 0, deaths: 0, assists: 0 };
  const plural = { kill: 'kills', death: 'deaths', assist: 'assists' };
  for (const ev of kdaEvents) {
    const phase = ev.t < EARLY_END_MS ? 'early' : ev.t < MID_END_MS ? 'mid' : 'late';
    phases[phase][plural[ev.kind]] += 1;
  }

  return {
    minutes,
    damage,
    goldDiff,
    events: kdaEvents,
    phases,
    opponentChampion: opp?.championName ?? null,
    gameEndMs,
    trivia: computeTrivia(timeline, puuid),
  };
}

// --- Trivia -------------------------------------------------------------------

// Base respawn timer (seconds) by champion level, 1-18.
const BASE_RESPAWN_S = [6, 6, 8, 8, 10, 12, 16, 21, 26, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
// Dying again within this long of respawning, without a kill in between,
// counts as a chain int.
const CHAIN_INT_WINDOW_MS = 150_000;
// With a 2.5 min window two deaths in a row is just normal; it takes a run of
// this many to be a real chain int (~17% of games in a 110-game sample).
const CHAIN_INT_MIN_DEATHS = 4;

/**
 * Approximate respawn timer. Riot doesn't put respawn times in the timeline,
 * so this uses the base timer by level plus the late-game time increase
 * factor (grows after 15:00, capped at +50%). Close enough to tell "walked
 * straight back in and died" from "died again a minute later".
 */
function estimateRespawnMs(level, deathMs) {
  const base = BASE_RESPAWN_S[Math.min(Math.max(level, 1), 18) - 1];
  const min = deathMs / 60_000;
  let factor = 0;
  if (min > 15) factor += Math.ceil(2 * (Math.min(min, 30) - 15)) * 0.00425;
  if (min > 30) factor += Math.ceil(2 * (Math.min(min, 45) - 30)) * 0.003;
  if (min > 45) factor += Math.ceil(2 * (min - 45)) * 0.0145;
  return base * (1 + Math.min(factor, 0.5)) * 1000;
}

function levelAt(frames, ms, pid) {
  return frameAtOrBefore(frames, ms)?.participantFrames?.[String(pid)]?.level ?? 1;
}

function hitDamage(hit) {
  return (hit.physicalDamage ?? 0) + (hit.magicDamage ?? 0) + (hit.trueDamage ?? 0);
}

/**
 * Longest run of deaths where each one came within 2.5 min of respawning from
 * the previous, with no kill in between. Returns { deaths, startMs, endMs,
 * longestAliveMs } or null when no run reached 4 deaths.
 */
function findChainInt(frames, deaths, kills, pid) {
  let best = null;
  let run = null;
  for (let i = 0; i < deaths.length; i++) {
    const t = deaths[i].timestamp;
    const prev = deaths[i - 1];
    const aliveFor = prev
      ? t - (prev.timestamp + estimateRespawnMs(levelAt(frames, prev.timestamp, pid), prev.timestamp))
      : Infinity;
    const killedSomeone =
      prev && kills.some((k) => k.killerId === pid && k.timestamp > prev.timestamp && k.timestamp < t);
    if (aliveFor <= CHAIN_INT_WINDOW_MS && !killedSomeone) {
      if (!run) run = { deaths: 1, startMs: prev.timestamp, longestAliveMs: 0 };
      run.deaths += 1;
      run.endMs = t;
      run.longestAliveMs = Math.max(run.longestAliveMs, aliveFor, 0);
      if (!best || run.deaths > best.deaths) best = { ...run };
    } else {
      run = null;
    }
  }
  return best && best.deaths >= CHAIN_INT_MIN_DEATHS ? best : null;
}

/**
 * The big fight where the player did the most, if it was a hard carry:
 * 3+ kills on a decent damage share, or half the team's damage plus 2+ kills
 * in a fight the team won. Damage here is what each side dealt to champions who died in the
 * fight (that's what the death recaps cover).
 */
function findCarryFight(bigFights, pid, teamIds) {
  let best = null;
  for (const fight of bigFights) {
    let playerDmg = 0;
    let teamDmg = 0;
    let kills = 0;
    let enemiesLost = 0;
    let alliesLost = 0;
    for (const k of fight) {
      const victimIsAlly = teamIds.includes(k.victimId);
      if (victimIsAlly) {
        alliesLost += 1;
        continue;
      }
      enemiesLost += 1;
      if (k.killerId === pid) kills += 1;
      for (const hit of k.victimTeamfightDamageReceived ?? k.victimDamageReceived ?? []) {
        if (!teamIds.includes(hit.participantId)) continue;
        teamDmg += hitDamage(hit);
        if (hit.participantId === pid) playerDmg += hitDamage(hit);
      }
    }
    const damageShare = teamDmg > 0 ? playerDmg / teamDmg : 0;
    const wonFight = enemiesLost > alliesLost;
    const carried = (kills >= 3 && damageShare >= 0.25) || (damageShare >= 0.5 && wonFight && kills >= 2);
    if (!carried) continue;
    const impact = kills + damageShare * 4;
    if (!best || impact > best.impact) {
      best = { t: fight[0].timestamp, kills, damageShare, enemiesLost, alliesLost, impact };
    }
  }
  return best;
}

/**
 * Did each death buy anything? A death is "traded" when, in the fight it
 * happened in (kills chained ≤20s apart), the player got a takedown or their
 * team lost no more champions than the enemy did. A solo death with nothing
 * back is the textbook untraded death.
 * Returns { deaths, traded }.
 */
function countTradedDeaths(fights, pid, teamIds) {
  let deaths = 0;
  let traded = 0;
  for (const fight of fights) {
    const myDeaths = fight.filter((k) => k.victimId === pid).length;
    if (myDeaths === 0) continue;
    deaths += myDeaths;
    const enemiesLost = fight.filter((k) => !teamIds.includes(k.victimId)).length;
    const alliesLost = fight.length - enemiesLost;
    const tookSomeone = fight.some(
      (k) =>
        !teamIds.includes(k.victimId) &&
        (k.killerId === pid || (k.assistingParticipantIds ?? []).includes(pid)),
    );
    if (tookSomeone || enemiesLost >= alliesLost) traded += myDeaths;
  }
  return { deaths, traded };
}

/**
 * Raw signals for the post-match trivia section. Formatting lives in
 * report.js. Returns { chainInt, carryFight, bigFights, bigFightsJoined,
 * deathValue }.
 */
export function computeTrivia(timeline, puuid) {
  const info = timeline?.info;
  const frames = info?.frames ?? [];
  const pid = info?.participants?.find((x) => x.puuid === puuid)?.participantId;
  if (!pid || frames.length === 0) return null;
  const teamIds = pid <= 5 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];

  const kills = frames.flatMap((f) => f.events ?? []).filter((e) => e.type === 'CHAMPION_KILL');
  const deaths = kills.filter((e) => e.victimId === pid);
  const fights = groupFights(kills);
  const bigFights = fights.filter((f) => f.length >= BIG_FIGHT_MIN_KILLS);

  return {
    chainInt: findChainInt(frames, deaths, kills, pid),
    carryFight: findCarryFight(bigFights, pid, teamIds),
    bigFights: bigFights.length,
    bigFightsJoined: bigFights.filter((f) => f.some((k) => involvedInKill(k, pid))).length,
    deathValue: countTradedDeaths(fights, pid, teamIds),
  };
}
