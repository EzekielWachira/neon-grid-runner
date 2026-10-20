// Visuals for the set pieces in core/zones.ts: tunnel frames that close in around the track, and
// the Sentinel, a giant machine at the horizon that paints its laser walls down the road.
import * as THREE from 'three';
import { BEAT, SECTOR_BEATS, TRACK_HALF, LANE_W, VIEW_DIST, laneX } from '../core/config.ts';
import type { Sim } from '../core/sim.ts';
import { SENTINEL, SENTINEL_FROM, SENTINEL_WARN, inTunnel } from '../core/zones.ts';
import { bend } from './curve.ts';
import type { LivePalette } from './palette.ts';

const FRAME_SPACING = 6;
const FRAMES = Math.ceil(VIEW_DIST / FRAME_SPACING) + 2;
const TUNNEL_H = 5.4;
const HALF = TRACK_HALF + 0.7;
const MAX_LINES = 12;
/** Where the Sentinel hovers: far down the track, high over it. */
export const SENTINEL_POS = new THREE.Vector3(0, 23, -125);

export class SetPieces {
  readonly group = new THREE.Group();
  private frames: THREE.LineSegments[] = [];
  private frameMats: THREE.LineBasicMaterial[] = [];

  private sentinel = new THREE.Group();
  private shell: THREE.LineBasicMaterial;
  private eye: THREE.MeshBasicMaterial;
  private rings: THREE.Mesh[] = [];
  private ringMat: THREE.MeshBasicMaterial;
  private lines: THREE.LineSegments;
  private linePos = new Float32Array(MAX_LINES * 6);
  private lineMat: THREE.LineBasicMaterial;
  private flash = 0;

