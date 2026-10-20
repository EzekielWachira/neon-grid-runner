import './style.css';
import { BEAT, POWER_TIME, type PowerKind } from './core/config.ts';
import { Sim, type SimEvent } from './core/sim.ts';
import { Bot } from './core/bot.ts';
import { hashString } from './core/rng.ts';
import { audio } from './audio/engine.ts';
import { View, type Quality } from './render/view.ts';
import { PALETTES } from './render/palette.ts';
import { Input, type Action } from './input.ts';

// ---------------------------------------------------------------- save

interface Settings {
  quality: Quality;
  music: number;
  sfx: number;
  shake: boolean;
  fps: boolean;
  muted: boolean;
}
interface Save {
  best: number;
  bestDistance: number;
  runs: number;
  daily: Record<string, number>;
  settings: Settings;
}
const KEY = 'neon-grid-runner:v1';
function load(): Save {
  const fresh: Save = { best: 0, bestDistance: 0, runs: 0, daily: {}, settings: { quality: 'auto', music: 0.8, sfx: 0.9, shake: true, fps: false, muted: false } };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...fresh, ...raw, settings: { ...fresh.settings, ...(raw.settings ?? {}) } };
  } catch {
    return fresh;
  }
}
const save = load();
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Storage unavailable: progress lasts for this session only.
  }
};

const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const screens = ['title', 'hud', 'pause', 'over', 'settings'] as const;
type Screen = (typeof screens)[number];
function show(...names: Screen[]) {
  for (const s of screens) $(`#${s}`).classList.toggle('visible', names.includes(s));
}
const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

const canvas = $<HTMLCanvasElement>('#c');
const view = new View(canvas);

// ---------------------------------------------------------------- clock

/** Song time: the audio clock when sound is available (so beats line up exactly), else wall time. */
class Clock {
  private base = 0;
  private pausedAt = -1;
  private useAudio = false;
  start(withAudio: boolean): number {
    this.useAudio = withAudio;
    this.pausedAt = -1;
    this.base = (withAudio ? audio.now : performance.now() / 1000) + 0.15;
    return this.base;
  }
  now() {
    if (this.useAudio) return audio.now - this.base;
    return (this.pausedAt >= 0 ? this.pausedAt : performance.now() / 1000) - this.base;
  }
  pause() {
    if (this.useAudio) audio.suspend();
    else this.pausedAt = performance.now() / 1000;
  }
  resume() {
    if (this.useAudio) audio.resume();
    else if (this.pausedAt >= 0) {
      this.base += performance.now() / 1000 - this.pausedAt;
      this.pausedAt = -1;
    }
  }
}
const clock = new Clock();

// ---------------------------------------------------------------- state

type State = 'title' | 'run' | 'paused' | 'dying' | 'over';
let state: State = 'title';
let sim = new Sim((Math.random() * 2 ** 31) | 0);
let bot: Bot | null = new Bot(sim);
let attractT = 0;
let daily: string | null = null;
let dyingFor = 0;
let lastCount = -1;
let overAt = 0;

function startAttract() {
  sim = new Sim((Math.random() * 2 ** 31) | 0);
  bot = new Bot(sim);
  attractT = 0;
  view.reset();
  state = 'title';
  renderTitle();
  show('title');
}

function startRun(isDaily: boolean) {
  const ok = audio.init();
  daily = isDaily ? dateKey() : null;
  const seed = isDaily ? hashString(`ngr-daily:${daily}`) : (Math.random() * 2 ** 31) | 0;
  sim = new Sim(seed);
  bot = null;
  devBot = null;
  view.reset();
  const songStart = clock.start(ok && !!audio.ctx);
  if (ok) audio.startSong(songStart);
  lastCount = -1;
  state = 'run';
  $('#hud').classList.toggle('daily', isDaily);
  $('#popups').innerHTML = '';
  $('#banner').className = 'banner';
  show('hud');
}

