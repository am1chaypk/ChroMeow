/**
 * VerletRope — a string pinned at one end (node 0): Verlet integration with
 * gravity and air drag, several passes of distance-constraint relaxation (it
 * resists stretching but can bunch up), and one-way collisions with the page's
 * ledges and the viewport floor, where it rests and slides with friction instead
 * of clipping through. Used by the feather wand (v3.1).
 */
import { clamp, type Vec2 } from '../shared/math';
import { platformBelow, type Platform, type WorldBounds } from './Physics';


export interface RopeNode {
  x: number;
  y: number;
  px: number;
  py: number;
  /** Resting on a ledge / the floor this step. */
  grounded: boolean;
}

export interface RopeOptions {
  /** Gravity (px/s²). */
  gravity: number;
  /** Velocity kept per 60 Hz frame while in the air (air drag). */
  damping: number;
  /** Distance-constraint relaxation passes per sub-step. */
  iterations: number;
  /** Collision radius of a node (px). */
  radius: number;
}

/** 0.45 px/frame² of gravity at 60 Hz, 0.97 air drag per frame, 7 relaxation passes. */
export const DEFAULT_ROPE: RopeOptions = { gravity: 0.45 * 60 * 60, damping: 0.97, iterations: 7, radius: 1.5 };

/**
 * A Verlet rope pinned at one end (node 0). Gravity, damping, distance
 * constraints, one-way collisions with ledges (it rests on top of them, slides
 * with friction and falls off their edges) and the viewport floor.
 */
export class StringRope {
  readonly nodes: RopeNode[] = [];
  segLen: number;
  readonly opts: RopeOptions;

  /** Laid out from (x, y) in direction `angle` (default: hanging straight down). */
  constructor(x: number, y: number, count: number, segLen: number, angle = Math.PI / 2, opts: Partial<RopeOptions> = {}) {
    this.segLen = segLen;
    this.opts = { ...DEFAULT_ROPE, ...opts };
    for (let i = 0; i < count; i++) {
      const nx = x + Math.cos(angle) * i * segLen;
      const ny = y + Math.sin(angle) * i * segLen;
      this.nodes.push({ x: nx, y: ny, px: nx, py: ny, grounded: false });
    }
  }

  reset(x: number, y: number): void {
    this.nodes.forEach((n, i) => {
      n.x = n.px = x;
      n.y = n.py = y + i * this.segLen;
      n.grounded = false;
    });
  }

  translate(dx: number, dy: number): void {
    for (const n of this.nodes) {
      n.x += dx;
      n.px += dx;
      n.y += dy;
      n.py += dy;
    }
  }

  step(dt: number, ax: number, ay: number, platforms: readonly Platform[], bounds: WorldBounds): void {
    const h = clamp(dt, 0, 1 / 20);
    if (h <= 0) return;
    const sub = 3;
    const sh = h / sub;
    const nodes = this.nodes;
    const { gravity, iterations } = this.opts;
    const airDamp = Math.pow(this.opts.damping, sh * 60);
    for (let s = 0; s < sub; s++) {
      const root = nodes[0];
      root.px = root.x;
      root.py = root.y;
      root.x = ax;
      root.y = ay;
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        const damp = n.grounded ? 0.82 : airDamp;
        const vx = (n.x - n.px) * damp;
        const vy = (n.y - n.py) * damp;
        n.px = n.x;
        n.py = n.y;
        n.x += vx;
        n.y += vy + gravity * sh * sh;
      }
      for (let iter = 0; iter < iterations; iter++) {
        for (let i = 1; i < nodes.length; i++) {
          const a = nodes[i - 1];
          const b = nodes[i];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-6;
          // A string only resists stretching, never compression (it can bunch up on the floor).
          if (d <= this.segLen) continue;
          const diff = (d - this.segLen) / d;
          if (i === 1) {
            b.x -= dx * diff;
            b.y -= dy * diff;
          } else {
            a.x += dx * diff * 0.5;
            a.y += dy * diff * 0.5;
            b.x -= dx * diff * 0.5;
            b.y -= dy * diff * 0.5;
          }
        }
        this.collide(platforms, bounds, iter === iterations - 1);
      }
    }
  }

  /** Keeps nodes on top of the ledge / floor below them; on the last pass also applies friction and sets `grounded`. */
  private collide(platforms: readonly Platform[], bounds: WorldBounds, last: boolean): void {
    for (let i = 1; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.x = clamp(n.x, 1, bounds.width - 1);
      // Only ledges the node was above a moment ago stop it (one-way, like the cats' ledges).
      const support = platformBelow(n.x, Math.min(n.py, n.y) - 2, platforms, 1);
      const gy = (support ? support.y : bounds.height - 2) - this.opts.radius;
      if (n.y > gy) n.y = gy;
      if (!last) continue;
      n.grounded = n.y >= gy - 0.05;
      if (n.grounded) {
        // Friction: a dragged string slides, it doesn't skate; resting contact kills the bounce.
        n.px = n.x - (n.x - n.px) * 0.55;
        n.py = n.y;
      }
    }
  }

  tip(): Vec2 {
    const t = this.nodes[this.nodes.length - 1];
    return { x: t.x, y: t.y };
  }

  /** The lowest-hanging free point (what a cat paws at when the string dangles). */
  lowestFree(): Vec2 | null {
    let best: RopeNode | null = null;
    for (const n of this.nodes) if (!n.grounded && (!best || n.y > best.y)) best = n;
    return best ? { x: best.x, y: best.y } : null;
  }

  /** How far the string hangs freely below its anchor (0 when it all lies on the ground). */
  hangDepth(): number {
    const a = this.nodes[0];
    let d = 0;
    for (const n of this.nodes) if (!n.grounded) d = Math.max(d, n.y - a.y);
    return d;
  }

  /** Mean speed of the nodes (px/s at the given dt) — a swinging or wriggling string is irresistible. */
  speed(dt: number): number {
    if (dt <= 0) return 0;
    let s = 0;
    for (const n of this.nodes) s += Math.hypot(n.x - n.px, n.y - n.py);
    return s / this.nodes.length / (dt / 3);
  }

  /** Nearest node index to a point within `r` px, or −1. */
  nearest(x: number, y: number, r: number): number {
    let best = -1;
    let bd = r;
    this.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** A paw swat: kicks the nodes around index `i` with velocity (vx, vy) px/s. */
  bat(i: number, vx: number, vy: number, dt = 1 / 60): void {
    const sub = dt / 3;
    this.nodes.forEach((n, k) => {
      if (k === 0) return;
      const w = Math.max(0, 1 - Math.abs(k - i) / 3);
      if (w <= 0) return;
      n.px = n.x - vx * sub * w;
      n.py = n.y - vy * sub * w;
      n.grounded = false;
    });
  }

  /** Total length of the rope as simulated (for tests). */
  length(): number {
    let l = 0;
    for (let i = 1; i < this.nodes.length; i++) l += Math.hypot(this.nodes[i].x - this.nodes[i - 1].x, this.nodes[i].y - this.nodes[i - 1].y);
    return l;
  }
}
