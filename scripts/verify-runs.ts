// Plays many seeded runs headless with the autopilot and fails if it ever crashes.
// That proves the generator's "safe route" really is survivable with the real collision code.
// Run with: npm run verify
import { Bot } from '../src/core/bot.ts';
import { Sim } from '../src/core/sim.ts';

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

if (failures) {
  console.error(`\n${failures} run(s) crashed.`);
  process.exit(1);
}
console.log(`\nAll ${SEEDS * FRAME_RATES.length} runs survived ${DURATION}s at ${FRAME_RATES.join('/')} fps.`);