  constructor() {
    // One tunnel frame: a portal round the track plus ceiling and wall lines running back to the next one.
    const v: number[] = [];
    const seg = (a: number[], b: number[]) => v.push(...a, ...b);
    seg([-HALF, 0, 0], [-HALF, TUNNEL_H, 0]);
    seg([HALF, 0, 0], [HALF, TUNNEL_H, 0]);
    seg([-HALF, TUNNEL_H, 0], [HALF, TUNNEL_H, 0]);
    for (let l = 0; l <= 5; l++) {
      const x = laneX(l) - LANE_W / 2;
      seg([x, TUNNEL_H, 0], [x, TUNNEL_H, -FRAME_SPACING]);
    }
    for (const y of [1.8, 3.6]) for (const s of [-1, 1]) seg([s * HALF, y, 0], [s * HALF, y, -FRAME_SPACING]);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    for (let i = 0; i < FRAMES; i++) {
      const mat = bend(new THREE.LineBasicMaterial({ toneMapped: false }));
      const f = new THREE.LineSegments(fg, mat);
      f.frustumCulled = false;
      f.visible = false;
      this.frames.push(f);
      this.frameMats.push(mat);
      this.group.add(f);
    }

    // The Sentinel: a dark hull (so it stands out against the sun) with a wireframe shell, a burning
    // core and two gyroscope rings. It's far off, so it ignores the fog that hides the distance.
    this.shell = bend(new THREE.LineBasicMaterial({ toneMapped: false, fog: false }));
    this.eye = bend(new THREE.MeshBasicMaterial({ toneMapped: false, fog: false }));
    this.ringMat = bend(new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    const hull = bend(new THREE.MeshBasicMaterial({ color: 0x07020f, fog: false }));
    this.sentinel.add(new THREE.Mesh(new THREE.IcosahedronGeometry(7.6, 0), hull));
    this.sentinel.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(8, 0)), this.shell));
    this.sentinel.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(4.8, 1)), this.shell));
    this.sentinel.add(new THREE.Mesh(new THREE.OctahedronGeometry(2.6, 0), this.eye));
    for (const r of [12, 15]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.2, 4, 72), this.ringMat);
      this.rings.push(ring);
      this.sentinel.add(ring);
    }
    this.sentinel.traverse((o) => (o.frustumCulled = false));
    this.sentinel.visible = false;
    this.group.add(this.sentinel);

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineMat = bend(new THREE.LineBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.lines = new THREE.LineSegments(lg, this.lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  /** How present the Sentinel is (0..1) and whether it's going down (after a clear). */
  private presence(sim: Sim) {
    if (!sim.track.features) return { k: 0, dying: false };
    const beat = sim.t / BEAT;
    const sector = Math.floor(beat / SECTOR_BEATS);
    const b = beat - sector * SECTOR_BEATS;
    if (sector < SENTINEL_FROM) return { k: 0, dying: false };
    const [s, e] = SENTINEL;
    if (b >= s - SENTINEL_WARN && b < s) return { k: (b - (s - SENTINEL_WARN)) / SENTINEL_WARN, dying: false };
    if (b >= s && b < e) return { k: 1, dying: false };
    if (b >= e && b < e + 3) return { k: 1 - (b - e) / 3, dying: true };
    return { k: 0, dying: false };
  }

  /** The Sentinel's position this frame (for effects). */
  sentinelPos(out = new THREE.Vector3()) {
    return out.copy(this.sentinel.position);
  }

  onVolley() {
    this.flash = 1;
  }

  update(sim: Sim, p: LivePalette, dt: number, time: number, offset: number, pulse: number, show: boolean) {
    const c = p.c;
    // Tunnel frames ride along with the world; each shows only where the track at that distance is in a tunnel.
    const shift = ((offset % FRAME_SPACING) + FRAME_SPACING) % FRAME_SPACING;
    for (let i = 0; i < FRAMES; i++) {
      const f = this.frames[i];
      const z = shift - i * FRAME_SPACING + 6;
      const at = sim.t + -z / sim.speed;
      f.visible = show && sim.track.features && z < 2 && inTunnel(at);
      if (!f.visible) continue;
      f.position.z = z;
      // Dim right by the camera (or the frame blooms across the screen), and pulse on the beat.
      const near = Math.min(1, Math.max(0, (-z - 2) / 14));
      this.frameMats[i].color.copy(i % 2 ? c.primary : c.secondary).multiplyScalar((1.2 + pulse * 1.4) * (0.1 + 0.9 * near));
    }

    const { k, dying } = this.presence(sim);
    this.sentinel.visible = show && k > 0;
    this.flash *= Math.exp(-dt * 8);
    if (this.sentinel.visible) {
      const rise = 1 - Math.pow(1 - Math.min(1, k), 3);
      this.sentinel.position.set(SENTINEL_POS.x + Math.sin(time * 0.7) * 3, SENTINEL_POS.y - (1 - rise) * (dying ? -6 : 30), SENTINEL_POS.z);
      this.sentinel.rotation.y = time * 0.4;
      this.sentinel.scale.setScalar(dying ? 0.6 + 0.4 * k : 1);
      this.rings[0].rotation.set(time * 1.3, time * 0.7, 0);
      this.rings[1].rotation.set(-time * 0.9, 0, time * 1.1);
      const glow = (1.5 + pulse * 2 + this.flash * 4) * (dying ? k : 1);
      this.shell.color.copy(c.accent).multiplyScalar(glow);
      this.eye.color.copy(c.warm).lerp(new THREE.Color(1, 1, 1), this.flash * 0.6).multiplyScalar(3 + this.flash * 4);
      this.ringMat.color.copy(c.primary).multiplyScalar(0.8 + pulse);
    }

    // Targeting beams from the eye to each laser wall while it's still far off.
    let n = 0;
    if (this.sentinel.visible && !dying) {
      for (const o of sim.track.obstacles) {
        if (n >= MAX_LINES) break;
        if (o.kind !== 'beam' || o.done) continue;
        const z = -(o.time - sim.t) * sim.speed;
        if (z > -45 || z < -VIEW_DIST) continue;
        const x = (laneX(o.lane0) + laneX(o.lane1)) / 2;
        this.linePos.set([this.sentinel.position.x, this.sentinel.position.y, this.sentinel.position.z, x, 4.6, z], n * 6);
        n++;
      }
    }
    this.lines.geometry.setDrawRange(0, n * 2);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lineMat.color.copy(c.accent).multiplyScalar(1.5 + this.flash * 2);
  }
}
