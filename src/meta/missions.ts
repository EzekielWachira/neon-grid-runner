// Missions: three active challenges at a time. Completing them earns credits and raises your
// rank; every completion is replaced by a new one scaled to the new rank.
import { mulberry32 } from '../core/rng.ts';
import type { Sim, SimEvent } from '../core/sim.ts';

export type MissionKind =
  | 'orbsRun'
  | 'nearRun'
  | 'distRun'
  | 'sectorRun'
  | 'comboRun'
  | 'scoreRun'
  | 'closeRun'
  | 'powerRun'
  | 'nearStreak'
  | 'noPowerDist'
  | 'dailyScore'
  | 'sentinelRun'
  | 'rampRun'
  | 'smashTotal'
  | 'distTotal'
  | 'orbsTotal';

export interface Mission {
  id: number;
  kind: MissionKind;
  target: number;
  reward: number;
  /** Saved progress (only cumulative missions carry progress between runs). */
  progress: number;
}

export interface MissionSave {
  active: Mission[];
  done: number;
  nextId: number;
}

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

interface Spec {
  base: number;
  grow: number;
  round: number;
  text: (n: number) => string;
  minRank?: number;
  total?: boolean;
}

const SPECS: Record<MissionKind, Spec> = {
  orbsRun: { base: 30, grow: 0.45, round: 5, text: (n) => `Collect ${n} orbs in one run` },
  nearRun: { base: 3, grow: 0.4, round: 1, text: (n) => `Pull off ${n} near misses in one run` },
  distRun: { base: 1000, grow: 0.5, round: 250, text: (n) => `Run ${fmt(n)} m in one run` },
  sectorRun: { base: 2, grow: 0.2, round: 1, text: (n) => `Reach sector ${n}` },
  comboRun: { base: 15, grow: 0.4, round: 5, text: (n) => `Build a ${n} combo` },
  scoreRun: { base: 3000, grow: 0.6, round: 500, text: (n) => `Score ${fmt(n)} in one run` },
  closeRun: { base: 2, grow: 0.35, round: 1, text: (n) => `Make ${n} close jumps or slides in one run` },
  powerRun: { base: 2, grow: 0.25, round: 1, text: (n) => `Grab ${n} power-ups in one run` },
  nearStreak: { base: 2, grow: 0.15, round: 1, minRank: 2, text: (n) => `Get ${n} near misses within 5 seconds` },
  noPowerDist: { base: 1200, grow: 0.4, round: 100, minRank: 2, text: (n) => `Run ${fmt(n)} m before touching a power-up` },
  sentinelRun: { base: 1, grow: 0.15, round: 1, minRank: 2, text: (n) => `Survive ${n} Sentinel${n === 1 ? '' : 's'} in one run` },
  rampRun: { base: 3, grow: 0.35, round: 1, text: (n) => `Launch off ${n} ramps in one run` },
  dailyScore: { base: 2500, grow: 0.5, round: 500, text: (n) => `Score ${fmt(n)} on a daily run` },
  smashTotal: { base: 5, grow: 0.5, round: 1, minRank: 2, total: true, text: (n) => `Smash ${n} obstacles in overdrive (total)` },
  distTotal: { base: 5000, grow: 0.6, round: 1000, total: true, text: (n) => `Travel ${fmt(n)} m in total` },
  orbsTotal: { base: 250, grow: 0.6, round: 50, total: true, text: (n) => `Collect ${n} orbs in total` },
};

const RANKS = ['Rookie', 'Runner', 'Drifter', 'Racer', 'Ace', 'Phantom', 'Vanguard', 'Legend', 'Mythic'];

export const rankOf = (s: MissionSave) => 1 + Math.floor(s.done / 3);
export const rankName = (r: number) => (r <= RANKS.length ? RANKS[r - 1] : `${RANKS[RANKS.length - 1]} ${r - RANKS.length + 1}`);
export const missionText = (m: Mission) => SPECS[m.kind].text(m.target);
export const isTotal = (m: Mission) => !!SPECS[m.kind].total;

