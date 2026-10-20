import './style.css';
import { BEAT, type PowerKind } from './core/config.ts';
import { Sim, type InputEntry, type SimEvent } from './core/sim.ts';
import { Bot } from './core/bot.ts';
import type { ShipId } from './core/ships.ts';
import { decodeLog, encodeLog } from './core/ghost.ts';
import { audio } from './audio/engine.ts';
import { View, type CamMode, type Quality } from './render/view.ts';
import { PALETTES } from './render/palette.ts';
import { Input, type Action } from './input.ts';
import { MissionRun, freshMissions, isTotal, missionText, rankName, rankOf, type MissionSave, type RunReport } from './meta/missions.ts';
import {
  ABILITY_NAME,
  ITEMS,
  MASTERY_MAX,
  MASTERY_REWARD,
  MASTERY_XP,
  SHIP_INFO,
  STAT_LABEL,
  addMastery,
  claimMilestones,
  freshGarage,
  isShipId,
  itemKey,
  masteryLevel,
  masteryProgress,
  milestoneText,
  shipName,
  type GarageSave,
  type Item,
  type ItemKind,
  type StatKey,
} from './meta/garage.ts';
import { decodeGhostLink, encodeGhostLink, type GhostLink } from './meta/share.ts';
import { cardText, dailySeed, dailyShip, dateKey, drawCard, streak, streakBonus, type CardData } from './meta/daily.ts';

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
  curves: boolean;
}
interface GhostSave {
  seed: number;
  log: string;
  score: number;
  distance: number;
  /** Hull shown. */
  ship: ShipId;
  /** Class rules it was simulated with; missing on runs saved before ship classes (they flew as a Delta). */
  cls?: ShipId;
  key?: string;
}
interface Save {
  best: number;
  bestDistance: number;
  /** Highest sector reached in any run (1-based). */
  bestSector: number;
  runs: number;
  daily: Record<string, number>;
  settings: Settings;
  missions: MissionSave;
  garage: GarageSave;
  bestGhost?: GhostSave;
  /** Best score and its ghost for each ship (endless runs). */
  shipBest: Partial<Record<ShipId, number>>;
  shipGhosts: Partial<Record<ShipId, GhostSave>>;
  dailyGhost?: GhostSave;
  lastRun?: GhostSave;
}
const KEY = 'neon-grid-runner:v1';
function load(): Save {
  const fresh: Save = {
    best: 0,
    bestDistance: 0,
    bestSector: 1,
    runs: 0,
    daily: {},
    shipBest: {},
    shipGhosts: {},
    settings: { quality: 'auto', music: 0.8, sfx: 0.9, shake: true, fps: false, muted: false, ghosts: true, callsign: 'Runner', curves: true },
    missions: freshMissions(),
    garage: freshGarage(),
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const s: Save = { ...fresh, ...raw, settings: { ...fresh.settings, ...(raw.settings ?? {}) } };
    if (!s.missions?.active?.length) s.missions = freshMissions();
    s.garage = { ...fresh.garage, ...(raw.garage ?? {}), loadout: { ...fresh.garage.loadout, ...(raw.garage?.loadout ?? {}) } };
    s.garage.xp ??= {};
    for (const k of fresh.garage.owned) if (!s.garage.owned.includes(k)) s.garage.owned.push(k);
    // Saves from before ship classes: the old best run was flown with Delta rules, so it becomes the Delta best.
    if (s.bestGhost && !raw.shipGhosts) {
      s.shipGhosts = { delta: { ...s.bestGhost, cls: 'delta' } };
      s.shipBest = { delta: s.bestGhost.score };
    }
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

const clsOf = (g: GhostSave): ShipId => (g.cls && isShipId(g.cls) ? g.cls : 'delta');
const owns = (ship: ShipId) => save.garage.owned.includes(itemKey('ship', ship));

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const screens = ['title', 'hud', 'pause', 'over', 'settings', 'missions', 'garage', 'replay', 'replays', 'card'] as const;
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
  /** Hull shown. */
  ship: ShipId;
  /** Class rules the run was flown with; you fly the same class to race it. */
  cls: ShipId;
  name: string;
}

type RunMode = { kind: 'endless' } | { kind: 'daily'; key: string } | { kind: 'ghost'; rival: Rival };
type State = 'title' | 'garage' | 'run' | 'paused' | 'dying' | 'over' | 'replay';

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
/** The ship this run is flown in (your loadout, the daily's featured ship, or a rival's). */
let runShip: ShipId = 'delta';
/** A frame grabbed just after the crash, for the result card. */
let deathShot: string | null = null;
let lastCard: CardData | null = null;

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
  const seed = next.kind === 'daily' ? dailySeed(next.key) : next.kind === 'ghost' ? next.rival.seed : (Math.random() * 2 ** 31) | 0;
  // Dailies and ghost races lend you the ship they're flown in, so everyone races like for like.
  runShip = next.kind === 'daily' ? dailyShip(next.key) : next.kind === 'ghost' ? next.rival.cls : save.garage.loadout.ship;
  sim = new Sim(seed, null, runShip);
  bot = null;
  devBot = null;
  deathShot = null;

  // Who to race: a ghost race brings its rival; a daily run shows your earlier best from today.
  rival = null;
  if (next.kind === 'ghost') rival = next.rival;
  else if (next.kind === 'daily' && save.settings.ghosts && save.dailyGhost?.key === next.key && clsOf(save.dailyGhost) === runShip) {
    const log = decodeLog(save.dailyGhost.log);
    if (log) rival = { seed, log, score: save.dailyGhost.score, ship: save.dailyGhost.ship, cls: runShip, name: 'Your best' };
  }
  ghost = rival ? new Sim(seed, rival.log, rival.cls) : null;
  ghostWasAlive = true;
  view.reset();
  view.setLoadout({ ...save.garage.loadout, ship: runShip });
  view.setGhostShip(rival ? rival.ship : null);
  $('#ghost-tag').textContent = rival?.name ?? '';
  $('#hud').classList.toggle('has-ghost', !!rival);

  missionRun = new MissionRun(save.missions, next.kind === 'daily');
  const songStart = clock.start(ok && !!audio.ctx);
  if (ok) audio.startSong(songStart);
  lastCount = -1;
  state = 'run';
  const loaner = !owns(runShip);
  $('#hud').classList.toggle('daily', next.kind !== 'endless' || loaner);
  $('#mode-tag').textContent = [next.kind === 'daily' ? 'Daily run' : next.kind === 'ghost' ? 'Ghost race' : '', runShip !== save.garage.loadout.ship ? `${shipName(runShip)}${loaner ? ' (loaner)' : ''}` : '']
    .filter(Boolean)
    .join(' · ');
  $('#popups').innerHTML = '';
  $('#banner').className = 'banner';
  setupAbilityHud();
  // A quick reminder of the ship's trick while you're still learning it (or flying a loaner).
  const ability = ABILITY_NAME[runShip];
  if (ability && (loaner || (save.garage.xp[runShip] ?? 0) < MASTERY_XP[1])) {
    setTimeout(() => state === 'run' && toast(`${shipName(runShip)} · ${ability}`, abilityHint(runShip)), 400);
  }
  show('hud');
}

