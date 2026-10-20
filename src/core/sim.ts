// Game rules with no rendering: player physics, collisions, pickups, power-ups and scoring.
// The renderer and audio read this state and react to `events`; scripts/verify-runs.ts runs it headless.
import {
  BEAT,
  BOOST_TIME,
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
  RAMP_VY,
  distanceAt,
  isLaser,
  laneX,
  sectorAt,
  speedAt,
  type PowerKind,
} from './config.ts';
import { TRACK_VERSION, Track, moverLane, type Obstacle, type Pickup } from './track.ts';
import { zoneState, type ZoneState } from './zones.ts';
import {
  GLIDE_GRAVITY,
  GLIDE_MIN_Y,
  GLIDE_SINK,
  GLIDE_TIME,
  PHASE_TIME,
  PULSE_CHARGE,
  PULSE_GRID,
  PULSE_RANGE,
  SHIP_CLASSES,
  type ShipClass,
  type ShipId,
} from './ships.ts';

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
  | { type: 'sector'; sector: number }
  | { type: 'glide' }
  /** The pulse cannon fired; `obstacle` is what it destroyed (null for a miss). */
  | { type: 'pulse'; obstacle: Obstacle | null }
  | { type: 'phase' }
  | { type: 'phaseThrough'; obstacle: Obstacle }
  | { type: 'abilityReady' }
  | { type: 'ramp' }
  | { type: 'boost'; pickup: Pickup }
  | { type: 'tunnel'; on: boolean }
  | { type: 'flip'; on: boolean }
  | { type: 'sentinelWarn' }
  | { type: 'sentinelStart' }
  | { type: 'sentinelClear'; bonus: number };

export interface SimOptions {
  /** Track version the run is on (older recordings replay on the track they were made on). */
  trk?: number;
  /** Practice: start at this song time, with a clear run-up of PRACTICE_LEAD beats. */
  startAt?: number;
}

/** Beats of empty track at the start of a practice attempt. */
export const PRACTICE_LEAD = 4;

/** The simulation advances in fixed ticks so a recorded run replays identically at any frame rate. */
export const SIM_STEP = 1 / 240;

