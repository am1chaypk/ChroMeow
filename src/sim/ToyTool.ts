/**
 * ToyTool — the hand-held toys, driven by the left mouse button. DOM-free, so
 * the page overlay (PlayMode) and the Cat Studio preview share the same feel:
 *
 *  • Treat: every left click drops a treat right there.
 *  • Laser: the dot shines while the button is held and follows the pointer.
 *  • Ball:  press to pick it up, drag, and let go to throw — the throw speed is
 *           the hand's speed over the last few dozen milliseconds.
 *  • Feather wand (v3.1): the rod follows the pointer the whole time it is in
 *           hand (no button needed); the string and feather dangle from its tip.
 */
import type { ToolKind } from '../shared/types';
import type { World } from './World';

export type { ToolKind };
export const TOOL_KINDS: readonly ToolKind[] = ['treat', 'laser', 'ball', 'feather_wand'];

export interface MotionSample {
  x: number;
  y: number;
  t: number;
}

type Sample = MotionSample;

/** Velocity (px/s) of the most recent ~90 ms of pointer motion. */
export function releaseVelocity(samples: readonly Sample[], window = 0.09): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    first = samples[i];
    if (last.t - samples[i].t >= window) break;
  }
  const dt = last.t - first.t;
  if (dt <= 1e-3) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

export class ToyTool {
  kind: ToolKind | null = null;
  private pressed = false;
  private samples: Sample[] = [];

  constructor(private readonly world: () => World | null) {}

  get active(): boolean {
    return this.kind !== null;
  }

  get holding(): boolean {
    return this.pressed;
  }

  select(kind: ToolKind | null): void {
    if (this.pressed) this.cancel();
    if (this.kind === 'feather_wand' && kind !== 'feather_wand') this.world()?.wandOff();
    this.kind = kind;
  }

  /** Pointer moved over the page (button up or down): the feather wand follows it. */
  hover(x: number, y: number): void {
    if (this.kind === 'feather_wand') this.world()?.wandAt(x, y);
  }

  down(x: number, y: number, t: number): void {
    const w = this.world();
    if (!w || !this.kind) return;
    this.pressed = true;
    this.samples = [{ x, y, t }];
    if (this.kind === 'treat') w.placeTreat(x, y);
    else if (this.kind === 'laser') w.laserAt(x, y, true);
    else if (this.kind === 'feather_wand') w.wandAt(x, y);
    else w.holdBall(x, y);
  }

  move(x: number, y: number, t: number): void {
    if (!this.pressed) return;
    const w = this.world();
    if (!w) return;
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 0.25) this.samples.shift();
    if (this.kind === 'laser') w.laserAt(x, y, true);
    else if (this.kind === 'ball') w.holdBall(x, y);
    else if (this.kind === 'feather_wand') w.wandAt(x, y);
  }

  up(x: number, y: number, t: number): void {
    if (!this.pressed) return;
    this.move(x, y, t);
    this.pressed = false;
    const w = this.world();
    if (!w) return;
    if (this.kind === 'laser') w.laserAt(x, y, false);
    else if (this.kind === 'ball') {
      let { vx, vy } = releaseVelocity(this.samples);
      // A simple click (no flick) still gives the ball a playful little hop.
      if (Math.hypot(vx, vy) < 60) {
        vx = (Math.random() - 0.5) * 160;
        vy = -220;
      }
      w.throwBall(vx, vy);
    }
    this.samples = [];
  }

  /** Lets go of anything held (pointer lost, tool switched, play mode ended). */
  cancel(): void {
    if (!this.pressed) return;
    this.pressed = false;
    const w = this.world();
    const last = this.samples[this.samples.length - 1];
    if (w && last) {
      if (this.kind === 'laser') w.laserAt(last.x, last.y, false);
      else if (this.kind === 'ball') w.throwBall(0, 0);
    }
    this.samples = [];
  }
}
