// Synthesised synthwave soundtrack + sound effects. The AudioContext clock is also the game's
// master clock while running, so obstacles land exactly on the beat (and pausing just suspends it).
import { BEAT, INTRO_BEATS } from '../core/config.ts';

const STEP = BEAT / 4;
const LOOKAHEAD = 0.14;
// i–VI–III–VII in A minor, two bars per chord.
const CHORDS = [
  { root: 45, notes: [57, 60, 64] },
  { root: 41, notes: [53, 57, 60] },
  { root: 48, notes: [55, 60, 64] },
  { root: 43, notes: [55, 59, 62] },
];
const ARP = [0, 1, 2, 1, 0, 2, 1, 2];
const BASS = [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 7, 12];
const PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88, 91];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  ctx: AudioContext | null = null;
  musicVolume = 0.8;
  sfxVolume = 0.9;
  muted = false;

  private master!: GainNode;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private duck!: GainNode;
  private sfxBus!: GainNode;
  private delaySend!: GainNode;
  private noise!: AudioBuffer;
  private timer = 0;
  private songStart = 0;
  private step = 0;
  private playing = false;
  layer = 0;

  /** Must be called from a user gesture. Returns false if Web Audio is unavailable. */
  init(): boolean {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return true;
    }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master = ctx.createGain();
      this.master.connect(comp).connect(ctx.destination);

      this.musicFilter = ctx.createBiquadFilter();
      this.musicFilter.type = 'lowpass';
      this.musicFilter.frequency.value = 18000;
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.musicFilter).connect(this.master);
      // Bass and pads pass through `duck`, which dips on every kick (sidechain pumping).
      this.duck = ctx.createGain();
      this.duck.connect(this.musicBus);

      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);

      const delay = ctx.createDelay(1);
      delay.delayTime.value = STEP * 3;
      const fb = ctx.createGain();
      fb.gain.value = 0.38;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 3000;
      this.delaySend = ctx.createGain();
      this.delaySend.gain.value = 0.35;
      this.delaySend.connect(delay).connect(damp).connect(fb).connect(delay);
      damp.connect(this.musicBus);

      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.applyVolumes();
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  get now() {
    return this.ctx?.currentTime ?? 0;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.02);
    this.musicBus.gain.setTargetAtTime(this.musicVolume * 0.55, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.sfxVolume * 0.8, t, 0.02);
  }

  suspend() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }

  // ---------------------------------------------------------------- song

  /** Starts the soundtrack with beat 0 at context time `at`. */
  startSong(at: number) {
    if (!this.ctx) return;
    this.stopTimer();
    this.songStart = at;
    this.step = 0;
    this.playing = true;
    this.layer = 0;
    const t = this.ctx.currentTime;
    this.musicFilter.frequency.cancelScheduledValues(t);
    this.musicFilter.frequency.setValueAtTime(18000, t);
    this.applyVolumes();
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  /** Death: the music dives through a closing filter and fades. */
  stopSong(dive = true) {
    if (!this.ctx) return;
    this.playing = false;
    this.stopTimer();
    const t = this.ctx.currentTime;
    if (dive) {
      this.musicFilter.frequency.cancelScheduledValues(t);
      this.musicFilter.frequency.setValueAtTime(this.musicFilter.frequency.value, t);
      this.musicFilter.frequency.exponentialRampToValueAtTime(70, t + 1.6);
      this.musicBus.gain.setTargetAtTime(0, t + 0.6, 0.5);
    } else {
      this.musicBus.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  private schedule() {
    if (!this.ctx || !this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.songStart + this.step * STEP < horizon) {
      this.playStep(this.step, this.songStart + this.step * STEP);
      this.step++;
    }
  }

  private playStep(n: number, t: number) {
    if (t < this.ctx!.currentTime - 0.05) return;
    const beat = Math.floor(n / 4);
    const s16 = n % 16;
    const bar = Math.floor(n / 16);
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
    const intro = beat < INTRO_BEATS;
    const L = intro ? -1 : this.layer;

    if (s16 % 4 === 0) this.kick(t);
    if (!intro) {
      if (s16 === 4 || s16 === 12) this.snare(t);
      if (s16 % 2 === 0 || L >= 1) this.hat(t, s16 === 14 && L >= 1);
      if (L >= 3 && (s16 === 4 || s16 === 12)) this.clap(t);
    }
    const note = chord.root + BASS[s16] + (L >= 3 && s16 % 8 === 7 ? 12 : 0);
    if (L >= 0 || s16 % 4 === 0) this.bass(t, note);
    if (n % 32 === 0) this.pad(t, chord.notes, STEP * 32);
    if (L >= 2 && s16 % (L >= 4 ? 1 : 2) === 0) {
      const i = ARP[(n / (L >= 4 ? 1 : 2)) % ARP.length | 0];
      this.lead(t, chord.notes[i] + 12 + (bar % 4 === 3 && s16 > 8 ? 12 : 0));
    }
  }

  // ---------------------------------------------------------------- instruments

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private osc(type: OscillatorType, freq: number, t: number, dur: number, dest: AudioNode, detune = 0) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private noiseSrc(t: number, dur: number, dest: AudioNode) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    return src;
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(this.musicBus);
    this.env(g, t, 1, 0.002, 0.42);
    const o = this.osc('sine', 165, t, 0.45, g);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    // Sidechain: duck bass and pads under the kick.
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setValueAtTime(0.25, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.22);
  }

  private snare(t: number) {
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    bp.connect(g).connect(this.musicBus);
    this.env(g, t, 0.55, 0.002, 0.2);
    this.noiseSrc(t, 0.25, bp);
    const tg = ctx.createGain();
    tg.connect(this.musicBus);
    this.env(tg, t, 0.3, 0.002, 0.1);
    this.osc('triangle', 190, t, 0.12, tg);
  }

  private clap(t: number) {
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    const g = ctx.createGain();
    bp.connect(g).connect(this.musicBus);
    g.connect(this.delaySend);
    for (let i = 0; i < 3; i++) {
      g.gain.setValueAtTime(0.35, t + i * 0.012);
      g.gain.exponentialRampToValueAtTime(0.01, t + i * 0.012 + 0.01);
    }
    g.gain.setValueAtTime(0.3, t + 0.036);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    this.noiseSrc(t, 0.22, bp);
  }

  private hat(t: number, open: boolean) {
    const ctx = this.ctx!;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    hp.connect(g).connect(this.musicBus);
    this.env(g, t, open ? 0.16 : 0.1, 0.001, open ? 0.24 : 0.035);
    this.noiseSrc(t, open ? 0.3 : 0.06, hp);
  }

  private bass(t: number, midi: number) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(220, t);
    f.frequency.exponentialRampToValueAtTime(1300 + this.layer * 250, t + 0.012);
    f.frequency.exponentialRampToValueAtTime(240, t + STEP * 0.95);
    const g = ctx.createGain();
    f.connect(g).connect(this.duck);
    this.env(g, t, 0.32, 0.004, STEP * 0.95);
    this.osc('sawtooth', mtof(midi), t, STEP, f);
    this.osc('square', mtof(midi - 12), t, STEP, f);
  }

  private pad(t: number, notes: number[], dur: number) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1800, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    f.connect(g).connect(this.duck);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.8);
    g.gain.setValueAtTime(0.07, t + dur - 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3);
    for (const n of notes) for (const d of [-9, 9]) this.osc('sawtooth', mtof(n), t, dur + 0.4, f, d);
  }

  private lead(t: number, midi: number) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.18);
    const g = ctx.createGain();
    f.connect(g);
    g.connect(this.musicBus);
    g.connect(this.delaySend);
    this.env(g, t, 0.09, 0.003, 0.22);
    this.osc('square', mtof(midi), t, 0.25, f);
    this.osc('sawtooth', mtof(midi), t, 0.25, f, 7);
  }

  // ---------------------------------------------------------------- sfx

  private sfxTone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const g = this.ctx.createGain();
    g.connect(this.sfxBus);
    this.env(g, t, vol, 0.004, dur);
    const o = this.osc(type, f0, t, dur + 0.02, g);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  }

  private sfxNoise(dur: number, vol: number, from: number, to: number, type: BiquadFilterType = 'lowpass', delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    f.connect(g).connect(this.sfxBus);
    this.env(g, t, vol, 0.005, dur);
    this.noiseSrc(t, dur, f);
  }

  jump() {
    this.sfxTone('sine', 320, 760, 0.14, 0.22);
    this.sfxNoise(0.12, 0.08, 2000, 6000, 'bandpass');
  }
  land() {
    this.sfxTone('sine', 140, 60, 0.09, 0.18);
  }
  slide() {
    this.sfxNoise(0.25, 0.18, 3500, 400);
  }
  lane(dir: number) {
    this.sfxTone('triangle', dir > 0 ? 1500 : 1300, dir > 0 ? 1700 : 1100, 0.04, 0.05);
  }
  orb(combo: number) {
    const f = mtof(PENTA[combo % PENTA.length] + (combo >= PENTA.length ? 12 : 0));
    this.sfxTone('triangle', f, f, 0.16, 0.13);
    this.sfxTone('sine', f * 2, f * 2, 0.09, 0.05, 0.03);
  }
  power() {
    [0, 4, 7, 12, 16].forEach((s, i) => this.sfxTone('square', mtof(72 + s), mtof(72 + s), 0.1, 0.07, i * 0.045));
    this.sfxNoise(0.4, 0.1, 800, 9000, 'bandpass');
  }
  nearMiss() {
    this.sfxNoise(0.22, 0.22, 600, 5000, 'bandpass');
    this.sfxTone('sine', 1760, 2200, 0.12, 0.07, 0.04);
  }
  mult() {
    this.sfxTone('sine', 1320, 1320, 0.1, 0.07);
    this.sfxTone('sine', 1980, 1980, 0.14, 0.06, 0.06);
  }
  smash() {
    this.sfxNoise(0.35, 0.4, 4000, 200);
    this.sfxTone('square', 220, 60, 0.18, 0.12);
  }
  shieldBreak() {
    for (let i = 0; i < 6; i++) this.sfxTone('sine', 1800 + Math.random() * 2400, 900, 0.35, 0.05, i * 0.015);
    this.sfxNoise(0.5, 0.35, 8000, 600, 'highpass');
  }
  death() {
    this.sfxNoise(1.6, 0.9, 3000, 40);
    this.sfxTone('sine', 160, 28, 1.2, 0.6);
    this.sfxTone('sawtooth', 90, 30, 0.6, 0.18);
    for (let i = 0; i < 6; i++) this.sfxNoise(0.07, 0.2, 6000, 1500, 'bandpass', 0.1 + Math.random() * 0.6);
  }
  countdown(go: boolean) {
    this.sfxTone('square', go ? 1760 : 880, go ? 1760 : 880, go ? 0.32 : 0.12, 0.09);
  }
  sector() {
    this.sfxNoise(1.2, 0.25, 300, 12000, 'bandpass');
    [57, 64, 69, 76].forEach((m) => this.sfxTone('sawtooth', mtof(m), mtof(m), 0.9, 0.04, 1));
  }
  click() {
    this.sfxTone('triangle', 900, 700, 0.05, 0.06);
  }
  /** Interceptor's cannon: a laser zap, with a crunch when it hits something. */
  pulse(hit: boolean) {
    this.sfxTone('sawtooth', 2400, 180, 0.22, 0.12);
    this.sfxTone('square', 1200, 90, 0.16, 0.06);
    if (hit) this.sfxNoise(0.3, 0.32, 5000, 300, 'lowpass', 0.05);
  }
  /** Phantom's phase: a swelling, detuned shimmer. */
  phase() {
    [0, 7, 12].forEach((s, i) => this.sfxTone('sine', mtof(76 + s), mtof(64 + s), 0.6, 0.06, i * 0.02));
    this.sfxNoise(0.7, 0.12, 9000, 1200, 'highpass');
  }
  phaseThrough() {
    this.sfxTone('sine', 2600, 1300, 0.18, 0.06);
  }
  glide() {
    this.sfxNoise(0.5, 0.12, 900, 2600, 'bandpass');
    this.sfxTone('triangle', 520, 660, 0.3, 0.06);
  }
  abilityReady() {
    this.sfxTone('triangle', mtof(84), mtof(84), 0.08, 0.07);
    this.sfxTone('triangle', mtof(91), mtof(91), 0.14, 0.07, 0.07);
  }
}

export const audio = new AudioEngine();
