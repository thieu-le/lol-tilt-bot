// Ranked 5s / flex stacks: when 3+ tracked players are on the same team, the
// game gets ONE shared post instead of one per player. It calls out who
// carried and who played the worst (or outright griefed), scored across all
// five teammates, and collects each squadmate's own lines (tilt message,
// Fraud Watch, curses, bets) as they're processed.

import { EmbedBuilder } from 'discord.js';
import { computeTrivia } from './timeline.js';

// Tracked players on one team needed to count as a squad game.
export const SQUAD_MIN_TRACKED = 3;

// Worst player gets "Griefed" instead of "Weakest link" when they fed:
// lots of untraded deaths or a chain int on a bad KDA, or 10+ deaths under
// 1 KDA. A chain int alone isn't griefing if they still put up numbers.
const GRIEF_UNTRADED_DEATHS = 6;
const GRIEF_CHAIN_DEATHS = 5;
const GRIEF_MAX_KDA = 1.5;
const GRIEF_DEATHS = 10;
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
 * untraded, chainInt, griefed }.
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

    const griefed =
      (kda < GRIEF_MAX_KDA &&
        (untraded >= GRIEF_UNTRADED_DEATHS || (chainInt?.deaths ?? 0) >= GRIEF_CHAIN_DEATHS)) ||
      (p.deaths >= GRIEF_DEATHS && kda < 1);

    return { participant: p, score, kda, damageShare, killParticipation, untraded, chainInt, griefed };
  });

  const ranked = [...entries].sort((a, b) => b.score - a.score);
  return {
    won: Boolean(team[0]?.win),
    ranked,
    carry: ranked[0],
    worst: ranked[ranked.length - 1],
  };
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
  const worstTitle = worst.griefed ? '🚮 Griefed' : '🧊 Weakest link';
  lines.push(
    `${worstTitle}: ${nameFor(worst.participant, trackedByPuuid)} (${worst.participant.championName}) — ${statLine(worst)}${why.length ? ` • ${why.join(', ')}` : ''}`,
  );
  return lines.join('\n');
}

/** Scoreboard of the whole team, best to worst. */
export function buildSquadScoreboard(verdict, squad) {
  const trackedByPuuid = new Map(squad.members.map((m) => [m.puuid, m]));
  return verdict.ranked
    .map((e, i) => `${i + 1}. ${nameFor(e.participant, trackedByPuuid)} ${e.participant.championName} — ${statLine(e)}`)
    .join('\n');
}

// Discord embed limits.
const FIELD_VALUE_MAX = 1024;
const MAX_CONTENT = 2000;

/**
 * Render the stored squad post. Each squadmate's own lines become an embed
 * field, added as they're processed. Returns { content, embeds }.
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
  return { content, embeds: [embed] };
}