const touchUi = () => document.body.classList.contains('touch');
function abilityHint(ship: ShipId) {
  if (ship === 'manta') return touchUi() ? 'Swipe up again in mid-air to glide' : 'Press jump again in mid-air to glide';
  const how = touchUi() ? 'Tap the button' : 'E / Shift';
  return ship === 'twin' ? `${how} to blast the next block in your lane` : `${how} to phase through anything (once per sector)`;
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
  const ship = runShip;
  const run: GhostSave = { seed: sim.seed, log, score, distance: Math.floor(sim.distance), ship, cls: ship };

  let isBest = false;
  let shipBest = false;
  if (mode.kind !== 'daily') {
    isBest = score > save.best;
    if (isBest) {
      save.best = score;
      save.bestGhost = run;
    }
    shipBest = score > (save.shipBest[ship] ?? 0);
    if (shipBest) {
      save.shipBest[ship] = score;
      save.shipGhosts[ship] = run;
    }
  }
  save.bestDistance = Math.max(save.bestDistance, Math.floor(sim.distance));
  save.bestSector = Math.max(save.bestSector, sim.sector + 1);
  let dailyBest = false;
  let streakCredits = 0;
  let days = 0;
  if (mode.kind === 'daily') {
    const first = !(mode.key in save.daily);
    dailyBest = first ? score > 0 : score > save.daily[mode.key];
    if (first || dailyBest) save.daily[mode.key] = Math.max(score, save.daily[mode.key] ?? 0);
    if (dailyBest) save.dailyGhost = { ...run, key: mode.key };
    days = streak(save.daily);
    // The first daily of each day pays a streak bonus.
    if (first) {
      streakCredits = streakBonus(days);
      save.garage.credits += streakCredits;
    }
  }
  save.lastRun = { ...run, key: mode.kind === 'daily' ? mode.key : undefined };
  const report = settleRun();
  const mastery = addMastery(save.garage, ship, sim.distance);
  const unlocked = claimMilestones(save.garage, { bestSector: save.bestSector, rank: rankOf(save.missions) });
  persist();

  const modeLabel = mode.kind === 'daily' ? `Daily run · ${mode.key}` : mode.kind === 'ghost' ? 'Ghost race' : 'Endless run';
  lastCard = {
    mode: modeLabel,
    daily: mode.kind === 'daily',
    score,
    distance: sim.distance,
    sector: sim.sector,
    nearMisses: sim.nearMisses,
    bestCombo: sim.bestCombo,
    seconds: sim.t,
    shipName: shipName(ship),
    shipRole: SHIP_INFO[ship].role,
    callsign: save.settings.callsign || 'Runner',
    streak: days,
    shot: deathShot,
    link: ghostUrl(),
  };

  $('#over-score').textContent = fmt(score);
  const badge = isBest ? 'New best!' : dailyBest ? 'Daily best!' : shipBest ? `New ${shipName(ship)} best!` : '';
  $('#over-badge').textContent = badge;
  $('#over-badge').classList.toggle('show', !!badge);
  $('#over-mode').textContent = `${modeLabel} · ${shipName(ship)}`;
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
  const line = (cls: string, text: string) => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    rw.append(el);
  };
  if (streakCredits) line('reward-streak', `🔥 ${days}-day daily streak  +${streakCredits}`);
  line('reward-mastery', `${shipName(ship)} mastery +${fmt(mastery.after - mastery.before)} m`);
  for (let l = mastery.levelBefore + 1; l <= mastery.levelAfter; l++) line('reward-rank', `${shipName(ship)} mastery ${l}! ${MASTERY_REWARD[l]?.text ?? ''}`);
  for (const item of unlocked) line('reward-rank', `Unlocked: ${item.name}${item.kind === 'color' ? ' paint' : ''}`);
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
    else if (a === 'ability') sim.ability();
    else if (a === 'pause') pause();
  } else if (state === 'paused' && a === 'pause') resume();
  else if (state === 'title' && a === 'jump' && !document.querySelector('.modal.visible')) startRun(challenge ? ghostMode(challenge) : { kind: 'endless' });
  else if (state === 'over' && a === 'jump' && performance.now() - overAt > 800) retry();
  else if (state === 'garage' && a === 'pause') closeGarage();
  else if (state === 'garage' && garageTab === 'ship' && (a === 'left' || a === 'right')) stepGallery(a === 'left' ? -1 : 1);
  else if (state === 'replay' && rp) {
    if (a === 'jump') togglePlay();
    else if (a === 'left') replaySeek(rp.t - 5);
    else if (a === 'right') replaySeek(rp.t + 5);
    else if (a === 'pause') rp.photo ? setPhoto(false) : exitReplay();
  }
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
    case 'glide':
      audio.glide();
      break;
    case 'pulse':
      audio.pulse(!!e.obstacle);
      if (e.obstacle) popup(`Blasted +${Math.round(25 * sim.mult * sim.cls.score)}`, 'power overdrive');
      break;
    case 'phase':
      audio.phase();
      popup('Phase', 'power shield');
      break;
    case 'phaseThrough':
      audio.phaseThrough();
      break;
    case 'abilityReady':
      audio.abilityReady();
      bump($('#ability'));
      break;
    case 'death':
      audio.death();
      audio.stopSong();
      state = 'dying';
      dyingFor = 0;
      break;
  }
}

