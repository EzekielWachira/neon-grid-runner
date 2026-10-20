// Achievements: one-off badges for feats in a run, for each ship's speciality, and for long-term
// progress. Run badges are checked live (so they pop mid-run); the rest when a run ends.
import type { Sim } from '../core/sim.ts';
import type { ShipId } from '../core/ships.ts';

export interface AchContext {
  /** The run being played or just finished (null when checking outside a run). */
  sim: Sim | null;
  /** True once the run is over (meta badges are only checked then). */
  ended: boolean;
  ship: ShipId;
  totalOrbs: number;
  runs: number;
  streak: number;
  shipsOwned: number;
  /** Mastery level per ship. */
  mastery: Record<ShipId, number>;
  rank: number;
  beatGhost: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  /** Shown on this ship's gallery page. */
  ship?: ShipId;
  test: (c: AchContext) => boolean;
}

const run = (f: (s: Sim, c: AchContext) => boolean) => (c: AchContext) => !!c.sim && f(c.sim, c);
const inShip = (ship: ShipId, f: (s: Sim) => boolean) => run((s) => s.ship === ship && f(s));

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first', name: 'First Light', desc: 'Finish your first run.', test: (c) => c.ended && c.runs >= 1 },
  { id: 'km1', name: 'Kilometre', desc: 'Run 1,000 m in one run.', test: run((s) => s.distance >= 1000) },
  { id: 'km5', name: 'Long Haul', desc: 'Run 5,000 m in one run.', test: run((s) => s.distance >= 5000) },
  { id: 'km10', name: 'Marathon', desc: 'Run 10,000 m in one run.', test: run((s) => s.distance >= 10000) },
  { id: 'sector3', name: 'Outrunner', desc: 'Reach Sector 3.', test: run((s) => s.sector >= 2) },
  { id: 'sector6', name: 'Full Spectrum', desc: 'Reach Sector 6 and see every palette.', test: run((s) => s.sector >= 5) },
  { id: 'sector10', name: 'Beyond', desc: 'Reach Sector 10.', test: run((s) => s.sector >= 9) },
  { id: 'combo50', name: 'Chain Reaction', desc: 'Build a 50 combo.', test: run((s) => s.bestCombo >= 50) },
  { id: 'combo150', name: 'Unbroken', desc: 'Build a 150 combo.', test: run((s) => s.bestCombo >= 150) },
  { id: 'near25', name: 'Thread the Needle', desc: '25 near misses in one run.', test: run((s) => s.nearMisses >= 25) },
  { id: 'score25k', name: 'High Voltage', desc: 'Score 25,000 in one run.', test: run((s) => s.score >= 25000) },
  { id: 'score100k', name: 'Overload', desc: 'Score 100,000 in one run.', test: run((s) => s.score >= 100000) },
  { id: 'grounded', name: 'Grounded', desc: 'Clear a whole sector without jumping.', test: run((s) => s.stats.noJumpSectors >= 1) },
  { id: 'purist', name: 'Purist', desc: 'Clear a whole sector without a power-up.', test: run((s) => s.stats.noPowerSectors >= 1) },
  { id: 'sentinel', name: 'Sentinel Down', desc: 'Survive a Sentinel.', test: run((s) => s.stats.sentinels >= 1) },
  { id: 'sentinel3', name: 'Giant Slayer', desc: 'Survive 3 Sentinels in one run.', test: run((s) => s.stats.sentinels >= 3) },
  { id: 'flip', name: 'Upside Down', desc: 'Make it through a gravity flip.', test: run((s) => s.stats.flips >= 1) },
  { id: 'ramps', name: 'Ramp Rat', desc: 'Launch off 10 ramps in one run.', test: run((s) => s.stats.ramps >= 10) },
  { id: 'boosts', name: 'Boosted', desc: 'Hit 20 boost pads in one run.', test: run((s) => s.stats.boosts >= 20) },
  { id: 'rampage', name: 'Rampage', desc: 'Smash 10 obstacles in a single overdrive.', test: run((s) => s.stats.bestOverdriveSmash >= 10) },
  { id: 'delta', name: 'Back to Basics', desc: 'Reach Sector 4 in the Delta.', ship: 'delta', test: inShip('delta', (s) => s.sector >= 3) },
  { id: 'arrow', name: 'Needle', desc: '15 side near misses in one Arrow run.', ship: 'arrow', test: inShip('arrow', (s) => s.stats.sideMisses >= 15) },
  { id: 'manta', name: 'Hang Time', desc: 'Glide 10 times in one Manta run.', ship: 'manta', test: inShip('manta', (s) => s.stats.glides >= 10) },
  { id: 'twin', name: 'Marksman', desc: 'Pulse 3 blocks in one Interceptor run.', ship: 'twin', test: inShip('twin', (s) => s.stats.pulseHits >= 3) },
  { id: 'phantom', name: 'Ghost Walk', desc: 'Phase through 5 obstacles in one Phantom run.', ship: 'phantom', test: inShip('phantom', (s) => s.stats.phaseThroughs >= 5) },
  { id: 'fleet', name: 'Fleet', desc: 'Unlock all five ships.', test: (c) => c.shipsOwned >= 5 },
  { id: 'ace', name: 'Ace Pilot', desc: 'Fly every ship to mastery 3.', test: (c) => Object.values(c.mastery).every((l) => l >= 3) },
  { id: 'streak7', name: 'Daily Devotion', desc: 'Play the daily run 7 days in a row.', test: (c) => c.streak >= 7 },
  { id: 'ghost', name: 'Ghostbuster', desc: 'Beat a ghost in a ghost race.', test: (c) => c.ended && c.beatGhost },
  { id: 'rank5', name: 'Veteran', desc: 'Reach Rank 5.', test: (c) => c.rank >= 5 },
  { id: 'orbs5k', name: 'Orb Hoarder', desc: 'Collect 5,000 orbs in total.', test: (c) => c.totalOrbs >= 5000 },
];

export const ACH_REWARD = 100;

/** Returns achievements newly earned in this context (not already in `have`). */
export function checkAchievements(c: AchContext, have: Record<string, number>): Achievement[] {
  return ACHIEVEMENTS.filter((a) => !(a.id in have) && a.test(c));
}

export const shipAchievement = (ship: ShipId) => ACHIEVEMENTS.find((a) => a.ship === ship)!;
