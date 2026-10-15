// Post-match report: a chart image (damage over time, gold vs lane opponent,
// K/D/A timeline) plus a stats embed, attached to the win/tilt message.
//
// Rendering is local via @napi-rs/canvas — no third-party chart service, and
// prebuilt binaries mean no native build step on Mac or Windows.

import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

// Bundle the chart font instead of relying on system fonts — slim Linux
// containers (Railway) often have none, which renders every label blank.
const require = createRequire(import.meta.url);
for (const weight of [400, 700]) {
  GlobalFonts.registerFromPath(
    require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`),
    'TiltInter',
  );
}

const W = 1000;
const H = 600;
const PAD_L = 64;
const PAD_R = 24;
const FONT = 'TiltInter, sans-serif';

const C = {
  bg: '#1e1f22',
  grid: '#313338',
  text: '#dbdee1',
  muted: '#949ba4',
  player: '#00a8fc',
  teammates: '#949ba4',
  opponent: '#f23f43',
  ahead: '#23a55a',
  behind: '#f23f43',
  kill: '#23a55a',
  assist: '#a5b4fc',
  death: '#f23f43',
};

const DAMAGE = { top: 48, height: 210 };
const GOLD = { top: 326, height: 100 };
const STRIP = { top: 492, rowGap: 22 };
const AXIS_Y = 580;
// Vertical spans that get minute gridlines — keeps lines out of panel titles.
const GRID_SPANS = [
  [DAMAGE.top, DAMAGE.top + DAMAGE.height],
  [GOLD.top, GOLD.top + GOLD.height],
  [STRIP.top - 10, STRIP.top + 2 * STRIP.rowGap + 10],
];

function formatK(n) {
  const abs = Math.abs(n);
  if (abs >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(Math.round(n));
}

export function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Round up to a "nice" axis max (1, 2, 2.5, 5 × 10^n). */
function niceCeil(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

function label(ctx, text, x, y, { color = C.muted, size = 13, align = 'left', weight = '' } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${FONT}`.trim();
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function drawLine(ctx, xs, ys, color, { width = 2.5, dash = [] } = {}) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  xs.forEach((x, i) => (i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i])));
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawLegend(ctx, items, rightX, y) {
  let x = rightX;
  ctx.font = `13px ${FONT}`;
  for (const { text, color, dash } of [...items].reverse()) {
    const w = ctx.measureText(text).width;
    label(ctx, text, x, y, { align: 'right', color: C.text });
    x -= w + 8;
    drawLine(ctx, [x - 18, x], [y, y], color, { dash });
    x -= 36;
  }
}

/**
 * Render the report chart. `series` is buildReportSeries() output. Returns a
 * PNG Buffer.
 */