function bump(el: HTMLElement) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
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
    if (el) (el.querySelector('b') as HTMLElement).style.width = `${(left / sim.powerMax(k)) * 100}%`;
  }
  updateAbilityHud();

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

// Ability button: a charge ring that doubles as the touch control.
function setupAbilityHud() {
  const el = $('#ability');
  el.hidden = !sim.cls.ability;
  $('#ability-name').textContent = ABILITY_NAME[sim.ship] ?? '';
  $('#ability-key').textContent = touchUi() ? '' : 'E';
}

function updateAbilityHud() {
  if (!sim.cls.ability) return;
  const el = $('#ability');
  el.style.setProperty('--charge', String(sim.abilityCharge));
  el.classList.toggle('ready', sim.abilityCharge >= 1);
  el.classList.toggle('active', sim.phase > 0 || sim.firing);
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
  } else if (state === 'replay' && rp) {
    updateReplay(dt, time);
  } else if (state === 'paused') {
    view.render(sim, 0.0001, 'paused', time, ghost);
  } else {
    if (state === 'dying') {
      dyingFor += dt;
      // A beat after the crash, while the explosion is at its brightest.
      if (!deathShot && dyingFor > 0.25) deathShot = view.capture();
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
  return { kind: 'ghost', rival: { seed: g.seed, log, score: g.score, ship: g.ship, cls: g.cls, name: g.name } };
}

function renderTitle() {
  $('#best').textContent = fmt(save.best);
  const today = dateKey();
  const d = save.daily[today];
  const days = streak(save.daily);
  $('#daily-best').textContent = `${shipName(dailyShip(today))} day · ${today in save.daily ? `Today: ${fmt(d)}` : 'New seed'}${days > 1 ? ` · 🔥${days}` : ''}`;
  const rank = rankOf(save.missions);
  $('#rank-chip').textContent = `Rank ${rank} · ${rankName(rank)}`;
  $('#credit-chip').textContent = `${fmt(save.garage.credits)} credits`;
  const ship = save.garage.loadout.ship;
  const mine = save.shipGhosts[ship];
  const race = $<HTMLButtonElement>('#race');
  race.hidden = !mine;
  if (mine) $('#race-sub').textContent = `Beat your ${shipName(ship)} ${fmt(mine.score)}`;
  $('#ship-chip').textContent = `${shipName(ship)} · ${SHIP_INFO[ship].role}`;

  const card = $('#challenge');
  card.hidden = !challenge;
  if (challenge) {
    $('#challenge-name').textContent = `${challenge.name}${challenge.day ? ` · daily ${challenge.day}` : ''}`;
    $('#challenge-score').textContent = `${fmt(challenge.score)} pts · ${shipName(challenge.cls)}`;
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
/** The ship being looked at in the gallery (not necessarily the one equipped). */
let galleryShip: ShipId = 'delta';
const GALLERY: ShipId[] = ITEMS.filter((i) => i.kind === 'ship').map((i) => i.id as ShipId);

function openGarage() {
  state = 'garage';
  galleryShip = save.garage.loadout.ship;
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
  view.setLoadout(save.garage.loadout);
  renderTitle();
  show('title');
}

const progress = () => ({ bestSector: save.bestSector, rank: rankOf(save.missions) });
const ownsItem = (item: Item) => save.garage.owned.includes(itemKey(item.kind, item.id));

/** What the card or action button says about an item you don't own yet. */
function lockText(item: Item) {
  const ms = item.milestone ? milestoneText(item.milestone) : '';
  if (item.cost === null) return ms;
  return ms ? `${fmt(item.cost)} credits · or ${ms.toLowerCase()}` : `${fmt(item.cost)} credits`;
}

function stepGallery(dir: number) {
  const i = GALLERY.indexOf(galleryShip);
  galleryShip = GALLERY[(i + dir + GALLERY.length) % GALLERY.length];
  audio.click();
  renderGarage();
}

function renderGarage() {
  const g = save.garage;
  // New milestones can be met outside a run (e.g. ranking up), so check them whenever the garage opens.
  claimMilestones(g, progress());
  $('#gar-credits').textContent = `${fmt(g.credits)} credits`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.gar-tab')) b.classList.toggle('on', b.dataset.tab === garageTab);
  const ships = garageTab === 'ship';
  $('#garage').classList.toggle('ships', ships);
  view.setLoadout(ships ? { ...g.loadout, ship: galleryShip } : g.loadout);
  if (ships) renderGallery();

  const grid = $('#gar-items');
  grid.innerHTML = '';
  for (const item of ITEMS.filter((i) => i.kind === garageTab)) {
    const key = itemKey(item.kind, item.id);
    const owned = g.owned.includes(key);
    const equipped = g.loadout[item.kind] === item.id;
    const card = document.createElement('button');
    const selected = ships && item.id === galleryShip;
    card.className = `gar-item${equipped ? ' equipped' : ''}${owned ? ' owned' : ''}${selected ? ' selected' : ''}`;
    card.dataset.key = key;
    card.innerHTML = `<span class="gi-name"></span><span class="gi-desc"></span><span class="gi-state"></span>`;
    if (item.kind === 'color') {
      const dot = document.createElement('i');
      dot.className = 'gi-swatch';
      dot.style.background = item.swatch === undefined ? 'conic-gradient(#ff2bd6, #22e6ff, #7dff3a, #ffd23f, #ff2bd6)' : `#${item.swatch.toString(16).padStart(6, '0')}`;
      card.prepend(dot);
    }
    card.querySelector('.gi-name')!.textContent = item.name;
    card.querySelector('.gi-desc')!.textContent = ships ? SHIP_INFO[item.id as ShipId].role : item.desc;
    card.querySelector('.gi-state')!.textContent = equipped ? 'Equipped' : owned ? (ships ? `Mastery ${masteryLevel(g.xp[item.id as ShipId] ?? 0)}` : 'Equip') : ships ? 'Locked' : lockText(item);
    if (!owned && (item.cost === null || g.credits < item.cost) && !ships) card.classList.add('locked');
    if (!owned && ships) card.classList.add('dim');
    grid.append(card);
  }
}

/** The gallery's detail view for the selected ship: role, stats, trait, mastery and the unlock/equip button. */
function renderGallery() {
  const id = galleryShip;
  const info = SHIP_INFO[id];
  const item = ITEMS.find((i) => i.kind === 'ship' && i.id === id)!;
  const g = save.garage;
  $('#gd-name').textContent = item.name;
  $('#gd-role').textContent = info.role;
  $('#gd-index').textContent = `${GALLERY.indexOf(id) + 1} / ${GALLERY.length}`;

  const stats = $('#gd-stats');
  stats.innerHTML = '';
  for (const k of Object.keys(STAT_LABEL) as StatKey[]) {
    const row = document.createElement('div');
    row.className = 'gd-stat';
    const label = document.createElement('span');
    label.textContent = STAT_LABEL[k];
    const pips = document.createElement('i');
    for (let n = 1; n <= 5; n++) {
      const pip = document.createElement('b');
      if (n <= info.stats[k]) pip.className = 'on';
      pips.append(pip);
    }
    row.append(label, pips);
    stats.append(row);
  }

  const ability = ABILITY_NAME[id];
  $('#gd-perk-name').textContent = ability ?? 'Trait';
  $('#gd-perk').textContent = info.perk;
  $('#gd-key').textContent = info.active ? (touchUi() ? 'Tap the ability button' : 'E · Shift · gamepad X') : '';
  $('#gd-trade').textContent = info.tradeoff;

  const xp = g.xp[id] ?? 0;
  const lvl = masteryLevel(xp);
  $('#gd-mastery').textContent = `Mastery ${lvl}${lvl >= MASTERY_MAX ? ' · Mastered' : ''}`;
  $('#gd-xp').textContent = lvl >= MASTERY_MAX ? `${fmt(xp)} m flown` : `${fmt(xp)} / ${fmt(MASTERY_XP[lvl])} m · next: ${MASTERY_REWARD[lvl + 1]?.text ?? ''}`;
  $('#gd-xp-bar').style.width = `${masteryProgress(xp) * 100}%`;
  $('#gd-best').textContent = save.shipBest[id] ? `Best ${fmt(save.shipBest[id]!)}` : 'No runs yet';
  $('#gallery').classList.toggle('mastered', lvl >= MASTERY_MAX);

  const btn = $<HTMLButtonElement>('#gd-action');
  const owned = ownsItem(item);
  const equipped = g.loadout.ship === id;
  btn.disabled = equipped || (!owned && (item.cost === null || g.credits < item.cost));
  btn.textContent = equipped ? 'Equipped' : owned ? 'Equip' : item.cost !== null && g.credits >= item.cost ? `Unlock · ${fmt(item.cost)} credits` : 'Locked';
  const affordable = item.cost !== null && g.credits >= item.cost;
  $('#gd-lock').textContent = owned ? '' : affordable ? (item.milestone ? `Or free: ${milestoneText(item.milestone).toLowerCase()}` : '') : lockText(item);
}

function buyOrEquip(item: Item) {
  const g = save.garage;
  const key = itemKey(item.kind, item.id);
  if (!g.owned.includes(key)) {
    if (item.cost === null || g.credits < item.cost) return;
    g.credits -= item.cost;
    g.owned.push(key);
    audio.power();
  }
  (g.loadout as unknown as Record<string, string>)[item.kind] = item.id;
  persist();
  renderGarage();
}

$('#gar-items').addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.gar-item');
  if (!card) return;
  const [kind, id] = card.dataset.key!.split(':') as [ItemKind, string];
  // Ships are browsed first and equipped from the detail view; trails and colours equip straight away.
  if (kind === 'ship') {
    galleryShip = id as ShipId;
    renderGarage();
    return;
  }
  buyOrEquip(ITEMS.find((i) => i.kind === kind && i.id === id)!);
});
$('#gd-action').addEventListener('click', () => buyOrEquip(ITEMS.find((i) => i.kind === 'ship' && i.id === galleryShip)!));
$('#gd-prev').addEventListener('click', () => stepGallery(-1));
$('#gd-next').addEventListener('click', () => stepGallery(1));
for (const b of document.querySelectorAll<HTMLButtonElement>('.gar-tab')) {
  b.addEventListener('click', () => {
    garageTab = b.dataset.tab as ItemKind;
    renderGarage();
    placeGaragePreview();
  });
}

// ---------------------------------------------------------------- replay theatre

interface ReplaySrc {
  seed: number;
  log: InputEntry[];
  ship: ShipId;
  cls: ShipId;
  name: string;
  score: number;
}

const CAMS: CamMode[] = ['cinematic', 'chase', 'side', 'low', 'top', 'orbit'];
const CAM_LABEL: Record<CamMode, string> = { cinematic: 'Cinematic', chase: 'Chase', side: 'Side', low: 'Low', top: 'Top', orbit: 'Orbit' };

let rp: { src: ReplaySrc; sim: Sim; t: number; speed: number; paused: boolean; duration: number; photo: boolean; seeking: boolean } | null = null;

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function srcFrom(g: GhostSave | GhostLink, name: string): ReplaySrc | null {
  const log = decodeLog(g.log);
  if (!log) return null;
  const cls = 'name' in g ? g.cls : clsOf(g);
  return { seed: g.seed, log, ship: isShipId(g.ship) ? g.ship : 'delta', cls, name, score: g.score };
}

/** Opens a run in the replay theatre. The run is simulated once up front to find its length. */
function openReplay(src: ReplaySrc) {
  audio.init();
  audio.stopSong(false);
  const probe = new Sim(src.seed, src.log, src.cls);
  while (probe.alive && probe.t < 1800) {
    probe.step(probe.t + 5);
    probe.events.length = 0;
  }
  rp = { src, sim: new Sim(src.seed, src.log, src.cls), t: 0, speed: 1, paused: false, duration: probe.t + 2, photo: false, seeking: false };
  sim = rp.sim;
  ghost = null;
  view.reset();
  view.setGhostShip(null);
  view.setLoadout({ ...save.garage.loadout, ship: src.ship });
  view.cameraMode = 'cinematic';
  state = 'replay';
  $('#rp-name').textContent = src.name;
  $('#replay').classList.remove('photo');
  renderReplayControls();
  show('replay');
  syncReplayMusic();
}

function exitReplay() {
  if (!rp) return;
  audio.stopSong(false);
  rp = null;
  view.cameraMode = 'chase';
  view.setLoadout(save.garage.loadout);
  startAttract();
}

/** Jumps to time t. Going backwards re-simulates from the start (a few milliseconds). */
function replaySeek(t: number) {
  if (!rp) return;
  t = Math.max(0, Math.min(rp.duration, t));
  if (t < rp.sim.t) {
    rp.sim = new Sim(rp.src.seed, rp.src.log, rp.src.cls);
    sim = rp.sim;
    view.reset();
  }
  rp.sim.step(t);
  rp.sim.events.length = 0;
  rp.t = t;
  view.palette.set(rp.sim.sector, true);
  syncReplayMusic();
}

/** Music only makes sense at normal speed; it restarts aligned to the replay's song time. */
function syncReplayMusic() {
  if (!rp) return;
  if (!rp.paused && rp.speed === 1 && rp.sim.alive && !rp.seeking) {
    audio.startSong(audio.now - rp.t);
    audio.layer = rp.sim.sector;
  } else {
    audio.stopSong(false);
  }
}

function togglePlay() {
  if (!rp) return;
  if (rp.t >= rp.duration) replaySeek(0);
  rp.paused = !rp.paused;
  syncReplayMusic();
  renderReplayControls();
}

function setSpeed(v: number) {
  if (!rp) return;
  rp.speed = v;
  syncReplayMusic();
  renderReplayControls();
}

function cycleCamera() {
  const i = CAMS.indexOf(view.cameraMode);
  view.cameraMode = CAMS[(i + 1) % CAMS.length];
  renderReplayControls();
}

function setPhoto(on: boolean) {
  if (!rp) return;
  rp.photo = on;
  if (on && !rp.paused) togglePlay();
  $('#replay').classList.toggle('photo', on);
}

function renderReplayControls() {
  if (!rp) return;
  $('#rp-play').classList.toggle('playing', !rp.paused);
  $('#rp-play').setAttribute('aria-label', rp.paused ? 'Play' : 'Pause');
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === rp.speed);
  $('#rp-cam').textContent = `Camera: ${CAM_LABEL[view.cameraMode]}`;
}

