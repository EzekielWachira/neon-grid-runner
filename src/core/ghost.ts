// Compact text encoding for input logs: each input is its tick gap in base 36 followed by
// its action letter, e.g. "2fL1aJ9S". A five-minute run is typically a few kilobytes.
import type { InputCode, InputEntry } from './sim.ts';

const MAX_CHARS = 200_000;

export function encodeLog(log: InputEntry[]): string {
  let out = '';
  let last = 0;
  for (const e of log) {
    out += (e.tick - last).toString(36) + e.a;
    last = e.tick;
  }
  return out;
}

export function decodeLog(s: string): InputEntry[] | null {
  if (typeof s !== 'string' || s.length > MAX_CHARS) return null;
  const out: InputEntry[] = [];
  const re = /([0-9a-z]+)([LRJSA])/g;
  let tick = 0;
  let consumed = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index !== consumed) return null;
    consumed = re.lastIndex;
    tick += parseInt(m[1], 36);
    if (!Number.isFinite(tick)) return null;
    out.push({ tick, a: m[2] as InputCode });
  }
  return consumed === s.length ? out : null;
}
