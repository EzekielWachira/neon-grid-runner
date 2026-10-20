// The environment: sky, sun, stars, wireframe mountains, the grid floor, rails, arches, towers and speed lines.
import * as THREE from 'three';
import { TRACK_HALF, LANE_W, VIEW_DIST } from '../core/config.ts';
import { mulberry32 } from '../core/rng.ts';
import { fogUniforms, floorMaterial, railMaterial, skyMaterial, sunMaterial } from './materials.ts';
import type { LivePalette } from './palette.ts';
import { bend } from './curve.ts';

const ARCH_SPACING = 36;
const ARCH_COUNT = 8;
const TOWER_COUNT = 70;
const TOWER_SPAN = 420;
const SPEEDLINES = 160;

const hdr = (c: THREE.Color, k: number) => new THREE.Color(c.r * k, c.g * k, c.b * k);

export class World {
  readonly group = new THREE.Group();
  private floor: THREE.ShaderMaterial;
  private sky: THREE.ShaderMaterial;
  private sun: THREE.ShaderMaterial;
  private rails: THREE.ShaderMaterial;
  private mountainLines: THREE.LineBasicMaterial;
  private mountainFill: THREE.MeshBasicMaterial;
  private arches: THREE.Group[] = [];
  /** One material per arch, so each can dim as it nears the camera. */
  private archMats: THREE.MeshBasicMaterial[] = [];
  private towerBody: THREE.InstancedMesh;
  private towerEdge: THREE.InstancedMesh;
  private towerTop: THREE.InstancedMesh;
  private towers: { x: number; z: number; w: number; h: number; d: number }[] = [];
  private speedLines: THREE.LineSegments;
  private speedPos: Float32Array;
  private speedMat: THREE.LineBasicMaterial;
  private stars: THREE.Points;
  private tmp = new THREE.Object3D();
  /** 0..1 while inside a tunnel: the sun and sky dim behind the walls. */
  enclosed = 0;

  constructor() {
    const g = this.group;

    // Sky dome and sun.
    this.sky = skyMaterial();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(520, 32, 16), this.sky);
    sky.renderOrder = -3;
    g.add(sky);