function updateReplay(dt: number, time: number) {
  const r = rp!;
  if (!r.paused) {
    r.t = Math.min(r.duration, r.t + dt * r.speed);
    if (r.t >= r.duration) {
      r.paused = true;
      renderReplayControls();
    }
  }
  r.sim.step(r.t);
  const loud = r.speed === 1 && !r.paused;
  for (const e of r.sim.events) {
    view.handle(e, r.sim);
    if (!loud) continue;
    if (e.type === 'orb') audio.orb(e.combo);
    else if (e.type === 'nearMiss') audio.nearMiss();
    else if (e.type === 'jump') audio.jump();
    else if (e.type === 'power') audio.power();
    else if (e.type === 'smash') audio.smash();
    else if (e.type === 'shieldBreak') audio.shieldBreak();
    else if (e.type === 'pulse') audio.pulse(!!e.obstacle);
    else if (e.type === 'phase') audio.phase();
    else if (e.type === 'glide') audio.glide();
    else if (e.type === 'sector') {
      audio.sector();
      audio.layer = e.sector;
    } else if (e.type === 'death') {
      audio.death();
      audio.stopSong();
    }
  }
  r.sim.events.length = 0;

  if (!r.seeking) $<HTMLInputElement>('#rp-seek').value = String(Math.round((r.t / r.duration) * 1000));
  $('#rp-time').textContent = `${fmtTime(r.t)} / ${fmtTime(r.duration)}`;
  $('#rp-score').textContent = `${fmt(r.sim.score)} pts · ${fmt(r.sim.distance)} m`;

  const viewMode = !r.sim.alive ? 'dying' : r.paused ? 'paused' : 'run';
  view.render(r.sim, r.paused ? dt : dt * r.speed, viewMode, time);
}

