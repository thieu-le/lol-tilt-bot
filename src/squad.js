// Ranked 5s / flex stacks: when 3+ tracked players are on the same team, the
// game gets ONE shared post instead of one per player. It calls out who
// carried and who played the worst, scored across all five teammates, and on
// a thrown loss who griefed it (see detectThrow), and collects each squadmate's own lines (tilt message,
// Fraud Watch, curses, bets) as they're processed.

import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { computeTrivia } from './timeline.js';

// Tracked players on one team needed to count as a squad game.
export const SQUAD_MIN_TRACKED = 3;

// Throw detection (losses only). A game is "thrown" when the enemy takes
// Baron or Elder — or our team falls from a big gold lead — and the game ends
// shortly after. The griefer is whoever kept dying from that point to the
// Nexus falling.
const THROW_OBJECTIVE_WINDOW_MS = 6 * 60 * 1000; // objective → game end
const THROW_MAX_DEFICIT = 3000; // already this far behind = lost, not thrown
const THROW_LEAD = 3000; // peak team gold lead that counts as "we were winning"
const THROW_LEAD_LOOKBACK_MS = 12 * 60 * 1000;
const OBJECTIVE_FIGHT_LEAD_MS = 45_000; // deaths this long before the objective count as "the fight"
const OBJECTIVE_FIGHT_TAIL_MS = 15_000;
const GRIEF_MIN_DEATHS = 2;
// Supports aren't supposed to top damage — floor their damage share at a
// typical support's so they're judged on KP and vision instead.
const SUPPORT_DAMAGE_FLOOR = 0.15;

/**
 * Tracked players on `puuid`'s team in this match, or null when fewer than
 * SQUAD_MIN_TRACKED. Returns { teamId, members: [trackedPlayer], key }.
 */
export function findSquad(match, puuid, trackedPlayers) {
  const participants = match?.info?.participants ?? [];
  const me = participants.find((p) => p.puuid === puuid);
  if (!me) return null;
  const teamPuuids = new Set(participants.filter((p) => p.teamId === me.teamId).map((p) => p.puuid));
  const members = trackedPlayers.filter((t) => teamPuuids.has(t.puuid));
  if (members.length < SQUAD_MIN_TRACKED) return null;
  const key = members.map((m) => m.puuid).sort().join(',');
  return { teamId: me.teamId, members, key };
}

function share(value, total) {
  return total > 0 ? value / total : 0;
}

/**
 * Score every player on the squad's team and pick the carry and the worst.
 * `rawTimeline` is optional; without it the untraded-death and chain-int
 * penalties are skipped. Returns { won, ranked: [entry], carry, worst }
 * where entry = { participant, score, kda, damageShare, killParticipation,
 * untraded, chainInt }.
 */
export function computeSquadVerdict(match, teamId, rawTimeline = null) {
  const team = (match?.info?.participants ?? []).filter((p) => p.teamId === teamId);
  const sum = (field) => team.reduce((s, p) => s + (p[field] ?? 0), 0);
  const teamKills = sum('kills');
  const teamDamage = sum('totalDamageDealtToChampions');
  const teamTurret = sum('damageDealtToTurrets');
  const teamVision = sum('visionScore');

  const entries = team.map((p) => {
    const kda = (p.kills + p.assists) / Math.max(p.deaths, 1);
    const damageShare = share(p.totalDamageDealtToChampions ?? 0, teamDamage);
    const killParticipation = share(p.kills + p.assists, teamKills);
    const trivia = rawTimeline ? computeTrivia(rawTimeline, p.puuid) : null;
    const untraded = trivia?.deathValue ? trivia.deathValue.deaths - trivia.deathValue.traded : 0;
    const chainInt = trivia?.chainInt ?? null;

    const isSupport = p.teamPosition === 'UTILITY';
    const score =
      (isSupport ? Math.max(damageShare, SUPPORT_DAMAGE_FLOOR) : damageShare) * 100 +
      killParticipation * 25 +
      Math.min(kda, 8) * 2.5 +
      share(p.damageDealtToTurrets ?? 0, teamTurret) * 10 +
      share(p.visionScore ?? 0, teamVision) * (isSupport ? 25 : 10) -
      untraded * 3 -
      (chainInt ? 8 : 0);

    return { participant: p, score, kda, damageShare, killParticipation, untraded, chainInt };
  });

  const ranked = [...entries].sort((a, b) => b.score - a.score);
  const won = Boolean(team[0]?.win);
  return {
    won,
    ranked,
    carry: ranked[0],
    worst: ranked[ranked.length - 1],
    throw: won ? null : detectThrow(match, teamId, rawTimeline),
  };
}

function teamGoldAt(frame, pids) {
  return pids.reduce((sum, id) => sum + (frame?.participantFrames?.[String(id)]?.totalGold ?? 0), 0);
}

