// Ship classes: what each hull changes about the rules. The simulation reads these, so a run is only
// reproducible with the class it was flown in (ghost links and saves record it).
// Every trait either helps the player or takes away a reward, never the route itself, so a track
// the generator proves survivable stays survivable in every ship (scripts/verify-runs.ts checks this).
import { BEAT, type PowerKind } from './config.ts';

export type ShipId = 'delta' | 'arrow' | 'manta' | 'twin' | 'phantom';
export const SHIP_IDS: ShipId[] = ['delta', 'arrow', 'manta', 'twin', 'phantom'];
export const isShipId = (s: unknown): s is ShipId => SHIP_IDS.includes(s as ShipId);

/** An active ability, fired with its own button. */
export type Ability = 'pulse' | 'phase';

export interface ShipClass {
  /** Lane-change time multiplier (lower is quicker). */
  laneTime: number;
  /** Half-width of the hitbox in metres. */
  halfW: number;
  /** Power-up duration multiplier. */
  powerTime: number;
  /** Multiplier on every point scored. */
  score: number;
  /** A second jump press high in the air glides. */
  glide: boolean;
  ability: Ability | null;
  /** This power-up never spawns for the ship (its slot goes to the others). */
  noPower: PowerKind | null;
}

export const SHIP_CLASSES: Record<ShipId, ShipClass> = {
  delta: { laneTime: 1, halfW: 0.55, powerTime: 1, score: 1, glide: false, ability: null, noPower: null },
  arrow: { laneTime: 0.75, halfW: 0.45, powerTime: 0.7, score: 1, glide: false, ability: null, noPower: null },
  manta: { laneTime: 1, halfW: 0.55, powerTime: 1, score: 0.9, glide: true, ability: null, noPower: null },
  twin: { laneTime: 1, halfW: 0.55, powerTime: 1, score: 1, glide: false, ability: 'pulse', noPower: 'magnet' },
  phantom: { laneTime: 1, halfW: 0.55, powerTime: 1, score: 1, glide: false, ability: 'phase', noPower: 'shield' },
};

/** Pulse cannon: recharges over 16 beats and fires on the next sixteenth note. */
export const PULSE_CHARGE = 16 * BEAT;
export const PULSE_GRID = BEAT / 4;
/** How far ahead the pulse reaches, in metres. */
export const PULSE_RANGE = 60;
/** Phase: one charge per sector, lasting this long. */
export const PHASE_TIME = 1.1;
/** Glide: how long it lasts, how much gravity it keeps and the slowest it lets you sink. */
export const GLIDE_TIME = 0.55;
export const GLIDE_GRAVITY = 0.12;
export const GLIDE_SINK = -1.4;
/** Glide only starts this high, so a jump pressed just before landing still buffers. */
export const GLIDE_MIN_Y = 1.0;
