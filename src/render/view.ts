// Owns the WebGL renderer, camera and post-processing, and turns simulation events into visuals.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BEAT, LANE_W, SPEED_MAX, SPEED_START, laneX } from '../core/config.ts';
import type { Sim, SimEvent } from '../core/sim.ts';
import { FinishShader, fogUniforms } from './materials.ts';
import { LivePalette } from './palette.ts';
import { World } from './world.ts';
import { Ship } from './ship.ts';
import { Things } from './things.ts';
import { Fx } from './fx.ts';
import type { Loadout, ShipId } from '../meta/garage.ts';
import { bend, bendUniform, curveAt } from './curve.ts';
import { PULSE_RANGE } from '../core/ships.ts';
import { SetPieces } from './setpieces.ts';

export type Quality = 'auto' | 'high' | 'medium' | 'low';
export type ViewMode = 'title' | 'run' | 'dying' | 'paused' | 'garage';
/** Camera modes for replays ('chase' is the normal gameplay camera). */
export type CamMode = 'chase' | 'cinematic' | 'side' | 'low' | 'top' | 'orbit';
const CINEMATIC_SHOTS: CamMode[] = ['side', 'low', 'top', 'orbit', 'chase'];
const SHOT_LENGTH = 4.5;

const QUALITY = {
  high: { ratio: 2, bloom: 1 },
  medium: { ratio: 1.25, bloom: 0.5 },
  low: { ratio: 1, bloom: 0 },
};