export function renderReportChart(series) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const maxMin = Math.max(series.gameEndMs / 60_000, 1);
  const plotW = W - PAD_L - PAD_R;
  const xAt = (min) => PAD_L + (min / maxMin) * plotW;
  const xs = series.minutes.map(xAt);

  // Vertical minute gridlines shared by every panel.
  const tickEvery = maxMin > 12 ? 5 : 2;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  for (let m = 0; m <= maxMin; m += tickEvery) {
    const x = xAt(m);
    for (const [top, bottom] of GRID_SPANS) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    label(ctx, `${m}m`, x, AXIS_Y, { align: 'center' });
  }

  // --- Damage panel ---------------------------------------------------------
  const { damage } = series;
  const dmgMax = niceCeil(
    Math.max(...damage.player, ...damage.teammates, ...(damage.opponent ?? [0])),
  );
  const yDmg = (v) => DAMAGE.top + DAMAGE.height - (v / dmgMax) * DAMAGE.height;
  label(ctx, 'Damage to champions', PAD_L, 22, { color: C.text, size: 15, weight: 'bold' });
  for (let i = 0; i <= 4; i++) {
    const v = (dmgMax / 4) * i;
    label(ctx, formatK(v), PAD_L - 10, yDmg(v), { align: 'right' });
  }
  drawLine(ctx, xs, damage.teammates.map(yDmg), C.teammates, { dash: [6, 5], width: 2 });
  if (damage.opponent) drawLine(ctx, xs, damage.opponent.map(yDmg), C.opponent, { width: 2 });
  drawLine(ctx, xs, damage.player.map(yDmg), C.player, { width: 3 });
  const legend = [
    { text: 'You', color: C.player },
    { text: 'Teammates avg', color: C.teammates, dash: [6, 5] },
  ];
  if (damage.opponent) legend.push({ text: series.opponentChampion ?? 'Lane opponent', color: C.opponent });
  drawLegend(ctx, legend, W - PAD_R, 22);

  // --- Gold diff panel ------------------------------------------------------
  const goldTitle = series.opponentChampion ? `Gold vs ${series.opponentChampion}` : 'Gold vs lane opponent';
  label(ctx, goldTitle, PAD_L, GOLD.top - 26, { color: C.text, size: 15, weight: 'bold' });
  if (series.goldDiff) {
    const gMax = niceCeil(Math.max(...series.goldDiff.map(Math.abs), 500));
    const mid = GOLD.top + GOLD.height / 2;
    const yGold = (v) => mid - (v / gMax) * (GOLD.height / 2);
    for (const v of [gMax, 0, -gMax]) {
      label(ctx, (v > 0 ? '+' : '') + formatK(v), PAD_L - 10, yGold(v), { align: 'right' });
    }
    // Fill each segment green above zero, red below.
    for (let i = 1; i < xs.length; i++) {
      const avg = (series.goldDiff[i - 1] + series.goldDiff[i]) / 2;
      ctx.fillStyle = avg >= 0 ? `${C.ahead}55` : `${C.behind}55`;
      ctx.beginPath();
      ctx.moveTo(xs[i - 1], mid);
      ctx.lineTo(xs[i - 1], yGold(series.goldDiff[i - 1]));
      ctx.lineTo(xs[i], yGold(series.goldDiff[i]));
      ctx.lineTo(xs[i], mid);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = C.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, mid);
    ctx.lineTo(W - PAD_R, mid);
    ctx.stroke();
    drawLine(ctx, xs, series.goldDiff.map(yGold), C.text, { width: 1.5 });
  } else {
    label(ctx, 'No lane opponent found', PAD_L, GOLD.top + GOLD.height / 2);
  }

  // --- K/D/A strip ------------------------------------------------------------
  label(ctx, 'Kills / Assists / Deaths', PAD_L, STRIP.top - 34, { color: C.text, size: 15, weight: 'bold' });
  const rows = { kill: 0, assist: 1, death: 2 };
  const rowLabel = { kill: 'K', assist: 'A', death: 'D' };
  for (const [kind, row] of Object.entries(rows)) {
    label(ctx, rowLabel[kind], PAD_L - 10, STRIP.top + row * STRIP.rowGap, {
      align: 'right',
      color: C[kind],
      weight: 'bold',
    });
  }
  for (const ev of series.events) {
    const x = xAt(ev.t / 60_000);
    const y = STRIP.top + rows[ev.kind] * STRIP.rowGap;
    ctx.fillStyle = C[ev.kind];
    ctx.strokeStyle = C[ev.kind];
    if (ev.kind === 'kill') {
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y + 5);
      ctx.lineTo(x - 6, y + 5);
      ctx.closePath();
      ctx.fill();
    } else if (ev.kind === 'death') {
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas.toBuffer('image/png');
}

// --- Squad chart (/analyze5s) ----------------------------------------------

const SQUAD_H = 680;
const SQUAD_DAMAGE = { top: 48, height: 220 };
const SQUAD_GOLD = { top: 340, height: 110 };
const SQUAD_ROWS = { top: 522, rowGap: 24 };
const SQUAD_AXIS_Y = 664;
// One color per teammate, distinct from the green/red used for K/D markers.
const SQUAD_COLORS = ['#00a8fc', '#f0b232', '#c77dff', '#ff8fab', '#5eead4'];

/**
 * Team chart: every teammate's damage over time, team gold vs the enemy with
 * objective markers and the throw point, and one K/A/D row per teammate.
 * `series` is buildSquadSeries() output; `throwMs` marks where the game was
 * thrown (or null). Returns a PNG Buffer.
 */
