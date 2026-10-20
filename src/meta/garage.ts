// Cosmetic unlocks bought with mission credits. Nothing here changes the hitbox or physics.
export type ShipId = 'delta' | 'arrow' | 'manta' | 'twin' | 'phantom';
export type TrailId = 'twin' | 'comet' | 'pulse' | 'rainbow' | 'sparkle';
export type ColorId = 'sector' | 'cyan' | 'magenta' | 'gold' | 'lime' | 'ice' | 'crimson' | 'chrome';

export interface Loadout {
  ship: ShipId;
  trail: TrailId;
  color: ColorId;
}

export type ItemKind = keyof Loadout;

export interface Item {
  kind: ItemKind;
  id: string;
  name: string;
  desc: string;
  cost: number;
  /** Swatch colour for the card. */
  swatch?: number;
}

export const ITEMS: Item[] = [
  { kind: 'ship', id: 'delta', name: 'Delta', desc: 'The classic. Balanced lines.', cost: 0 },
  { kind: 'ship', id: 'arrow', name: 'Arrow', desc: 'Long, needle-thin nose.', cost: 400 },
  { kind: 'ship', id: 'manta', name: 'Manta', desc: 'Wide, flat wings that skim the grid.', cost: 800 },
  { kind: 'ship', id: 'twin', name: 'Interceptor', desc: 'Twin booms and a split exhaust.', cost: 1500 },
  { kind: 'ship', id: 'phantom', name: 'Phantom', desc: 'Faceted stealth hull.', cost: 2500 },

  { kind: 'trail', id: 'twin', name: 'Twin', desc: 'Light ribbons from both wingtips.', cost: 0 },
  { kind: 'trail', id: 'comet', name: 'Comet', desc: 'One wide streak from the engines.', cost: 300 },
  { kind: 'trail', id: 'pulse', name: 'Pulse', desc: 'Flares on every kick drum.', cost: 600 },
  { kind: 'trail', id: 'rainbow', name: 'Spectrum', desc: 'Cycles through every hue.', cost: 900 },
  { kind: 'trail', id: 'sparkle', name: 'Stardust', desc: 'Sheds glittering sparks.', cost: 1200 },

  { kind: 'color', id: 'sector', name: 'Sector', desc: 'Follows each sector’s palette.', cost: 0 },
  { kind: 'color', id: 'cyan', name: 'Cyan', desc: '', cost: 200, swatch: 0x22e6ff },
  { kind: 'color', id: 'magenta', name: 'Magenta', desc: '', cost: 200, swatch: 0xff2bd6 },
  { kind: 'color', id: 'gold', name: 'Gold', desc: '', cost: 500, swatch: 0xffd23f },
  { kind: 'color', id: 'lime', name: 'Lime', desc: '', cost: 500, swatch: 0x7dff3a },
  { kind: 'color', id: 'ice', name: 'Ice', desc: '', cost: 700, swatch: 0xa8e8ff },
  { kind: 'color', id: 'crimson', name: 'Crimson', desc: '', cost: 700, swatch: 0xff2b45 },
  { kind: 'color', id: 'chrome', name: 'Chrome', desc: '', cost: 1200, swatch: 0xf4f0ff },
];

export const itemKey = (kind: ItemKind, id: string) => `${kind}:${id}`;

export interface GarageSave {
  credits: number;
  owned: string[];
  loadout: Loadout;
}

export function freshGarage(): GarageSave {
  return {
    credits: 0,
    owned: ITEMS.filter((i) => i.cost === 0).map((i) => itemKey(i.kind, i.id)),
    loadout: { ship: 'delta', trail: 'twin', color: 'sector' },
  };
}

export const colorHex = (id: ColorId): number | null => ITEMS.find((i) => i.kind === 'color' && i.id === id)?.swatch ?? null;
export const isShipId = (s: unknown): s is ShipId => ITEMS.some((i) => i.kind === 'ship' && i.id === s);
