// Procedural track. Each row lands exactly on a beat. The generator first plans a safe route
// (a lane plus an action per row, with lane changes limited by the gap before the row), then fills
// the rest of the row with obstacles around it, so every run is survivable by construction.
//
// Track version 2 adds set pieces (tunnels, gravity flips, the Sentinel; see zones.ts), ramps and
// boost pads. Version 1 is kept exactly as it was, so runs recorded on it still replay.
import {
  BEAT,
  GRAVITY,
  INTRO_BEATS,
  RAMP_VY,
  JUMP_HEIGHT,
  JUMP_TIME,
  LANES,
  sectorAt,
  type ObstacleKind,
  type PowerKind,
} from './config.ts';
import { mulberry32, randInt, weighted, type Rng } from './rng.ts';
import { afterQuiet, zoneState } from './zones.ts';

/** The newest track version; new runs use it. */
export const TRACK_VERSION = 2;

/** `ramp`: be in the lane and on the ground, and the ramp throws you over the wall a beat later. */
export type SafeAction = 'run' | 'jump' | 'slide' | 'ramp';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  lane0: number;
  lane1: number;
  /** Song time at which it reaches the player. */
  time: number;
  /** Movers sweep between lanes; at `time` they sit at `from`. */
  mover?: { from: number; to: number; period: number };
  done?: 'hit' | 'smashed' | 'passed';
}

export interface Pickup {
  id: number;
  kind: 'orb' | 'boost' | PowerKind;
  lane: number;
  time: number;
  y: number;
  taken?: boolean;
}

export interface Row {
  time: number;
  lane: number;
  action: SafeAction;
}

type Template = 'scatter' | 'wall' | 'hurdles' | 'laserLow' | 'laserHigh' | 'gates' | 'mover' | 'ramp';

export function moverLane(o: Obstacle, t: number): number {
  const m = o.mover!;
  const ph = ((t - o.time) * Math.PI * 2) / m.period;
  return m.from + (m.to - m.from) * (0.5 - 0.5 * Math.cos(ph));
}

/** Difficulty 0..1 over the first five minutes. */
export const difficultyAt = (t: number) => Math.min(1, Math.max(0, t / 300));

export class Track {
  obstacles: Obstacle[] = [];
  pickups: Pickup[] = [];
  rows: Row[] = [];

  private rng: Rng;
  private t = INTRO_BEATS * BEAT;
  private lane = Math.floor(LANES / 2);
  private lastAction: SafeAction = 'run';
  private nextId = 1;
  private rowCount = 0;
  private nextPower: number;
  private first = true;
  private noPower: PowerKind | null;
  /** Version 2 features: set pieces, ramps and boost pads. */
  readonly features: boolean;
  private sentinelRows = 0;

  /** `noPower` leaves one power-up kind out (the ship can't use it); the rest of the track is unchanged. */
  constructor(seed: number, noPower: PowerKind | null = null, version = TRACK_VERSION) {
    this.rng = mulberry32(seed);
    this.noPower = noPower;
    this.features = version >= 2;
    this.nextPower = 14 + Math.floor(this.rng() * 8);
  }

  /** Keeps rows generated until `time` (call with the far edge of the view). */
  generateUntil(time: number) {
    while (this.t < time) this.addRow();
  }

  /** Drops everything already behind the player. */
  prune(time: number) {
    const cut = time - 1.5;
    if (this.obstacles.length && this.obstacles[0].time < cut) this.obstacles = this.obstacles.filter((o) => o.time >= cut);
    if (this.pickups.length && this.pickups[0].time < cut) this.pickups = this.pickups.filter((p) => p.time >= cut);
    if (this.rows.length && this.rows[0].time < cut - 2) this.rows = this.rows.filter((r) => r.time >= cut - 2);
  }

  /** Practice: removes everything that arrives before `time`, leaving a clear run-up. */
  clearBefore(time: number) {
    this.obstacles = this.obstacles.filter((o) => o.time >= time);
    this.pickups = this.pickups.filter((p) => p.time >= time);
    this.rows = this.rows.filter((r) => r.time >= time);
  }

  private id() {
    return this.nextId++;
  }

  private obstacle(kind: ObstacleKind, lane0: number, lane1 = lane0, mover?: Obstacle['mover']) {
    this.obstacles.push({ id: this.id(), kind, lane0, lane1, time: this.t, mover });
  }

  private pickup(kind: Pickup['kind'], lane: number, time: number, y = 1) {
    this.pickups.push({ id: this.id(), kind, lane, time, y });
  }