function openReplays() {
  const list = $('#rp-list');
  list.innerHTML = '';
  const add = (title: string, sub: string, src: ReplaySrc | null) => {
    if (!src) return;
    const row = document.createElement('div');
    row.className = 'rp-row';
    const text = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = title;
    const span = document.createElement('span');
    span.textContent = sub;
    text.append(b, span);
    const go = document.createElement('button');
    go.className = 'btn primary small';
    go.textContent = 'Watch';
    go.addEventListener('click', () => openReplay(src));
    row.append(text, go);
    list.append(row);
  };
  if (save.lastRun) add('Last run', `${fmt(save.lastRun.score)} pts · ${fmt(save.lastRun.distance)} m`, srcFrom(save.lastRun, 'Last run'));
  if (save.bestGhost) add('Best run', `${fmt(save.bestGhost.score)} pts · ${fmt(save.bestGhost.distance)} m`, srcFrom(save.bestGhost, 'Best run'));
  if (save.dailyGhost?.key === dateKey()) add('Today’s daily best', `${fmt(save.dailyGhost.score)} pts`, srcFrom(save.dailyGhost, 'Daily best'));
  if (challenge) add(`${challenge.name}’s run`, `${fmt(challenge.score)} pts · shared ghost`, srcFrom(challenge, `${challenge.name}’s run`));
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'ms-note';
    empty.textContent = 'Finish a run and it will show up here.';
    list.append(empty);
  }
  show('title', 'replays');
}

