// The player's craft (and the ghost's): a low-poly hull with glowing edges, engine flames,
// light trails and a shield bubble. Hull, trail style and colour come from the garage loadout.
import * as THREE from 'three';
import type { Sim } from '../core/sim.ts';
import { colorHex, type Loadout, type ShipId } from '../meta/garage.ts';
import { trailMaterial } from './materials.ts';
import type { LivePalette } from './palette.ts';

const TRAIL_POINTS = 46;

class Trail {
  readonly mesh: THREE.Mesh;
  readonly color = new THREE.Color();
  private pts: THREE.Vector3[] = [];
  private pos: Float32Array;
  private alpha: Float32Array;
  private tint: Float32Array;
  width: number;

  constructor(width: number) {
    this.width = width;
    this.pos = new Float32Array(TRAIL_POINTS * 2 * 3);
    this.alpha = new Float32Array(TRAIL_POINTS * 2);
    this.tint = new Float32Array(TRAIL_POINTS * 2 * 3).fill(1);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.tint, 3));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, trailMaterial(this.color));
    this.mesh.frustumCulled = false;
  }

  reset() {
    this.pts = [];
  }

  /** `flow` is how far the world moved toward the camera this frame; `hue` < 0 means a solid colour. */
  update(head: THREE.Vector3, flow: number, strength: number, hue = -1, time = 0) {
    for (const p of this.pts) p.z += flow;
    this.pts.unshift(head.clone());
    if (this.pts.length > TRAIL_POINTS) this.pts.pop();
    const n = this.pts.length;
    const c = new THREE.Color();
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const p = this.pts[Math.min(i, n - 1)] ?? head;
      const f = i / (TRAIL_POINTS - 1);
      const w = this.width * (1 - f * 0.7);
      const o = i * 6;
      this.pos[o] = p.x;
      this.pos[o + 1] = p.y + w;
      this.pos[o + 2] = p.z;
      this.pos[o + 3] = p.x;
      this.pos[o + 4] = p.y - w;
      this.pos[o + 5] = p.z;
      const a = i < n ? Math.pow(1 - f, 1.6) * strength : 0;
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
      if (hue >= 0) c.setHSL((hue + f * 0.8 + time * 0.3) % 1, 1, 0.55);
      else c.setRGB(1, 1, 1);
      this.tint.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
  }
}

type V = [number, number, number];
interface HullDef {
  N: V;
  L: V;
  T: V;
  B: V;
  LI: V;
  /** Extra boxes (e.g. the Interceptor's booms): [x, y, z, w, h, d]. */
  boxes?: [number, number, number, number, number, number][];
}

const HULLS: Record<ShipId, HullDef> = {
  delta: { N: [0, 0.26, -1.55], L: [-1.02, 0.12, 0.62], T: [0, 0.58, 0.32], B: [0, 0.02, 0.6], LI: [-0.35, 0.16, 0.7] },
  arrow: { N: [0, 0.22, -2.25], L: [-0.62, 0.1, 0.5], T: [0, 0.5, 0.1], B: [0, 0.02, 0.55], LI: [-0.22, 0.14, 0.62] },
  manta: { N: [0, 0.16, -1.15], L: [-1.45, 0.06, 0.38], T: [0, 0.36, 0.2], B: [0, 0, 0.5], LI: [-0.52, 0.1, 0.78] },
  twin: {
    N: [0, 0.24, -1.35],
    L: [-0.95, 0.14, 0.45],
    T: [0, 0.5, 0.25],
    B: [0, 0.02, 0.55],
    LI: [-0.3, 0.16, 0.6],
    boxes: [
      [-0.82, 0.18, -0.1, 0.24, 0.24, 1.6],
      [0.82, 0.18, -0.1, 0.24, 0.24, 1.6],
    ],
  },
  phantom: { N: [0, 0.3, -1.7], L: [-1.18, 0.22, 0.85], T: [0, 0.72, 0.55], B: [0, -0.02, 0.38], LI: [-0.3, 0.26, 0.48] },
};

