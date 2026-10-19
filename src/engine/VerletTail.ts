/**
 * VerletTail — a 6-node Verlet integration chain for a cat's tail.
 *
 * Each step:
 *  1. Verlet integration with damping + gravity (world space, so the tail lags
 *     and swings naturally when the cat moves or turns).
 *  2. Shape (angular-stiffness) constraint: every node is pulled toward the rest
 *     direction of its segment — base angle + curl + an injected travelling sine
 *     wave. Happy cats get slow fluid S-curves; annoyed cats get a sharp, rapid
 *     whip concentrated at the tip.
 *  3. Follow-the-leader distance constraints with a hard per-joint bend limit.
 *  4. Optional ground collision so resting tails lie on the ledge instead of
 *     sinking into it — and dangle freely off its edge (Cat 2's sofa-crest loaf).
 *  5. Rate limits (v3): node speed relative to the tail root and the change of
 *     every joint's bend angle are clamped per step, and the wave / whip
 *     frequencies are capped, so the tail can never twitch frantically.
 *  6. Stillness (v3): `still` → 1 fades out wave and whip, kills the nodes'
 *     own velocity and, once fully still, locks the chain to its rest shape —
 *     a sitting, loafing, watching or sleeping cat's tail does not move at all.
 */
import { TAU, clamp, wrapAngle } from '../shared/math';

export interface TailNode {
  x: number;
  y: number;
  px: number;
  py: number;
}

export interface TailParams {
  /** World-space rest direction of the first segment (radians, canvas convention). */
  baseAngle: number;
  /** Extra rest angle added per segment (radians); sign follows the facing. */
  curl: number;
  /** Amplitude of the travelling wave (radians). */
  waveAmp: number;
  /** Wave frequency (Hz). */
  waveFreq: number;
  /** 0..1 rapid tip whipping (irritation). */
  whip: number;
  /** 0..1 how strongly the tail holds its rest shape. */
  stiffness: number;
  /** Gravity in px/s². */
  gravity: number;
  /** 0..1 velocity retention per step. */
  damping: number;
  /** Max bend between consecutive segments (radians). */
  maxBend: number;
  /** Mirror for left-facing cats (flips curl/wave handedness). */
  handedness: 1 | -1;
  /** 0..1 — 1 locks the tail completely still in its rest shape (seated / resting cats). */
  still?: number;
  /** Fastest a node may move relative to the tail root (px/s). */
  maxNodeSpeed?: number;
  /** Fastest any joint's bend angle may change (rad/s). */
  maxBendRate?: number;
}

/** Hard caps on how lively a tail can get (v3 rate limit). */
export const TAIL_MAX_NODE_SPEED = 420;
export const TAIL_MAX_BEND_RATE = 6.5;
export const TAIL_MAX_WAVE_FREQ = 1.1;
export const TAIL_MAX_WHIP_FREQ = 3.4;

export const DEFAULT_TAIL_PARAMS: TailParams = {
  baseAngle: -2.3,
  curl: 0.12,
  waveAmp: 0.18,
  waveFreq: 0.45,
  whip: 0,
  stiffness: 0.35,
  gravity: 380,
  damping: 0.96,
  maxBend: 1.15,
  handedness: 1,
};

export type GroundFn = (x: number) => number;

export class VerletTail {
  readonly nodes: TailNode[];
  segLen: number;
  phase = 0;
  private whipPhase = 0;
  /** Joint bend angles at the end of the previous step (NaN = unknown), for the bend-rate limit. */
  private bends: number[];
  /** True while the chain is locked to its rest shape. */
  locked = false;
  /** Anchor and base direction the lock was taken at. */
  private lockRef: { x: number; y: number; a: number; h: number } | null = null;

  constructor(count = 6, segLen = 10, x = 0, y = 0, angle = Math.PI) {
    this.segLen = segLen;
    this.nodes = [];
    for (let i = 0; i < count; i++) {
      const nx = x + Math.cos(angle) * segLen * i;
      const ny = y + Math.sin(angle) * segLen * i;
      this.nodes.push({ x: nx, y: ny, px: nx, py: ny });
    }
    this.bends = new Array(count).fill(NaN);
  }

  get count(): number {
    return this.nodes.length;
  }

