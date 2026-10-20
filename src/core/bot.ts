// Autopilot that follows the generator's planned safe route. It plays the title-screen attract
// mode, and scripts/verify-runs.ts uses it to prove generated tracks are survivable.
import { JUMP_TIME } from './config.ts';
import type { Sim } from './sim.ts';

export class Bot {
  private sim: Sim;
  private actedFor = -1;

  constructor(sim: Sim) {
    this.sim = sim;
  }

  update() {
    const sim = this.sim;
    const rows = sim.track.rows;
    const t = sim.t;
    const i = rows.findIndex((r) => r.time > t - 0.02);
    if (i < 0) return;
    const row = rows[i];
    const prev = rows[i - 1];

    // Hold the lane until the previous row has gone by, then head for the next safe lane.
    if (!prev || t > prev.time + 0.06) {
      while (sim.lane < row.lane) sim.move(1);
      while (sim.lane > row.lane) sim.move(-1);
    }

    if (this.actedFor !== row.time) {
      if (row.action === 'jump' && t >= row.time - JUMP_TIME / 2) {
        sim.jump();
        this.actedFor = row.time;
      } else if (row.action === 'slide' && t >= row.time - 0.3) {
        sim.slide();
        this.actedFor = row.time;
      }
    }
  }
}
