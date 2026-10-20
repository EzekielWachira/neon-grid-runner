// Set pieces that come round in every sector, at fixed beats so the music, the track generator,
// the simulation and the renderer all agree on them without talking to each other:
//   - a tunnel (slides, no jumps), from the second sector,
//   - a gravity flip inside the tunnel (the camera rolls over; controls follow the screen), from the third,
//   - the Sentinel: a boss that fires laser walls on every beat, from the second.
import { BEAT, SECTOR_BEATS } from './config.ts';

/** Beat ranges within a sector, [start, end). */
export const TUNNEL = [24, 44] as const;
export const FLIP = [30, 38] as const;
export const SENTINEL = [64, 80] as const;
/** The Sentinel announces itself this many beats early (riser in the music, warning banner). */
export const SENTINEL_WARN = 4;
/** No rows this close (in beats) to a flip's start or end, so the camera can roll over in peace. */
const FLIP_QUIET = 1.5;

export const TUNNEL_FROM = 1;
export const FLIP_FROM = 2;
export const SENTINEL_FROM = 1;

const split = (t: number) => {
  const beat = t / BEAT;
  const sector = Math.floor(beat / SECTOR_BEATS);
  return { sector, b: beat - sector * SECTOR_BEATS };
};
const inRange = (b: number, r: readonly [number, number]) => b >= r[0] && b < r[1];

export interface ZoneState {
  sector: number;
  tunnel: boolean;
  flipped: boolean;
  sentinel: 'none' | 'warn' | 'active';
}

export function zoneState(t: number): ZoneState {
  const { sector, b } = split(t);
  const tunnel = sector >= TUNNEL_FROM && inRange(b, TUNNEL);
  const flipped = sector >= FLIP_FROM && inRange(b, FLIP);
  const sentinel = sector < SENTINEL_FROM ? 'none' : inRange(b, SENTINEL) ? 'active' : inRange(b, [SENTINEL[0] - SENTINEL_WARN, SENTINEL[0]]) ? 'warn' : 'none';
  return { sector, tunnel, flipped, sentinel };
}

export const inTunnel = (t: number) => zoneState(t).tunnel;
export const inSentinel = (t: number) => zoneState(t).sentinel === 'active';

/** If `t` falls in the quiet gap around a flip, the time it ends (else `t`). */
export function afterQuiet(t: number): number {
  const { sector, b } = split(t);
  if (sector < FLIP_FROM) return t;
  for (const edge of FLIP) {
    if (b > edge - FLIP_QUIET && b < edge + FLIP_QUIET) return (sector * SECTOR_BEATS + Math.ceil(edge + FLIP_QUIET)) * BEAT;
  }
  return t;
}

/** Time (s) of a beat within a sector. */
export const sectorBeatTime = (sector: number, beat: number) => (sector * SECTOR_BEATS + beat) * BEAT;

/** Practice checkpoints, in beats within a sector: clear of every set piece, with room for a run-up. */
export const CHECKPOINTS = [0, 18, 46, 56, 82];