function hullGeometry(d: HullDef) {
  const mirror = (v: V): V => [-v[0], v[1], v[2]];
  const { N, L, T, B, LI } = d;
  const R = mirror(L);
  const RI = mirror(LI);
  const tris = [N, L, T, N, T, R, L, LI, T, LI, RI, T, RI, R, T, N, B, L, N, R, B, L, B, LI, R, RI, B, LI, B, RI];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

export interface ShipOptions {
  ghost?: boolean;
}

export class Ship {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  readonly trails = [new Trail(0.07), new Trail(0.07)];
  readonly ghost: boolean;
  loadout: Loadout = { ship: 'delta', trail: 'twin', color: 'sector' };

  private hullGroup = new THREE.Group();
  private hullMat: THREE.MeshBasicMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private flames: THREE.Mesh[] = [];
  private engines: THREE.Mesh[] = [];
  private flameMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private engineMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  private shield: THREE.LineSegments;
  private shieldMat = new THREE.LineBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private aura: THREE.Mesh;
  private auraMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
  private tips: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3()];
  private tail = new THREE.Vector3();
  private shieldFlash = 0;
  private fade = 1;
  private tmp = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(opts: ShipOptions = {}) {
    this.ghost = !!opts.ghost;
    this.hullMat = new THREE.MeshBasicMaterial({ color: 0x0a0420, transparent: this.ghost, opacity: this.ghost ? 0.12 : 1, depthWrite: !this.ghost });
    this.edgeMat = new THREE.LineBasicMaterial({ toneMapped: false, transparent: this.ghost, opacity: this.ghost ? 0.55 : 1, depthWrite: !this.ghost });
    this.body.add(this.hullGroup);

    this.shield = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.6, 1)), this.shieldMat);
    this.shield.position.y = 0.3;
    this.aura = new THREE.Mesh(new THREE.SphereGeometry(1.7, 20, 14), this.auraMat);
    this.aura.position.y = 0.3;
    // Hidden until update() decides otherwise (a ship that's never updated must not show them).
    this.shield.visible = false;
    this.aura.visible = false;
    this.body.add(this.shield, this.aura);
    this.group.add(this.body);
    this.setLoadout(this.loadout);
  }

  /** Rebuilds the hull for a new loadout. */
  setLoadout(l: Loadout) {
    this.loadout = { ...l };
    for (const c of [...this.hullGroup.children]) {
      this.hullGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    this.flames = [];
    this.engines = [];
    const def = HULLS[l.ship];
    const g = hullGeometry(def);
    this.hullGroup.add(new THREE.Mesh(g, this.hullMat), new THREE.LineSegments(new THREE.EdgesGeometry(g, 1), this.edgeMat));
    for (const [x, y, z, w, h, d] of def.boxes ?? []) {
      const bg = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(bg, this.hullMat);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(bg), this.edgeMat);
      m.position.set(x, y, z);
      e.position.set(x, y, z);
      this.hullGroup.add(m, e);
    }

    // Engines sit at the back; the Interceptor fires from its booms.
    const engineX = def.boxes ? def.boxes.map((b) => b[0]) : [-0.24, 0.24];
    const engineZ = def.boxes ? def.boxes[0][2] + def.boxes[0][5] / 2 : def.B[2] + 0.12;
    const engineY = def.boxes ? def.boxes[0][1] : 0.2;
    for (const x of engineX) {
      const eng = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), this.engineMat);
      eng.position.set(x, engineY, engineZ);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 1, 10, 1, true), this.flameMat);
      // Wide at the nozzle, tapering backwards (+z).
      flame.geometry.translate(0, 0.5, 0);
      flame.rotation.x = Math.PI / 2;
      flame.position.set(x, engineY, engineZ + 0.02);
      flame.visible = !this.ghost;
      eng.visible = !this.ghost;
      this.flames.push(flame);
      this.engines.push(eng);
      this.hullGroup.add(eng, flame);
    }
    const tipL = def.boxes ? [def.boxes[0][0], def.boxes[0][1], engineZ] : def.L;
    this.tips[0].set(tipL[0], tipL[1] + 0.02, tipL[2]);
    this.tips[1].set(-tipL[0], tipL[1] + 0.02, tipL[2]);
    this.tail.set(0, 0.2, engineZ + 0.05);

    const comet = l.trail === 'comet';
    this.trails[0].width = this.ghost ? 0.04 : comet ? 0.2 : 0.07;
    this.trails[1].mesh.visible = !comet && !this.ghost;
    for (const t of this.trails) t.reset();
  }

  reset() {
    this.group.visible = true;
    this.fade = 1;
    this.body.visible = true;
    for (const t of this.trails) t.reset();
  }

  breakShield() {
    this.shieldFlash = 1;
  }

  /** World positions of the trail emitters (for sparkle particles). */
  emitters(out: THREE.Vector3[]) {
    this.group.updateMatrixWorld(true);
    out[0].copy(this.tips[0]);
    this.body.localToWorld(out[0]);
    out[1].copy(this.tips[1]);
    this.body.localToWorld(out[1]);
    return out;
  }

  private mainColor(p: LivePalette, od: boolean) {
    if (this.ghost) return this.col.setRGB(0.85, 0.9, 1);
    if (od) return this.col.copy(p.c.sunTop);
    const hex = colorHex(this.loadout.color);
    return hex === null ? this.col.copy(p.c.secondary) : this.col.setHex(hex);
  }

  /** `garage` parks the ship centre-stage and spins it for the preview. */
  update(sim: Sim, p: LivePalette, dt: number, time: number, flow: number, alive: boolean, pulse = 0, garage = false) {
    const od = sim.powers.overdrive > 0 && !garage;
    if (garage) {
      this.group.position.set(0, 0.7 + Math.sin(time * 1.5) * 0.08, 0);
      // Gentle sway rather than a full spin, so the trails keep streaming backwards.
      this.body.rotation.set(0.08, Math.sin(time * 0.5) * 0.5, Math.sin(time * 0.8) * 0.12);
      this.body.scale.setScalar(1);
    } else {
      const hover = Math.sin(time * 3.2) * 0.06;
      const slide = sim.sliding ? 1 : 0;
      this.group.position.set(sim.x, 0.38 + sim.y + hover - slide * 0.18, 0);
      this.body.rotation.z = -sim.bank * 0.55;
      this.body.rotation.x = Math.max(-0.35, Math.min(0.35, sim.vy * 0.025));
      this.body.rotation.y = sim.bank * 0.12;
      const sy = 1 - slide * 0.45;
      this.body.scale.y += (sy - this.body.scale.y) * Math.min(1, dt * 18);
    }

    const main = this.mainColor(p, od);
    this.edgeMat.color.copy(main).multiplyScalar(this.ghost ? 1.2 : 2.2);
    const accent = this.ghost ? main : od ? p.c.warm : colorHex(this.loadout.color) !== null ? main : p.c.primary;
    this.engineMat.color.copy(accent).multiplyScalar(3);
    this.flameMat.color.copy(accent).multiplyScalar(1.6);
    const thrust = 0.7 + (sim.speed / 92) * 1.2 + (od ? 0.8 : 0) + Math.random() * 0.25;
    for (const f of this.flames) f.scale.set(1, thrust, 1);

    // A ghost fades out where its run ended.
    if (this.ghost) {
      this.fade = alive ? 1 : Math.max(0, this.fade - dt * 1.5);
      this.edgeMat.opacity = 0.55 * this.fade;
      this.hullMat.opacity = 0.12 * this.fade;
      this.group.visible = this.fade > 0.01;
    }

    const shieldOn = sim.powers.shield > 0 && !this.ghost && !garage;
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 2.5);
    const ending = shieldOn && sim.powers.shield < 2 ? (Math.sin(time * 30) > 0 ? 1 : 0.3) : 1;
    this.shield.visible = shieldOn || this.shieldFlash > 0;
    this.shieldMat.color.copy(p.c.secondary).multiplyScalar(shieldOn ? 1.4 * ending : 3 * this.shieldFlash);
    this.shield.scale.setScalar(1 + (1 - this.shieldFlash) * (shieldOn ? 0 : 0.8));
    this.shield.rotation.y = time * 0.8;
    this.shield.rotation.x = time * 0.5;

    this.aura.visible = od && !this.ghost;
    this.auraMat.color.copy(p.c.warm).multiplyScalar(0.35 + Math.sin(time * 20) * 0.08);

    // Blink while invulnerable after a shield break.
    if (!this.ghost) this.body.visible = garage || !(sim.invuln > 0 && Math.sin(time * 40) < 0);

    this.group.updateMatrixWorld(true);
    const style = this.loadout.trail;
    const strength = (alive ? 1 : 0.4) * (this.ghost ? 0.35 * this.fade : 1) * (style === 'pulse' && !this.ghost ? 0.35 + pulse * 1.3 : 1);
    const hue = style === 'rainbow' && !this.ghost ? (time * 0.15) % 1 : -1;
    const trailColor = this.ghost ? main : od ? p.c.warm : hue >= 0 ? this.col.setRGB(1, 1, 1) : colorHex(this.loadout.color) !== null ? main : p.c.primary;
    const flowNow = garage ? 0.35 * dt * 30 : flow;
    if (style === 'comet' || this.ghost) {
      this.trails[0].color.copy(trailColor);
      this.tmp.copy(this.tail);
      this.body.localToWorld(this.tmp);
      this.trails[0].update(this.tmp, flowNow, strength, hue, time);
    } else {
      for (let i = 0; i < 2; i++) {
        this.trails[i].color.copy(trailColor);
        this.tmp.copy(this.tips[i]);
        this.body.localToWorld(this.tmp);
        this.trails[i].update(this.tmp, flowNow, strength, hue, time);
      }
    }
  }
}
