// Game rules with no rendering: player physics, collisions, pickups, power-ups and scoring.
// The renderer and audio read this state and react to `events`; scripts/verify-runs.ts runs it headless.
import {
  BEAT,
  FAST_FALL_VY,
  GRAVITY,
  INPUT_BUFFER,
  JUMP_VY,
  LANE_TIME,
  LANE_W,
  LANES,
  OBSTACLE_SHAPE,
  PLAYER,
  POWER_TIME,
  SLIDE_TIME,
  VIEW_DIST,
  SPEED_START,
  laneX,
  sectorAt,
  speedAt,
  type PowerKind,
} from './config.ts';
import { Track, moverLane, type Obstacle, type Pickup } from './track.ts';

export type SimEvent =
  | { type: 'jump' }
  | { type: 'land' }
  | { type: 'slide' }
  | { type: 'lane'; dir: number }
  | { type: 'orb'; pickup: Pickup; combo: number }
  | { type: 'power'; pickup: Pickup }
  | { type: 'nearMiss'; obstacle: Obstacle; style: 'side' | 'over' | 'under'; bonus: number }
  | { type: 'smash'; obstacle: Obstacle }
  | { type: 'shieldBreak'; obstacle: Obstacle }
  | { type: 'death'; obstacle: Obstacle }
  | { type: 'mult'; mult: number }
  | { type: 'sector'; sector: number };

/** The simulation advances in fixed ticks so a recorded run replays identically at any frame rate. */
export const SIM_STEP = 1 / 240;

export type InputCode = 'L' | 'R' | 'J' | 'S';
/** One player input, stamped with the tick it was applied on. */
export interface InputEntry {
  tick: number;
  a: InputCode;
}

/** How recently a dodge must start to count as a near miss. */
const LATE_DODGE = 0.38;
const COMBO_WINDOW = 2.6;

export class Sim {
  readonly track: Track;
  t = 0;
  speed = SPEED_START;
  distance = 0;
  score = 0;
  orbs = 0;
  nearMisses = 0;
  combo = 0;
  bestCombo = 0;
  alive = true;
  sector = 0;

  // Player
  lane = Math.floor(LANES / 2);
  x = laneX(this.lane);
  y = 0;
  vy = 0;
  grounded = true;
  slideTimer = 0;
  /** -1..1 lateral velocity (for banking the ship). */
  bank = 0;
  powers: Record<PowerKind, number> = { shield: 0, magnet: 0, overdrive: 0 };
  invuln = 0;

  events: SimEvent[] = [];

  /** Ticks simulated so far; `t` is always exactly ticks * SIM_STEP. */
  ticks = 0;
  /** Every input this run, for ghosts and replays. */
  readonly log: InputEntry[] = [];
  /** Per-run counters for missions. */
  stats = { jumps: 0, slides: 0, powers: 0, smashes: 0, closeMoves: 0, magnets: 0, overdrives: 0, shields: 0 };
  /** Distance at the first power-up pickup (null until one is taken). */
  firstPowerAt: number | null = null;

  private replay: InputEntry[] | null;
  private replayIdx = 0;
  private prevT = 0;
  private comboTimer = 0;
  private jumpBuffer = 0;
  private slideBuffer = 0;
  private laneAt = -9;
  private jumpAt = -9;
  private slideAt = -9;
  private lastMult = 1;

  readonly seed: number;

  /** With `replay`, the sim plays back those inputs and ignores live ones (a ghost). */
  constructor(seed: number, replay: InputEntry[] | null = null) {
    this.seed = seed;
    this.replay = replay;
    this.track = new Track(seed);
    this.track.generateUntil(VIEW_DIST / SPEED_START + 2);
  }

  get mult() {
    return Math.min(8, 1 + Math.floor(this.combo / 8));
  }

  get sliding() {
    return this.slideTimer > 0;
  }

  // ---------------------------------------------------------------- input

  move(dir: -1 | 1) {
    this.input(dir < 0 ? 'L' : 'R');
  }

  jump() {
    this.input('J');
  }

  slide() {
    this.input('S');
  }

  get isGhost() {
    return this.replay !== null;
  }

