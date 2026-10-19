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
}

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

  constructor(count = 6, segLen = 10, x = 0, y = 0, angle = Math.PI) {
    this.segLen = segLen;
    this.nodes = [];
    for (let i = 0; i < count; i++) {
      const nx = x + Math.cos(angle) * segLen * i;
      const ny = y + Math.sin(angle) * segLen * i;
      this.nodes.push({ x: nx, y: ny, px: nx, py: ny });
    }
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
  }

  /** Translates the whole chain (used when the page scrolls under a sitting cat). */
  translate(dx: number, dy: number): void {
    for (const n of this.nodes) {
      n.x += dx;
      n.px += dx;
      n.y += dy;
      n.py += dy;
    }
  }

  /** Rest angle of segment i (1-based: segment from node i-1 to node i). */
  restAngle(i: number, p: TailParams): number {
    const n = this.nodes.length - 1;
    const f = i / n;
    const wave = p.waveAmp * Math.sin(this.phase * TAU - i * 0.85) * (0.35 + 0.65 * f);
    const whip = p.whip * 0.95 * Math.sin(this.whipPhase * TAU - i * 1.3) * f * f;
    return p.baseAngle + p.handedness * (p.curl * i + wave + whip);
  }

  step(dt: number, anchorX: number, anchorY: number, p: TailParams, ground: GroundFn | null = null, radius = 3): void {
    const h = clamp(dt, 0, 1 / 20);
    this.phase += h * p.waveFreq;
    this.whipPhase += h * (2.6 + 4.5 * p.whip);
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

      // 1. Integrate.
      for (let i = 1; i < n; i++) {
        const nd = nodes[i];
        const vx = (nd.x - nd.px) * p.damping;
        const vy = (nd.y - nd.py) * p.damping;
        nd.px = nd.x;
        nd.py = nd.y;
        nd.x += vx;
        nd.y += vy + p.gravity * sh * sh;
      }

      // 2. Angular stiffness toward the rest shape.
      for (let i = 1; i < n; i++) {
        const prev = nodes[i - 1];
        const nd = nodes[i];
        const a = this.restAngle(i, p);
        const tx = prev.x + Math.cos(a) * this.segLen;
        const ty = prev.y + Math.sin(a) * this.segLen;
        const k = clamp(p.stiffness * (1 - 0.5 * (i / n)), 0, 1) * (sh * 60);
        const kk = clamp(k, 0, 1);
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
      let parentAngle = Math.atan2(nodes[1].y - nodes[0].y, nodes[1].x - nodes[0].x);
      for (let i = 1; i < n; i++) {
        const prev = nodes[i - 1];
        const nd = nodes[i];
        let a = Math.atan2(nd.y - prev.y, nd.x - prev.x);
        if (i > 1) {
          const delta = wrapAngle(a - parentAngle);
          if (Math.abs(delta) > p.maxBend) a = parentAngle + Math.sign(delta) * p.maxBend;
        }
        const tx = prev.x + Math.cos(a) * this.segLen;
        const ty = prev.y + Math.sin(a) * this.segLen;
        nd.px += tx - nd.x;
        nd.py += ty - nd.y;
        nd.x = tx;
        nd.y = ty;
        parentAngle = a;
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