export type InputCode = 'L' | 'R' | 'J' | 'S' | 'A';
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

  /** The hull this run is flown in, and the rules it brings. */
  readonly ship: ShipId;
  readonly cls: ShipClass;
  /** 0..1; the ability can fire at 1. */
  abilityCharge = 0;
  /** Seconds of phase left (Phantom). */
  phase = 0;
  /** Seconds of glide left (Manta). */
  glide = 0;
  /** Seconds of boost-pad score doubling left. */
  boost = 0;
  /** Which set pieces are active (tunnel, flip, Sentinel). */
  zone: ZoneState;
  readonly trk: number;
  readonly startAt: number;
  private glideUsed = false;
  /** Song time the queued pulse fires at, or -1. */
  private fireAt = -1;

  events: SimEvent[] = [];

  /** Ticks simulated so far; `t` is always exactly ticks * SIM_STEP. */
  ticks = 0;
  /** Every input this run, for ghosts and replays. */
  readonly log: InputEntry[] = [];
  /** Per-run counters for missions. */
  stats = {
    jumps: 0,
    slides: 0,
    powers: 0,
    smashes: 0,
    closeMoves: 0,
    magnets: 0,
    overdrives: 0,
    shields: 0,
    abilities: 0,
    sideMisses: 0,
    glides: 0,
    pulseHits: 0,
    phaseThroughs: 0,
    ramps: 0,
    boosts: 0,
    sentinels: 0,
    flips: 0,
    /** Sectors finished without a jump, or without a power-up. */
    noJumpSectors: 0,
    noPowerSectors: 0,
    /** Most obstacles smashed during a single overdrive. */
    bestOverdriveSmash: 0,
  };
  private sectorJumps = 0;
  private sectorPowers = 0;
  private overdriveSmash = 0;
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
  constructor(seed: number, replay: InputEntry[] | null = null, ship: ShipId = 'delta', opts: SimOptions = {}) {
    this.seed = seed;
    this.replay = replay;
    this.ship = ship;
    this.cls = SHIP_CLASSES[ship];
    this.trk = opts.trk ?? TRACK_VERSION;
    this.abilityCharge = this.cls.ability === 'pulse' ? 0.5 : this.cls.ability === 'phase' ? 1 : 0;
    this.track = new Track(seed, this.cls.noPower, this.trk);
    this.track.generateUntil(VIEW_DIST / SPEED_START + 2);
    this.startAt = opts.startAt ?? 0;
    if (opts.startAt) {
      this.ticks = Math.round(opts.startAt / SIM_STEP);
      this.t = this.prevT = this.ticks * SIM_STEP;
      this.speed = speedAt(this.t);
      this.distance = distanceAt(this.t);
      this.sector = sectorAt(this.t);
      this.track.generateUntil(this.t + VIEW_DIST / SPEED_START + 2);
      this.track.clearBefore(this.t + PRACTICE_LEAD * BEAT);
    }
    this.zone = this.zoneAt(this.t);
  }

  private zoneAt(t: number): ZoneState {
    return this.track.features ? zoneState(t) : { sector: sectorAt(t), tunnel: false, flipped: false, sentinel: 'none' };
  }

  /** The camera is rolled over: the renderer flips the view and live controls follow the screen. */
  get flipped() {
    return this.zone.flipped;
  }

  /** Full duration of a power-up for this ship. */
  powerMax(k: PowerKind) {
    return POWER_TIME[k] * this.cls.powerTime;
  }

  /** True while the pulse is queued for the next sixteenth note. */
  get firing() {
    return this.fireAt >= 0;
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

  ability() {
    this.input('A');
  }

  get isGhost() {
    return this.replay !== null;
  }

  private input(a: InputCode, fromReplay = false) {
    if (!this.alive) return;
    if (!fromReplay) {
      if (this.replay) return;
      // An ability press that can't do anything isn't worth a byte of the log.
      if (a === 'A' && !this.canUseAbility()) return;
      this.log.push({ tick: this.ticks, a });
    }
    if (a === 'L' || a === 'R') this.doMove(a === 'L' ? -1 : 1);
    else if (a === 'J') this.doJump();
    else if (a === 'A') this.doAbility();
    else this.doSlide();
  }

  private doJump() {
    // Manta: a second press high in the air glides instead of buffering the next jump.
    if (this.cls.glide && !this.grounded && !this.glideUsed && this.y > GLIDE_MIN_Y) {
      this.glideUsed = true;
      this.glide = GLIDE_TIME;
      this.stats.glides++;
      this.vy = Math.max(this.vy, 0.6);
      this.events.push({ type: 'glide' });
      return;
    }
    this.jumpBuffer = INPUT_BUFFER;
  }

  canUseAbility() {
    return !!this.cls.ability && this.abilityCharge >= 1 && this.fireAt < 0 && this.phase <= 0;
  }

  private doAbility() {
    if (!this.canUseAbility()) return;
    this.abilityCharge = 0;
    this.stats.abilities++;
    if (this.cls.ability === 'pulse') {
      // Quantised to the music: it goes off on the next sixteenth note.
      this.fireAt = Math.ceil(this.t / PULSE_GRID - 1e-9) * PULSE_GRID;
    } else {
      this.phase = PHASE_TIME;
      this.events.push({ type: 'phase' });
    }
  }

  private firePulse() {
    this.fireAt = -1;
    const cx = laneX(this.lane);
    const x0 = cx - this.cls.halfW;
    const x1 = cx + this.cls.halfW;
    let target: Obstacle | null = null;
    for (const o of this.track.obstacles) {
      if (o.done || o.time <= this.t || isLaser(o.kind) || o.kind === 'ramp') continue;
      if ((o.time - this.t) * this.speed > PULSE_RANGE) break;
      const [ox0, ox1] = this.obstacleX(o, o.time);
      if (x1 > ox0 && x0 < ox1) {
        target = o;
        break;
      }
    }
    if (target) {
      target.done = 'smashed';
      this.stats.pulseHits++;
      this.addScore(25 * this.mult);
    }
    this.events.push({ type: 'pulse', obstacle: target });
  }

  /** Every point goes through here, so the ship's score multiplier applies to all of it. */
  private addScore(n: number) {
    this.score += n * this.cls.score;
  }

  private doMove(dir: -1 | 1) {
    const next = Math.min(LANES - 1, Math.max(0, this.lane + dir));
    if (next === this.lane) return;
    this.lane = next;
    this.laneAt = this.t;
    this.events.push({ type: 'lane', dir });
  }

  private doSlide() {
    this.glide = 0;
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

    if (this.fireAt >= 0 && t >= this.fireAt - 1e-9) this.firePulse();
    this.updateAbility(dt);
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

    this.boost = Math.max(0, this.boost - dt);
    this.addScore(this.speed * dt * 0.1 * this.mult * (this.powers.overdrive > 0 ? 2 : 1) * (this.boost > 0 ? 2 : 1));

    this.updateZones(t);

    const sector = sectorAt(t);
    if (sector !== this.sector) {
      if (this.sectorJumps === 0) this.stats.noJumpSectors++;
      if (this.sectorPowers === 0) this.stats.noPowerSectors++;
      this.sectorJumps = this.sectorPowers = 0;
      this.sector = sector;
      this.events.push({ type: 'sector', sector });
      // Phase recharges at the start of every sector.
      if (this.cls.ability === 'phase' && this.abilityCharge < 1 && this.phase <= 0) {
        this.abilityCharge = 1;
        this.events.push({ type: 'abilityReady' });
      }
    }
  }

  private updateZones(t: number) {
    const z = this.zoneAt(t);
    const p = this.zone;
    if (z.sentinel !== p.sentinel) {
      if (z.sentinel === 'warn') this.events.push({ type: 'sentinelWarn' });
      else if (z.sentinel === 'active') this.events.push({ type: 'sentinelStart' });
      else if (p.sentinel === 'active') {
        // Survived the whole barrage.
        const bonus = Math.round((1000 + 500 * z.sector) * this.cls.score);
        this.score += bonus;
        this.stats.sentinels++;
        this.events.push({ type: 'sentinelClear', bonus });
      }
    }
    if (z.tunnel !== p.tunnel) this.events.push({ type: 'tunnel', on: z.tunnel });
    if (z.flipped !== p.flipped) {
      if (!z.flipped) this.stats.flips++;
      this.events.push({ type: 'flip', on: z.flipped });
    }
    this.zone = z;
  }

  private updateAbility(dt: number) {
    this.phase = Math.max(0, this.phase - dt);
    if (this.cls.ability === 'pulse' && this.abilityCharge < 1 && this.fireAt < 0) {
      this.abilityCharge = Math.min(1, this.abilityCharge + dt / PULSE_CHARGE);
      if (this.abilityCharge >= 1) this.events.push({ type: 'abilityReady' });
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
      this.glideUsed = false;
      this.jumpAt = this.t;
      this.stats.jumps++;
      this.sectorJumps++;
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
      if (this.glide > 0) {
        this.glide = Math.max(0, this.glide - dt);
        this.vy = Math.max(GLIDE_SINK, this.vy - GRAVITY * GLIDE_GRAVITY * dt);
      } else {
        this.vy -= GRAVITY * dt;
      }
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.glide = 0;
        this.grounded = true;
        this.events.push({ type: 'land' });
      }
    }
    this.slideTimer = Math.max(0, this.slideTimer - dt);

    const target = laneX(this.lane);
    const maxStep = (LANE_W / (LANE_TIME * this.cls.laneTime)) * dt;
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
    const px0 = this.x - this.cls.halfW;
    const px1 = this.x + this.cls.halfW;
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
      if (o.kind === 'ramp') {
        if (xHit && this.y < 0.3) this.launch();
        if (xHit || o.time + w < this.t) o.done = 'passed';
        continue;
      }
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

  /** Ramp: thrown high enough to clear a wall of blocks one beat later. */
  private launch() {
    this.grounded = false;
    this.y = Math.max(this.y, 0.01);
    this.vy = RAMP_VY;
    this.slideTimer = 0;
    this.slideBuffer = 0;
    this.glideUsed = false;
    this.jumpAt = this.t;
    this.stats.ramps++;
    this.events.push({ type: 'ramp' });
  }

  private checkNearMiss(o: Obstacle, xHit: boolean, ox0: number, ox1: number, px0: number, px1: number) {
    let style: 'side' | 'over' | 'under' | null = null;
    if (xHit) {
      if (o.kind === 'low' || o.kind === 'laserLow') style = this.t - this.jumpAt < JUMP_LATE ? 'over' : null;
      else if (o.kind === 'high' || o.kind === 'laserHigh') style = this.t - this.slideAt < SLIDE_LATE ? 'under' : null;
    } else if (!isLaser(o.kind)) {
      const gap = Math.max(ox0 - px1, px0 - ox1);
      if (gap < 0.85 && this.t - this.laneAt < LATE_DODGE) style = 'side';
    }
    if (!style) return;
    this.nearMisses++;
    if (style !== 'side') this.stats.closeMoves++;
    else this.stats.sideMisses++;
    this.bumpCombo();
    const bonus = Math.round(50 * this.mult * this.cls.score);
    this.score += bonus;
    this.events.push({ type: 'nearMiss', obstacle: o, style, bonus });
  }

  private collide(o: Obstacle) {
    if (this.powers.overdrive > 0) {
      o.done = 'smashed';
      this.stats.smashes++;
      this.overdriveSmash++;
      this.stats.bestOverdriveSmash = Math.max(this.stats.bestOverdriveSmash, this.overdriveSmash);
      this.addScore(25 * this.mult);
      this.events.push({ type: 'smash', obstacle: o });
    } else if (this.phase > 0) {
      o.done = 'passed';
      this.stats.phaseThroughs++;
      this.events.push({ type: 'phaseThrough', obstacle: o });
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
      if (p.kind === 'boost') {
        this.boost = BOOST_TIME;
        this.stats.boosts++;
        this.events.push({ type: 'boost', pickup: p });
      } else if (p.kind === 'orb') {
        this.orbs++;
        this.bumpCombo();
        this.addScore(10 * this.mult);
        this.events.push({ type: 'orb', pickup: p, combo: this.combo });
      } else {
        this.powers[p.kind] = this.powerMax(p.kind);
        if (p.kind === 'overdrive') this.overdriveSmash = 0;
        this.stats.powers++;
        this.sectorPowers++;
        this.stats[p.kind === 'shield' ? 'shields' : p.kind === 'magnet' ? 'magnets' : 'overdrives']++;
        this.firstPowerAt ??= this.distance;
        this.addScore(100);
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
