// Plays many seeded runs headless with the autopilot and fails if it ever crashes.
// That proves the generator's "safe route" really is survivable with the real collision code.
// Run with: npm run verify
import { Bot } from '../src/core/bot.ts';
import { Sim } from '../src/core/sim.ts';
import { decodeLog, encodeLog } from '../src/core/ghost.ts';
import { mulberry32 } from '../src/core/rng.ts';

const SEEDS = 12;
const DURATION = 480;
const FRAME_RATES = [60, 30, 144];

let failures = 0;
for (const fps of FRAME_RATES) {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sim = new Sim(seed * 7919);
    const bot = new Bot(sim);
    const dt = 1 / fps;
    let t = 0;
    while (t < DURATION && sim.alive) {
      t += dt;
      bot.update();
      sim.step(t);
      sim.events.length = 0;
    }
    if (!sim.alive) {
      failures++;
      const o = sim.track.obstacles.find((x) => x.done === 'hit');
      console.log(`FAIL seed ${seed} @${fps}fps: died at t=${t.toFixed(2)} on ${o?.kind} lanes ${o?.lane0}-${o?.lane1} (player lane ${sim.lane}, x ${sim.x.toFixed(2)}, y ${sim.y.toFixed(2)})`);
    } else if (fps === 60) {
      console.log(
        `seed ${String(seed).padStart(2)}: ${Math.round(sim.distance)} m, score ${Math.round(sim.score)}, orbs ${sim.orbs}, near misses ${sim.nearMisses}, sector ${sim.sector + 1}`,
      );
    }
  }
}

// Control: a player who never moves must crash, or the collision code isn't doing anything.
{
  const idle = new Sim(424242);
  let t = 0;
  while (t < 120 && idle.alive) {
    t += 1 / 60;
    idle.step(t);
  }
  if (idle.alive) {
    console.error('Control failed: an idle player survived 120s, so collisions are not being detected.');
    failures++;
  } else {
    console.log(`Control: an idle player crashes at t=${t.toFixed(1)}s, as it should.`);
  }
}

// Ghost determinism: a recorded run, replayed from its input log at a different frame rate,
// must end with exactly the same score, distance and (for a crash) the same tick.
function play(sim: Sim, fps: number, until: number, drive?: (t: number) => void) {
  let t = 0;
  while (t < until && sim.alive) {
    t += 1 / fps;
    drive?.(t);
    sim.step(t);
    sim.events.length = 0;
  }
}
const replayCases: { name: string; make: (sim: Sim) => (t: number) => void }[] = [
  { name: 'autopilot (survives)', make: (sim) => { const bot = new Bot(sim); return () => bot.update(); } },
  {
    name: 'random inputs (crashes)',
    make: (sim) => {
      const rng = mulberry32(99);
      return () => {
        const r = rng();
        if (r < 0.02) sim.move(-1);
        else if (r < 0.04) sim.move(1);
        else if (r < 0.05) sim.jump();
        else if (r < 0.055) sim.slide();
      };
    },
  },
];
for (const c of replayCases) {
  const live = new Sim(31337);
  play(live, 60, 300, c.make(live));
  const log = decodeLog(encodeLog(live.log))!;
  for (const fps of [37, 144]) {
    const ghost = new Sim(31337, log);
    play(ghost, fps, 300);
    const same = ghost.ticks === live.ticks && ghost.alive === live.alive && ghost.score === live.score && ghost.distance === live.distance;
    if (!same) {
      failures++;
      console.error(`Replay mismatch (${c.name} @${fps}fps): live ticks ${live.ticks} score ${live.score.toFixed(3)} vs ghost ticks ${ghost.ticks} score ${ghost.score.toFixed(3)}`);
    }
  }
  console.log(`Replay: ${c.name}, ${live.log.length} inputs (${encodeLog(live.log).length} chars), ${live.alive ? 'alive' : `crashed at tick ${live.ticks}`}: identical at 37 and 144 fps.`);
}

if (failures) {
  console.error(`\n${failures} run(s) crashed.`);
  process.exit(1);
}
console.log(`\nAll ${SEEDS * FRAME_RATES.length} runs survived ${DURATION}s at ${FRAME_RATES.join('/')} fps.`);
