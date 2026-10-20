import * as THREE from 'three';

export interface PaletteDef {
  name: string;
  primary: number;
  secondary: number;
  accent: number;
  warm: number;
  skyTop: number;
  skyHorizon: number;
  sunTop: number;
  sunBottom: number;
  grid: number;
  mountain: number;
}

/** One palette per sector, cycling. */
export const PALETTES: PaletteDef[] = [
  { name: 'Synthwave', primary: 0xff2bd6, secondary: 0x22e6ff, accent: 0xb44bff, warm: 0xff7b2b, skyTop: 0x05010f, skyHorizon: 0x3a0a52, sunTop: 0xffe14d, sunBottom: 0xff2b8a, grid: 0xff2bd6, mountain: 0x22e6ff },
  { name: 'Outrun', primary: 0x2bd9ff, secondary: 0xff3b6b, accent: 0xffd23f, warm: 0xff8a1f, skyTop: 0x020617, skyHorizon: 0x0b2f55, sunTop: 0xfff3a0, sunBottom: 0xff5a3d, grid: 0x2bd9ff, mountain: 0xff3b6b },
  { name: 'Toxic', primary: 0x7dff3a, secondary: 0x00ffd5, accent: 0xff3af2, warm: 0xffd23f, skyTop: 0x010a05, skyHorizon: 0x0a3a24, sunTop: 0xeaff6a, sunBottom: 0x00c79a, grid: 0x7dff3a, mountain: 0x00ffd5 },
  { name: 'Inferno', primary: 0xff3b2b, secondary: 0xffb02b, accent: 0xff2b8a, warm: 0xffe14d, skyTop: 0x0f0202, skyHorizon: 0x4f0c0c, sunTop: 0xffe9a0, sunBottom: 0xff3b2b, grid: 0xff3b2b, mountain: 0xffb02b },
  { name: 'Glacier', primary: 0x8ad8ff, secondary: 0xe8f4ff, accent: 0x6a7bff, warm: 0xff8ad8, skyTop: 0x01040f, skyHorizon: 0x163055, sunTop: 0xffffff, sunBottom: 0x8ad8ff, grid: 0x8ad8ff, mountain: 0x6a7bff },
  { name: 'Vapor', primary: 0xff71ce, secondary: 0x01cdfe, accent: 0x05ffa1, warm: 0xfffb96, skyTop: 0x0a0218, skyHorizon: 0x2e0b52, sunTop: 0xfffb96, sunBottom: 0xff71ce, grid: 0x01cdfe, mountain: 0xff71ce },
];

type Key = Exclude<keyof PaletteDef, 'name'>;
const KEYS: Key[] = ['primary', 'secondary', 'accent', 'warm', 'skyTop', 'skyHorizon', 'sunTop', 'sunBottom', 'grid', 'mountain'];

/** The live palette: colours ease toward the current sector's palette. */
export class LivePalette {
  readonly c = Object.fromEntries(KEYS.map((k) => [k, new THREE.Color()])) as Record<Key, THREE.Color>;
  private target = Object.fromEntries(KEYS.map((k) => [k, new THREE.Color()])) as Record<Key, THREE.Color>;
  index = 0;

  constructor() {
    this.set(0, true);
  }

  set(sector: number, instant = false) {
    this.index = ((sector % PALETTES.length) + PALETTES.length) % PALETTES.length;
    const p = PALETTES[this.index];
    for (const k of KEYS) {
      this.target[k].setHex(p[k]);
      if (instant) this.c[k].copy(this.target[k]);
    }
  }

  get name() {
    return PALETTES[this.index].name;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 1.6);
    for (const key of KEYS) this.c[key].lerp(this.target[key], k);
  }
}
