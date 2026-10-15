// /analyze5s — full breakdown of the last ranked game where 3+ tracked
// players were on the same team: squad verdict (carry, weakest link, griefed)
// with a team chart, then every squadmate's own report (chart, stats,
// trivia, Fraud Watch / God Mode).

import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import * as riot from './riotService.js';
import { analyzeTimeline, buildReportSeries, buildSquadSeries } from './timeline.js';
import { buildMatchReport, renderSquadChart, formatClock } from './report.js';
import {
  findSquad,
  computeSquadVerdict,
  buildSquadHeader,
  buildSquadScoreboard,
} from './squad.js';
import {
  computeFraudScore,
  buildFraudWatchMessage,
  computeGodModeScore,
  buildGodModeMessage,
  FLOW_STATE_THRESHOLD,
} from './messages.js';

// How far back in each player's ranked history to look for a shared game.
const LOOKBACK_GAMES = 20;
// Candidate shared games to fetch before giving up.
const MAX_CANDIDATES = 5;
// Discord caps: 6000 chars across all embeds in one message, 10 embeds.
const EMBED_CHARS_PER_MESSAGE = 5500;
const EMBEDS_PER_MESSAGE = 10;

const QUEUE_LABELS = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex' };

/** Numeric tail of "NA1_5659600977", for newest-first sorting. */
function matchNumber(matchId) {
  return Number(String(matchId).split('_').pop());
}

/**
 * Most recent ranked match where 3+ tracked players were on one team.
 * Match IDs that show up in 3+ players' recent ranked lists are the
 * candidates, so this needs only one ID-list request per tracked player plus
 * a match fetch per candidate. Remakes are skipped.
 * Returns { match, squad } or null.
 */
export async function findLastSquadMatch(players) {
  const counts = new Map();
  for (const p of players) {
    const ids = await riot.getRecentMatchIds(p.puuid, LOOKBACK_GAMES, { type: 'ranked' });
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const candidates = [...counts]
    .filter(([, n]) => n >= 3)
    .map(([id]) => id)
    .sort((a, b) => matchNumber(b) - matchNumber(a))
    .slice(0, MAX_CANDIDATES);

  for (const id of candidates) {
    const result = await loadSquadMatch(id, players);
    if (result) return result;
  }
  return null;
}

/** Fetch a match and return { match, squad } if it was a (non-remake) squad game. */
export async function loadSquadMatch(matchId, players) {
  const match = await riot.getMatch(matchId);
  for (const p of players) {
    const squad = findSquad(match, p.puuid, players);
    if (!squad) continue;
    if (riot.extractMatchSummary(match, p.puuid)?.remake) return null;
    return { match, squad };
  }
  return null;
}

function embedLength(embed) {
  const e = embed.toJSON();
  return (
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.author?.name?.length ?? 0) +
    (e.footer?.text?.length ?? 0) +
    (e.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

/** One squadmate's report embed + chart, with Fraud Watch / God Mode on top. */
function buildMemberReport(match, rawTimeline, player, index, logger) {
  const summary = riot.extractMatchSummary(match, player.puuid);
  const timeline = rawTimeline ? analyzeTimeline(rawTimeline, player.puuid) : null;
  const series = rawTimeline ? buildReportSeries(rawTimeline, match, player.puuid) : null;
  const report = buildMatchReport(summary, series, logger, `player-${index}.png`);
  const embed = report.embeds[0];
  embed.setAuthor({ name: player.riotId.gameName });

  const displayToken = player.discordUserId ? `<@${player.discordUserId}>` : `**${player.riotId.gameName}**`;
  const performance = { ...summary, timeline };
  const callouts = [];
  const fraud = summary.won ? computeFraudScore(performance) : null;
  if (Number.isFinite(fraud) && fraud >= 50) {
    callouts.push(buildFraudWatchMessage(displayToken, fraud, summary, timeline));
  }
  const god = computeGodModeScore(performance);
  if (Number.isFinite(god) && god >= FLOW_STATE_THRESHOLD) {
    callouts.push(buildGodModeMessage(displayToken, god, summary, timeline));
  }
  if (callouts.length) embed.setDescription(callouts.join('\n\n'));
  return report;
}

/**
 * Build the full analysis as a list of messages to send in order. The first
 * is the squad verdict + team chart; the rest batch the squadmates' reports
 * under Discord's per-message embed limits.
 * Returns [{ content?, embeds, files }].
 */
export function buildSquadAnalysis(match, rawTimeline, squad, logger) {
  const verdict = computeSquadVerdict(match, squad.teamId, rawTimeline);
  const queue = QUEUE_LABELS[match.info?.queueId] ?? 'Ranked';
  const started = Math.floor((match.info?.gameStartTimestamp ?? 0) / 1000);

  const squadEmbed = new EmbedBuilder()
    .setColor(verdict.won ? 0x23a55a : 0xf23f43)
    .setTitle(`${queue} • ${formatClock((match.info?.gameDuration ?? 0) * 1000)} game`)
    .setDescription(`<t:${started}:f>\n\n${buildSquadScoreboard(verdict, squad)}`)
    .setFooter({ text: match.metadata?.matchId ?? '' });
  const files = [];
  const squadSeries = rawTimeline ? buildSquadSeries(rawTimeline, match, squad.teamId) : null;
  if (squadSeries) {
    const thrown = verdict.throw;
    const throwLabel = thrown?.kind === 'objective' ? `Lost ${thrown.objective}` : 'Lead peaked';
    try {
      files.push(
        new AttachmentBuilder(renderSquadChart(squadSeries, { throwMs: thrown?.t ?? null, throwLabel }), {
          name: 'squad.png',
        }),
      );
      squadEmbed.setImage('attachment://squad.png');
    } catch (err) {
      logger?.warn(`Failed to render squad chart: ${err.message}`);
    }
  }

  const messages = [{ content: buildSquadHeader(verdict, squad), embeds: [squadEmbed], files }];

  let batch = { embeds: [], files: [] };
  let batchChars = 0;
  squad.members.forEach((player, i) => {
    const report = buildMemberReport(match, rawTimeline, player, i, logger);
    const chars = embedLength(report.embeds[0]);
    if (
      batch.embeds.length &&
      (batchChars + chars > EMBED_CHARS_PER_MESSAGE || batch.embeds.length >= EMBEDS_PER_MESSAGE)
    ) {
      messages.push(batch);
      batch = { embeds: [], files: [] };
      batchChars = 0;
    }
    batch.embeds.push(...report.embeds);
    batch.files.push(...report.files);
    batchChars += chars;
  });
  if (batch.embeds.length) messages.push(batch);
  return messages;
}