function pause() {
  if (state !== 'run') return;
  state = 'paused';
  clock.pause();
  show('hud', 'pause');
}

function resume() {
  if (state !== 'paused') return;
  show('hud');
  // A short countdown so you're not thrown straight back in.
  const el = $('#resume-count');
  let n = 3;
  el.textContent = String(n);
  el.classList.add('visible');
  const tick = () => {
    n--;
    if (n > 0) {
      el.textContent = String(n);
      audio.countdown(false);
      setTimeout(tick, 450);
    } else {
      el.classList.remove('visible');
      state = 'run';
      clock.resume();
    }
  };
  audio.countdown(false);
  setTimeout(tick, 450);
}

function gameOver() {
  state = 'over';
  overAt = performance.now();
  save.runs++;
  const score = Math.floor(sim.score);
  const isBest = score > save.best;
  if (isBest) save.best = score;
  save.bestDistance = Math.max(save.bestDistance, Math.floor(sim.distance));
  let dailyBest = false;
  if (daily) {
    dailyBest = score > (save.daily[daily] ?? 0);
    if (dailyBest) save.daily[daily] = score;
  }
  persist();

  $('#over-score').textContent = fmt(score);
  $('#over-badge').textContent = isBest ? 'New best!' : dailyBest ? 'Daily best!' : '';
  $('#over-badge').classList.toggle('show', isBest || dailyBest);
  $('#over-mode').textContent = daily ? `Daily run · ${daily}` : 'Endless run';
  $('#stat-dist').textContent = `${fmt(sim.distance)} m`;
  $('#stat-orbs').textContent = fmt(sim.orbs);
  $('#stat-near').textContent = fmt(sim.nearMisses);
  $('#stat-combo').textContent = fmt(sim.bestCombo);
  $('#stat-sector').textContent = `${sim.sector + 1} · ${PALETTES[sim.sector % PALETTES.length].name}`;
  $('#stat-time').textContent = `${Math.floor(sim.t / 60)}:${String(Math.floor(sim.t % 60)).padStart(2, '0')}`;
  show('over');
}

// ---------------------------------------------------------------- input

const input = new Input(canvas, onAction);
function onAction(a: Action) {
  if (state === 'run') {
    if (a === 'left') sim.move(-1);
    else if (a === 'right') sim.move(1);
    else if (a === 'jump') sim.jump();
    else if (a === 'slide') sim.slide();
    else if (a === 'pause') pause();
  } else if (state === 'paused' && a === 'pause') resume();
  else if (state === 'title' && a === 'jump' && !$('#settings').classList.contains('visible')) startRun(false);
  else if (state === 'over' && a === 'jump' && performance.now() - overAt > 800) startRun(!!daily);
}

// ---------------------------------------------------------------- events → sound + UI

const POWER_LABEL: Record<PowerKind, string> = { shield: 'Shield', magnet: 'Magnet', overdrive: 'Overdrive' };