  reset(x: number, y: number, angle: number): void {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.x = n.px = x + Math.cos(angle) * this.segLen * i;
      n.y = n.py = y + Math.sin(angle) * this.segLen * i;
    }
    this.bends.fill(NaN);
    this.locked = false;
    this.lockRef = null;
  }

  /** Translates the whole chain (used when the page scrolls under a sitting cat). */
  translate(dx: number, dy: number): void {
    if (this.lockRef) this.lockRef = { ...this.lockRef, x: this.lockRef.x + dx, y: this.lockRef.y + dy };
    for (const n of this.nodes) {
      n.x += dx;
      n.px += dx;
      n.y += dy;
      n.py += dy;
    }
  }

  /** Rest angle of segment i (1-based: segment from node i-1 to node i). `motion` scales the wave and whip (0 = none). */
  restAngle(i: number, p: TailParams, motion = 1): number {
    const n = this.nodes.length - 1;
    const f = i / n;
    const wave = p.waveAmp * Math.sin(this.phase * TAU - i * 0.85) * (0.35 + 0.65 * f);
    const whip = p.whip * 0.95 * Math.sin(this.whipPhase * TAU - i * 1.3) * f * f;
    return p.baseAngle + p.handedness * (p.curl * i + (wave + whip) * motion);
  }

  step(dt: number, anchorX: number, anchorY: number, p: TailParams, ground: GroundFn | null = null, radius = 3): void {
    const h = clamp(dt, 0, 1 / 20);
    const still = clamp(p.still ?? 0, 0, 1);
    const motion = 1 - still;
    if (still >= 0.995) {
      this.lockTo(anchorX, anchorY, p, ground, radius);
      return;
    }
    this.locked = false;
    this.phase += h * Math.min(p.waveFreq, TAIL_MAX_WAVE_FREQ) * motion;
    this.whipPhase += h * Math.min(1.6 + 2.2 * p.whip, TAIL_MAX_WHIP_FREQ) * motion;
    const maxSpeed = p.maxNodeSpeed ?? TAIL_MAX_NODE_SPEED;
    const maxBendRate = (p.maxBendRate ?? TAIL_MAX_BEND_RATE) * (1 - 0.7 * still);
    const damping = p.damping * (1 - 0.85 * still);
    const substeps = 2;
    const sh = h / substeps;
    const nodes = this.nodes;
    const n = nodes.length;
    for (let s = 0; s < substeps; s++) {
      const root = nodes[0];
      root.px = root.x;
      root.py = root.y;
      root.x = anchorX;
      root.y = anchorY;
      const rootVX = root.x - root.px;
      const rootVY = root.y - root.py;

      // 1. Integrate.
      for (let i = 1; i < n; i++) {
        const nd = nodes[i];
        const vx = (nd.x - nd.px) * damping;
        const vy = (nd.y - nd.py) * damping;
        nd.px = nd.x;
        nd.py = nd.y;
        nd.x += vx;
        nd.y += vy + p.gravity * sh * sh;
      }

      // 2. Angular stiffness toward the rest shape.
      for (let i = 1; i < n; i++) {
        const prev = nodes[i - 1];
        const nd = nodes[i];
        const a = this.restAngle(i, p, motion);
        const tx = prev.x + Math.cos(a) * this.segLen;
        const ty = prev.y + Math.sin(a) * this.segLen;
        const k = clamp(p.stiffness * (1 - 0.5 * (i / n)), 0, 1) * (sh * 60);
        const kk = clamp(k + (1 - k) * still * 0.6, 0, 1);
        nd.x += (tx - nd.x) * kk;
        nd.y += (ty - nd.y) * kk;
      }

      // 3. Distance constraints — Jakobsen relaxation (root pinned, momentum-preserving).
      for (let iter = 0; iter < 6; iter++) {
        for (let i = 1; i < n; i++) {
          const a = nodes[i - 1];
          const b = nodes[i];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-6;
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
      }

      // 4. Ground collision.
      if (ground) {
        for (let i = 1; i < n; i++) {
          const nd = nodes[i];
          const gy = ground(nd.x) - radius;
          if (nd.y > gy) {
            nd.y = gy;
            nd.py = nd.y + (nd.py - nd.y) * 0.2;
            nd.px += (nd.x - nd.px) * 0.35;
          }
        }
      }

      // 5. Exact lengths + bend limit by projection. Previous positions are shifted by the
      //    same correction so the projection never injects velocity (keeps dangling tails calm).
      //    Each joint's bend relative to its parent segment (and the first segment's own
      //    direction) may only change by maxBendRate·h per step.
      const maxDelta = maxBendRate * sh;
      let parentAngle = 0;
      for (let i = 1; i < n; i++) {
        const prev = nodes[i - 1];
        const nd = nodes[i];
        const raw = Math.atan2(nd.y - prev.y, nd.x - prev.x);
        let bend = i === 1 ? raw : wrapAngle(raw - parentAngle);
        if (i > 1 && Math.abs(bend) > p.maxBend) bend = Math.sign(bend) * p.maxBend;
        const before = this.bends[i];
        if (Number.isFinite(before)) bend = before + clamp(wrapAngle(bend - before), -maxDelta, maxDelta);
        this.bends[i] = i === 1 ? wrapAngle(bend) : bend;
        const a = i === 1 ? bend : parentAngle + bend;
        const tx = prev.x + Math.cos(a) * this.segLen;
        const ty = prev.y + Math.sin(a) * this.segLen;
        nd.px += tx - nd.x;
        nd.py += ty - nd.y;
        nd.x = tx;
        nd.y = ty;
        parentAngle = a;
      }
      // 6. Node speed relative to the root (the tail as a whole may move as fast as the cat).
      const lim = maxSpeed * sh;
      for (let i = 1; i < n; i++) {
        const nd = nodes[i];
        const rvx = nd.x - nd.px - rootVX;
        const rvy = nd.y - nd.py - rootVY;
        const sp = Math.hypot(rvx, rvy);
        if (sp > lim) {
          const k = lim / sp;
          nd.px = nd.x - rootVX - rvx * k;
          nd.py = nd.y - rootVY - rvy * k;
        }
      }
      if (ground) {
        for (let i = 1; i < n; i++) {
          const nd = nodes[i];
          const gy = ground(nd.x) - radius;
          if (nd.y > gy) {
            nd.py += gy - nd.y;
            nd.y = gy;
          }
        }
      }
    }
  }

  /**
   * Fully still: the chain settles into its rest shape (no wave, no whip, no
   * velocity), resting on the ground where it touches it, and then stays locked
   * there — with the anchor and base angle unchanged the result is identical
   * frame after frame. A tail that is not quite there yet eases in over a few
   * frames instead of snapping.
   */
  private lockTo(anchorX: number, anchorY: number, p: TailParams, ground: GroundFn | null, radius: number): void {
    const nodes = this.nodes;
    // Locked and the body hasn't really moved (just breathing): leave every node exactly where it is.
    const L = this.lockRef;
    if (this.locked && L && Math.hypot(anchorX - L.x, anchorY - L.y) < 1.5 && Math.abs(wrapAngle(p.baseAngle - L.a)) < 0.03 && L.h === p.handedness) return;
    this.lockRef = { x: anchorX, y: anchorY, a: p.baseAngle, h: p.handedness };
    const root = nodes[0];
    root.x = root.px = anchorX;
    root.y = root.py = anchorY;
    const target = this.restShape(anchorX, anchorY, p, ground, radius);
    let dev = 0;
    for (let i = 1; i < nodes.length; i++) dev = Math.max(dev, Math.hypot(nodes[i].x - target[i].x, nodes[i].y - target[i].y));
    const k = this.locked || dev < 1.2 ? 1 : 0.35;
    let parentAngle = 0;
    for (let i = 1; i < nodes.length; i++) {
      const nd = nodes[i];
      nd.x = nd.px = nd.x + (target[i].x - nd.x) * k;
      nd.y = nd.py = nd.y + (target[i].y - nd.y) * k;
      const prev = nodes[i - 1];
      const world = Math.atan2(nd.y - prev.y, nd.x - prev.x);
      this.bends[i] = i === 1 ? world : wrapAngle(world - parentAngle);
      parentAngle = world;
    }
    this.locked = k === 1;
  }

  /** The tail's rest shape for these parameters (index 0 = the anchor). */
  restShape(anchorX: number, anchorY: number, p: TailParams, ground: GroundFn | null = null, radius = 3): { x: number; y: number }[] {
    const out = [{ x: anchorX, y: anchorY }];
    let parentAngle = p.baseAngle;
    for (let i = 1; i < this.nodes.length; i++) {
      const prev = out[i - 1];
      let bend = wrapAngle(this.restAngle(i, p, 0) - parentAngle);
      if (i > 1 && Math.abs(bend) > p.maxBend) bend = Math.sign(bend) * p.maxBend;
      const a = parentAngle + bend;
      let x = prev.x + Math.cos(a) * this.segLen;
      let y = prev.y + Math.sin(a) * this.segLen;
      if (ground) {
        const gy = ground(x) - radius;
        if (y > gy) {
          // Lie along the ground instead of sinking: keep the segment length, flatten it.
          y = Math.max(prev.y, gy);
          const dy = y - prev.y;
          const dx = Math.sqrt(Math.max(0, this.segLen * this.segLen - dy * dy));
          x = prev.x + (Math.cos(a) >= 0 ? dx : -dx);
        }
      }
      out.push({ x, y });
      parentAngle = Math.atan2(y - prev.y, x - prev.x);
    }
    return out;
  }

  /** Current tip position. */
  tip(): { x: number; y: number } {
    const t = this.nodes[this.nodes.length - 1];
    return { x: t.x, y: t.y };
  }

  /** Length of each segment as currently simulated (for tests / debugging). */
  segmentLengths(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.nodes.length; i++) {
      out.push(Math.hypot(this.nodes[i].x - this.nodes[i - 1].x, this.nodes[i].y - this.nodes[i - 1].y));
    }
    return out;
  }
}
