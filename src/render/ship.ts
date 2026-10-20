// The player's craft: a low-poly delta with glowing edges, engine flames, wingtip light trails
// and a shield bubble.
import * as THREE from 'three';
import type { Sim } from '../core/sim.ts';
import { trailMaterial } from './materials.ts';
import type { LivePalette } from './palette.ts';

const TRAIL_POINTS = 46;

class Trail {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private pos: Float32Array;
  private alpha: Float32Array;
  readonly color = new THREE.Color();

  constructor(width: number) {
    this.pos = new Float32Array(TRAIL_POINTS * 2 * 3);
    this.alpha = new Float32Array(TRAIL_POINTS * 2);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, trailMaterial(this.color));
    this.mesh.frustumCulled = false;
    this.width = width;
  }

  private width: number;

  reset() {
    this.pts = [];
  }

  /** `flow` is how far the world moved toward the camera this frame. */
  update(head: THREE.Vector3, flow: number, strength: number) {
    for (const p of this.pts) p.z += flow;
    this.pts.unshift(head.clone());
    if (this.pts.length > TRAIL_POINTS) this.pts.pop();
    const n = this.pts.length;
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
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

export class Ship {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  private hull: THREE.Mesh;
  private edges: THREE.LineSegments;
  private edgeMat = new THREE.LineBasicMaterial({ toneMapped: false });
  private flames: THREE.Mesh[] = [];
  private flameMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private engineMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  private shield: THREE.LineSegments;
  private shieldMat = new THREE.LineBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private aura: THREE.Mesh;
  private auraMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
  readonly trails = [new Trail(0.07), new Trail(0.07)];
  private tips = [new THREE.Vector3(-1.0, 0.14, 0.62), new THREE.Vector3(1.0, 0.14, 0.62)];
  private shieldFlash = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    // Hand-built delta hull.
    const N = [0, 0.26, -1.55];
    const L = [-1.02, 0.12, 0.62];
    const R = [1.02, 0.12, 0.62];
    const T = [0, 0.58, 0.32];
    const B = [0, 0.02, 0.6];
    const LI = [-0.35, 0.16, 0.7];
    const RI = [0.35, 0.16, 0.7];
    const tris = [N, L, T, N, T, R, L, LI, T, LI, RI, T, RI, R, T, N, B, L, N, R, B, L, B, LI, R, RI, B, LI, B, RI];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
    g.computeVertexNormals();
    this.hull = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x0a0420 }));
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 1), this.edgeMat);
    this.body.add(this.hull, this.edges);

    // Engines and flames.
    for (const x of [-0.24, 0.24]) {
      const eng = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), this.engineMat);
      eng.position.set(x, 0.2, 0.72);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 1, 10, 1, true), this.flameMat);
      // Wide at the nozzle, tapering backwards (+z).
      flame.geometry.translate(0, 0.5, 0);
      flame.rotation.x = Math.PI / 2;
      flame.position.set(x, 0.2, 0.74);
      this.flames.push(flame);
      this.body.add(eng, flame);
    }

    // Shield bubble and overdrive aura.
    this.shield = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.6, 1)), this.shieldMat);
    this.shield.position.y = 0.3;
    this.aura = new THREE.Mesh(new THREE.SphereGeometry(1.7, 20, 14), this.auraMat);
    this.aura.position.y = 0.3;
    this.body.add(this.shield, this.aura);

    this.group.add(this.body);
  }

  reset() {
    this.group.visible = true;
    for (const t of this.trails) t.reset();
  }

  breakShield() {
    this.shieldFlash = 1;
  }

  update(sim: Sim, p: LivePalette, dt: number, time: number, flow: number, alive: boolean) {
    const od = sim.powers.overdrive > 0;
    const hover = Math.sin(time * 3.2) * 0.06;
    const slide = sim.sliding ? 1 : 0;
    this.group.position.set(sim.x, 0.38 + sim.y + hover - slide * 0.18, 0);
    this.body.rotation.z = -sim.bank * 0.55;
    this.body.rotation.x = Math.max(-0.35, Math.min(0.35, sim.vy * 0.025));
    this.body.rotation.y = sim.bank * 0.12;
    const sy = 1 - slide * 0.45;
    this.body.scale.y += (sy - this.body.scale.y) * Math.min(1, dt * 18);

    const main = od ? p.c.sunTop : p.c.secondary;
    this.edgeMat.color.copy(main).multiplyScalar(2.2);
    this.engineMat.color.copy(od ? p.c.warm : p.c.primary).multiplyScalar(3);
    this.flameMat.color.copy(od ? p.c.warm : p.c.primary).multiplyScalar(1.6);
    const thrust = 0.7 + (sim.speed / 92) * 1.2 + (od ? 0.8 : 0) + Math.random() * 0.25;
    for (const f of this.flames) f.scale.set(1, thrust, 1);

    const shieldOn = sim.powers.shield > 0;
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 2.5);
    const ending = shieldOn && sim.powers.shield < 2 ? (Math.sin(time * 30) > 0 ? 1 : 0.3) : 1;
    this.shield.visible = shieldOn || this.shieldFlash > 0;
    this.shieldMat.color.copy(p.c.secondary).multiplyScalar(shieldOn ? 1.4 * ending : 3 * this.shieldFlash);
    this.shield.scale.setScalar(1 + (1 - this.shieldFlash) * (shieldOn ? 0 : 0.8));
    this.shield.rotation.y = time * 0.8;
    this.shield.rotation.x = time * 0.5;

    this.aura.visible = od;
    this.auraMat.color.copy(p.c.warm).multiplyScalar(0.35 + Math.sin(time * 20) * 0.08);

    // Blink while invulnerable after a shield break.
    this.body.visible = !(sim.invuln > 0 && Math.sin(time * 40) < 0);

    this.group.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const tr = this.trails[i];
      tr.color.copy(od ? p.c.warm : p.c.primary);
      this.tmp.copy(this.tips[i]);
      this.body.localToWorld(this.tmp);
      tr.update(this.tmp, flow, alive ? 1 : 0.4);
    }
  }
}