    this.sun = sunMaterial();
    // Sits just above the horizon so the striped lower half stays visible.
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), this.sun);
    sun.position.set(0, 64, -470);
    sun.renderOrder = -2;
    g.add(sun);

    // Stars in the upper sky.
    const rng = mulberry32(77);
    const starPos = new Float32Array(1400 * 3);
    for (let i = 0; i < 1400; i++) {
      const a = rng() * Math.PI * 2;
      const e = 0.06 + rng() * 1.4;
      starPos[i * 3] = Math.cos(a) * Math.cos(e) * 500;
      starPos[i * 3 + 1] = Math.sin(e) * 500;
      starPos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 500 - 60;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, fog: false }));
    this.stars.renderOrder = -2;
    g.add(this.stars);

    // Wireframe mountains framing a valley the track runs down.
    const { lines, fill } = this.buildMountains();
    this.mountainLines = lines.material as THREE.LineBasicMaterial;
    this.mountainFill = fill.material as THREE.MeshBasicMaterial;
    g.add(fill, lines);

    // Floor.
    this.floor = floorMaterial();
    this.floor.uniforms.uTrackHalf.value = TRACK_HALF;
    this.floor.uniforms.uLaneW.value = LANE_W;
    // Tessellated along its length so the curved-world bend has vertices to move.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(640, 520, 48, 160), this.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -240;
    g.add(floor);

    // Edge rails with running light dashes.
    this.rails = railMaterial();
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 440, 1, 1, 220), this.rails);
      rail.position.set(s * (TRACK_HALF + 0.12), 0.07, -210);
      g.add(rail);
    }

    // Neon arches over the track.
    const post = new THREE.BoxGeometry(0.22, 7.2, 0.22);
    const beam = new THREE.BoxGeometry(TRACK_HALF * 2 + 1.6, 0.22, 0.22);
    for (let i = 0; i < ARCH_COUNT; i++) {
      const a = new THREE.Group();
      const mat = bend(new THREE.MeshBasicMaterial({ toneMapped: false }));
      this.archMats.push(mat);
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(post, mat);
        p.position.set(s * (TRACK_HALF + 0.8), 3.6, 0);
        a.add(p);
      }
      const b = new THREE.Mesh(beam, mat);
      b.position.y = 7.2;
      a.add(b);
      this.arches.push(a);
      g.add(a);
    }

    // City of dark towers either side, with glowing edges.
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.towerBody = new THREE.InstancedMesh(box, bend(new THREE.MeshBasicMaterial({ color: 0x030108 })), TOWER_COUNT);
    this.towerEdge = new THREE.InstancedMesh(box, bend(new THREE.MeshBasicMaterial({ toneMapped: false })), TOWER_COUNT);
    this.towerTop = new THREE.InstancedMesh(box, bend(new THREE.MeshBasicMaterial({ toneMapped: false })), TOWER_COUNT);
    // Instances move every frame and the bend displaces them, so skip frustum culling.
    for (const m of [this.towerBody, this.towerEdge, this.towerTop]) m.frustumCulled = false;
    const trng = mulberry32(1234);
    for (let i = 0; i < TOWER_COUNT; i++) {
      const side = i % 2 ? 1 : -1;
      this.towers.push({
        x: side * (17 + trng() * 50),
        z: -trng() * TOWER_SPAN,
        w: 3 + trng() * 6,
        h: 6 + Math.pow(trng(), 1.6) * 46,
        d: 3 + trng() * 6,
      });
    }
    g.add(this.towerBody, this.towerEdge, this.towerTop);

    // Speed lines rushing past at high speed.
    this.speedPos = new Float32Array(SPEEDLINES * 6);
    for (let i = 0; i < SPEEDLINES; i++) this.resetSpeedLine(i, true);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.speedPos, 3));
    this.speedMat = bend(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.speedLines = new THREE.LineSegments(lg, this.speedMat);
    this.speedLines.frustumCulled = false;
    g.add(this.speedLines);
  }

  private buildMountains() {
    const rng = mulberry32(99);
    const cols = 110;
    const rows = 16;
    const W = 560;
    const D = 150;
    const grid: number[][] = [];
    const lat: number[] = [];
    for (let i = 0; i <= 64; i++) lat.push(rng());
    const n1 = (x: number) => {
      const f = ((((x / W + 0.5) * 64) % 64) + 64) % 64;
      const i = Math.floor(f);
      const t = f - i;
      const s = t * t * (3 - 2 * t);
      return lat[i] * (1 - s) + lat[(i + 1) % 64] * s;
    };
    const pos: number[] = [];
    for (let r = 0; r <= rows; r++) {
      grid.push([]);
      for (let c = 0; c <= cols; c++) {
        const x = -W / 2 + (c / cols) * W;
        const z = -300 - (r / rows) * D;
        const valley = Math.min(1, Math.max(0, (Math.abs(x) - 14) / 100));
        const ridge = Math.sin((r / rows) * Math.PI);
        const h = (n1(x * 1.3 + r * 9) * 0.65 + n1(x * 3.1 - r * 5) * 0.35) * 70 * valley * ridge + rng() * 3 * valley;
        grid[r].push(pos.length / 3);
        pos.push(x, h, z);
      }
    }
    const fillIdx: number[] = [];
    const lineIdx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const i = grid[r][c];
        if (c < cols) lineIdx.push(i, grid[r][c + 1]);
        if (r < rows) lineIdx.push(i, grid[r + 1][c]);
        if (r < rows && c < cols) fillIdx.push(i, grid[r + 1][c], grid[r][c + 1], grid[r][c + 1], grid[r + 1][c], grid[r + 1][c + 1]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const fillGeo = geo.clone();
    fillGeo.setIndex(fillIdx);
    geo.setIndex(lineIdx);
    const fill = new THREE.Mesh(fillGeo, bend(new THREE.MeshBasicMaterial({ color: 0x020006, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, fog: false })));
    const lines = new THREE.LineSegments(geo, bend(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7, fog: false, toneMapped: false })));
    fill.frustumCulled = false;
    lines.frustumCulled = false;
    return { fill, lines };
  }

  private resetSpeedLine(i: number, anywhere: boolean) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 12;
    const x = Math.cos(a) * r;
    const y = 2.5 + Math.sin(a) * r * 0.6;
    const z = anywhere ? -Math.random() * 90 : -90 - Math.random() * 20;
    const len = 3 + Math.random() * 6;
    const o = i * 6;
    this.speedPos.set([x, y, z, x, y, z - len], o);
  }

  /**
   * @param offset distance travelled (moves everything toward the camera)
   * @param pulse 0..1 beat pulse
   * @param beatPhase 0..1 within the current beat
   * @param rush 0..1 how strongly to show speed lines
   */
  update(p: LivePalette, offset: number, dt: number, speed: number, pulse: number, beatPhase: number, rush: number, time: number) {
    const c = p.c;
    fogUniforms.uFog.value.copy(c.skyHorizon).multiplyScalar(0.85);
    fogUniforms.uFogFar.value = VIEW_DIST + 30;

    const f = this.floor.uniforms;
    f.uOffset.value = offset;
    f.uPulse.value = pulse;
    f.uWave.value = (1 - beatPhase) * 200;
    f.uGrid.value.copy(c.grid);
    f.uTrack.value.copy(c.primary);

    this.sky.uniforms.uTop.value.copy(c.skyTop);
    this.sky.uniforms.uHorizon.value.copy(c.skyHorizon);
    this.sky.uniforms.uPulse.value = pulse;
    const dim = 1 - this.enclosed * 0.75;
    this.sun.uniforms.uTop.value.copy(c.sunTop).multiplyScalar(dim);
    this.sun.uniforms.uBottom.value.copy(c.sunBottom).multiplyScalar(dim);
    this.sun.uniforms.uTime.value = time;
    this.sun.uniforms.uPulse.value = pulse;

    this.rails.uniforms.uColor.value.copy(c.secondary);
    this.rails.uniforms.uOffset.value = offset;
    this.mountainLines.color.copy(c.mountain).multiplyScalar(0.9);
    this.mountainFill.color.copy(c.skyTop).multiplyScalar(0.5);

    const archGlow = 1.4 + pulse * 1.6;
    for (let i = 0; i < ARCH_COUNT; i++) {
      const z = ((((i * ARCH_SPACING + offset) % (ARCH_SPACING * ARCH_COUNT)) + ARCH_SPACING * ARCH_COUNT) % (ARCH_SPACING * ARCH_COUNT)) - ARCH_SPACING * ARCH_COUNT + 14;
      this.arches[i].position.z = z;
      // Dim as it nears the camera, or the overhead beam blooms across the whole screen.
      const near = Math.min(1, Math.max(0, (-z - 1) / 16));
      this.archMats[i].color.copy(c.secondary).multiplyScalar(archGlow * (0.12 + 0.88 * near));
      this.arches[i].visible = z < 2;
    }

    const edge = hdr(c.primary, 1.6);
    const top = hdr(c.secondary, 2 + pulse);
    for (let i = 0; i < TOWER_COUNT; i++) {
      const t = this.towers[i];
      const z = ((((t.z + offset * 0.98) % TOWER_SPAN) + TOWER_SPAN) % TOWER_SPAN) - TOWER_SPAN + 20;
      const m = this.tmp;
      m.position.set(t.x, 0, z);
      m.scale.set(t.w, t.h, t.d);
      m.updateMatrix();
      this.towerBody.setMatrixAt(i, m.matrix);
      // A thin glowing strip on the edge facing the track, and a cap on top.
      const inner = t.x - Math.sign(t.x) * (t.w / 2);
      m.position.set(inner, 0, z + t.d / 2);
      m.scale.set(0.12, t.h, 0.12);
      m.updateMatrix();
      this.towerEdge.setMatrixAt(i, m.matrix);
      m.position.set(t.x, t.h, z);
      m.scale.set(t.w + 0.1, 0.18, t.d + 0.1);
      m.updateMatrix();
      this.towerTop.setMatrixAt(i, m.matrix);
    }
    this.towerBody.instanceMatrix.needsUpdate = true;
    this.towerEdge.instanceMatrix.needsUpdate = true;
    this.towerTop.instanceMatrix.needsUpdate = true;
    (this.towerEdge.material as THREE.MeshBasicMaterial).color.copy(edge);
    (this.towerTop.material as THREE.MeshBasicMaterial).color.copy(top);

    this.speedMat.opacity += (rush * 0.55 - this.speedMat.opacity) * Math.min(1, dt * 4);
    this.speedMat.color.copy(c.secondary).lerp(new THREE.Color(1, 1, 1), 0.6);
    if (this.speedMat.opacity > 0.01) {
      const move = speed * 1.6 * dt;
      for (let i = 0; i < SPEEDLINES; i++) {
        const o = i * 6;
        this.speedPos[o + 2] += move;
        this.speedPos[o + 5] += move;
        if (this.speedPos[o + 5] > 12) this.resetSpeedLine(i, false);
      }
      this.speedLines.geometry.attributes.position.needsUpdate = true;
    }
    this.stars.rotation.y = time * 0.002;
  }
}