export function renderSquadChart(series, { throwMs = null, throwLabel = 'Thrown' } = {}) {
  const canvas = createCanvas(W, SQUAD_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, SQUAD_H);

  const maxMin = Math.max(series.gameEndMs / 60_000, 1);
  const plotW = W - PAD_L - PAD_R;
  const xAt = (min) => PAD_L + (min / maxMin) * plotW;
  const xs = series.minutes.map(xAt);
  const rowsBottom = SQUAD_ROWS.top + (series.players.length - 1) * SQUAD_ROWS.rowGap + 10;
  const spans = [
    [SQUAD_DAMAGE.top, SQUAD_DAMAGE.top + SQUAD_DAMAGE.height],
    [SQUAD_GOLD.top, SQUAD_GOLD.top + SQUAD_GOLD.height],
    [SQUAD_ROWS.top - 10, rowsBottom],
  ];

  const tickEvery = maxMin > 12 ? 5 : 2;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  for (let m = 0; m <= maxMin; m += tickEvery) {
    for (const [top, bottom] of spans) {
      ctx.beginPath();
      ctx.moveTo(xAt(m), top);
      ctx.lineTo(xAt(m), bottom);
      ctx.stroke();
    }
    label(ctx, `${m}m`, xAt(m), SQUAD_AXIS_Y, { align: 'center' });
  }

  // Throw marker spans every panel.
  if (Number.isFinite(throwMs)) {
    const x = xAt(throwMs / 60_000);
    ctx.strokeStyle = C.behind;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, SQUAD_DAMAGE.top);
    ctx.lineTo(x, rowsBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, throwLabel, x - 6, SQUAD_DAMAGE.top + 10, { color: C.behind, align: 'right', weight: 'bold' });
  }

  // --- Damage per teammate ----------------------------------------------------
  const dmgMax = niceCeil(Math.max(...series.players.flatMap((p) => p.damage)));
  const yDmg = (v) => SQUAD_DAMAGE.top + SQUAD_DAMAGE.height - (v / dmgMax) * SQUAD_DAMAGE.height;
  label(ctx, 'Damage to champions', PAD_L, 22, { color: C.text, size: 15, weight: 'bold' });
  for (let i = 0; i <= 4; i++) {
    const v = (dmgMax / 4) * i;
    label(ctx, formatK(v), PAD_L - 10, yDmg(v), { align: 'right' });
  }
  series.players.forEach((p, i) => drawLine(ctx, xs, p.damage.map(yDmg), SQUAD_COLORS[i % SQUAD_COLORS.length], { width: 2.5 }));
  drawLegend(
    ctx,
    series.players.map((p, i) => ({ text: p.champion, color: SQUAD_COLORS[i % SQUAD_COLORS.length] })),
    W - PAD_R,
    22,
  );

  // --- Team gold vs enemy + objectives ------------------------------------------
  label(ctx, 'Team gold vs enemy', PAD_L, SQUAD_GOLD.top - 26, { color: C.text, size: 15, weight: 'bold' });
  const gMax = niceCeil(Math.max(...series.teamGoldDiff.map(Math.abs), 1000));
  const mid = SQUAD_GOLD.top + SQUAD_GOLD.height / 2;
  const yGold = (v) => mid - (v / gMax) * (SQUAD_GOLD.height / 2);
  for (const v of [gMax, 0, -gMax]) {
    label(ctx, (v > 0 ? '+' : '') + formatK(v), PAD_L - 10, yGold(v), { align: 'right' });
  }
  for (let i = 1; i < xs.length; i++) {
    const avg = (series.teamGoldDiff[i - 1] + series.teamGoldDiff[i]) / 2;
    ctx.fillStyle = avg >= 0 ? `${C.ahead}55` : `${C.behind}55`;
    ctx.beginPath();
    ctx.moveTo(xs[i - 1], mid);
    ctx.lineTo(xs[i - 1], yGold(series.teamGoldDiff[i - 1]));
    ctx.lineTo(xs[i], yGold(series.teamGoldDiff[i]));
    ctx.lineTo(xs[i], mid);
    ctx.closePath();
    ctx.fill();
  }
  drawLine(ctx, xs, series.teamGoldDiff.map(yGold), C.text, { width: 1.5 });
  // Objective markers: ours above the panel's top edge, theirs below the bottom.
  for (const o of series.objectives) {
    const x = xAt(o.t / 60_000);
    const big = o.label === 'Baron' || o.label === 'Elder';
    const y = o.ours ? SQUAD_GOLD.top - 6 : SQUAD_GOLD.top + SQUAD_GOLD.height + 8;
    ctx.fillStyle = o.ours ? C.ahead : C.behind;
    ctx.beginPath();
    ctx.arc(x, y, big ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    if (big) label(ctx, o.label, x, o.ours ? y - 12 : y + 13, { color: o.ours ? C.ahead : C.behind, size: 11, align: 'center', weight: 'bold' });
  }

  // --- K/A/D rows, one per teammate -------------------------------------------
  // Title doubles as the legend: each word in its marker's color. (Plain
  // words — the bundled latin font has no ▲●✕ glyphs.)
  let titleX = PAD_L;
  ctx.font = `bold 15px ${FONT}`;
  for (const [word, color] of [['Kills', C.kill], [' / ', C.text], ['Assists', C.assist], [' / ', C.text], ['Deaths', C.death]]) {
    label(ctx, word, titleX, SQUAD_ROWS.top - 32, { color, size: 15, weight: 'bold' });
    titleX += ctx.measureText(word).width;
  }
  series.players.forEach((p, row) => {
    const y = SQUAD_ROWS.top + row * SQUAD_ROWS.rowGap;
    label(ctx, p.champion.slice(0, 7), PAD_L - 8, y, { align: 'right', color: SQUAD_COLORS[row % SQUAD_COLORS.length], size: 11, weight: 'bold' });
    for (const ev of p.events) {
      const x = xAt(ev.t / 60_000);
      ctx.fillStyle = C[ev.kind];
      ctx.strokeStyle = C[ev.kind];
      if (ev.kind === 'kill') {
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y + 4);
        ctx.lineTo(x - 5, y + 4);
        ctx.closePath();
        ctx.fill();
      } else if (ev.kind === 'death') {
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  return canvas.toBuffer('image/png');
}

function formatPhase({ kills, deaths, assists }) {
  return `${kills}/${deaths}/${assists}`;
}

function formatGap(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Gold-swing trivia thresholds: a lead/deficit this big at its peak...
const GOLD_SWING_PEAK = 2000;
// ...that ended at least this far the other way.
const GOLD_SWING_END = 1000;

/**
 * On a loss where the player was the team's carry (most gold, or most kills
 * with 5+), decide whose fault it was:
 *   - Failed to carry: 6+ deaths and at least 60% of them (min 4) bought
 *     nothing — no takedown, and the team lost the fight
 *   - Team gap: nearly every death was traded and they played well (KDA ≥
 *     2.5) — the team lost it, not them
 * `deathValue` is { deaths, traded } from the timeline. Returns a line or null.
 */
function buildCarryVerdict(summary, deathValue) {
  if (summary.won || !deathValue) return null;
  let carryReason = null;
  if (summary.goldRankOnTeam === 1) {
    carryReason = `most gold on the team (${(summary.goldEarned / 1000).toFixed(1)}k)`;
  } else if (summary.killRankOnTeam === 1 && summary.kills >= 5) {
    carryReason = `most kills on the team (${summary.kills})`;
  }
  if (!carryReason) return null;

  const { deaths, traded } = deathValue;
  const wasted = deaths - traded;
  const kda = (summary.kills + summary.assists) / Math.max(summary.deaths, 1);
  if (deaths >= 6 && wasted >= Math.max(4, deaths * 0.6)) {
    return `🫠 Failed to carry: had the ${carryReason}, then died ${deaths} times, ${wasted} of them for nothing`;
  }
  if (kda >= 2.5 && (deaths <= 2 || wasted / deaths <= 0.3)) {
    let deathsLine;
    if (deaths === 0) deathsLine = 'never died';
    else if (deaths <= 2) deathsLine = `only died ${deaths === 1 ? 'once' : 'twice'}`;
    else deathsLine = `traded on ${traded} of ${deaths} deaths`;
    return `🙏 Team gap: had the ${carryReason} and ${deathsLine}. Not their fault`;
  }
  return null;
}

/**
 * Fun-fact lines for the report. Each one only shows up when it actually
 * happened, so most games get zero to two.
 */
export function buildTrivia(summary, series) {
  const facts = [];
  const trivia = series?.trivia;

  const chain = trivia?.chainInt;
  if (chain) {
    facts.push(
      `💀 Chain inted: died ${chain.deaths} times in a row from ${formatClock(chain.startMs)} to ${formatClock(chain.endMs)}, never more than ${formatGap(chain.longestAliveMs)} after respawning and no kills in between`,
    );
  }

  // Split pushing = lots of tower damage, little champ damage, and (when we
  // can tell) missing most fights. An ADC who hits towers AND shows up to
  // every fight isn't split pushing.
  const { turretDamageShare, damageShare } = summary;
  const knowsFights = trivia?.bigFights >= 2;
  const skipped = knowsFights ? trivia.bigFights - trivia.bigFightsJoined : 0;
  if (
    turretDamageShare >= 0.35 &&
    damageShare < 0.18 &&
    (!knowsFights || skipped / trivia.bigFights >= 0.5)
  ) {
    let fact = `🏰 Split-push merchant: ${Math.round(turretDamageShare * 100)}% of team tower damage, only ${Math.round(damageShare * 100)}% of champ damage`;
    if (knowsFights) fact += `, skipped ${skipped} of ${trivia.bigFights} big fights`;
    facts.push(fact);
  }

  const carryVerdict = buildCarryVerdict(summary, trivia?.deathValue);
  if (carryVerdict) facts.push(carryVerdict);

  const carry = trivia?.carryFight;
  if (carry) {
    const kills = carry.kills === 1 ? '1 kill' : `${carry.kills} kills`;
    facts.push(
      `🔥 Hard carried the fight at ${formatClock(carry.t)}: ${kills}, ${Math.round(carry.damageShare * 100)}% of team damage (${carry.enemiesLost}-for-${carry.alliesLost})`,
    );
  }

  const gold = series?.goldDiff;
  if (gold?.length) {
    const end = gold[gold.length - 1];
    const peak = Math.max(...gold);
    const trough = Math.min(...gold);
    const opp = series.opponentChampion ?? 'their lane opponent';
    if (peak >= GOLD_SWING_PEAK && end <= -GOLD_SWING_END) {
      facts.push(`📉 Threw a ${peak.toLocaleString()} gold lead on ${opp}`);
    } else if (trough <= -GOLD_SWING_PEAK && end >= GOLD_SWING_END) {
      facts.push(`📈 Came back from ${(-trough).toLocaleString()} gold down on ${opp}`);
    }
  }

  return facts;
}

/**
 * Build the stats embed. `series` may be null (no timeline) — the embed then
 * shows end-of-game stats only and no chart.
 */
export function buildReportEmbed(summary, series) {
  const minutes = (summary.gameDuration ?? 0) / 60;
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
  const kda = (summary.kills + summary.assists) / Math.max(summary.deaths, 1);

  const embed = new EmbedBuilder()
    .setColor(summary.won ? 0x23a55a : 0xf23f43)
    .setTitle(
      `${summary.championName} • ${summary.won ? 'Victory' : 'Defeat'} • ${summary.kills}/${summary.deaths}/${summary.assists}`,
    )
    .addFields(
      { name: 'KDA', value: `${kda.toFixed(2)} • ${pct(summary.killParticipation)} KP`, inline: true },
      {
        name: 'Damage',
        value: `${summary.totalDamageDealtToChampions.toLocaleString()} • ${pct(summary.damageShare)} (#${summary.damageRankOnTeam} on team)`,
        inline: true,
      },
      {
        name: 'CS',
        value: minutes > 0 ? `${summary.cs} (${(summary.cs / minutes).toFixed(1)}/min)` : String(summary.cs),
        inline: true,
      },
      { name: 'Gold', value: summary.goldEarned.toLocaleString(), inline: true },
      { name: 'Vision', value: String(summary.visionScore), inline: true },
      { name: 'Turret dmg', value: pct(summary.turretDamageShare), inline: true },
    );

  if (series) {
    const { early, mid, late } = series.phases;
    embed.addFields({
      name: 'K/D/A by phase',
      value: `Early (0-14) ${formatPhase(early)} • Mid (14-25) ${formatPhase(mid)} • Late (25+) ${formatPhase(late)}`,
    });

    const notes = [];
    const firstDeath = series.events.find((e) => e.kind === 'death');
    notes.push(firstDeath ? `First death ${formatClock(firstDeath.t)}` : 'Never died');
    if (series.goldDiff) {
      const at15 = series.goldDiff[15];
      if (Number.isFinite(at15)) {
        notes.push(`${at15 >= 0 ? '+' : ''}${at15.toLocaleString()} gold vs ${series.opponentChampion} @15`);
      }
    }
    if (summary.largestMultiKill >= 3) {
      notes.push(['', '', '', 'Triple kill', 'Quadra kill', 'PENTAKILL'][Math.min(summary.largestMultiKill, 5)]);
    }
    embed.addFields({ name: 'Notes', value: notes.join(' • ') });
  }

  const trivia = buildTrivia(summary, series);
  if (trivia.length) embed.addFields({ name: 'Trivia', value: trivia.join('\n') });

  if (summary.gameDuration) {
    embed.setFooter({ text: `${formatClock(summary.gameDuration * 1000)} game` });
  }
  return embed;
}

/**
 * Embed + chart attachment ready to spread into channel.send(). Falls back to
 * embed-only if rendering throws.
 */
export function buildMatchReport(summary, series, logger, fileName = 'report.png') {
  const embed = buildReportEmbed(summary, series);
  if (!series) return { embeds: [embed], files: [] };
  try {
    const file = new AttachmentBuilder(renderReportChart(series), { name: fileName });
    embed.setImage(`attachment://${fileName}`);
    return { embeds: [embed], files: [file] };
  } catch (err) {
    logger?.warn(`Failed to render match report chart: ${err.message}`);
    return { embeds: [embed], files: [] };
  }
}
