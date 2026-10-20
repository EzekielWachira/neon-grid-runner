// Daily run extras: the featured ship everyone flies that day, play streaks, and the shareable
// result card (an image plus a short text version with a ghost link).
import { hashString } from '../core/rng.ts';
import { SHIP_IDS, type ShipId } from '../core/ships.ts';
import { PALETTES } from '../render/palette.ts';

export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const dailySeed = (key: string) => hashString(`ngr-daily:${key}`);

/** Everyone flies the same ship on a given day, so daily scores compare like for like. */
export const dailyShip = (key: string): ShipId => SHIP_IDS[hashString(`ngr-ship:${key}`) % SHIP_IDS.length];

/** Consecutive days with a daily run, ending today (or yesterday, if today's isn't done yet). */
export function streak(daily: Record<string, number>, today = new Date()): number {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!(dateKey(d) in daily)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (dateKey(d) in daily) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** Credits for the first daily run of each day, growing with the streak (capped at a week). */
export const streakBonus = (days: number) => 50 * Math.min(7, Math.max(1, days));

// ---------------------------------------------------------------- result card

export interface CardData {
  /** e.g. "Daily run · 2026-10-20". */
  mode: string;
  daily: boolean;
  score: number;
  distance: number;
  /** Zero-based sector reached. */
  sector: number;
  nearMisses: number;
  bestCombo: number;
  seconds: number;
  shipName: string;
  shipRole: string;
  callsign: string;
  streak: number;
  /** PNG data URL of the moment the run ended, used as the hero image. */
  shot: string | null;
  /** A ghost link for others to race this run. */
  link: string;
}

const SQUARES = ['🟪', '🟦', '🟩', '🟥', '⬜', '🟨'];
const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

/** Wordle-style strip: one square per sector, coloured for the ones reached. */
export function sectorStrip(sector: number) {
  const reached = Math.min(sector + 1, 12);
  const n = Math.max(6, reached);
  let s = '';
  for (let i = 0; i < n; i++) s += i < reached ? SQUARES[i % SQUARES.length] : '⬛';
  return s;
}

export function cardText(c: CardData) {
  const lines = [
    `NEON GRID RUNNER · ${c.mode}`,
    `${c.shipName} · ${fmt(c.score)} pts · ${fmt(c.distance)} m`,
    `${sectorStrip(c.sector)} Sector ${c.sector + 1}`,
  ];
  if (c.daily && c.streak > 1) lines.push(`🔥 ${c.streak}-day streak`);
  lines.push(`Race my ghost: ${c.link}`);
  return lines.join('\n');
}

const W = 1080;
const H = 1350;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Draws the 4:5 result card (a good shape for social feeds). */
export async function drawCard(c: CardData): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const pal = PALETTES[c.sector % PALETTES.length];

  g.fillStyle = '#05010f';
  g.fillRect(0, 0, W, H);

  // Hero: the frame the run ended on, cropped to cover the top, fading into the background.
  const heroH = 760;
  if (c.shot) {
    try {
      const img = await loadImage(c.shot);
      const s = Math.max(W / img.width, heroH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      g.save();
      g.beginPath();
      g.rect(0, 0, W, heroH);
      g.clip();
      g.drawImage(img, (W - w) / 2, (heroH - h) / 2, w, h);
      g.restore();
    } catch {
      // No screenshot: the gradient below still makes a clean card.
    }
  }
  const fade = g.createLinearGradient(0, 0, 0, heroH);
  fade.addColorStop(0, 'rgba(5,1,15,0.75)');
  fade.addColorStop(0.25, 'rgba(5,1,15,0.1)');
  fade.addColorStop(0.7, 'rgba(5,1,15,0.35)');
  fade.addColorStop(1, '#05010f');
  g.fillStyle = fade;
  g.fillRect(0, 0, W, heroH);

  // A synthwave floor behind the stats.
  g.save();
  g.globalAlpha = 0.16;
  g.strokeStyle = hex(pal.grid);
  g.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const y = heroH + Math.pow(i / 11, 1.8) * (H - heroH);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  for (let i = -10; i <= 10; i++) {
    g.beginPath();
    g.moveTo(W / 2 + i * 40, heroH);
    g.lineTo(W / 2 + i * 220, H);
    g.stroke();
  }
  g.restore();

  // Logo and mode.
  const logo = g.createLinearGradient(60, 0, 700, 0);
  logo.addColorStop(0, '#ff2bd6');
  logo.addColorStop(1, '#22e6ff');
  g.fillStyle = logo;
  g.font = 'italic 900 58px Orbitron, sans-serif';
  g.textBaseline = 'top';
  g.shadowColor = 'rgba(255,43,214,0.6)';
  g.shadowBlur = 24;
  g.fillText('NEON GRID RUNNER', 60, 60);
  g.shadowBlur = 0;
  g.fillStyle = '#f4ecff';
  g.font = '600 30px "Chakra Petch", sans-serif';
  g.fillText(c.mode.toUpperCase(), 62, 136);

  // Score.
  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.shadowColor = hex(pal.primary);
  g.shadowBlur = 40;
  g.font = '600 150px "Chakra Petch", sans-serif';
  g.fillText(fmt(c.score), W / 2, 640);
  g.shadowBlur = 0;
  g.fillStyle = '#b3a6d6';
  g.font = '600 28px "Chakra Petch", sans-serif';
  g.fillText(`P O I N T S   ·   ${c.callsign.toUpperCase()}`, W / 2, 805);

  // Stats row.
  const stats: [string, string][] = [
    ['DISTANCE', `${fmt(c.distance)} m`],
    ['TIME', `${Math.floor(c.seconds / 60)}:${String(Math.floor(c.seconds % 60)).padStart(2, '0')}`],
    ['NEAR MISSES', fmt(c.nearMisses)],
    ['BEST COMBO', fmt(c.bestCombo)],
  ];
  const colW = (W - 120) / stats.length;
  stats.forEach(([label, value], i) => {
    const x = 60 + colW * i + colW / 2;
    g.fillStyle = '#b3a6d6';
    g.font = '600 22px "Chakra Petch", sans-serif';
    g.fillText(label, x, 890);
    g.fillStyle = '#f4ecff';
    g.font = '600 46px "Chakra Petch", sans-serif';
    g.fillText(value, x, 924);
  });

  // Sector strip: one tile per sector, lit in that sector's colour.
  const reached = Math.min(c.sector + 1, 12);
  const tiles = Math.max(6, reached);
  const size = Math.min(70, (W - 160) / tiles - 12);
  const total = tiles * size + (tiles - 1) * 12;
  for (let i = 0; i < tiles; i++) {
    const x = (W - total) / 2 + i * (size + 12);
    const y = 1030;
    if (i < reached) {
      const p = PALETTES[i % PALETTES.length];
      g.fillStyle = hex(p.primary);
      g.shadowColor = hex(p.primary);
      g.shadowBlur = 20;
    } else {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.shadowBlur = 0;
    }
    g.fillRect(x, y, size, size);
  }
  g.shadowBlur = 0;
  g.fillStyle = '#f4ecff';
  g.font = '600 26px "Chakra Petch", sans-serif';
  g.fillText(`SECTOR ${c.sector + 1} · ${pal.name.toUpperCase()}`, W / 2, 1030 + size + 20);

  // Ship and streak.
  g.fillStyle = '#22e6ff';
  g.font = '700 30px Orbitron, sans-serif';
  const shipLine = `${c.shipName.toUpperCase()} · ${c.shipRole.toUpperCase()}`;
  g.fillText(c.daily && c.streak > 1 ? `${shipLine}   🔥 ${c.streak}-DAY STREAK` : shipLine, W / 2, 1200);

  // Footer.
  g.fillStyle = '#b3a6d6';
  g.font = '500 26px "Chakra Petch", sans-serif';
  g.fillText(`${location.host}${location.pathname}`.replace(/\/$/, ''), W / 2, 1270);

  // Frame.
  g.strokeStyle = 'rgba(255,120,240,0.35)';
  g.lineWidth = 4;
  g.strokeRect(24, 24, W - 48, H - 48);
  return cv;
}
