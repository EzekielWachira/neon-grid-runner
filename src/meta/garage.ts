// Garage: ships (each a class with its own rules, see core/ships.ts), light trails and colours.
// Unlocks cost mission credits; some ships can also be earned through milestones, and flying a
// ship levels up its mastery, which pays credits and unlocks that ship's signature paint.
import { SHIP_CLASSES, isShipId, type ShipId } from '../core/ships.ts';

export { isShipId, type ShipId };
export type TrailId = 'twin' | 'comet' | 'pulse' | 'rainbow' | 'sparkle';
export type ColorId = 'sector' | 'cyan' | 'magenta' | 'gold' | 'lime' | 'ice' | 'crimson' | 'chrome' | 'mint' | 'ember' | 'abyss' | 'plasma' | 'spectre';

export interface Loadout {
  ship: ShipId;
  trail: TrailId;
  color: ColorId;
}

export type ItemKind = keyof Loadout;

/** A free unlock for reaching a milestone (instead of, or as well as, paying credits). */
export type Milestone = { kind: 'sector'; n: number } | { kind: 'rank'; n: number } | { kind: 'mastery'; ship: ShipId; n: number };

export interface Item {
  kind: ItemKind;
  id: string;
  name: string;
  desc: string;
  /** Credits to buy it; null when only the milestone unlocks it. */
  cost: number | null;
  milestone?: Milestone;
  /** Swatch colour for the card. */
  swatch?: number;
}

export const ITEMS: Item[] = [
  { kind: 'ship', id: 'delta', name: 'Delta', desc: 'The all-rounder.', cost: 0 },
  { kind: 'ship', id: 'arrow', name: 'Arrow', desc: 'Darts between lanes.', cost: 400 },
  { kind: 'ship', id: 'manta', name: 'Manta', desc: 'Glides over trouble.', cost: 800 },
  { kind: 'ship', id: 'twin', name: 'Interceptor', desc: 'Shoots blocks out of the way.', cost: 1500, milestone: { kind: 'sector', n: 4 } },
  { kind: 'ship', id: 'phantom', name: 'Phantom', desc: 'Phases through anything.', cost: 2500, milestone: { kind: 'rank', n: 5 } },

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
  // Signature paints: one per ship, earned at mastery level 3.
  { kind: 'color', id: 'mint', name: 'Vector', desc: 'Delta signature', cost: null, milestone: { kind: 'mastery', ship: 'delta', n: 3 }, swatch: 0x5cffc8 },
  { kind: 'color', id: 'ember', name: 'Afterburn', desc: 'Arrow signature', cost: null, milestone: { kind: 'mastery', ship: 'arrow', n: 3 }, swatch: 0xff6a1f },
  { kind: 'color', id: 'abyss', name: 'Abyss', desc: 'Manta signature', cost: null, milestone: { kind: 'mastery', ship: 'manta', n: 3 }, swatch: 0x4a6bff },
  { kind: 'color', id: 'plasma', name: 'Plasma', desc: 'Interceptor signature', cost: null, milestone: { kind: 'mastery', ship: 'twin', n: 3 }, swatch: 0xc04dff },
  { kind: 'color', id: 'spectre', name: 'Spectre', desc: 'Phantom signature', cost: null, milestone: { kind: 'mastery', ship: 'phantom', n: 3 }, swatch: 0xc8fff4 },
];

export const itemKey = (kind: ItemKind, id: string) => `${kind}:${id}`;
export const shipItem = (id: ShipId) => ITEMS.find((i) => i.kind === 'ship' && i.id === id)!;
export const shipName = (id: ShipId) => shipItem(id).name;

// ---------------------------------------------------------------- gallery

export type StatKey = 'handling' | 'agility' | 'air' | 'power' | 'score';
export const STAT_LABEL: Record<StatKey, string> = { handling: 'Handling', agility: 'Agility', air: 'Air', power: 'Power-ups', score: 'Score' };

export interface ShipInfo {
  role: string;
  /** What the ship can do that others can't. */
  perk: string;
  /** What it gives up for it. */
  tradeoff: string;
  /** Has an ability button (Interceptor, Phantom). */
  active: boolean;
  /** 1..5 bars for the gallery. */
  stats: Record<StatKey, number>;
}