/**
 * Find the moment a lost game was thrown and who griefed it. Returns null
 * when there's no timeline, no throw, or nobody died enough to blame.
 *
 * Throw point, in order of preference:
 *   1. The enemy's last Baron / Elder within 6 min of the game ending, if we
 *      weren't already 3k+ gold behind a minute before it.
 *   2. Otherwise, our peak team gold lead in the last 12 min, if it was 3k+
 *      (we were winning and lost anyway).
 * Blame = deaths from the throw fight to the end, +1.5 for dying first in
 * the objective fight. Needs 2+ deaths in the window.
 *
 * Returns { kind: 'objective'|'lead', objective, t, endMs, goldLead,
 *           griefer: { participant, deaths, diedFirst }, teamDeaths }.
 */
export function detectThrow(match, teamId, rawTimeline) {
  const info = rawTimeline?.info;
  const frames = info?.frames ?? [];
  if (!frames.length) return null;

  const pidByPuuid = new Map((info.participants ?? []).map((x) => [x.puuid, x.participantId]));
  const team = (match?.info?.participants ?? []).filter((p) => p.teamId === teamId);
  const ourPids = team.map((p) => pidByPuuid.get(p.puuid)).filter(Boolean);
  const enemyPids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((id) => !ourPids.includes(id));
  const participantByPid = new Map(team.map((p) => [pidByPuuid.get(p.puuid), p]));

  const events = frames.flatMap((f) => f.events ?? []);
  const endMs = events.find((e) => e.type === 'GAME_END')?.timestamp ?? frames[frames.length - 1].timestamp;
  const leadAt = (ms) => {
    const frame = [...frames].reverse().find((f) => f.timestamp <= ms) ?? frames[0];
    return teamGoldAt(frame, ourPids) - teamGoldAt(frame, enemyPids);
  };

  // 1. Lost Baron / Elder shortly before the end.
  let throwPoint = null;
  const lostObjective = events
    .filter(
      (e) =>
        e.type === 'ELITE_MONSTER_KILL' &&
        e.killerTeamId !== teamId &&
        (e.monsterType === 'BARON_NASHOR' || e.monsterSubType === 'ELDER_DRAGON') &&
        endMs - e.timestamp <= THROW_OBJECTIVE_WINDOW_MS,
    )
    .pop();
  if (lostObjective) {
    const goldLead = leadAt(lostObjective.timestamp - 60_000);
    if (goldLead > -THROW_MAX_DEFICIT) {
      throwPoint = {
        kind: 'objective',
        objective: lostObjective.monsterType === 'BARON_NASHOR' ? 'Baron' : 'Elder',
        t: lostObjective.timestamp,
        goldLead,
      };
    }
  }

  // 2. Blew a big gold lead late.
  if (!throwPoint) {
    let peak = null;
    for (const f of frames) {
      if (endMs - f.timestamp > THROW_LEAD_LOOKBACK_MS) continue;
      const lead = teamGoldAt(f, ourPids) - teamGoldAt(f, enemyPids);
      if (!peak || lead > peak.goldLead) peak = { t: f.timestamp, goldLead: lead };
    }
    if (peak && peak.goldLead >= THROW_LEAD) throwPoint = { kind: 'lead', ...peak };
  }
  if (!throwPoint) return null;

  const fightStart = throwPoint.kind === 'objective' ? throwPoint.t - OBJECTIVE_FIGHT_LEAD_MS : throwPoint.t;
  const ourDeaths = events.filter(
    (e) => e.type === 'CHAMPION_KILL' && ourPids.includes(e.victimId) && e.timestamp >= fightStart,
  );
  if (!ourDeaths.length) return null;

  const firstAtObjective =
    throwPoint.kind === 'objective'
      ? ourDeaths.find((e) => e.timestamp <= throwPoint.t + OBJECTIVE_FIGHT_TAIL_MS)?.victimId ?? null
      : null;

  const blame = new Map();
  for (const d of ourDeaths) {
    const b = blame.get(d.victimId) ?? { deaths: 0, firstDeathMs: d.timestamp };
    b.deaths += 1;
    blame.set(d.victimId, b);
  }
  let griefer = null;
  for (const [pid, b] of blame) {
    const diedFirst = pid === firstAtObjective;
    const points = b.deaths + (diedFirst ? 1.5 : 0);
    if (
      !griefer ||
      points > griefer.points ||
      (points === griefer.points && b.firstDeathMs < griefer.firstDeathMs)
    ) {
      griefer = { pid, points, deaths: b.deaths, diedFirst, firstDeathMs: b.firstDeathMs };
    }
  }
  if (!griefer || griefer.deaths < GRIEF_MIN_DEATHS) return null;

  return {
    ...throwPoint,
    endMs,
    teamDeaths: ourDeaths.length,
    griefer: {
      participant: participantByPid.get(griefer.pid),
      deaths: griefer.deaths,
      diedFirst: griefer.diedFirst,
    },
  };
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatLead(gold) {
  const k = (Math.abs(gold) / 1000).toFixed(1);
  if (Math.abs(gold) < 500) return 'even on gold';
  return gold > 0 ? `up ${k}k gold` : `down ${k}k gold`;
}

/** "🚮 Griefed: ..." line for a detected throw. */
function buildGriefLine(thrown, trackedByPuuid) {
  const { griefer } = thrown;
  const who = `${nameFor(griefer.participant, trackedByPuuid)} (${griefer.participant.championName})`;
  const nexus = `the Nexus fell at ${clock(thrown.endMs)}`;
  if (thrown.kind === 'objective') {
    const what = griefer.diedFirst
      ? `died first at ${thrown.objective} (${clock(thrown.t)}), then ${griefer.deaths - 1} more time${griefer.deaths - 1 === 1 ? '' : 's'} before ${nexus}`
      : `died ${griefer.deaths} times between losing ${thrown.objective} (${clock(thrown.t)}) and ${nexus}`;
    return `🚮 Griefed: ${who} — ${what}. We were ${formatLead(thrown.goldLead)} before ${thrown.objective}; team died ${thrown.teamDeaths} times after.`;
  }
  return `🚮 Griefed: ${who} — we were up ${(thrown.goldLead / 1000).toFixed(1)}k gold at ${clock(thrown.t)}, then they died ${griefer.deaths} times before ${nexus}.`;
}

/** `<@id>` for tracked players with a Discord link, otherwise their Riot name. */
function nameFor(participant, trackedByPuuid) {
  const tracked = trackedByPuuid.get(participant.puuid);
  if (tracked?.discordUserId) return `<@${tracked.discordUserId}>`;
  return `**${participant.riotIdGameName ?? tracked?.riotId?.gameName ?? participant.championName}**`;
}

function statLine(entry) {
  const p = entry.participant;
  return `${p.kills}/${p.deaths}/${p.assists} • ${Math.round(entry.damageShare * 100)}% dmg • ${Math.round(entry.killParticipation * 100)}% KP`;
}

/**
 * The squad post's header text: result, carry and worst call-outs. Plain
 * string so it can be stored and re-rendered on every edit.
 */
export function buildSquadHeader(verdict, squad) {
  const trackedByPuuid = new Map(squad.members.map((m) => [m.puuid, m]));
  const label = squad.members.length >= 5 ? 'RANKED 5s' : `${squad.members.length}-STACK`;
  const lines = [`🎮 **${label}** — ${verdict.won ? '✅ VICTORY' : '❌ DEFEAT'}`];

  const { carry, worst } = verdict;
  const carryTitle = verdict.won ? '👑 Carried' : '👑 Tried to carry';
  lines.push(`${carryTitle}: ${nameFor(carry.participant, trackedByPuuid)} (${carry.participant.championName}) — ${statLine(carry)}`);

  const why = [];
  if (worst.untraded > 0) why.push(`${worst.untraded} death${worst.untraded === 1 ? '' : 's'} for nothing`);
  if (worst.chainInt) why.push(`chain inted ${worst.chainInt.deaths} deaths`);
  lines.push(
    `🧊 Weakest link: ${nameFor(worst.participant, trackedByPuuid)} (${worst.participant.championName}) — ${statLine(worst)}${why.length ? ` • ${why.join(', ')}` : ''}`,
  );
  if (verdict.throw) lines.push(buildGriefLine(verdict.throw, trackedByPuuid));
  return lines.join('\n');
}

/** Scoreboard of the whole team, best to worst. */
export function buildSquadScoreboard(verdict, squad) {
  const trackedByPuuid = new Map(squad.members.map((m) => [m.puuid, m]));
  return verdict.ranked
    .map((e, i) => `${i + 1}. ${nameFor(e.participant, trackedByPuuid)} ${e.participant.championName} — ${statLine(e)}`)
    .join('\n');
}

// --- Squad vote -----------------------------------------------------------
//
// Every squad post carries a vote: the players in the game pick who griefed,
// who inted and who tilted. Live tallies render on the post; the vote closes
// after SQUAD_VOTE_WINDOW_MS or when the squad's next game replaces the post.

export const SQUAD_VOTE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const VOTE_CATEGORIES = [
  { key: 'griefed', emoji: '🚮', question: 'Who griefed?', title: 'Griefed' },
  { key: 'inted', emoji: '💀', question: 'Who inted?', title: 'Inted' },
  { key: 'tilted', emoji: '😤', question: 'Who tilted?', title: 'Tilted' },
];
export const VOTE_NOBODY = 'nobody';
const VOTE_CUSTOM_ID_PREFIX = 'squadvote';

/**
 * The five teammates as vote options: [{ id, label }]. `id` is a short
 * stable key (option values are capped at 100 chars, so no puuids).
 */
export function buildVoteRoster(verdict, squad) {
  const trackedByPuuid = new Map(squad.members.map((m) => [m.puuid, m]));
  return verdict.ranked.map((e, i) => {
    const p = e.participant;
    const name = trackedByPuuid.get(p.puuid)?.riotId?.gameName ?? p.riotIdGameName ?? 'Unknown';
    return { id: String(i + 1), label: `${p.championName} — ${name}`.slice(0, 100) };
  });
}

/** `squadvote:<matchId>:<category>` → { matchId, category } or null. */
export function parseVoteCustomId(customId) {
  const [prefix, matchId, category] = String(customId ?? '').split(':');
  if (prefix !== VOTE_CUSTOM_ID_PREFIX || !matchId || !category) return null;
  return { matchId, category };
}

/**
 * Top pick per category: { [key]: { labels: [..], count } | null }. Ties
 * list everyone tied; "Nobody" can win too. Null when nobody voted.
 */
export function voteWinners(post) {
  const rosterById = new Map((post.vote?.roster ?? []).map((r) => [r.id, r.label]));
  const winners = {};
  for (const { key } of VOTE_CATEGORIES) {
    const counts = new Map();
    for (const ballot of Object.values(post.vote?.ballots ?? {})) {
      const pick = ballot[key];
      if (pick) counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
    const top = Math.max(0, ...counts.values());
    winners[key] = top
      ? {
          count: top,
          labels: [...counts]
            .filter(([, n]) => n === top)
            .map(([id]) => (id === VOTE_NOBODY ? 'Nobody' : rosterById.get(id) ?? '?')),
        }
      : null;
  }
  return winners;
}

function voteFieldValue(post) {
  const winners = voteWinners(post);
  const lines = VOTE_CATEGORIES.map(({ key, emoji, title }) => {
    const w = winners[key];
    if (!w) return `${emoji} ${title}: —`;
    return `${emoji} ${title}: **${w.labels.join(' / ')}** (${w.count} vote${w.count === 1 ? '' : 's'})`;
  });
  const voted = Object.keys(post.vote?.ballots ?? {}).length;
  const eligible = post.vote?.voters?.length ?? 0;
  const closes = Math.floor(Date.parse(post.vote.closesAt) / 1000);
  lines.push(
    post.vote.closed
      ? `${voted} of ${eligible} voted • voting closed`
      : `${voted} of ${eligible} voted • closes <t:${closes}:R>`,
  );
  return lines.join('\n');
}

function buildVoteMenus(post) {
  return VOTE_CATEGORIES.map(({ key, emoji, question }) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${VOTE_CUSTOM_ID_PREFIX}:${post.matchId}:${key}`)
        .setPlaceholder(`${emoji} ${question}`)
        .addOptions(
          ...post.vote.roster.map((r) => ({ label: r.label, value: r.id })),
          { label: 'Nobody', value: VOTE_NOBODY, emoji: '🙏' },
        ),
    ),
  );
}

/** "voted griefer Vi — gayian" style summary for the earlier-today line. */
export function summarizeVote(post) {
  const w = voteWinners(post);
  const parts = VOTE_CATEGORIES.filter(({ key }) => w[key] && !w[key].labels.includes('Nobody')).map(
    ({ key, title }) => `${title.toLowerCase()}: ${w[key].labels.map((l) => l.split(' — ')[0]).join('/')}`,
  );
  return parts.length ? parts.join(', ') : null;
}

// Discord embed limits.
const FIELD_VALUE_MAX = 1024;
const MAX_CONTENT = 2000;

/**
 * Render the stored squad post. Each squadmate's own lines become an embed
 * field, added as they're processed, followed by the squad vote. Returns
 * { content, embeds, components } — components are the vote menus while the
 * vote is open, and empty once it closes.
 */
export function renderSquadPost(post) {
  let content = post.earlierLine ? `${post.header}\n\n${post.earlierLine}` : post.header;
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1)}…`;

  const embed = new EmbedBuilder()
    .setColor(post.won ? 0x23a55a : 0xf23f43)
    .setTitle('Squad scoreboard')
    .setDescription(post.scoreboard);
  for (const { title, text } of Object.values(post.memberSections ?? {})) {
    const value = text.length > FIELD_VALUE_MAX ? `${text.slice(0, FIELD_VALUE_MAX - 1)}…` : text;
    embed.addFields({ name: title, value });
  }
  if (post.vote) {
    embed.addFields({
      name: post.vote.closed ? '🗳️ Squad verdict' : '🗳️ Squad vote',
      value: voteFieldValue(post),
    });
  }
  const components = post.vote && !post.vote.closed ? buildVoteMenus(post) : [];
  return { content, embeds: [embed], components };
}
