# Neon Grid Runner

A synthwave 3D endless runner that moves to the beat. Steer across five lanes, jump hurdles and lasers, slide under gates, and chain orbs and near misses into combos while the grid speeds up.

## Features

- **Music-synced track:** the soundtrack is generated live with Web Audio, and its clock drives the game, so every obstacle row lands exactly on a beat. The grid, sun and arches pulse with the kick.
- **Survivable by construction:** the generator plans a safe route through each row first (lane changes limited by the time before the row), then builds obstacles around it.
- **Proven by a bot:** `npm run verify` plays 36 eight-minute runs headless with an autopilot at 30, 60 and 144 fps using the real collision code, plus a control run that must crash. It also replays recorded runs at different frame rates and checks the results match exactly. The same autopilot plays on the title screen.
- **Obstacles:** blocks, hurdles (jump), hanging gates (slide), full-width lasers high and low, and movers that sweep across lanes
- **Power-ups:** shield (absorbs one hit), magnet (pulls in orbs), overdrive (smash through everything, double score)
- **Scoring:** orbs and near misses build a combo; every 8 raises the multiplier (up to ×8). Late dodges, close jumps and close slides count as near misses.
- **Sectors:** every 24 bars the palette changes (Synthwave, Outrun, Toxic, Inferno, Glacier, Vapor), the music adds layers and the track gets denser
- **Daily run:** the same seeded track and the same featured ship for everyone each day (lent to you if you haven't unlocked it), with its own best score, a play streak that pays bonus credits, and a shareable result card: a 4:5 image of your run plus a text version with a ghost link
- **Ghost racing:** the simulation runs in fixed 1/240 s ticks and records every input, so a run replays exactly from its seed and input log (about 1 KB for five minutes). Race your best run in *Ghost race*, see your earlier best on today's daily run, or share a ghost link so friends race your exact run. A live HUD readout shows how far ahead or behind you are.
- **Missions:** three active challenges at a time (single-run and cumulative). Completing them earns credits and raises your rank; each is replaced by a harder one.
- **Ship gallery:** five ships, each with its own trait and trade-off, browsed in the garage with stat bars and a live 3D demo of the trait:

  | Ship | Trait | Trade-off |
  | --- | --- | --- |
  | Delta | All-rounder | None |
  | Arrow | 25% faster lane changes, slimmer hitbox | Power-ups last 30% less |
  | Manta | Press jump again in mid-air to glide | 10% less score |
  | Interceptor | Pulse cannon blasts the next block in your lane; charges over 16 beats, fires on the next sixteenth note | No magnets |
  | Phantom | Phase through everything for 1.1 s, once per sector | No shields |

  Ships unlock with credits, and the Interceptor and Phantom also unlock free at Sector 4 and Rank 5. Each ship levels up its own **mastery** as you fly it (credits, plus a signature paint at level 3), and keeps its own best score and ghost. Trails (Twin, Comet, Pulse, Spectrum, Stardust) and colours are cosmetic.
- **Curving road:** every shader bends the world by distance ahead (a "curved world" vertex bend), so the track sweeps left and right and rolls over hills while the simulation stays perfectly straight. It follows distance travelled, so replays curve exactly like the original run, and it can be turned off in Settings.
- **Replay theatre:** watch your last run, best run, today's daily best or a shared ghost link. Play/pause, scrub (seeking backwards re-simulates from the start in milliseconds), ¼× to 2× speed, camera modes (cinematic auto-cuts, chase, side, low, top, orbit) and a photo mode that saves a full-resolution PNG. Music re-syncs at 1× speed.
- **Visuals:** custom grid, sky, sun and hologram shaders; bloom; chromatic aberration, scanlines and grain; light trails; particles; ship-shatter explosions; speed lines; adaptive resolution
- **Controls:** keyboard, touch swipes and gamepads

## Run locally

```bash
npm install
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run verify` | Headless autopilot runs that prove generated tracks are survivable in every ship, and that recorded runs replay exactly |

## Controls

| Action | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Steer | `←` `→` / `A` `D` | Swipe left/right | D-pad / left stick |
| Jump | `↑` / `W` / `Space` | Swipe up or tap | A |
| Slide (fast-fall in the air) | `↓` / `S` | Swipe down | B |
| Ship ability (Interceptor, Phantom) | `E` / `F` / `Shift` | Ability button | X / Y / bumpers |
| Pause | `Esc` / `P` | Pause button | Start |

In the replay theatre: `Space` play/pause, `←`/`→` seek 5 s, `C` camera, `H` photo mode, `Esc` exit.

## Code map

| Path | Role |
| --- | --- |
| `src/core/` | Pure game logic with no rendering: config, seeded RNG, track generator, fixed-tick simulation, autopilot, input-log encoding |
| `src/audio/engine.ts` | Synth soundtrack, sidechain, sound effects and the master clock |
| `src/render/` | Three.js scene: shaders, curved-world bend, environment, ship, obstacles, particles, cameras and post-processing |
| `src/core/ships.ts` | Ship classes: the rules each ship changes |
| `src/meta/` | Missions, garage catalogue, gallery and mastery, daily extras (featured ship, streaks, result card) and ghost-link encoding |
| `src/main.ts` | Game states, HUD, menus, ghosts, saving |
| `scripts/verify-runs.ts` | Headless survivability check (runs in CI before every deploy) |

## Deploying

`.github/workflows/deploy.yml` verifies, builds and deploys to GitHub Pages on every push to `main`. If the verify step fails, nothing is deployed.

## Ghost links

`…/#ghost=<data>` opens a challenge card on the title screen. The data carries the seed, the input log, the score, the runner's callsign (set in Settings) and their ship. You race in the same ship, lent to you if you don't own it, because the ship's rules are part of the simulation. Links from before ship classes (`v: 1`) replay with Delta rules, which are exactly the old rules.