export const SHIP_INFO: Record<ShipId, ShipInfo> = {
  delta: {
    role: 'All-rounder',
    perk: 'No tricks and no weak spots: every power-up, full score.',
    tradeoff: 'Nothing to lean on when it gets tight.',
    active: false,
    stats: { handling: 3, agility: 3, air: 3, power: 4, score: 4 },
  },
  arrow: {
    role: 'Speedster',
    perk: 'Changes lanes 25% faster, with a slimmer hitbox for tighter near misses.',
    tradeoff: 'Power-ups last 30% less.',
    active: false,
    stats: { handling: 5, agility: 5, air: 3, power: 2, score: 4 },
  },
  manta: {
    role: 'Glider',
    perk: 'Press jump again high in the air to glide and stretch the jump.',
    tradeoff: 'Scores 10% less.',
    active: false,
    stats: { handling: 3, agility: 3, air: 5, power: 4, score: 3 },
  },
  twin: {
    role: 'Gunship',
    perk: 'Pulse cannon: blasts the next block in your lane. Charges over 16 beats and fires on the beat.',
    tradeoff: 'Magnets never spawn.',
    active: true,
    stats: { handling: 3, agility: 3, air: 3, power: 3, score: 5 },
  },
  phantom: {
    role: 'Stealth',
    perk: 'Phase: slip through everything for a second. One charge per sector.',
    tradeoff: 'Shields never spawn.',
    active: true,
    stats: { handling: 3, agility: 3, air: 3, power: 3, score: 4 },
  },
};

export const ABILITY_NAME: Record<ShipId, string | null> = { delta: null, arrow: null, manta: 'Glide', twin: 'Pulse', phantom: 'Phase' };
// Keep the gallery honest: an ability button exists exactly when the class has an ability.
for (const id of Object.keys(SHIP_INFO) as ShipId[]) if (SHIP_INFO[id].active !== !!SHIP_CLASSES[id].ability) throw new Error(`SHIP_INFO.${id}.active is out of sync`);

// ---------------------------------------------------------------- mastery

/** Metres flown in a ship to reach each level (index 0 is level 1). */
export const MASTERY_XP = [0, 2500, 7500, 18000, 36000];
export const MASTERY_MAX = MASTERY_XP.length;
/** What reaching each level gives (index = level). */
export const MASTERY_REWARD: Record<number, { credits: number; text: string }> = {
  2: { credits: 150, text: '+150 credits' },
  3: { credits: 0, text: 'Signature paint' },
  4: { credits: 400, text: '+400 credits' },
  5: { credits: 1000, text: '+1,000 credits · Mastered' },
};

export function masteryLevel(xp: number) {
  let lvl = 1;
  while (lvl < MASTERY_MAX && xp >= MASTERY_XP[lvl]) lvl++;
  return lvl;
}

/** Progress 0..1 toward the next level (1 at max). */
export function masteryProgress(xp: number) {
  const lvl = masteryLevel(xp);
  if (lvl >= MASTERY_MAX) return 1;
  const a = MASTERY_XP[lvl - 1];
  return (xp - a) / (MASTERY_XP[lvl] - a);
}

// ---------------------------------------------------------------- save

export interface GarageSave {
  credits: number;
  owned: string[];
  loadout: Loadout;
  /** Metres flown per ship (mastery). */
  xp: Partial<Record<ShipId, number>>;
}

export function freshGarage(): GarageSave {
  return {
    credits: 0,
    owned: ITEMS.filter((i) => i.cost === 0).map((i) => itemKey(i.kind, i.id)),
    loadout: { ship: 'delta', trail: 'twin', color: 'sector' },
    xp: {},
  };
}

export interface Progress {
  bestSector: number;
  rank: number;
}

export function milestoneMet(m: Milestone, g: GarageSave, p: Progress) {
  if (m.kind === 'sector') return p.bestSector >= m.n;
  if (m.kind === 'rank') return p.rank >= m.n;
  return masteryLevel(g.xp[m.ship] ?? 0) >= m.n;
}

export function milestoneText(m: Milestone) {
  if (m.kind === 'sector') return `Reach Sector ${m.n}`;
  if (m.kind === 'rank') return `Reach Rank ${m.n}`;
  return `${shipName(m.ship)} mastery ${m.n}`;
}

/** Adds every item whose milestone is now met; returns the newly unlocked ones. */
export function claimMilestones(g: GarageSave, p: Progress): Item[] {
  const fresh: Item[] = [];
  for (const item of ITEMS) {
    const key = itemKey(item.kind, item.id);
    if (item.milestone && !g.owned.includes(key) && milestoneMet(item.milestone, g, p)) {
      g.owned.push(key);
      fresh.push(item);
    }
  }
  return fresh;
}

export interface MasteryGain {
  ship: ShipId;
  before: number;
  after: number;
  levelBefore: number;
  levelAfter: number;
  credits: number;
}

/** Adds flown distance to a ship's mastery and pays out any level rewards. */
export function addMastery(g: GarageSave, ship: ShipId, metres: number): MasteryGain {
  const before = g.xp[ship] ?? 0;
  const after = before + Math.floor(metres);
  g.xp[ship] = after;
  const levelBefore = masteryLevel(before);
  const levelAfter = masteryLevel(after);
  let credits = 0;
  for (let l = levelBefore + 1; l <= levelAfter; l++) credits += MASTERY_REWARD[l]?.credits ?? 0;
  g.credits += credits;
  return { ship, before, after, levelBefore, levelAfter, credits };
}

export const colorHex = (id: ColorId): number | null => ITEMS.find((i) => i.kind === 'color' && i.id === id)?.swatch ?? null;