const WHITE = new THREE.Color(1, 1, 1);

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly palette = new LivePalette();
  readonly scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1200);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private finish: ShaderPass;
  private world = new World();
  private ship = new Ship();
  private ghostShip = new Ship({ ghost: true });
  private ghostWasAlive = true;
  private sparkPos = [new THREE.Vector3(), new THREE.Vector3()];
  private things = new Things();
  private fx = new Fx();
  // The Interceptor's pulse: a bright bolt that flashes down the lane and fades.
  private beamMat = bend(new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  private beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 1, 1, 1, 32).translate(0, 0, -0.5), this.beamMat);
  private beamLife = 0;
  private lastDemo = 0;
  private setPieces = new SetPieces();
  /** Camera roll for gravity flips (0 or π once settled). */
  private roll = 0;
  /** 0..1, eases in while inside a tunnel (the camera tucks in lower). */
  private tunnelK = 0;
  /** 0..1 while the Sentinel is up: the sky darkens behind it. */
  private bossK = 0;
  private lastBeat = -1;

  private quality: Quality = 'auto';
  private ratio = 1.5;
  private frameEma = 16;
  private slowFor = 0;
  private fastFor = 0;

  private shake = 0;
  private flash = 0;
  private flashColor = new THREE.Color();
  private aberration = 0;
  private fovKick = 0;
  private camPos = new THREE.Vector3(0, 3, 8);
  private camLook = new THREE.Vector3(0, 1, -14);
  private offset = 0;
  private tmp = new THREE.Vector3();
  shakeEnabled = true;
  /** Curved, rolling road (purely visual). */
  curves = true;
  cameraMode: CamMode = 'chase';
  private shot: CamMode = 'chase';
  private bendTarget = new THREE.Vector2();
  /** Screen point (px) where the garage preview should centre the ship, clear of the UI panel. */
  garageFocus: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(0x000000);
    // Standard materials (arches, towers) fade into the horizon colour like the custom shaders do.
    this.scene.fog = new THREE.Fog(0x000000, 40, 210);
    this.scene.add(this.world.group, this.things.group, this.ship.group, this.fx.group);
    for (const t of this.ship.trails) this.scene.add(t.mesh);
    this.scene.add(this.ghostShip.group, this.ghostShip.trails[0].mesh);
    this.ghostShip.group.visible = false;
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.scene.add(this.beam, this.setPieces.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.5, 0.42);
    this.composer.addPass(this.bloom);
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.resize());
    this.setQuality('auto');
  }

  setQuality(q: Quality) {
    this.quality = q;
    const preset = QUALITY[q === 'auto' ? 'high' : q];
    this.ratio = Math.min(window.devicePixelRatio || 1, preset.ratio);
    this.bloom.enabled = preset.bloom > 0;
    this.resize();
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.ratio);
    this.composer.setSize(w, h);
    const bloomScale = this.quality === 'medium' ? 0.35 : 0.5;
    this.bloom.resolution.set(Math.round(w * this.ratio * bloomScale), Math.round(h * this.ratio * bloomScale));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.material.uniforms.uScale.value = (h * this.ratio) / 900;
  }

  /** Auto quality: step resolution down when frames are slow, back up when there's headroom. */
  private adapt(dt: number) {
    if (this.quality !== 'auto') return;
    this.frameEma += (dt * 1000 - this.frameEma) * 0.05;
    if (this.frameEma > 21) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else if (this.frameEma < 14) {
      this.fastFor += dt;
      this.slowFor = 0;
    } else {
      this.slowFor = this.fastFor = 0;
    }
    const max = Math.min(window.devicePixelRatio || 1, 2);
    if (this.slowFor > 1.5 && this.ratio > 0.6) {
      this.ratio = Math.max(0.6, this.ratio - 0.25);
      if (this.ratio <= 0.85) this.bloom.enabled = false;
      this.slowFor = 0;
      this.resize();
    } else if (this.fastFor > 5 && this.ratio < max) {
      this.ratio = Math.min(max, this.ratio + 0.25);
      this.bloom.enabled = true;
      this.fastFor = 0;
      this.resize();
    }
  }

  get pixelRatio() {
    return this.ratio;
  }

  setLoadout(l: Loadout) {
    this.ship.setLoadout(l);
  }

  /** Shows a ghost flying a recorded run (its hull from the recording), or hides it with null. */
  setGhostShip(ship: ShipId | null) {
    if (ship) this.ghostShip.setLoadout({ ship, trail: 'twin', color: 'sector' });
    // reset() makes the ship visible, so it has to come before hiding.
    this.ghostShip.reset();
    this.ghostShip.group.visible = ship !== null;
    this.ghostShip.trails[0].mesh.visible = ship !== null;
    this.ghostWasAlive = true;
  }

  reset() {
    this.palette.set(0, true);
    this.things.reset();
    this.fx.reset();
    this.ship.reset();
    this.flash = 0;
    this.shake = 0;
    this.aberration = 0;
    this.beamLife = 0;
    this.roll = 0;
    this.tunnelK = 0;
    this.bossK = 0;
  }

  /** Fires the pulse bolt from the ship's nose to `toZ` (negative is ahead). */
  private fireBeam(from: THREE.Vector3, toZ: number, col: THREE.Color) {
    this.beam.position.set(from.x, from.y + 0.1, from.z - 0.8);
    this.beam.scale.set(1, 1, Math.max(1, this.beam.position.z - toZ));
    this.beamMat.color.copy(col).multiplyScalar(3);
    this.beamLife = 1;
    // Seen from the chase camera the bolt is nearly end-on, so a spray of sparks along it sells the shot.
    const len = this.beam.scale.z;
    for (let i = 0; i < 40; i++) {
      const z = this.beam.position.z - Math.random() * len;
      this.fx.spawn(from.x + (Math.random() - 0.5) * 0.3, from.y + 0.1 + (Math.random() - 0.5) * 0.3, z, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0, 0.35, 0.45, i % 3 ? col : WHITE);
    }
  }

  // ---------------------------------------------------------------- events

  handle(e: SimEvent, sim: Sim) {
    const c = this.palette.c;
    const shipPos = this.ship.group.position;
    switch (e.type) {
      case 'orb': {
        this.fx.burst(this.tmp.set(laneX(e.pickup.lane), e.pickup.y, 0), c.secondary, 14, 7, 0.5, 0.45);
        break;
      }
      case 'power': {
        const col = e.pickup.kind === 'shield' ? new THREE.Color(0x4fd8ff) : e.pickup.kind === 'magnet' ? new THREE.Color(0xff8a2b) : new THREE.Color(0xffe14d);
        this.fx.burst(this.tmp.copy(shipPos), col, 70, 14, 0.8, 0.8);
        this.doFlash(col, 0.25);
        this.fovKick = 6;
        break;
      }
      case 'nearMiss': {
        const o = e.obstacle;
        const p = this.things.obstaclePos(o, sim, this.tmp);
        if (e.style === 'side') p.x = p.x > sim.x ? p.x - LANE_W / 2 + 0.2 : p.x + LANE_W / 2 - 0.2;
        p.z = 0;
        this.fx.burst(p, WHITE, 26, 11, 0.45, 0.4);
        this.fx.burst(p, c.primary, 16, 7, 0.6, 0.5);
        this.aberration = Math.max(this.aberration, 0.008);
        this.fovKick = Math.max(this.fovKick, 3);
        break;
      }
      case 'smash':
      case 'shieldBreak': {
        const o = e.obstacle;
        const p = this.things.obstaclePos(o, sim, this.tmp);
        p.z = Math.min(p.z, 0);
        const col = this.things.colorOf(o.kind);
        this.fx.burst(p, col, 90, 16, 0.9, 0.9, { gravity: 18, up: 4 });
        this.fx.burst(p, WHITE, 30, 20, 0.5, 0.4);
        this.addShake(e.type === 'smash' ? 0.35 : 0.6);
        if (e.type === 'shieldBreak') {
          this.ship.breakShield();
          this.doFlash(c.secondary, 0.35);
          this.aberration = 0.02;
        }
        break;
      }
      case 'death': {
        const at = shipPos.clone();
        this.ship.group.visible = false;
        this.fx.shatter(at, c.secondary, sim.speed * 0.15);
        // Layered but restrained: too many additive particles in one spot just saturate to white.
        this.fx.burst(at, c.warm, 90, 18, 1.0, 1.3, { flow: false, gravity: 6, up: 3 });
        this.fx.burst(at, WHITE, 22, 28, 0.5, 0.5, { flow: false });
        this.fx.burst(at, c.primary, 45, 11, 1.3, 1.6, { flow: false });
        this.fx.burst(at, c.secondary, 40, 22, 0.4, 0.9, { flow: false, gravity: 14, up: 5 });
        this.doFlash(c.warm, 0.5);
        this.addShake(1.4);
        this.aberration = 0.035;
        break;
      }
      case 'jump':
      case 'land': {
        this.fx.burst(this.tmp.set(sim.x, 0.1, 0.4), c.primary, e.type === 'land' ? 14 : 10, 5, 0.35, 0.35);
        break;
      }
      case 'pulse': {
        const hit = e.obstacle && this.things.obstaclePos(e.obstacle, sim, new THREE.Vector3());
        this.fireBeam(shipPos, hit ? hit.z : -PULSE_RANGE, c.secondary);
        this.fx.burst(this.tmp.copy(shipPos).setZ(shipPos.z - 1), c.secondary, 20, 6, 0.4, 0.3);
        if (hit && e.obstacle) {
          const col = this.things.colorOf(e.obstacle.kind);
          this.fx.burst(hit, col, 80, 15, 0.9, 0.8, { gravity: 16, up: 4 });
          this.fx.burst(hit, WHITE, 30, 20, 0.5, 0.4);
        }
        this.addShake(0.25);
        this.fovKick = Math.max(this.fovKick, 4);
        this.aberration = Math.max(this.aberration, 0.012);
        break;
      }
      case 'phase': {
        this.fx.burst(this.tmp.copy(shipPos), WHITE, 40, 9, 0.5, 0.5);
        this.doFlash(c.secondary, 0.2);
        this.aberration = Math.max(this.aberration, 0.03);
        break;
      }
      case 'phaseThrough': {
        const p = this.things.obstaclePos(e.obstacle, sim, this.tmp);
        p.z = 0;
        this.fx.burst(p, this.things.colorOf(e.obstacle.kind), 30, 8, 0.5, 0.5);
        break;
      }
      case 'ramp': {
        this.fx.burst(this.tmp.copy(shipPos).setY(0.1), c.sunTop, 40, 9, 0.5, 0.5, { gravity: 10 });
        this.fovKick = Math.max(this.fovKick, 7);
        this.addShake(0.2);
        break;
      }
      case 'boost': {
        this.fx.burst(this.tmp.copy(shipPos).setY(0.2), c.secondary, 36, 8, 0.45, 0.4, { up: 2 });
        this.fovKick = Math.max(this.fovKick, 8);
        this.aberration = Math.max(this.aberration, 0.012);
        break;
      }
      case 'flip': {
        this.fovKick = Math.max(this.fovKick, 10);
        this.aberration = Math.max(this.aberration, 0.03);
        this.doFlash(c.accent, 0.25);
        break;
      }
      case 'sentinelWarn': {
        this.doFlash(c.warm, 0.2);
        this.addShake(0.3);
        break;
      }
      case 'sentinelClear': {
        const at = this.setPieces.sentinelPos(new THREE.Vector3());
        this.fx.burst(at, c.warm, 160, 40, 6, 2.2, { flow: false, gravity: 8 });
        this.fx.burst(at, WHITE, 60, 60, 4, 1.2, { flow: false });
        this.fx.burst(at, c.accent, 90, 30, 7, 2.6, { flow: false });
        this.doFlash(WHITE, 0.45);
        this.addShake(0.9);
        this.fovKick = 12;
        break;
      }
      case 'glide': {
        this.fx.burst(this.tmp.copy(shipPos), c.secondary, 30, 6, 0.4, 0.5, { up: -3 });
        break;
      }
      case 'sector': {
        this.palette.set(e.sector);
        this.doFlash(new THREE.Color().setHex(0xffffff), 0.3);
        this.fovKick = 10;
        break;
      }
      default:
        break;
    }
  }

  private doFlash(col: THREE.Color, amount: number) {
    this.flashColor.copy(col);
    this.flash = Math.max(this.flash, amount);
  }

  addShake(n: number) {
    if (this.shakeEnabled) this.shake = Math.max(this.shake, n);
  }

  // ---------------------------------------------------------------- frame

  render(sim: Sim, dt: number, mode: ViewMode, time: number, ghost: Sim | null = null) {
    this.adapt(dt);
    const p = this.palette;
    p.update(dt);
    const c = p.c;

    const garage = mode === 'garage';
    // The road's bend follows distance travelled, so a replay curves exactly like the original run.
    if (garage || !this.curves) this.bendTarget.set(0, 0);
    else this.bendTarget.copy(curveAt(sim.distance, 1));
    bendUniform.value.lerp(this.bendTarget, 1 - Math.exp(-dt * 4));
    const moving = mode === 'run' || mode === 'title' || garage;
    const flow = moving ? sim.speed * dt * (garage ? 0.3 : 1) : 0;
    this.offset += flow;

    const beat = sim.t / BEAT;
    const phase = ((beat % 1) + 1) % 1;
    const pulse = moving ? Math.exp(-phase * 6) : 0;
    const speedK = (sim.speed - SPEED_START) / (SPEED_MAX - SPEED_START);
    const od = sim.powers.overdrive > 0;

    this.world.update(p, this.offset, dt, sim.speed, pulse, phase, moving ? Math.max(od || sim.boost > 0 ? 1 : 0, (speedK - 0.35) * 1.5) : 0, time);
    // The Sentinel flashes as it fires each volley.
    const beatIdx = Math.floor(beat);
    if (beatIdx !== this.lastBeat && sim.zone.sentinel === 'active' && mode === 'run') this.setPieces.onVolley();
    this.lastBeat = beatIdx;
    this.setPieces.update(sim, p, dt, time, this.offset, pulse, !garage);
    (this.scene.fog as THREE.Fog).color.copy(fogUniforms.uFog.value);
    this.ship.update(sim, p, dt, time, flow, mode !== 'dying', pulse, garage);
    this.things.group.visible = !garage;
    this.things.update(sim, p, time, pulse, this.ship.group.position);

    if (ghost && (mode === 'run' || mode === 'dying' || mode === 'paused')) {
      this.ghostShip.update(ghost, p, dt, time, flow, ghost.alive);
      if (this.ghostWasAlive && !ghost.alive) this.fx.burst(this.ghostShip.group.position.clone(), new THREE.Color(0.8, 0.9, 1), 50, 9, 0.6, 0.9);
      this.ghostWasAlive = ghost.alive;
    }

    // Stardust trail: glitter shed from the emitters.
    if (this.ship.loadout.trail === 'sparkle' && moving && this.ship.group.visible) {
      const [a, b] = this.ship.emitters(this.sparkPos);
      for (const at of [a, b]) {
        const col = new THREE.Color().setHSL(Math.random(), 0.9, 0.7);
        this.fx.spawn(at.x, at.y, at.z, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, 3, 0.6, 0.35, col);
      }
    }

    // Belly sparks while sliding.
    if (sim.sliding && mode === 'run') {
      for (let i = 0; i < 3; i++) {
        this.fx.spawn(sim.x + (Math.random() - 0.5) * 0.8, 0.08, 0.7, (Math.random() - 0.5) * 3, Math.random() * 3, 4 + Math.random() * 6, 0.3, 0.35, c.warm, { gravity: 12 });
      }
    }
    // Overdrive: embers streaming off the ship.
    if (od && mode === 'run') {
      this.fx.spawn(sim.x + (Math.random() - 0.5) * 1.6, 0.4 + sim.y + Math.random() * 0.6, 0.6, 0, 0, 6, 0.5, 0.5, c.warm);
    }
    // Phase: the ship sheds pale motes while it's out of phase.
    if (sim.phase > 0 && mode === 'run') {
      this.fx.spawn(sim.x + (Math.random() - 0.5) * 2, 0.3 + sim.y + Math.random(), (Math.random() - 0.5) * 2, 0, 0.5, 4, 0.5, 0.3, WHITE);
    }
    // Glide: wingtip vapour.
    if (sim.glide > 0 && mode === 'run') {
      const [a, b] = this.ship.emitters(this.sparkPos);
      for (const at of [a, b]) this.fx.spawn(at.x, at.y, at.z, 0, -0.5, 4, 0.4, 0.3, c.secondary);
    }
    // Garage: the Interceptor test-fires its cannon.
    if (garage && this.ship.loadout.ship === 'twin') {
      const d = this.ship.demo(time);
      if (d > 0 && this.lastDemo === 0) {
        this.fireBeam(this.ship.group.position, -30, c.secondary);
        this.fx.burst(this.tmp.copy(this.ship.group.position).setZ(-1.2), c.secondary, 24, 6, 0.4, 0.3, { flow: false });
      }
      this.lastDemo = d;
    }
    this.beamLife = Math.max(0, this.beamLife - dt * (mode === 'paused' ? 0 : 5));
    this.beam.visible = this.beamLife > 0;
    this.beamMat.opacity = this.beamLife;
    this.beam.scale.x = this.beam.scale.y = 0.5 + this.beamLife;

    // Paused (incl. photo mode) freezes effects in place while the camera can still move.
    this.fx.update(mode === 'paused' ? 0 : mode === 'dying' ? dt * 0.6 : dt, flow);

    // Camera.
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let fov: number;
    if (garage) {
      // Swing across the front of the parked ship; trails stream away behind it, out of the lens.
      const a = Math.sin(time * 0.25) * 1.05;
      pos = this.tmp.set(Math.sin(a) * 4, 1.5 + Math.sin(time * 0.21) * 0.25, -Math.cos(a) * 4);
      look = new THREE.Vector3(0, 0.75, 0);
      fov = 52;
    } else if (mode === 'title') {
      // Slow cinematic sweep beside the autopilot.
      pos = this.tmp.set(Math.sin(time * 0.17) * 7 + sim.x * 0.3, 1.9 + Math.sin(time * 0.23) * 0.6, 7.5 + Math.cos(time * 0.17) * 1.5);
      look = new THREE.Vector3(sim.x * 0.5, 1.4, -20);
      fov = 62;
    } else {
      // Cinematic mode cuts between shots on a timer; a cut snaps the camera instead of easing.
      let shot = this.cameraMode;
      if (shot === 'cinematic') shot = CINEMATIC_SHOTS[Math.floor(time / SHOT_LENGTH) % CINEMATIC_SHOTS.length];
      const cut = shot !== this.shot;
      this.shot = shot;
      const sx = sim.x;
      const sy = sim.y;
      switch (shot) {
        case 'side':
          pos = this.tmp.set(sx + 6.5, 1.6 + sy * 0.5, 2.5);
          look = new THREE.Vector3(sx, 0.9 + sy * 0.5, -6);
          fov = 55;
          break;
        case 'low':
          // Ahead of the ship, low on the grid, looking back at it.
          pos = this.tmp.set(sx - 1.8, 0.45, -7.5);
          look = new THREE.Vector3(sx, 0.9 + sy * 0.4, 1.5);
          fov = 60;
          break;
        case 'top':
          pos = this.tmp.set(sx * 0.4, 15, 9);
          look = new THREE.Vector3(sx * 0.4, 0, -10);
          fov = 58;
          break;
        case 'orbit':
          pos = this.tmp.set(sx + Math.sin(time * 0.6) * 5, 2.2 + sy * 0.4, Math.cos(time * 0.6) * 5);
          look = new THREE.Vector3(sx, 0.8 + sy * 0.6, 0);
          fov = 56;
          break;
        default:
          // Tucks in lower inside tunnels, under the ceiling.
          pos = this.tmp.set(sx * 0.55, 3.1 - this.tunnelK * 0.8 + sy * 0.35, 7.4 - speedK * 0.9 - this.tunnelK * 0.8);
          look = new THREE.Vector3(sx * 0.72, 1.15 + sy * 0.22, -14);
          fov = 66 + speedK * 12 + (od || sim.boost > 0 ? 8 : 0) - this.tunnelK * 4;
      }
      if (cut) {
        this.camPos.copy(pos);
        this.camLook.copy(look);
        this.camera.fov = fov;
      }
    }
    const k = 1 - Math.exp(-dt * (mode === 'dying' ? 2 : 9));
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.fovKick *= Math.exp(-dt * 5);
    this.camera.fov += (fov + this.fovKick - this.camera.fov) * Math.min(1, dt * 6);
    // In the garage, shift the image so the ship sits beside the panel (left on wide screens,
    // above it on phones where the panel docks at the bottom).
    if (garage) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const f = this.garageFocus ?? { x: w / 2, y: h / 2 };
      this.camera.setViewOffset(w, h, w / 2 - f.x, h / 2 - f.y, w, h);
    } else if (this.camera.view?.enabled) {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();

    this.shake *= Math.exp(-dt * 5);
    const sh = this.shake * 0.35;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);
    // Gravity flip: roll the whole view over (about a beat), so the ship rides the tunnel ceiling.
    const inPlay = mode !== 'title' && !garage;
    this.roll += ((inPlay && sim.flipped ? Math.PI : 0) - this.roll) * (1 - Math.exp(-dt * 7));
    this.tunnelK += ((inPlay && sim.zone.tunnel ? 1 : 0) - this.tunnelK) * (1 - Math.exp(-dt * 3));
    this.bossK += ((sim.zone.sentinel !== 'none' && mode !== 'garage' ? 1 : 0) - this.bossK) * (1 - Math.exp(-dt * 2));
    this.world.enclosed = Math.max(this.tunnelK, this.bossK * 0.8);
    // Lean slightly into the curve ahead.
    this.camera.rotateZ((mode === 'title' || garage ? 0 : -sim.bank * 0.07) - bendUniform.value.x * 40 + this.roll);

    // Post.
    this.flash *= Math.exp(-dt * 4.5);
    this.aberration *= Math.exp(-dt * 3);
    const f = this.finish.uniforms;
    f.uTime.value = time;
    f.uFlash.value = this.flash;
    (f.uFlashColor.value as THREE.Color).copy(this.flashColor);
    f.uAberration.value = 0.0015 + speedK * 0.003 + (od ? 0.004 : 0) + this.aberration;
    this.bloom.strength = 0.85 + pulse * 0.2 + (od ? 0.25 : 0);

    this.composer.render(dt);
  }

  /** Renders the current frame and returns it as a PNG data URL (photo mode). */
  capture(): string {
    this.composer.render(0);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** For UI that wants the ship's screen position (e.g. score popups). */
  shipScreen(out = new THREE.Vector2()) {
    return this.toScreen(this.ship.group.position, out);
  }

  /** Screen position of the ghost (for its name tag), or null when it isn't shown. */
  ghostScreen(out = new THREE.Vector2()) {
    if (!this.ghostShip.group.visible) return null;
    return this.toScreen(this.tmp.copy(this.ghostShip.group.position).setY(this.ghostShip.group.position.y + 1.1), out);
  }

  private toScreen(v: THREE.Vector3, out: THREE.Vector2) {
    this.tmp.copy(v).project(this.camera);
    return out.set((this.tmp.x * 0.5 + 0.5) * window.innerWidth, (-this.tmp.y * 0.5 + 0.5) * window.innerHeight);
  }
}
