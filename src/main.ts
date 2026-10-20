import './style.css';
import { BEAT, POWER_TIME, type PowerKind } from './core/config.ts';
import { Sim, type InputEntry, type SimEvent } from './core/sim.ts';
import { Bot } from './core/bot.ts';
import { hashString } from './core/rng.ts';
import { decodeLog, encodeLog } from './core/ghost.ts';
import { audio } from './audio/engine.ts';
import { View, type Quality } from './render/view.ts';
import { PALETTES } from './render/palette.ts';
import { Input, type Action } from './input.ts';
import { MissionRun, freshMissions, isTotal, missionText, rankName, rankOf, type MissionSave, type RunReport } from './meta/missions.ts';
import { ITEMS, freshGarage, isShipId, itemKey, type GarageSave, type ItemKind, type ShipId } from './meta/garage.ts';
import { decodeGhostLink, encodeGhostLink, type GhostLink } from './meta/share.ts';

// ---------------------------------------------------------------- save

interface Settings {
  quality: Quality;
  music: number;
  sfx: number;
  shake: boolean;
  fps: boolean;
  muted: boolean;
  ghosts: boolean;
  callsign: string;
}
interface GhostSave {
  seed: number;
  log: string;
  score: number;
  distance: number;
  ship: ShipId;
  key?: string;
}
interface Save {
  best: number;
  bestDistance: number;
  runs: number;
  daily: Record<string, number>;
  settings: Settings;
  missions: MissionSave;
  garage: GarageSave;
  bestGhost?: GhostSave;
  dailyGhost?: GhostSave;
}
const KEY = 'neon-grid-runner:v1';
function load(): Save {
  const fresh: Save = {
    best: 0,
    bestDistance: 0,
    runs: 0,
    daily: {},
    settings: { quality: 'auto', music: 0.8, sfx: 0.9, shake: true, fps: false, muted: false, ghosts: true, callsign: 'Runner' },
    missions: freshMissions(),
    garage: freshGarage(),
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const s: Save = { ...fresh, ...raw, settings: { ...fresh.settings, ...(raw.settings ?? {}) } };
    if (!s.missions?.active?.length) s.missions = freshMissions();
    s.garage = { ...fresh.garage, ...(raw.garage ?? {}), loadout: { ...fresh.garage.loadout, ...(raw.garage?.loadout ?? {}) } };
    for (const k of fresh.garage.owned) if (!s.garage.owned.includes(k)) s.garage.owned.push(k);
    return s;
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
const screens = ['title', 'hud', 'pause', 'over', 'settings', 'missions', 'garage'] as const;
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

interface Rival {
  seed: number;
  log: InputEntry[];
  score: number;
  ship: ShipId;
  name: string;
}

type RunMode = { kind: 'endless' } | { kind: 'daily'; key: string } | { kind: 'ghost'; rival: Rival };
type State = 'title' | 'garage' | 'run' | 'paused' | 'dying' | 'over';

let state: State = 'title';
let sim = new Sim((Math.random() * 2 ** 31) | 0);
let bot: Bot | null = new Bot(sim);
let attractT = 0;
let mode: RunMode = { kind: 'endless' };
let ghost: Sim | null = null;
let rival: Rival | null = null;
let missionRun: MissionRun | null = null;
let challenge: GhostLink | null = null;
let dyingFor = 0;
let lastCount = -1;
let overAt = 0;
let ghostWasAlive = true;

// Dev-only autopilot (`__ngr.autopilot(true)` in the console lets the bot play a real run).
let devAutopilot = false;
let devBot: Bot | null = null;

function startAttract() {
  sim = new Sim((Math.random() * 2 ** 31) | 0);
  bot = new Bot(sim);
  attractT = 0;
  ghost = null;
  view.setGhostShip(null);
  view.reset();
  state = 'title';
  renderTitle();
  show('title');
}

function startRun(next: RunMode) {
  const ok = audio.init();
  mode = next;
  const seed = next.kind === 'daily' ? hashString(`ngr-daily:${next.key}`) : next.kind === 'ghost' ? next.rival.seed : (Math.random() * 2 ** 31) | 0;
  sim = new Sim(seed);
  bot = null;
  devBot = null;

  // Who to race: a ghost race brings its rival; a daily run shows your earlier best from today.
  rival = null;
  if (next.kind === 'ghost') rival = next.rival;
  else if (next.kind === 'daily' && save.settings.ghosts && save.dailyGhost?.key === next.key) {
    const log = decodeLog(save.dailyGhost.log);
    if (log) rival = { seed, log, score: save.dailyGhost.score, ship: save.dailyGhost.ship, name: 'Your best' };
  }
  ghost = rival ? new Sim(seed, rival.log) : null;
  ghostWasAlive = true;
  view.reset();
  view.setGhostShip(rival ? rival.ship : null);
  $('#ghost-tag').textContent = rival?.name ?? '';
  $('#hud').classList.toggle('has-ghost', !!rival);

  missionRun = new MissionRun(save.missions, next.kind === 'daily');
  const songStart = clock.start(ok && !!audio.ctx);
  if (ok) audio.startSong(songStart);
  lastCount = -1;
  state = 'run';
  $('#hud').classList.toggle('daily', next.kind !== 'endless');
  $('#mode-tag').textContent = next.kind === 'daily' ? 'Daily run' : next.kind === 'ghost' ? 'Ghost race' : '';
  $('#popups').innerHTML = '';
  $('#banner').className = 'banner';
  show('hud');
}

function retry() {
  startRun(mode);
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

/** Banks mission progress and credits for the run that just ended. */
function settleRun(): RunReport | null {
  if (!missionRun) return null;
  const report = missionRun.finish(sim);
  missionRun = null;
  save.garage.credits += report.credits;
  persist();
  return report;
}

function quitToMenu() {
  audio.stopSong(false);
  clock.resume();
  clearPowers();
  settleRun();
  startAttract();
}

function gameOver() {
  state = 'over';
  overAt = performance.now();
  save.runs++;
  const score = Math.floor(sim.score);
  const log = encodeLog(sim.log);
  const ship = save.garage.loadout.ship;

  let isBest = false;
  if (mode.kind !== 'daily') {
    isBest = score > save.best;
    if (isBest) {
      save.best = score;
      save.bestGhost = { seed: sim.seed, log, score, distance: Math.floor(sim.distance), ship };
    }
  }
  save.bestDistance = Math.max(save.bestDistance, Math.floor(sim.distance));
  let dailyBest = false;
  if (mode.kind === 'daily') {
    dailyBest = score > (save.daily[mode.key] ?? 0);
    if (dailyBest) {
      save.daily[mode.key] = score;
      save.dailyGhost = { seed: sim.seed, log, score, distance: Math.floor(sim.distance), ship, key: mode.key };
    }
  }
  const report = settleRun();
  persist();

  $('#over-score').textContent = fmt(score);
  $('#over-badge').textContent = isBest ? 'New best!' : dailyBest ? 'Daily best!' : '';
  $('#over-badge').classList.toggle('show', isBest || dailyBest);
  $('#over-mode').textContent = mode.kind === 'daily' ? `Daily run · ${mode.key}` : mode.kind === 'ghost' ? 'Ghost race' : 'Endless run';
  $('#stat-dist').textContent = `${fmt(sim.distance)} m`;
  $('#stat-orbs').textContent = fmt(sim.orbs);
  $('#stat-near').textContent = fmt(sim.nearMisses);
  $('#stat-combo').textContent = fmt(sim.bestCombo);
  $('#stat-sector').textContent = `${sim.sector + 1} · ${PALETTES[sim.sector % PALETTES.length].name}`;
  $('#stat-time').textContent = `${Math.floor(sim.t / 60)}:${String(Math.floor(sim.t % 60)).padStart(2, '0')}`;

  // Ghost verdict.
  const gl = $('#over-ghost');
  if (rival) {
    const diff = score - rival.score;
    const them = rival.name === 'Your best' ? 'your ghost' : rival.name;
    gl.textContent = diff > 0 ? `You beat ${them} by ${fmt(diff)}` : `${them[0].toUpperCase()}${them.slice(1)} wins by ${fmt(-diff)}`;
    gl.className = `over-ghost ${diff > 0 ? 'win' : 'lose'}`;
  } else {
    gl.textContent = '';
    gl.className = 'over-ghost';
  }

  // Rewards.
  const rw = $('#over-rewards');
  rw.innerHTML = '';
  if (report) {
    const credits = document.createElement('div');
    credits.className = 'reward-credits';
    credits.textContent = `+${fmt(report.credits)} credits`;
    rw.append(credits);
    for (const m of report.completed) {
      const row = document.createElement('div');
      row.className = 'reward-mission';
      row.textContent = `✓ ${missionText(m)}  +${m.reward}`;
      rw.append(row);
    }
    if (report.rankAfter > report.rankBefore) {
      const up = document.createElement('div');
      up.className = 'reward-rank';
      up.textContent = `Rank up! ${report.rankAfter} · ${rankName(report.rankAfter)}`;
      rw.append(up);
    }
  }
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
  else if (state === 'title' && a === 'jump' && !document.querySelector('.modal.visible')) startRun(challenge ? ghostMode(challenge) : { kind: 'endless' });
  else if (state === 'over' && a === 'jump' && performance.now() - overAt > 800) retry();
  else if (state === 'garage' && a === 'pause') closeGarage();
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

let toastTimer = 0;
function toast(title: string, text: string) {
  const el = $('#toast');
  el.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  const s = document.createElement('span');
  s.textContent = text;
  el.append(b, s);
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

function onEvent(e: SimEvent) {
  view.handle(e, sim);
  missionRun?.onEvent(e, sim);
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
const tagPos = { x: 0, y: 0 };
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

  // Ghost: live score gap and a name tag that follows its ship.
  if (ghost && rival) {
    const diff = Math.round(sim.score - ghost.score);
    const gd = $('#ghost-diff');
    gd.textContent = `vs ${rival.name} ${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${fmt(Math.abs(diff))}`;
    gd.className = `ghost-diff ${diff >= 0 ? 'ahead' : 'behind'}`;
    const p = view.ghostScreen();
    const tag = $('#ghost-tag');
    if (p && ghost.alive) {
      tagPos.x += (p.x - tagPos.x) * 0.5;
      tagPos.y += (p.y - tagPos.y) * 0.5;
      tag.style.transform = `translate(${tagPos.x}px, ${tagPos.y}px) translate(-50%, -100%)`;
      tag.style.opacity = '1';
    } else tag.style.opacity = '0';
    if (ghostWasAlive && !ghost.alive) toast('Ghost down', `${rival.name} crashed at ${fmt(ghost.distance)} m`);
    ghostWasAlive = ghost.alive;
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

  if (state === 'title' || state === 'garage') {
    attractT += dt;
    bot!.update();
    sim.step(attractT);
    for (const e of sim.events) view.handle(e, sim);
    sim.events.length = 0;
    if (!sim.alive) {
      sim = new Sim((Math.random() * 2 ** 31) | 0);
      bot = new Bot(sim);
      attractT = 0;
    }
    view.render(sim, dt, state === 'garage' ? 'garage' : 'title', time);
  } else if (state === 'run') {
    if (devAutopilot) (devBot ??= new Bot(sim)).update();
    const t = Math.max(0, clock.now());
    sim.step(t);
    if (ghost) {
      ghost.step(t);
      ghost.events.length = 0;
    }
    for (const e of sim.events) onEvent(e);
    sim.events.length = 0;
    if (missionRun) {
      for (const done of missionRun.update(sim)) {
        toast('Mission complete', `${missionText(done)}  +${done.reward}`);
        audio.power();
      }
    }
    updateHud();
    view.render(sim, dt, state === 'run' ? 'run' : 'dying', time, ghost);
  } else if (state === 'paused') {
    view.render(sim, 0.0001, 'paused', time, ghost);
  } else {
    if (state === 'dying') {
      dyingFor += dt;
      if (dyingFor > 1.8) {
        clearPowers();
        gameOver();
      }
    }
    view.render(sim, dt, 'dying', time, ghost);
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

// ---------------------------------------------------------------- title, missions, garage

function ghostMode(g: GhostLink): RunMode {
  const log = decodeLog(g.log) ?? [];
  return { kind: 'ghost', rival: { seed: g.seed, log, score: g.score, ship: g.ship, name: g.name } };
}

function renderTitle() {
  $('#best').textContent = fmt(save.best);
  const d = save.daily[dateKey()];
  $('#daily-best').textContent = d ? `Today: ${fmt(d)}` : 'New seed today';
  const rank = rankOf(save.missions);
  $('#rank-chip').textContent = `Rank ${rank} · ${rankName(rank)}`;
  $('#credit-chip').textContent = `${fmt(save.garage.credits)} credits`;
  const race = $<HTMLButtonElement>('#race');
  race.hidden = !save.bestGhost;
  if (save.bestGhost) $('#race-sub').textContent = `Beat your ${fmt(save.bestGhost.score)}`;

  const card = $('#challenge');
  card.hidden = !challenge;
  if (challenge) {
    $('#challenge-name').textContent = `${challenge.name}${challenge.day ? ` · daily ${challenge.day}` : ''}`;
    $('#challenge-score').textContent = `${fmt(challenge.score)} pts`;
  }
}

function openMissions() {
  const ms = save.missions;
  const rank = rankOf(ms);
  $('#ms-rank').textContent = `Rank ${rank} · ${rankName(rank)}`;
  $('#ms-next').style.width = `${((ms.done % 3) / 3) * 100}%`;
  const left = 3 - (ms.done % 3);
  $('#ms-next-label').textContent = `${left} more mission${left === 1 ? '' : 's'} to rank ${rank + 1}`;
  const list = $('#ms-list');
  list.innerHTML = '';
  for (const m of ms.active) {
    const card = document.createElement('div');
    card.className = 'mission';
    const title = document.createElement('div');
    title.className = 'mission-text';
    title.textContent = missionText(m);
    const meta = document.createElement('div');
    meta.className = 'mission-meta';
    meta.textContent = `${isTotal(m) ? `${fmt(m.progress)} / ${fmt(m.target)}` : 'In one run'} · +${m.reward} credits`;
    card.append(title, meta);
    if (isTotal(m)) {
      const bar = document.createElement('i');
      const fill = document.createElement('b');
      fill.style.width = `${Math.min(100, (m.progress / m.target) * 100)}%`;
      bar.append(fill);
      card.append(bar);
    }
    list.append(card);
  }
  show('title', 'missions');
}

let garageTab: ItemKind = 'ship';
function openGarage() {
  state = 'garage';
  renderGarage();
  show('garage');
  placeGaragePreview();
}

/** Centre the 3D ship in the space the panel leaves free (beside it, or above it on phones). */
function placeGaragePreview() {
  const r = $('.garage-panel').getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  view.garageFocus = w > 640 ? { x: r.left / 2, y: h * 0.52 } : { x: w / 2, y: Math.max(80, r.top / 2) };
}
window.addEventListener('resize', () => state === 'garage' && placeGaragePreview());

function closeGarage() {
  state = 'title';
  renderTitle();
  show('title');
}

function renderGarage() {
  const g = save.garage;
  $('#gar-credits').textContent = `${fmt(g.credits)} credits`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.gar-tab')) b.classList.toggle('on', b.dataset.tab === garageTab);
  const grid = $('#gar-items');
  grid.innerHTML = '';
  for (const item of ITEMS.filter((i) => i.kind === garageTab)) {
    const key = itemKey(item.kind, item.id);
    const owned = g.owned.includes(key);
    const equipped = g.loadout[item.kind] === item.id;
    const card = document.createElement('button');
    card.className = `gar-item${equipped ? ' equipped' : ''}${owned ? ' owned' : ''}`;
    card.dataset.key = key;
    card.innerHTML = `<span class="gi-name"></span><span class="gi-desc"></span><span class="gi-state"></span>`;
    if (item.kind === 'color') {
      const dot = document.createElement('i');
      dot.className = 'gi-swatch';
      dot.style.background = item.swatch === undefined ? 'conic-gradient(#ff2bd6, #22e6ff, #7dff3a, #ffd23f, #ff2bd6)' : `#${item.swatch.toString(16).padStart(6, '0')}`;
      card.prepend(dot);
    }
    card.querySelector('.gi-name')!.textContent = item.name;
    card.querySelector('.gi-desc')!.textContent = item.desc;
    card.querySelector('.gi-state')!.textContent = equipped ? 'Equipped' : owned ? 'Equip' : `${fmt(item.cost)} credits`;
    if (!owned && g.credits < item.cost) card.classList.add('locked');
    grid.append(card);
  }
}

$('#gar-items').addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.gar-item');
  if (!card) return;
  const [kind, id] = card.dataset.key!.split(':') as [ItemKind, string];
  const item = ITEMS.find((i) => i.kind === kind && i.id === id)!;
  const g = save.garage;
  const key = itemKey(kind, id);
  if (!g.owned.includes(key)) {
    if (g.credits < item.cost) return;
    g.credits -= item.cost;
    g.owned.push(key);
    audio.power();
  }
  (g.loadout as unknown as Record<string, string>)[kind] = id;
  view.setLoadout(g.loadout);
  persist();
  renderGarage();
});
for (const b of document.querySelectorAll<HTMLButtonElement>('.gar-tab')) {
  b.addEventListener('click', () => {
    garageTab = b.dataset.tab as ItemKind;
    renderGarage();
  });
}

// ---------------------------------------------------------------- settings + wiring

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
  $<HTMLInputElement>('#set-ghosts').checked = s.ghosts;
  $<HTMLInputElement>('#set-callsign').value = s.callsign;
  show('title', 'settings');
}

async function copyText(text: string, btn: HTMLElement, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = label), 1500);
  } catch {
    window.prompt('Copy this:', text);
  }
}

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  audio.init();
  audio.click();
  // Don't keep focus on buttons, or Space/arrows would press them mid-run.
  btn.blur();
});