  private addRow() {
    const rng = this.rng;
    const prevT = this.t;
    const prevLane = this.lane;
    const d = difficultyAt(this.t);
    const sentinel = this.features && zoneState(this.t + BEAT).sentinel === 'active';

    // Gap before this row, in beats. Tighter as difficulty rises; jumps and slides need room after them.
    // The Sentinel fires on every beat.
    let gap = sentinel ? 1 : this.first ? 0 : weighted(rng, [4, 3, 2, 1], [3 - 2.4 * d, 2, 1 + 2.2 * d, d > 0.2 ? 2.4 * d : 0]);
    if (this.lastAction !== 'run') gap = Math.max(gap, 2);
    this.first = false;
    this.t += gap * BEAT;
    // Rows never land while the camera rolls over for a gravity flip (a longer gap is always safe).
    if (this.features) {
      const t = afterQuiet(this.t);
      if (t !== this.t) {
        gap += Math.round((t - this.t) / BEAT);
        this.t = t;
      }
    }
    const zone = this.features ? zoneState(this.t) : null;

    // Plan the safe lane: one lane of travel per beat of gap, at most two.
    const maxShift = gap >= 2 ? 2 : 1;
    const shifts: number[] = [];
    const weights: number[] = [];
    for (let s = -maxShift; s <= maxShift; s++) {
      const l = prevLane + s;
      if (l < 0 || l >= LANES) continue;
      shifts.push(s);
      weights.push(s === 0 ? 1 : Math.abs(s) === 1 ? 2 : 1);
    }
    const lane = prevLane + weighted(rng, shifts, weights);
    this.lane = lane;

    const sector = sectorAt(this.t);
    let action: SafeAction;
    if (zone?.sentinel === 'active') {
      action = this.sentinelRow(lane);
    } else {
      // Tunnels have a ceiling: nothing in them needs a jump.
      const tunnel = !!zone?.tunnel;
      const items: Template[] = ['scatter', 'wall', 'hurdles', 'laserLow', 'laserHigh', 'gates', 'mover'];
      const weights = [
        3,
        d > 0.12 ? 1 + d : 0,
        d > 0.05 && !tunnel ? 0.8 : 0,
        d > 0.08 && !tunnel ? 0.8 : 0,
        d > 0.25 || tunnel ? 0.8 + (tunnel ? 1.2 : 0) : 0,
        d > 0.3 || tunnel ? 1 + (tunnel ? 0.8 : 0) : 0,
        d > 0.4 || sector >= 3 ? 1.2 * d : 0,
      ];
      // Ramps need a beat of open track after them for the wall they launch you over.
      if (this.features && !tunnel && d > 0.08 && this.lastAction === 'run' && !zoneState(this.t + BEAT * 2).tunnel && zoneState(this.t + BEAT * 3).sentinel === 'none') {
        items.push('ramp');
        weights.push(0.55);
      }
      const tpl = weighted<Template>(rng, items, weights);
      action = this.fillRow(tpl, lane, d, tunnel);
    }
    this.lastAction = action;
    if (action === 'ramp') {
      // The ramp row (run onto it), then the wall a beat later that it carries you over.
      this.rows.push({ time: this.t, lane, action: 'run' });
      this.t += BEAT;
      for (let l = 0; l < LANES; l++) this.obstacle('block', l);
    }
    this.rows.push({ time: this.t, lane, action });
    this.rowCount++;

    // Orb trails along the safe route, and arcs over jumps / low lines under slides.
    if (gap >= 2 && rng() < 0.65) {
      const steps = gap * 2 - 1;
      const switchAt = 1 + Math.floor(rng() * Math.max(1, steps - 1));
      for (let k = 1; k <= steps; k++) {
        if (k === 1 && this.lastActionBefore !== 'run') continue;
        this.pickup('orb', k < switchAt ? prevLane : lane, prevT + (k * BEAT) / 2);
      }
    }
    if (action === 'jump' && rng() < 0.7) {
      for (const dt of [-0.18, 0, 0.18]) {
        const s = 0.5 + dt / JUMP_TIME;
        this.pickup('orb', lane, this.t + dt, 0.75 + 4 * JUMP_HEIGHT * s * (1 - s));
      }
    } else if (action === 'ramp') {
      // A high arc of orbs over the wall, along the flight path.
      for (const dt of [-0.2, 0, 0.2]) {
        const tau = BEAT + dt;
        this.pickup('orb', lane, this.t + dt, 0.75 + RAMP_VY * tau - (GRAVITY * tau * tau) / 2);
      }
    } else if (action === 'slide' && rng() < 0.6) {
      for (const dt of [-0.15, 0, 0.15]) this.pickup('orb', lane, this.t + dt, 0.45);
    }

    // Boost pads sit on the safe route too, on open stretches.
    if (this.features && gap >= 2 && !zone?.tunnel && zone?.sentinel === 'none' && rng() < 0.14) {
      this.pickup('boost', lane, prevT + BEAT, 0.05);
    }

    // Power-ups sit on the safe route, one beat after the previous row.
    if (this.rowCount >= this.nextPower && gap >= 2 && !sentinel) {
      // Filtering keeps it to one draw from the RNG, so every later row matches the other ships' tracks.
      const kinds = (['shield', 'magnet', 'overdrive'] as PowerKind[]).filter((k) => k !== this.noPower);
      const weights = kinds.map((k) => ({ shield: 0.45, magnet: 0.35, overdrive: 0.2 })[k]);
      const kind = weighted(rng, kinds, weights);
      this.pickups.push({ id: this.id(), kind, lane, time: prevT + BEAT, y: 1 });
      this.nextPower = this.rowCount + 20 + Math.floor(rng() * 14);
    }
    this.lastActionBefore = action;
  }