function newMission(save: MissionSave): Mission {
  const rank = rankOf(save);
  const rng = mulberry32(save.nextId * 2654435761);
  const taken = new Set(save.active.map((m) => m.kind));
  const kinds = (Object.keys(SPECS) as MissionKind[]).filter((k) => !taken.has(k) && (SPECS[k].minRank ?? 1) <= rank);
  const kind = kinds[Math.floor(rng() * kinds.length)];
  const spec = SPECS[kind];
  const target = Math.max(spec.round, Math.round((spec.base * (1 + spec.grow * (rank - 1))) / spec.round) * spec.round);
  return { id: save.nextId++, kind, target, reward: 100 + 40 * (rank - 1) + (spec.total ? 60 : 0), progress: 0 };
}

export function freshMissions(): MissionSave {
  const s: MissionSave = { active: [], done: 0, nextId: 1 };
  while (s.active.length < 3) s.active.push(newMission(s));
  return s;
}

export interface RunReport {
  completed: Mission[];
  credits: number;
  rankBefore: number;
  rankAfter: number;
}

/** Tracks mission progress live during one run. */
export class MissionRun {
  /** Missions completed this run, in order (for mid-run popups and the results screen). */
  readonly completed: Mission[] = [];
  private save: MissionSave;
  private daily: boolean;
  private nearTimes: number[] = [];
  private bestStreak = 0;

  constructor(save: MissionSave, daily: boolean) {
    this.save = save;
    this.daily = daily;
  }

  onEvent(e: SimEvent, sim: Sim) {
    if (e.type !== 'nearMiss') return;
    this.nearTimes.push(sim.t);
    while (this.nearTimes.length && this.nearTimes[0] < sim.t - 5) this.nearTimes.shift();
    this.bestStreak = Math.max(this.bestStreak, this.nearTimes.length);
  }

  value(m: Mission, sim: Sim): number {
    switch (m.kind) {
      case 'orbsRun':
        return sim.orbs;
      case 'nearRun':
        return sim.nearMisses;
      case 'distRun':
        return sim.distance;
      case 'sectorRun':
        return sim.sector + 1;
      case 'comboRun':
        return sim.bestCombo;
      case 'scoreRun':
        return sim.score;
      case 'closeRun':
        return sim.stats.closeMoves;
      case 'powerRun':
        return sim.stats.powers;
      case 'nearStreak':
        return this.bestStreak;
      case 'noPowerDist':
        return sim.firstPowerAt ?? sim.distance;
      case 'sentinelRun':
        return sim.stats.sentinels;
      case 'rampRun':
        return sim.stats.ramps;
      case 'dailyScore':
        return this.daily ? sim.score : 0;
      case 'smashTotal':
        return m.progress + sim.stats.smashes;
      case 'distTotal':
        return m.progress + sim.distance;
      case 'orbsTotal':
        return m.progress + sim.orbs;
    }
  }

  /** Call each frame; returns missions that just completed. */
  update(sim: Sim): Mission[] {
    const fresh: Mission[] = [];
    for (const m of this.save.active) {
      if (this.completed.includes(m)) continue;
      if (this.value(m, sim) >= m.target) {
        this.completed.push(m);
        fresh.push(m);
      }
    }
    return fresh;
  }

  /** Ends the run: banks progress, swaps completed missions for new ones, returns the rewards. */
  finish(sim: Sim): RunReport {
    this.update(sim);
    const rankBefore = rankOf(this.save);
    let credits = Math.floor(sim.distance / 100);
    for (const m of this.save.active) if (isTotal(m) && !this.completed.includes(m)) m.progress = this.value(m, sim);
    for (const m of this.completed) {
      credits += m.reward;
      this.save.done++;
      const i = this.save.active.indexOf(m);
      this.save.active.splice(i, 1, newMission(this.save));
    }
    return { completed: this.completed, credits, rankBefore, rankAfter: rankOf(this.save) };
  }
}