$('#play').addEventListener('click', () => startRun({ kind: 'endless' }));
$('#daily').addEventListener('click', () => startRun({ kind: 'daily', key: dateKey() }));
$('#race').addEventListener('click', () => {
  const g = save.bestGhost!;
  startRun({ kind: 'ghost', rival: { seed: g.seed, log: decodeLog(g.log) ?? [], score: g.score, ship: isShipId(g.ship) ? g.ship : 'delta', name: 'Your best' } });
});
$('#challenge-go').addEventListener('click', () => challenge && startRun(ghostMode(challenge)));
$('#challenge-x').addEventListener('click', () => {
  challenge = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderTitle();
});
$('#missions-btn').addEventListener('click', openMissions);
$('#missions-close').addEventListener('click', () => show('title'));
$('#garage-btn').addEventListener('click', openGarage);
$('#garage-close').addEventListener('click', closeGarage);
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => {
  renderTitle();
  show('title');
});
$('#pause-btn').addEventListener('click', pause);
$('#resume').addEventListener('click', resume);
$('#restart').addEventListener('click', () => {
  audio.stopSong(false);
  clock.resume();
  clearPowers();
  settleRun();
  retry();
});
$('#quit').addEventListener('click', quitToMenu);
$('#retry').addEventListener('click', retry);
$('#menu').addEventListener('click', startAttract);
$('#share').addEventListener('click', () => {
  const link: GhostLink = {
    seed: sim.seed,
    log: encodeLog(sim.log),
    score: sim.score,
    name: save.settings.callsign || 'Runner',
    ship: save.garage.loadout.ship,
    day: mode.kind === 'daily' ? mode.key : undefined,
  };
  const url = `${location.href.split('#')[0]}#ghost=${encodeGhostLink(link)}`;
  void copyText(`Race my ghost in NEON GRID RUNNER: ${fmt(sim.score)} pts, ${fmt(sim.distance)} m\n${url}`, $('#share'), 'Share ghost');
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
for (const id of ['shake', 'fps', 'ghosts'] as const) {
  $(`#set-${id}`).addEventListener('change', (e) => {
    save.settings[id] = (e.target as HTMLInputElement).checked;
    persist();
    applySettings();
  });
}
$('#set-callsign').addEventListener('input', (e) => {
  save.settings.callsign = (e.target as HTMLInputElement).value.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 16);
  persist();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

// A shared ghost link opens a challenge card on the title screen.
const hash = location.hash.slice(1);
if (hash.startsWith('ghost=')) challenge = decodeGhostLink(hash.slice(6));

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ngr = {
    view,
    sim: () => sim,
    ghost: () => ghost,
    save,
    autopilot: (on: boolean) => {
      devAutopilot = on;
      devBot = null;
    },
  };
}

view.setLoadout(save.garage.loadout);
applySettings();
startAttract();
requestAnimationFrame(frame);