  private input(a: InputCode, fromReplay = false) {
    if (!this.alive) return;
    if (!fromReplay) {
      if (this.replay) return;
      this.log.push({ tick: this.ticks, a });
    }
    if (a === 'L' || a === 'R') this.doMove(a === 'L' ? -1 : 1);
    else if (a === 'J') this.jumpBuffer = INPUT_BUFFER;
    else this.doSlide();
  }

  private doMove(dir: -1 | 1) {
    const next = Math.min(LANES - 1, Math.max(0, this.lane + dir));
    if (next === this.lane) return;
    this.lane = next;
    this.laneAt = this.t;
    this.events.push({ type: 'lane', dir });
  }

  private doSlide() {
    // In the air this becomes a fast-fall, and the slide starts on landing.
    this.slideBuffer = this.grounded ? INPUT_BUFFER : 0.6;
    if (!this.grounded) this.vy = Math.min(this.vy, FAST_FALL_VY);
  }

  // ---------------------------------------------------------------- step

  /** Advances (in fixed ticks) up to song time `t`. */
  step(t: number) {
    while (this.alive && (this.ticks + 1) * SIM_STEP <= t + 1e-9) {
      if (this.replay) {
        while (this.replayIdx < this.replay.length && this.replay[this.replayIdx].tick <= this.ticks) {
          this.input(this.replay[this.replayIdx++].a, true);
        }
      }
      this.tick();
    }
  }

  private tick() {
    const dt = SIM_STEP;
    this.prevT = this.t;
    this.ticks++;
    const t = this.ticks * SIM_STEP;
    this.t = t;
    this.speed = speedAt(t);
    this.distance += this.speed * dt;

    this.track.generateUntil(t + VIEW_DIST / SPEED_START + 2);
    this.track.prune(t);

    this.updatePlayer(dt);
    this.updateObstacles();
    this.updatePickups();

    for (const k of Object.keys(this.powers) as PowerKind[]) this.powers[k] = Math.max(0, this.powers[k] - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.comboTimer -= dt;
    if (this.comboTimer <= 0 && this.combo) this.combo = 0;
    if (this.mult !== this.lastMult) {
      this.lastMult = this.mult;
      this.events.push({ type: 'mult', mult: this.mult });
    }

    this.score += this.speed * dt * 0.1 * this.mult * (this.powers.overdrive > 0 ? 2 : 1);

    const sector = sectorAt(t);
    if (sector !== this.sector) {
      this.sector = sector;
      this.events.push({ type: 'sector', sector });
    }
  }

  private updatePlayer(dt: number) {
    this.jumpBuffer -= dt;
    this.slideBuffer -= dt;

    if (this.jumpBuffer > 0 && this.grounded) {
      this.jumpBuffer = 0;
      this.slideTimer = 0;
      this.grounded = false;
      this.vy = JUMP_VY;
      this.jumpAt = this.t;
      this.stats.jumps++;
      this.events.push({ type: 'jump' });
    }
    if (this.slideBuffer > 0 && this.grounded) {
      this.slideBuffer = 0;
      this.slideTimer = SLIDE_TIME;
      this.slideAt = this.t;
      this.stats.slides++;
      this.events.push({ type: 'slide' });
    }

    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.events.push({ type: 'land' });
      }
    }
    this.slideTimer = Math.max(0, this.slideTimer - dt);

