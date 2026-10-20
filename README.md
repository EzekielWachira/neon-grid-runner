# Neon Grid Runner

A synthwave 3D endless runner that moves to the beat. Steer across five lanes, jump hurdles and lasers, slide under gates, and chain orbs and near misses into combos while the grid speeds up.

## Features

- **Music-synced track:** the soundtrack is generated live with Web Audio, and its clock drives the game, so every obstacle row lands exactly on a beat. The grid, sun and arches pulse with the kick.
- **Survivable by construction:** the generator plans a safe route through each row first (lane changes limited by the time before the row), then builds obstacles around it.
- **Proven by a bot:** `npm run verify` plays 36 eight-minute runs headless with an autopilot at 30, 60 and 144 fps using the real collision code, plus a control run that must crash. The same autopilot plays on the title screen.
- **Obstacles:** blocks, hurdles (jump), hanging gates (slide), full-width lasers high and low, and movers that sweep across lanes
- **Power-ups:** shield (absorbs one hit), magnet (pulls in orbs), overdrive (smash through everything, double score)
- **Scoring:** orbs and near misses build a combo; every 8 raises the multiplier (up to ×8). Late dodges, close jumps and close slides count as near misses.
- **Sectors:** every 24 bars the palette changes (Synthwave, Outrun, Toxic, Inferno, Glacier, Vapor), the music adds layers and the track gets denser
- **Daily run:** the same seeded track for everyone each day, with its own best score
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
| `npm run verify` | Headless autopilot runs that prove generated tracks are survivable |

## Controls

| Action | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Steer | `←` `→` / `A` `D` | Swipe left/right | D-pad / left stick |
| Jump | `↑` / `W` / `Space` | Swipe up or tap | A |
| Slide (fast-fall in the air) | `↓` / `S` | Swipe down | B |
| Pause | `Esc` / `P` | Pause button | Start |

## Code map

| Path | Role |
| --- | --- |
| `src/core/` | Pure game logic with no rendering: config, seeded RNG, track generator, simulation, autopilot |
| `src/audio/engine.ts` | Synth soundtrack, sidechain, sound effects and the master clock |
| `src/render/` | Three.js scene: shaders, environment, ship, obstacles, particles, camera and post-processing |
| `src/main.ts` | Game states, HUD, menus, saving |
| `scripts/verify-runs.ts` | Headless survivability check (runs in CI before every deploy) |

## Deploying

`.github/workflows/deploy.yml` verifies, builds and deploys to GitHub Pages on every push to `main`. If the verify step fails, nothing is deployed.
