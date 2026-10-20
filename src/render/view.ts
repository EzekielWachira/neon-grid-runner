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

export type Quality = 'auto' | 'high' | 'medium' | 'low';
export type ViewMode = 'title' | 'run' | 'dying' | 'paused';

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
  private things = new Things();
  private fx = new Fx();

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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(0x000000);
    // Standard materials (arches, towers) fade into the horizon colour like the custom shaders do.
    this.scene.fog = new THREE.Fog(0x000000, 40, 210);
    this.scene.add(this.world.group, this.things.group, this.ship.group, this.fx.group);
    for (const t of this.ship.trails) this.scene.add(t.mesh);

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

  reset() {
    this.palette.set(0, true);
    this.things.reset();
    this.fx.reset();
    this.ship.reset();
    this.flash = 0;
    this.shake = 0;
    this.aberration = 0;
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

  render(sim: Sim, dt: number, mode: ViewMode, time: number) {
    this.adapt(dt);
    const p = this.palette;
    p.update(dt);
    const c = p.c;

    const moving = mode === 'run' || mode === 'title';
    const flow = moving ? sim.speed * dt : 0;
    this.offset += flow;

    const beat = sim.t / BEAT;
    const phase = ((beat % 1) + 1) % 1;
    const pulse = moving ? Math.exp(-phase * 6) : 0;
    const speedK = (sim.speed - SPEED_START) / (SPEED_MAX - SPEED_START);
    const od = sim.powers.overdrive > 0;

    this.world.update(p, this.offset, dt, sim.speed, pulse, phase, moving ? Math.max(od ? 1 : 0, (speedK - 0.35) * 1.5) : 0, time);
    (this.scene.fog as THREE.Fog).color.copy(fogUniforms.uFog.value);
    this.ship.update(sim, p, dt, time, flow, mode !== 'dying');
    this.things.update(sim, p, time, pulse, this.ship.group.position);

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
    this.fx.update(mode === 'dying' ? dt * 0.6 : dt, flow);

    // Camera.
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let fov: number;
    if (mode === 'title') {
      // Slow cinematic sweep beside the autopilot.
      pos = this.tmp.set(Math.sin(time * 0.17) * 7 + sim.x * 0.3, 1.9 + Math.sin(time * 0.23) * 0.6, 7.5 + Math.cos(time * 0.17) * 1.5);
      look = new THREE.Vector3(sim.x * 0.5, 1.4, -20);
      fov = 62;
    } else {
      pos = this.tmp.set(sim.x * 0.55, 3.1 + sim.y * 0.35, 7.4 - speedK * 0.9);
      look = new THREE.Vector3(sim.x * 0.72, 1.15 + sim.y * 0.22, -14);
      fov = 66 + speedK * 12 + (od ? 8 : 0);
    }
    const k = 1 - Math.exp(-dt * (mode === 'dying' ? 2 : 9));
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.fovKick *= Math.exp(-dt * 5);
    this.camera.fov += (fov + this.fovKick - this.camera.fov) * Math.min(1, dt * 6);
    this.camera.updateProjectionMatrix();

    this.shake *= Math.exp(-dt * 5);
    const sh = this.shake * 0.35;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);
    this.camera.rotateZ(mode === 'title' ? 0 : -sim.bank * 0.07);

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

  /** For UI that wants the ship's screen position (e.g. score popups). */
  shipScreen(out = new THREE.Vector2()) {
    this.tmp.copy(this.ship.group.position).project(this.camera);
    return out.set((this.tmp.x * 0.5 + 0.5) * window.innerWidth, (-this.tmp.y * 0.5 + 0.5) * window.innerHeight);
  }
}