// ---------------------------------------------------------------- settings + wiring

function applySettings() {
  const s = save.settings;
  audio.musicVolume = s.music;
  audio.sfxVolume = s.sfx;
  audio.muted = s.muted;
  audio.applyVolumes();
  view.shakeEnabled = s.shake;
  view.curves = s.curves;
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
  $<HTMLInputElement>('#set-curves').checked = s.curves;
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
  if (!btn || btn.id === 'ability') return;
  audio.init();
  audio.click();
  // Don't keep focus on buttons, or Space/arrows would press them mid-run.
  btn.blur();
});

$('#play').addEventListener('click', () => startRun({ kind: 'endless' }));
$('#daily').addEventListener('click', () => startRun({ kind: 'daily', key: dateKey() }));
$('#race').addEventListener('click', () => {
  const g = save.shipGhosts[save.garage.loadout.ship];
  if (!g) return;
  startRun({ kind: 'ghost', rival: { seed: g.seed, log: decodeLog(g.log) ?? [], score: g.score, ship: isShipId(g.ship) ? g.ship : 'delta', cls: clsOf(g), name: 'Your best' } });
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
$('#ability').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'run') sim.ability();
});
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
/** A link for others to race the run that just ended. */
function ghostUrl() {
  const link: GhostLink = {
    seed: sim.seed,
    log: encodeLog(sim.log),
    score: sim.score,
    name: save.settings.callsign || 'Runner',
    ship: runShip,
    cls: runShip,
    day: mode.kind === 'daily' ? mode.key : undefined,
  };
  return `${location.href.split('#')[0]}#ghost=${encodeGhostLink(link)}`;
}
$('#share').addEventListener('click', () => {
  void copyText(`Race my ghost in NEON GRID RUNNER: ${fmt(sim.score)} pts, ${fmt(sim.distance)} m in the ${shipName(runShip)}\n${ghostUrl()}`, $('#share'), 'Share ghost');
});

