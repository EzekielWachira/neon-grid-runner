// Shared tuning. Units are metres and seconds; the player sits at z = 0 and the world flows toward +z.

export const LANES = 5;
export const LANE_W = 2.4;
export const TRACK_HALF = (LANES * LANE_W) / 2;

/** Centre x of a (possibly fractional) lane. */
export const laneX = (lane: number) => (lane - (LANES - 1) / 2) * LANE_W;

export const BPM = 124;
export const BEAT = 60 / BPM;
/** Beats before the first obstacle row (the countdown plays over them). */
export const INTRO_BEATS = 8;
/** A sector lasts 24 bars; each one shifts the palette, adds music layers and raises difficulty. */
export const SECTOR_BEATS = 96;

export const SPEED_START = 30;
export const SPEED_MAX = 92;
/** Time constant (s) of the speed ramp. */
export const SPEED_RAMP = 150;
export const VIEW_DIST = 190;

export const JUMP_TIME = 0.72;
export const JUMP_HEIGHT = 2.4;
export const GRAVITY = (8 * JUMP_HEIGHT) / (JUMP_TIME * JUMP_TIME);
export const JUMP_VY = (4 * JUMP_HEIGHT) / JUMP_TIME;
export const FAST_FALL_VY = -20;
export const SLIDE_TIME = 0.62;
export const LANE_TIME = 0.13;
/** Inputs pressed this early are remembered (e.g. jump just before landing). */
export const INPUT_BUFFER = 0.16;

export const PLAYER = {
  halfW: 0.55,
  halfD: 0.9,
  bottom: 0.2,
  top: 1.3,
  slideTop: 0.7,
};

export type ObstacleKind = 'block' | 'low' | 'high' | 'laserLow' | 'laserHigh' | 'mover' | 'beam' | 'ramp';

/** Vertical extent and depth of each obstacle kind. */
export const OBSTACLE_SHAPE: Record<ObstacleKind, { y0: number; y1: number; depth: number; pad: number }> = {
  block: { y0: 0, y1: 3.2, depth: 1.2, pad: 0.15 },
  mover: { y0: 0, y1: 2.6, depth: 1.2, pad: 0.2 },
  low: { y0: 0, y1: 0.9, depth: 0.6, pad: 0.15 },
  high: { y0: 0.95, y1: 2.8, depth: 0.6, pad: 0.15 },
  laserLow: { y0: 0.35, y1: 0.7, depth: 0.25, pad: 0 },
  laserHigh: { y0: 0.95, y1: 1.3, depth: 0.25, pad: 0 },
  /** The Sentinel's laser walls: too tall to jump. */
  beam: { y0: 0, y1: 4.6, depth: 0.3, pad: 0.1 },
  /** Not an obstacle: running onto it launches you (see RAMP_VY). */
  ramp: { y0: 0, y1: 0.45, depth: 2, pad: 0.2 },
};
/** Obstacles that are lasers (the pulse cannon can't break them). */
export const isLaser = (k: ObstacleKind) => k === 'laserLow' || k === 'laserHigh' || k === 'beam';

/** A ramp throws you so you peak exactly one beat later, high over the wall it guards. */
export const RAMP_VY = GRAVITY * BEAT;
export const BOOST_TIME = 2.5;

export type PowerKind = 'shield' | 'magnet' | 'overdrive';
export const POWER_TIME: Record<PowerKind, number> = { shield: 15, magnet: 10, overdrive: 6 };

export const speedAt = (t: number) => SPEED_START + (SPEED_MAX - SPEED_START) * (1 - Math.exp(-Math.max(0, t) / SPEED_RAMP));
/** Distance covered by song time t (the integral of speedAt), for runs that start part-way in. */
export const distanceAt = (t: number) => SPEED_START * t + (SPEED_MAX - SPEED_START) * (t - SPEED_RAMP * (1 - Math.exp(-t / SPEED_RAMP)));
export const sectorAt = (t: number) => Math.max(0, Math.floor(t / BEAT / SECTOR_BEATS));