  private lastActionBefore: SafeAction = 'run';

  /**
   * One Sentinel volley: a laser wall across every lane but the safe one. Every fourth volley is
   * a low sweep across the whole track instead, which you jump.
   */
  private sentinelRow(lane: number): SafeAction {
    this.sentinelRows++;
    if (this.sentinelRows % 4 === 0 && this.lastAction === 'run') {
      this.obstacle('laserLow', 0, LANES - 1);
      return 'jump';
    }
    if (lane > 0) this.obstacle('beam', 0, lane - 1);
    if (lane < LANES - 1) this.obstacle('beam', lane + 1, LANES - 1);
    return 'run';
  }

  /** Fills one row around the safe lane and returns the action the safe lane needs. */
  private fillRow(tpl: Template, lane: number, d: number, tunnel = false): SafeAction {
    const rng = this.rng;
    const others = [...Array(LANES).keys()].filter((l) => l !== lane);

    // Sometimes the safe lane itself needs a jump or a slide (never a jump in a tunnel).
    const safeHurdle = (): SafeAction => {
      const r = rng();
      if (r < 0.18 + 0.12 * d && !tunnel) {
        this.obstacle('low', lane);
        return 'jump';
      }
      if (d > 0.25 && r < 0.3 + 0.15 * d) {
        this.obstacle('high', lane);
        return 'slide';
      }
      return 'run';
    };

    switch (tpl) {
      case 'ramp': {
        this.obstacle('ramp', lane);
        return 'ramp';
      }
      case 'wall': {
        for (const l of others) this.obstacle('block', l);
        return safeHurdle();
      }
      case 'hurdles': {
        for (const l of others) this.obstacle(rng() < 0.3 + 0.3 * d ? 'block' : 'low', l);
        this.obstacle('low', lane);
        return 'jump';
      }
      case 'laserLow': {
        this.obstacle('laserLow', 0, LANES - 1);
        return 'jump';
      }
      case 'laserHigh': {
        this.obstacle('laserHigh', 0, LANES - 1);
        return 'slide';
      }
      case 'gates': {
        const act: SafeAction = rng() < 0.5 ? 'slide' : 'run';
        if (act === 'slide') this.obstacle('high', lane);
        for (const l of others) {
          const r = rng();
          if (r < 0.45) this.obstacle('high', l);
          else if (r < 0.8) this.obstacle('block', l);
        }
        return act;
      }
      case 'mover': {
        // A block that sweeps across lanes but sits at least two lanes from the safe lane on arrival.
        const far = others.filter((l) => Math.abs(l - lane) >= 2);
        if (!far.length) return this.fillRow('scatter', lane, d, tunnel);
        const from = far[randInt(rng, 0, far.length - 1)];
        const toward = Math.sign(lane - from);
        const to = Math.min(LANES - 1, Math.max(0, from + toward * randInt(rng, 1, 2)));
        this.obstacle('mover', from, from, { from, to, period: BEAT * (rng() < 0.5 ? 2 : 4) });
        // Keep its sweep path clear, so it never slides through other blocks.
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        for (const l of others) if ((l < lo || l > hi) && rng() < 0.25 + 0.3 * d) this.obstacle('block', l);
        return 'run';
      }
      default: {
        const p = 0.3 + 0.45 * d;
        let placed = 0;
        for (const l of others) {
          if (rng() < p) {
            const r = rng();
            this.obstacle(d > 0.2 && r < 0.2 ? 'low' : d > 0.35 && r < 0.35 ? 'high' : 'block', l);
            placed++;
          }
        }
        if (!placed) this.obstacle('block', others[randInt(rng, 0, others.length - 1)]);
        return safeHurdle();
      }
    }
  }
}
