// Particles (sparks, bursts, embers) and the ship's death shards.
import * as THREE from 'three';
import { particleMaterial } from './materials.ts';
import { bend } from './curve.ts';

const MAX = 3000;
const SHARDS = 60;

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  r: number;
  g: number;
  b: number;
  /** Rides along with the world toward the camera. */
  flow: boolean;
  gravity: number;
  drag: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Fx {
  readonly group = new THREE.Group();
  private ps: P[] = [];
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private points: THREE.Points;
  readonly material = particleMaterial();

  private shards: THREE.InstancedMesh;
  private shardData: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; life: number }[] = [];
  private shardMat = bend(new THREE.MeshBasicMaterial({ toneMapped: false }));
  private tmp = new THREE.Object3D();

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this.shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.28), this.shardMat, SHARDS);
    this.shards.count = 0;
    this.shards.frustumCulled = false;
    this.group.add(this.shards);
  }

  reset() {
    this.ps = [];
    this.shardData = [];
    this.shards.count = 0;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: THREE.Color, opts: { flow?: boolean; gravity?: number; drag?: number } = {}) {
    if (this.ps.length >= MAX) return;
    this.ps.push({ x, y, z, vx, vy, vz, life, max: life, size, r: c.r, g: c.g, b: c.b, flow: opts.flow ?? true, gravity: opts.gravity ?? 0, drag: opts.drag ?? 1.5 });
  }

  burst(at: THREE.Vector3, c: THREE.Color, n: number, speed: number, size: number, life = 0.6, opts: { flow?: boolean; gravity?: number; up?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const u = rand(-1, 1);
      const a = rand(0, Math.PI * 2);
      const s = Math.sqrt(1 - u * u);
      const v = rand(0.3, 1) * speed;
      this.spawn(at.x, at.y, at.z, Math.cos(a) * s * v, u * v + (opts.up ?? 0), Math.sin(a) * s * v, rand(life * 0.5, life), rand(size * 0.5, size), c, opts);
    }
  }

  /** The ship breaks apart into spinning shards plus a fireball. */
  shatter(at: THREE.Vector3, c: THREE.Color, forward: number) {
    this.shardMat.color.copy(c).multiplyScalar(2.5);
    this.shardData = [];
    for (let i = 0; i < SHARDS; i++) {
      this.shardData.push({
        p: at.clone().add(new THREE.Vector3(rand(-0.6, 0.6), rand(0, 0.5), rand(-0.8, 0.8))),
        v: new THREE.Vector3(rand(-9, 9), rand(2, 13), rand(-forward * 0.6, 4)),
        r: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)),
        w: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)),
        life: rand(1.6, 3),
      });
    }
    this.shards.count = SHARDS;
  }

  update(dt: number, flow: number) {
    const ps = this.ps;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      const d = Math.exp(-dt * p.drag);
      p.vx *= d;
      p.vy = p.vy * d - p.gravity * dt;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt + (p.flow ? flow : 0);
      if (p.y < 0.02 && p.gravity) {
        p.y = 0.02;
        p.vy *= -0.35;
      }
    }
    const n = Math.min(ps.length, MAX);
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const a = p.life / p.max;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.col[i * 3] = p.r;
      this.col[i * 3 + 1] = p.g;
      this.col[i * 3 + 2] = p.b;
      this.size[i] = p.size * (0.5 + 0.5 * a);
      this.alpha[i] = a;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true;

    if (this.shards.count) {
      let alive = 0;
      for (let i = 0; i < this.shardData.length; i++) {
        const s = this.shardData[i];
        s.life -= dt;
        s.v.y -= 22 * dt;
        s.v.multiplyScalar(Math.exp(-dt * 0.6));
        s.p.addScaledVector(s.v, dt);
        if (s.p.y < 0.1) {
          s.p.y = 0.1;
          s.v.y *= -0.4;
          s.v.x *= 0.7;
          s.v.z *= 0.7;
        }
        s.r.x += s.w.x * dt;
        s.r.y += s.w.y * dt;
        s.r.z += s.w.z * dt;
        const k = Math.max(0, Math.min(1, s.life));
        this.tmp.position.copy(s.p);
        this.tmp.rotation.copy(s.r);
        this.tmp.scale.setScalar(k);
        this.tmp.updateMatrix();
        this.shards.setMatrixAt(i, this.tmp.matrix);
        if (s.life > 0) alive++;
      }
      this.shards.instanceMatrix.needsUpdate = true;
      if (!alive) this.shards.count = 0;
    }
  }
}