    const target = laneX(this.lane);
    const maxStep = (LANE_W / LANE_TIME) * dt;
    const dx = Math.max(-maxStep, Math.min(maxStep, target - this.x));
    this.x += dx;
    this.bank += ((dt > 0 ? dx / maxStep : 0) - this.bank) * Math.min(1, dt * 12);
  }

  /** Player's vertical extent right now. */
  playerY(): [number, number] {
    return [this.y + PLAYER.bottom, this.y + (this.sliding ? PLAYER.slideTop : PLAYER.top)];
  }

  obstacleX(o: Obstacle, t = this.t): [number, number] {
    const pad = OBSTACLE_SHAPE[o.kind].pad;
    if (o.mover) {
      const c = laneX(moverLane(o, t));
      return [c - LANE_W / 2 + pad, c + LANE_W / 2 - pad];
    }
    return [laneX(o.lane0) - LANE_W / 2 + pad, laneX(o.lane1) + LANE_W / 2 - pad];
  }

  private updateObstacles() {
    const [py0, py1] = this.playerY();
    const px0 = this.x - PLAYER.halfW;
    const px1 = this.x + PLAYER.halfW;
    for (const o of this.track.obstacles) {
      if (o.done) continue;
      const shape = OBSTACLE_SHAPE[o.kind];
      // Swept test in time, so nothing tunnels through at high speed or low frame rates.
      const w = (shape.depth / 2 + PLAYER.halfD) / this.speed;
      if (o.time - w > this.t) continue;
      if (o.time + w < this.prevT) {
        o.done = 'passed';
        continue;
      }
      const [ox0, ox1] = this.obstacleX(o);
      const xHit = px1 > ox0 && px0 < ox1;
      const yHit = py1 > shape.y0 && py0 < shape.y1;
      if (xHit && yHit) {
        this.collide(o);
        continue;
      }
      if (o.time + w < this.t) {
        o.done = 'passed';
        this.checkNearMiss(o, xHit, ox0, ox1, px0, px1);
      }
    }
  }

  private checkNearMiss(o: Obstacle, xHit: boolean, ox0: number, ox1: number, px0: number, px1: number) {
    let style: 'side' | 'over' | 'under' | null = null;
    if (xHit) {
      if (o.kind === 'low' || o.kind === 'laserLow') style = this.t - this.jumpAt < JUMP_LATE ? 'over' : null;
      else if (o.kind === 'high' || o.kind === 'laserHigh') style = this.t - this.slideAt < SLIDE_LATE ? 'under' : null;
    } else if (o.kind !== 'laserLow' && o.kind !== 'laserHigh') {
      const gap = Math.max(ox0 - px1, px0 - ox1);
      if (gap < 0.85 && this.t - this.laneAt < LATE_DODGE) style = 'side';
    }
    if (!style) return;
    this.nearMisses++;
    if (style !== 'side') this.stats.closeMoves++;
    this.bumpCombo();
    const bonus = 50 * this.mult;
    this.score += bonus;
    this.events.push({ type: 'nearMiss', obstacle: o, style, bonus });
  }

  private collide(o: Obstacle) {
    if (this.powers.overdrive > 0) {
      o.done = 'smashed';
      this.stats.smashes++;
      this.score += 25 * this.mult;
      this.events.push({ type: 'smash', obstacle: o });
    } else if (this.invuln > 0) {
      o.done = 'passed';
    } else if (this.powers.shield > 0) {
      this.powers.shield = 0;
      this.invuln = 1;
      this.combo = 0;
      o.done = 'smashed';
      this.events.push({ type: 'shieldBreak', obstacle: o });
    } else {
      o.done = 'hit';
      this.alive = false;
      this.events.push({ type: 'death', obstacle: o });
    }
  }

  private bumpCombo() {
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboTimer = COMBO_WINDOW;
  }

  private updatePickups() {
    const cy = this.y + (this.sliding ? 0.45 : 0.75);
    const magnet = this.powers.magnet > 0;
    for (const p of this.track.pickups) {
      if (p.taken) continue;
      if (Math.abs(p.time - this.t) * this.speed > 1.3 && !(p.time > this.prevT && p.time <= this.t)) continue;
      const dx = Math.abs(laneX(p.lane) - this.x);
      const reachX = magnet && p.kind === 'orb' ? LANE_W * 2.6 : 1.15;
      const reachY = magnet && p.kind === 'orb' ? 99 : 1.15;
      if (dx > reachX || Math.abs(p.y - cy) > reachY) continue;
      p.taken = true;
      if (p.kind === 'orb') {
        this.orbs++;
        this.bumpCombo();
        this.score += 10 * this.mult;
        this.events.push({ type: 'orb', pickup: p, combo: this.combo });
      } else {
        this.powers[p.kind] = POWER_TIME[p.kind];
        this.stats.powers++;
        this.stats[p.kind === 'shield' ? 'shields' : p.kind === 'magnet' ? 'magnets' : 'overdrives']++;
        this.firstPowerAt ??= this.distance;
        this.score += 100;
        this.events.push({ type: 'power', pickup: p });
      }
    }
  }

  /** Beats since the run began (for the renderer's pulses). */
  get beat() {
    return this.t / BEAT;
  }
}

const JUMP_LATE = 0.42;
const SLIDE_LATE = 0.4;
