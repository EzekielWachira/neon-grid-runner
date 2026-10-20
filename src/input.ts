// Keyboard, touch swipes and gamepads, all mapped to the same six actions.
export type Action = 'left' | 'right' | 'jump' | 'slide' | 'ability' | 'pause';

const KEYS: Record<string, Action> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump',
  ArrowDown: 'slide',
  KeyS: 'slide',
  KeyE: 'ability',
  KeyF: 'ability',
  ShiftLeft: 'ability',
  ShiftRight: 'ability',
  Escape: 'pause',
  KeyP: 'pause',
};

const SWIPE = 28;

export class Input {
  private handler: (a: Action) => void;
  private touch: { id: number; x: number; y: number; t: number; fired: boolean } | null = null;
  private padPrev: boolean[] = [];
  private axisPrev = 0;
  private vAxisPrev = 0;
  enabled = true;

  constructor(target: HTMLElement, handler: (a: Action) => void) {
    this.handler = handler;
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !this.enabled) return;
      // Let sliders and dropdowns keep their own arrow keys.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const a = KEYS[e.code];
      if (!a) return;
      e.preventDefault();
      this.handler(a);
    });

    // Swipes fire as soon as they pass the threshold, so they feel instant; a quick tap jumps.
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !this.enabled) return;
      this.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), fired: false };
    });
    target.addEventListener('pointermove', (e) => {
      const t = this.touch;
      if (!t || t.id !== e.pointerId || t.fired) return;
      const dx = e.clientX - t.x;
      const dy = e.clientY - t.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return;
      t.fired = true;
      if (Math.abs(dx) > Math.abs(dy)) this.handler(dx < 0 ? 'left' : 'right');
      else this.handler(dy < 0 ? 'jump' : 'slide');
    });
    const end = (e: PointerEvent) => {
      const t = this.touch;
      if (!t || t.id !== e.pointerId) return;
      if (!t.fired && performance.now() - t.t < 220) this.handler('jump');
      this.touch = null;
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', () => (this.touch = null));
  }

  /** Polls gamepads (call once per frame). D-pad/stick to steer, A jump, B slide, X/Y/bumpers ability, Start pause. */
  poll() {
    if (!this.enabled || !navigator.getGamepads) return;
    const pad = [...navigator.getGamepads()].find((p) => p && p.connected);
    if (!pad) return;
    const map: [number, Action][] = [
      [14, 'left'],
      [15, 'right'],
      [0, 'jump'],
      [12, 'jump'],
      [1, 'slide'],
      [13, 'slide'],
      [2, 'ability'],
      [3, 'ability'],
      [4, 'ability'],
      [5, 'ability'],
      [9, 'pause'],
    ];
    for (const [i, a] of map) {
      const down = !!pad.buttons[i]?.pressed;
      if (down && !this.padPrev[i]) this.handler(a);
      this.padPrev[i] = down;
    }
    const ax = pad.axes[0] ?? 0;
    const dir = ax < -0.6 ? -1 : ax > 0.6 ? 1 : 0;
    if (dir && dir !== this.axisPrev) this.handler(dir < 0 ? 'left' : 'right');
    this.axisPrev = dir;
    const ay = pad.axes[1] ?? 0;
    const vdir = ay < -0.7 ? -1 : ay > 0.7 ? 1 : 0;
    if (vdir && vdir !== this.vAxisPrev) this.handler(vdir < 0 ? 'jump' : 'slide');
    this.vAxisPrev = vdir;
  }
}