function popup(text: string, cls = '') {
  const el = document.createElement('div');
  el.className = `popup ${cls}`;
  el.textContent = text;
  const p = view.shipScreen();
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y - 70}px`;
  $('#popups').append(el);
  setTimeout(() => el.remove(), 900);
}

function banner(title: string, sub: string) {
  const b = $('#banner');
  b.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'banner-title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'banner-sub';
  s.textContent = sub;
  b.append(t, s);
  b.className = 'banner';
  void b.offsetWidth;
  b.className = 'banner show';
}

function onEvent(e: SimEvent) {
  view.handle(e, sim);
  switch (e.type) {
    case 'jump':
      audio.jump();
      break;
    case 'land':
      audio.land();
      break;
    case 'slide':
      audio.slide();
      break;
    case 'lane':
      audio.lane(e.dir);
      break;
    case 'orb':
      audio.orb(e.combo);
      break;
    case 'power':
      audio.power();
      popup(POWER_LABEL[e.pickup.kind as PowerKind], `power ${e.pickup.kind}`);
      break;
    case 'nearMiss':
      audio.nearMiss();
      popup(`${e.style === 'side' ? 'Near miss' : e.style === 'over' ? 'Close jump' : 'Close slide'} +${e.bonus}`, 'near');
      break;
    case 'mult':
      if (e.mult > 1) {
        audio.mult();
        const m = $('#mult');
        m.classList.remove('bump');
        void m.offsetWidth;
        m.classList.add('bump');
      }
      break;
    case 'smash':
      audio.smash();
      break;
    case 'shieldBreak':
      audio.shieldBreak();
      popup('Shield down', 'bad');
      break;
    case 'sector':
      audio.sector();
      audio.layer = e.sector;
      banner(`Sector ${e.sector + 1}`, PALETTES[e.sector % PALETTES.length].name);
      break;
    case 'death':
      audio.death();
      audio.stopSong();
      state = 'dying';
      dyingFor = 0;
      break;
  }
}

// ---------------------------------------------------------------- HUD

const powerEls = new Map<PowerKind, HTMLElement>();
function updateHud() {
  $('#score').textContent = fmt(sim.score);
  const m = $('#mult');
  m.textContent = `x${sim.mult * (sim.powers.overdrive > 0 ? 2 : 1)}`;
  m.classList.toggle('hot', sim.mult > 1 || sim.powers.overdrive > 0);
  $('#dist').textContent = `${fmt(sim.distance)} m`;
  $('#sector-label').textContent = `Sector ${sim.sector + 1}`;
  $('#combo').textContent = sim.combo >= 3 ? `${sim.combo} combo` : '';

  for (const k of ['shield', 'magnet', 'overdrive'] as PowerKind[]) {
    const left = sim.powers[k];
    let el = powerEls.get(k);
    if (left > 0 && !el) {
      el = document.createElement('div');
      el.className = `power-bar ${k}`;
      el.innerHTML = `<span></span><i><b></b></i>`;
      el.querySelector('span')!.textContent = POWER_LABEL[k];
      $('#powers').append(el);
      powerEls.set(k, el);
    } else if (left <= 0 && el) {
      el.remove();
      powerEls.delete(k);
    }
    if (el) (el.querySelector('b') as HTMLElement).style.width = `${(left / POWER_TIME[k]) * 100}%`;
  }

  // Countdown on beats 4–7 of the intro.
  const beat = Math.floor(sim.t / BEAT);
  const cd = $('#countdown');
  if (beat >= 4 && beat <= 8 && beat !== lastCount) {
    lastCount = beat;
    const label = beat === 8 ? '' : beat === 7 ? 'GO' : String(7 - beat);
    cd.textContent = label;
    cd.className = label ? 'countdown show' : 'countdown';
    if (label) audio.countdown(label === 'GO');
  }
}

function clearPowers() {
  for (const el of powerEls.values()) el.remove();
  powerEls.clear();
}

// ---------------------------------------------------------------- loop

let last = performance.now();
let fpsAcc = 0;
let fpsFrames = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const time = now / 1000;
  input.poll();

  if (state === 'title') {
    attractT += dt;
    bot!.update();
    sim.step(attractT);
    for (const e of sim.events) view.handle(e, sim);
    sim.events.length = 0;
    if (!sim.alive) startAttract();
    view.render(sim, dt, 'title', time);
  } else if (state === 'run') {
    if (devAutopilot) (devBot ??= new Bot(sim)).update();
    sim.step(Math.max(0, clock.now()));
    for (const e of sim.events) onEvent(e);
    sim.events.length = 0;
    updateHud();
    view.render(sim, dt, state === 'run' ? 'run' : 'dying', time);
  } else if (state === 'paused') {
    view.render(sim, 0.0001, 'paused', time);
  } else {
    if (state === 'dying') {
      dyingFor += dt;
      if (dyingFor > 1.8) {
        clearPowers();
        gameOver();
      }
    }
    view.render(sim, dt, 'dying', time);
  }

  if (save.settings.fps) {
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) {
      $('#fps').textContent = `${Math.round(fpsFrames / fpsAcc)} fps · ${view.pixelRatio.toFixed(2)}x`;
      fpsAcc = 0;
      fpsFrames = 0;
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- menus

function renderTitle() {
  $('#best').textContent = fmt(save.best);
  const d = save.daily[dateKey()];
  $('#daily-best').textContent = d ? `Today: ${fmt(d)}` : 'New seed today';
}

function applySettings() {
  const s = save.settings;
  audio.musicVolume = s.music;
  audio.sfxVolume = s.sfx;
  audio.muted = s.muted;
  audio.applyVolumes();
  view.shakeEnabled = s.shake;
  view.setQuality(s.quality);
  $('#fps').hidden = !s.fps;
  $('#mute-btn').classList.toggle('muted', s.muted);
}

function openSettings() {
  const s = save.settings;
  $<HTMLSelectElement>('#set-quality').value = s.quality;
  $<HTMLInputElement>('#set-music').value = String(s.music);
  $<HTMLInputElement>('#set-sfx').value = String(s.sfx);
  $<HTMLInputElement>('#set-shake').checked = s.shake;
  $<HTMLInputElement>('#set-fps').checked = s.fps;
  show('title', 'settings');
}

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  audio.init();
  audio.click();
  // Don't keep focus on buttons, or Space/arrows would press them mid-run.
  btn.blur();
});

$('#play').addEventListener('click', () => startRun(false));
$('#daily').addEventListener('click', () => startRun(true));
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => show('title'));
$('#pause-btn').addEventListener('click', pause);
$('#resume').addEventListener('click', resume);
$('#restart').addEventListener('click', () => {
  audio.stopSong(false);
  clock.resume();
  clearPowers();
  startRun(!!daily);
});
$('#quit').addEventListener('click', () => {
  audio.stopSong(false);
  clock.resume();
  clearPowers();
  startAttract();
});
$('#retry').addEventListener('click', () => startRun(!!daily));
$('#menu').addEventListener('click', startAttract);
$('#share').addEventListener('click', async () => {
  const text = `NEON GRID RUNNER — ${fmt(sim.score)} pts · ${fmt(sim.distance)} m · Sector ${sim.sector + 1}${daily ? ` · Daily ${daily}` : ''}\n${location.href.split('#')[0]}`;
  try {
    await navigator.clipboard.writeText(text);
    $('#share').textContent = 'Copied!';
    setTimeout(() => ($('#share').textContent = 'Share score'), 1500);
  } catch {
    window.prompt('Copy your score:', text);
  }
});
$('#mute-btn').addEventListener('click', () => {
  save.settings.muted = !save.settings.muted;
  persist();
  applySettings();
});

$('#set-quality').addEventListener('change', (e) => {
  save.settings.quality = (e.target as HTMLSelectElement).value as Quality;
  persist();
  applySettings();
});
for (const id of ['music', 'sfx'] as const) {
  $(`#set-${id}`).addEventListener('input', (e) => {
    save.settings[id] = Number((e.target as HTMLInputElement).value);
    persist();
    applySettings();
  });
}
for (const id of ['shake', 'fps'] as const) {
  $(`#set-${id}`).addEventListener('change', (e) => {
    save.settings[id] = (e.target as HTMLInputElement).checked;
    persist();
    applySettings();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

// Dev-only handle for debugging in the browser console (`__ngr.autopilot(true)` lets the bot play a real run).
let devAutopilot = false;
let devBot: Bot | null = null;
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ngr = {
    view,
    sim: () => sim,
    autopilot: (on: boolean) => {
      devAutopilot = on;
      devBot = null;
    },
  };
}

applySettings();
startAttract();
requestAnimationFrame(frame);
