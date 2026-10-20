// Meshes for obstacles and pickups, pooled and positioned from the simulation each frame.
import * as THREE from 'three';
import { LANE_W, OBSTACLE_SHAPE, VIEW_DIST, laneX, type ObstacleKind } from '../core/config.ts';
import type { Sim } from '../core/sim.ts';
import { moverLane, type Obstacle, type Pickup } from '../core/track.ts';
import { holoMaterial } from './materials.ts';
import type { LivePalette } from './palette.ts';
import { bend } from './curve.ts';

const RISE_TIME = 0.35;
const hdr = (c: THREE.Color, k: number) => new THREE.Color(c.r * k, c.g * k, c.b * k);

interface Live<T> {
  data: T;
  obj: THREE.Object3D;
  born: number;
}

export class Things {
  readonly group = new THREE.Group();
  private colors = {
    block: new THREE.Color(),
    mover: new THREE.Color(),
    low: new THREE.Color(),
    high: new THREE.Color(),
  };
  private mats: Record<'block' | 'mover' | 'low' | 'high', THREE.ShaderMaterial>;
  private geos: Record<'block' | 'mover' | 'low' | 'high', THREE.BufferGeometry>;
  private laserCore = bend(new THREE.MeshBasicMaterial({ toneMapped: false }));
  private laserGlow = bend(new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  private underline = bend(new THREE.MeshBasicMaterial({ toneMapped: false }));
  private orbEdge = bend(new THREE.LineBasicMaterial({ toneMapped: false }));
  private orbCore = bend(new THREE.MeshBasicMaterial({ toneMapped: false }));
  private orbGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.34, 0));
  private coreGeo = new THREE.SphereGeometry(0.12, 10, 8);
  private powerMats = {
    shield: bend(new THREE.LineBasicMaterial({ toneMapped: false })),
    magnet: bend(new THREE.LineBasicMaterial({ toneMapped: false })),
    overdrive: bend(new THREE.LineBasicMaterial({ toneMapped: false })),
  };
  private ringGeo = new THREE.TorusGeometry(0.8, 0.035, 6, 40);

  private obstacles = new Map<number, Live<Obstacle>>();
  private pickups = new Map<number, Live<Pickup>>();
  private pool = new Map<string, THREE.Object3D[]>();

  constructor() {
    this.mats = {
      block: holoMaterial(this.colors.block),
      mover: holoMaterial(this.colors.mover),
      low: holoMaterial(this.colors.low),
      high: holoMaterial(this.colors.high),
    };
    const w = LANE_W - 0.3;
    const box = (h: number, d: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(0, h / 2, 0);
      return g;
    };
    this.geos = {
      block: box(OBSTACLE_SHAPE.block.y1, OBSTACLE_SHAPE.block.depth),
      mover: box(OBSTACLE_SHAPE.mover.y1, OBSTACLE_SHAPE.mover.depth),
      low: box(OBSTACLE_SHAPE.low.y1, OBSTACLE_SHAPE.low.depth),
      high: box(OBSTACLE_SHAPE.high.y1 - OBSTACLE_SHAPE.high.y0, OBSTACLE_SHAPE.high.depth),
    };
  }

  reset() {
    for (const l of this.obstacles.values()) this.release(l.obj);
    for (const l of this.pickups.values()) this.release(l.obj);
    this.obstacles.clear();
    this.pickups.clear();
  }

  // ---------------------------------------------------------------- pooling

  private acquire(key: string, make: () => THREE.Object3D) {
    const list = this.pool.get(key) ?? [];
    this.pool.set(key, list);
    const obj = list.pop() ?? make();
    obj.userData.key = key;
    obj.visible = true;
    // The curved-world bend moves things away from where three.js thinks they are.
    obj.traverse((o) => (o.frustumCulled = false));
    this.group.add(obj);
    return obj;
  }

  private release(obj: THREE.Object3D) {
    this.group.remove(obj);
    this.pool.get(obj.userData.key)!.push(obj);
  }

  private makeObstacle(o: Obstacle): THREE.Object3D {
    const kind = o.kind;
    if (kind === 'laserLow' || kind === 'laserHigh') {
      const lanes = o.lane1 - o.lane0 + 1;
      return this.acquire(`${kind}:${lanes}`, () => {
        const g = new THREE.Group();
        const width = lanes * LANE_W;
        const core = new THREE.Mesh(new THREE.BoxGeometry(width, 0.07, 0.07), this.laserCore);
        const glow = new THREE.Mesh(new THREE.BoxGeometry(width, 0.42, 0.42), this.laserGlow);
        core.name = 'core';
        glow.name = 'glow';
        g.add(glow, core);
        // Emitter posts standing on the floor at each end of the beam.
        const beamY = (OBSTACLE_SHAPE[kind].y0 + OBSTACLE_SHAPE[kind].y1) / 2;
        for (const s of [-1, 1]) {
          const em = new THREE.Mesh(this.geos.low, this.mats.high);
          em.scale.set(0.18, (beamY + 0.25) / OBSTACLE_SHAPE.low.y1, 0.6);
          em.position.set(s * (width / 2 + 0.25), -beamY, 0);
          g.add(em);
        }
        return g;
      });
    }
    const k = kind as 'block' | 'mover' | 'low' | 'high';
    return this.acquire(kind, () => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.geos[k], this.mats[k]);
      m.name = 'body';
      g.add(m);
      if (k === 'high') {
        // A glowing underline marks the gap you slide through.
        const u = new THREE.Mesh(new THREE.BoxGeometry(LANE_W - 0.3, 0.06, 0.08), this.underline);
        u.position.set(0, 0, OBSTACLE_SHAPE.high.depth / 2);
        g.add(u);
      }
      return g;
    });
  }

  private makePickup(p: Pickup): THREE.Object3D {
    if (p.kind === 'orb') {
      return this.acquire('orb', () => {
        const g = new THREE.Group();
        g.add(new THREE.LineSegments(this.orbGeo, this.orbEdge), new THREE.Mesh(this.coreGeo, this.orbCore));
        return g;
      });
    }
    const kind = p.kind;
    return this.acquire(kind, () => {
      const g = new THREE.Group();
      const mat = this.powerMats[kind];
      const icon =
        kind === 'shield'
          ? new THREE.OctahedronGeometry(0.42, 0)
          : kind === 'magnet'
            ? new THREE.TorusGeometry(0.32, 0.1, 4, 10, Math.PI * 1.3)
            : new THREE.DodecahedronGeometry(0.4, 0);
      const iconMesh = new THREE.LineSegments(new THREE.EdgesGeometry(icon), mat);
      iconMesh.name = 'icon';
      const ring = new THREE.Mesh(this.ringGeo, bend(new THREE.MeshBasicMaterial({ toneMapped: false, color: 0xffffff })));
      ring.name = 'ring';
      g.add(iconMesh, ring);
      return g;
    });
  }

  // ---------------------------------------------------------------- per-frame

  update(sim: Sim, p: LivePalette, time: number, pulse: number, shipPos: THREE.Vector3) {
    const c = p.c;
    this.colors.block.copy(c.primary);
    this.colors.mover.copy(c.accent);
    this.colors.low.copy(c.warm);
    this.colors.high.copy(c.secondary);
    for (const m of Object.values(this.mats)) {
      m.uniforms.uTime.value = time;
      m.uniforms.uPulse.value = pulse;
    }
    const flicker = 0.85 + Math.random() * 0.3;
    this.laserCore.color.copy(hdr(c.warm, 5 * flicker)).lerp(new THREE.Color(5, 5, 5), 0.25);
    this.laserGlow.color.copy(c.warm);
    this.underline.color.copy(hdr(c.secondary, 4));
    this.orbEdge.color.copy(hdr(c.secondary, 2.6));
    this.orbCore.color.copy(hdr(c.secondary, 3)).lerp(new THREE.Color(3, 3, 3), 0.5);
    this.powerMats.shield.color.copy(hdr(new THREE.Color(0x4fd8ff), 3));
    this.powerMats.magnet.color.copy(hdr(new THREE.Color(0xff8a2b), 3));
    this.powerMats.overdrive.color.copy(hdr(new THREE.Color(0xffe14d), 3));

    const t = sim.t;
    const speed = sim.speed;
    const seen = new Set<number>();

    for (const o of sim.track.obstacles) {
      const z = -(o.time - t) * speed;
      if (z < -VIEW_DIST || z > 14 || o.done === 'smashed' || o.done === 'hit') continue;
      seen.add(o.id);
      let live = this.obstacles.get(o.id);
      if (!live) {
        live = { data: o, obj: this.makeObstacle(o), born: time };
        this.obstacles.set(o.id, live);
      }
      const obj = live.obj;
      const rise = Math.min(1, (time - live.born) / RISE_TIME);
      const ease = 1 - Math.pow(1 - rise, 3);
      if (o.kind === 'laserLow' || o.kind === 'laserHigh') {
        const y = (OBSTACLE_SHAPE[o.kind].y0 + OBSTACLE_SHAPE[o.kind].y1) / 2;
        obj.position.set((laneX(o.lane0) + laneX(o.lane1)) / 2, y * ease, z);
        obj.scale.set(ease, 1, 1);
        const glow = obj.getObjectByName('glow')!;
        glow.scale.set(1, 0.7 + Math.random() * 0.6, 1);
      } else {
        const x = o.mover ? laneX(moverLane(o, t)) : laneX(o.lane0);
        obj.position.set(x, o.kind === 'high' ? OBSTACLE_SHAPE.high.y0 : 0, z);
        obj.scale.set(1, Math.max(0.01, ease), 1);
        if (o.mover) obj.rotation.y = Math.sin(time * 4) * 0.05;
      }
    }
    for (const [id, live] of this.obstacles) {
      if (!seen.has(id)) {
        this.release(live.obj);
        this.obstacles.delete(id);
      }
    }

    seen.clear();
    const magnet = sim.powers.magnet > 0;
    for (const pk of sim.track.pickups) {
      const z = -(pk.time - t) * speed;
      if (z < -VIEW_DIST || z > 10 || pk.taken) continue;
      seen.add(pk.id);
      let live = this.pickups.get(pk.id);
      if (!live) {
        live = { data: pk, obj: this.makePickup(pk), born: time };
        this.pickups.set(pk.id, live);
      }
      const obj = live.obj;
      let x = laneX(pk.lane);
      let y = pk.y + Math.sin(time * 4 + pk.id) * 0.08;
      let zz = z;
      if (magnet && pk.kind === 'orb' && z > -32 && Math.abs(x - sim.x) < LANE_W * 2.6) {
        // Pulled toward the ship as it gets close.
        const k = Math.pow(1 - Math.max(0, -z) / 32, 2);
        x += (shipPos.x - x) * k;
        y += (shipPos.y + 0.3 - y) * k;
        zz += (0 - zz) * k * 0.4;
      }
      obj.position.set(x, y, zz);
      obj.rotation.y = time * 2 + pk.id;
      obj.rotation.x = time * 1.3;
      const s = Math.min(1, (time - live.born) / RISE_TIME);
      obj.scale.setScalar(Math.max(0.01, s));
      if (pk.kind !== 'orb') {
        const ring = obj.getObjectByName('ring') as THREE.Mesh;
        (ring.material as THREE.MeshBasicMaterial).color.copy(
          pk.kind === 'shield' ? new THREE.Color(0x4fd8ff) : pk.kind === 'magnet' ? new THREE.Color(0xff8a2b) : new THREE.Color(0xffe14d),
        ).multiplyScalar(2 + Math.sin(time * 6) * 0.8);
        ring.rotation.set(Math.PI / 2 + Math.sin(time) * 0.3, 0, time);
      }
    }
    for (const [id, live] of this.pickups) {
      if (!seen.has(id)) {
        this.release(live.obj);
        this.pickups.delete(id);
      }
    }
  }

  /** World position an obstacle is drawn at, for effects. */
  obstaclePos(o: Obstacle, sim: Sim, out = new THREE.Vector3()) {
    const x = o.mover ? laneX(moverLane(o, sim.t)) : (laneX(o.lane0) + laneX(o.lane1)) / 2;
    const shape = OBSTACLE_SHAPE[o.kind];
    return out.set(x, (shape.y0 + shape.y1) / 2, -(o.time - sim.t) * sim.speed);
  }

  /** Colour of an obstacle kind, for effects. */
  colorOf(kind: ObstacleKind) {
    if (kind === 'laserLow' || kind === 'laserHigh') return this.laserGlow.color;
    return this.colors[kind];
  }
}
