/**
 * FelineFSM — executes state requests as natural transition chains.
 *
 *  request(target): plans the shortest biological chain from the current state
 *    and walks it, dwelling in each intermediate state long enough for the pose
 *    to blend (or for a timed state such as a stretch or yawn to finish).
 *  force(state): physics interrupts (startle, fall, land) — still validated.
 *  restore(state): cross-tab hydration (collapses transient states to calm ones).
 */
import type { CatState } from '../shared/catStates';
import { Rng } from '../shared/rng';
import { STATE_META, canTransition, findPath, restorableState } from './States';

export type TransitionListener = (from: CatState, to: CatState) => void;

export class FelineFSM {
  current: CatState;
  previous: CatState;
  /** Seconds in the current state. */
  time = 0;
  /** Seconds this state should last (Infinity = until told otherwise). */
  duration = Infinity;
  /** Remaining chain toward `target`. */
  queue: CatState[] = [];
  target: CatState | null = null;
  /** For RETURN states (paw tuck, judgmental squint). */
  private returnTo: CatState | null = null;
  private pendingTarget: CatState | null = null;
  private listeners: TransitionListener[] = [];
  private rng: Rng;

  constructor(initial: CatState = 'IDLE_SIT', seed: number | string = 1) {
    this.current = initial;
    this.previous = initial;
    this.rng = new Rng(seed);
  }

  onTransition(fn: TransitionListener): void {
    this.listeners.push(fn);
  }

  get progress(): number {
    return Number.isFinite(this.duration) && this.duration > 0 ? Math.min(1, this.time / this.duration) : 0;
  }

  get settled(): boolean {
    return this.queue.length === 0 && this.pendingTarget === null && (this.target === null || this.current === this.target);
  }

  /** True once the requested target has been reached and is showing. */
  isAt(state: CatState): boolean {
    return this.current === state && this.queue.length === 0;
  }

  private enter(next: CatState, intermediate: boolean): void {
    const from = this.current;
    this.previous = from;
    this.current = next;
    this.time = 0;
    const meta = STATE_META[next];
    if (meta.duration) this.duration = this.rng.range(meta.duration[0], meta.duration[1]);
    else this.duration = intermediate ? meta.passThrough : Infinity;
    if (meta.next === 'RETURN' && from !== next) this.returnTo = STATE_META[from].next === 'RETURN' ? this.returnTo : from;
    for (const l of this.listeners) l(from, next);
  }

  /**
   * Ask for `target`. Returns false if no natural chain exists. When the current
   * state is a committed (non-interruptible) one, the request is deferred until
   * it completes.
   */
  request(target: CatState): boolean {
    if (target === this.current && this.queue.length === 0) {
      this.target = target;
      this.pendingTarget = null;
      if (!STATE_META[target].duration) this.duration = Infinity;
      return true;
    }
    if (this.target === target && this.queue.length > 0) return true;
    const meta = STATE_META[this.current];
    if (!meta.interruptible && this.time < this.duration) {
      if (!findPath(meta.next && meta.next !== 'RETURN' ? meta.next : this.current, target) && !findPath(this.current, target)) return false;
      this.pendingTarget = target;
      return true;
    }
    return this.plan(target);
  }

  private plan(target: CatState): boolean {
    const path = findPath(this.current, target);
    if (!path) return false;
    this.target = target;
    this.pendingTarget = null;
    this.queue = path.slice(1);
    if (this.queue.length > 0) {
      const next = this.queue.shift() as CatState;
      this.enter(next, this.queue.length > 0);
    }
    return true;
  }

  /** Physics-driven interrupt; returns false if the edge is not allowed. */
  force(state: CatState): boolean {
    if (state === this.current) return true;
    if (!canTransition(this.current, state)) return false;
    this.queue = [];
    this.pendingTarget = null;
    this.target = state;
    this.enter(state, false);
    return true;
  }

  /** Cross-tab hydration: jump straight into a (calm) state without a chain. */
  restore(state: CatState): void {
    const s = restorableState(state);
    this.queue = [];
    this.pendingTarget = null;
    this.target = s;
    this.previous = s;
    this.current = s;
    this.time = 0;
    this.duration = Infinity;
  }

  /** Extends or shortens the current timed state (e.g. a longer butt-wiggle before a pounce). */
  setDuration(seconds: number): void {
    this.duration = seconds;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.time < this.duration) return;
    // Current state finished.
    if (this.pendingTarget) {
      const pt = this.pendingTarget;
      this.pendingTarget = null;
      const meta = STATE_META[this.current];
      // Committed states hand over to their natural successor first.
      if (meta.next && meta.next !== 'RETURN' && !canTransition(this.current, pt)) {
        this.enter(meta.next, true);
        this.pendingTarget = pt;
        return;
      }
      if (!this.plan(pt)) this.advanceDefault();
      return;
    }
    if (this.queue.length > 0) {
      const next = this.queue.shift() as CatState;
      this.enter(next, this.queue.length > 0);
      return;
    }
    if (Number.isFinite(this.duration)) this.advanceDefault();
  }

  private advanceDefault(): void {
    const meta = STATE_META[this.current];
    if (!meta.duration) {
      this.duration = Infinity;
      return;
    }
    let next: CatState | null = null;
    if (meta.next === 'RETURN') {
      // A brief reaction returns to exactly the posture it interrupted.
      const back = this.returnTo;
      this.returnTo = null;
      if (back && back !== this.current) {
        this.enter(back, false);
        this.target = back;
        return;
      }
      next = this.current === 'JUDGMENTAL_AIRPLANE_SQUINT' ? 'CURLED_SLEEP' : 'IDLE_SIT';
    } else next = meta.next;
    if (next && next !== this.current) {
      if (canTransition(this.current, next)) this.enter(next, false);
      else {
        const path = findPath(this.current, next);
        if (path && path.length > 1) {
          this.queue = path.slice(2);
          this.enter(path[1], this.queue.length > 0);
        } else this.duration = Infinity;
      }
      this.target = next;
    } else this.duration = Infinity;
  }
}
