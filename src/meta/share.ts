// Ghost challenge links: the seed, input log and a few labels, carried in the URL hash.
// v2 links fly with their ship's class rules; v1 links predate ship classes, so their runs were
// simulated as a Delta whatever hull they showed.
import { decodeLog } from '../core/ghost.ts';
import { isShipId, type ShipId } from './garage.ts';

export interface GhostLink {
  seed: number;
  log: string;
  score: number;
  name: string;
  /** The hull shown for the run. */
  ship: ShipId;
  /** The class rules the run was simulated with. */
  cls: ShipId;
  /** Set when the run was a daily run. */
  day?: string;
}

function toB64(str: string) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
}

export function encodeGhostLink(g: GhostLink): string {
  return toB64(JSON.stringify({ v: 2, s: g.seed, l: g.log, p: Math.floor(g.score), n: g.name, h: g.ship, d: g.day }));
}

export function decodeGhostLink(s: string): GhostLink | null {
  try {
    const d = JSON.parse(fromB64(s));
    if ((d.v !== 1 && d.v !== 2) || !Number.isInteger(d.s) || typeof d.l !== 'string' || !decodeLog(d.l)) return null;
    const ship: ShipId = isShipId(d.h) ? d.h : 'delta';
    return {
      seed: d.s >>> 0,
      log: d.l,
      score: Number.isFinite(d.p) ? Math.max(0, Math.floor(d.p)) : 0,
      name: typeof d.n === 'string' && d.n.trim() ? d.n.trim().slice(0, 16) : 'A rival',
      ship,
      cls: d.v === 2 ? ship : 'delta',
      day: typeof d.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.d) ? d.d : undefined,
    };
  } catch {
    return null;
  }
}