// Result card: an image of the run plus a short text version, for sharing anywhere.
let cardBlob: Blob | null = null;
let cardUrl = '';
async function openCard() {
  if (!lastCard) return;
  show('over', 'card');
  const img = $<HTMLImageElement>('#card-img');
  img.removeAttribute('src');
  $('#card').classList.add('loading');
  const cv = await drawCard(lastCard);
  cardBlob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (cardUrl) URL.revokeObjectURL(cardUrl);
  cardUrl = cardBlob ? URL.createObjectURL(cardBlob) : cv.toDataURL('image/png');
  img.src = cardUrl;
  $('#card').classList.remove('loading');
  $('#card-text').textContent = cardText(lastCard);
  const file = cardBlob && new File([cardBlob], 'neon-grid-runner.png', { type: 'image/png' });
  $('#card-share').hidden = !(file && navigator.canShare?.({ files: [file] }));
}
function saveCard() {
  const a = document.createElement('a');
  a.href = cardUrl;
  a.download = `neon-grid-runner-${lastCard?.daily ? 'daily-' : ''}${Date.now()}.png`;
  a.click();
}
$('#card-btn').addEventListener('click', () => void openCard());
$('#card-close').addEventListener('click', () => show('over'));
$('#card-save').addEventListener('click', saveCard);
$('#card-copy').addEventListener('click', () => lastCard && void copyText(cardText(lastCard), $('#card-copy'), 'Copy text'));
$('#card-share').addEventListener('click', async () => {
  if (!cardBlob || !lastCard) return;
  try {
    await navigator.share({ files: [new File([cardBlob], 'neon-grid-runner.png', { type: 'image/png' })], text: cardText(lastCard) });
  } catch {
    // Cancelled, or the share sheet failed: the save and copy buttons are still there.
  }
});
$('#watch').addEventListener('click', () => {
  const src = save.lastRun && srcFrom(save.lastRun, 'Last run');
  if (src) openReplay(src);
});
$('#replays-btn').addEventListener('click', openReplays);
$('#replays-close').addEventListener('click', () => show('title'));
$('#challenge-watch').addEventListener('click', () => {
  const src = challenge && srcFrom(challenge, `${challenge.name}’s run`);
  if (src) openReplay(src);
});
$('#rp-play').addEventListener('click', togglePlay);
$('#rp-exit').addEventListener('click', exitReplay);
$('#rp-cam').addEventListener('click', cycleCamera);
$('#rp-photo').addEventListener('click', () => setPhoto(true));
$('#rp-photo-exit').addEventListener('click', () => setPhoto(false));
$('#rp-photo-cam').addEventListener('click', cycleCamera);
$('#rp-save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = view.capture();
  a.download = `neon-grid-runner-${Date.now()}.png`;
  a.click();
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
const seek = $<HTMLInputElement>('#rp-seek');
seek.addEventListener('input', () => {
  if (!rp) return;
  rp.seeking = true;
  replaySeek((Number(seek.value) / 1000) * rp.duration);
});
seek.addEventListener('change', () => {
  if (!rp) return;
  rp.seeking = false;
  syncReplayMusic();
});
window.addEventListener('keydown', (e) => {
  if (state !== 'replay' || e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyC') cycleCamera();
  else if (e.code === 'KeyH') setPhoto(!rp?.photo);
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
for (const id of ['shake', 'fps', 'ghosts', 'curves'] as const) {
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
