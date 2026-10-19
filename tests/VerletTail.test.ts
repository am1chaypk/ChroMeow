import { describe, expect, it } from 'vitest';
import { DEFAULT_TAIL_PARAMS, VerletTail, type TailParams } from '../src/engine/VerletTail';
import { wrapAngle } from '../src/shared/math';

const limp: TailParams = { ...DEFAULT_TAIL_PARAMS, stiffness: 0, waveAmp: 0, whip: 0, curl: 0, gravity: 900, damping: 0.9 };

function settle(tail: VerletTail, p: TailParams, steps = 600, ax = 0, ay = 0, ground: ((x: number) => number) | null = null): void {
  for (let i = 0; i < steps; i++) tail.step(1 / 60, ax, ay, p, ground);
}

describe('VerletTail', () => {
  it('has six nodes and keeps every segment at its rest length', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    expect(tail.count).toBe(6);
    settle(tail, { ...DEFAULT_TAIL_PARAMS, whip: 1, waveAmp: 0.6 }, 240);
    for (const l of tail.segmentLengths()) expect(l).toBeCloseTo(10, 3);
  });

  it('pins the root node to the anchor', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    settle(tail, DEFAULT_TAIL_PARAMS, 30, 120, 45);
    expect(tail.nodes[0].x).toBeCloseTo(120, 6);
    expect(tail.nodes[0].y).toBeCloseTo(45, 6);
  });

  it('hangs straight down under gravity when it has no stiffness', () => {
    const tail = new VerletTail(6, 10, 0, 0, 0);
    settle(tail, limp, 900);
    const tip = tail.tip();
    expect(Math.abs(tip.x)).toBeLessThan(1.5);
    expect(tip.y).toBeGreaterThan(48);
  });

  it('holds its rest shape (angular stiffness) without gravity', () => {
    const tail = new VerletTail(6, 10, 0, 0, 0);
    const p: TailParams = { ...DEFAULT_TAIL_PARAMS, baseAngle: -Math.PI / 2, curl: 0, waveAmp: 0, whip: 0, stiffness: 0.9, gravity: 0 };
    settle(tail, p, 600);
    const tip = tail.tip();
    expect(Math.abs(tip.x)).toBeLessThan(2);
    expect(tip.y).toBeLessThan(-46);
  });

  it('respects the per-joint bend limit', () => {
    const tail = new VerletTail(6, 10, 0, 0, 0);
    const p: TailParams = { ...DEFAULT_TAIL_PARAMS, curl: 2.5, stiffness: 1, gravity: 0, maxBend: 0.6, waveAmp: 0 };
    settle(tail, p, 300);
    const n = tail.nodes;
    for (let i = 2; i < n.length; i++) {
      const a1 = Math.atan2(n[i - 1].y - n[i - 2].y, n[i - 1].x - n[i - 2].x);
      const a2 = Math.atan2(n[i].y - n[i - 1].y, n[i].x - n[i - 1].x);
      expect(Math.abs(wrapAngle(a2 - a1))).toBeLessThanOrEqual(0.6 + 1e-6);
    }
  });

  it('rests on the ledge instead of sinking into it, and dangles past its edge', () => {
    const tail = new VerletTail(6, 10, 0, -5, Math.PI);
    // Ledge spans x ∈ [-25, 100] at y = 0; anchor just above it.
    const ground = (x: number) => (x >= -25 && x <= 100 ? 0 : Infinity);
    settle(tail, { ...limp, baseAngle: Math.PI }, 900, 0, -5, ground);
    for (const nd of tail.nodes) if (nd.x >= -25) expect(nd.y).toBeLessThanOrEqual(0.01);
    expect(tail.tip().y).toBeGreaterThan(5); // the part beyond the edge hangs down
  });

  it('whips harder at the tip when annoyed', () => {
    const calm = new VerletTail(6, 10, 0, 0, Math.PI);
    const angry = new VerletTail(6, 10, 0, 0, Math.PI);
    const base: TailParams = { ...DEFAULT_TAIL_PARAMS, gravity: 0, stiffness: 0.6, waveAmp: 0.05 };
    let calmTravel = 0;
    let angryTravel = 0;
    for (let i = 0; i < 240; i++) {
      const c0 = calm.tip();
      const a0 = angry.tip();
      calm.step(1 / 60, 0, 0, { ...base, whip: 0 });
      angry.step(1 / 60, 0, 0, { ...base, whip: 1 });
      calmTravel += Math.hypot(calm.tip().x - c0.x, calm.tip().y - c0.y);
      angryTravel += Math.hypot(angry.tip().x - a0.x, angry.tip().y - a0.y);
    }
    expect(angryTravel).toBeGreaterThan(calmTravel * 2);
  });

  it('translates rigidly with the page when scrolled', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    const before = tail.nodes.map((n) => ({ ...n }));
    tail.translate(0, 37);
    tail.nodes.forEach((n, i) => {
      expect(n.y - before[i].y).toBeCloseTo(37, 9);
      expect(n.py - before[i].py).toBeCloseTo(37, 9);
    });
  });
});

describe('VerletTail v3: rate limits & still seated tail', () => {
  const lively: TailParams = { ...DEFAULT_TAIL_PARAMS, waveAmp: 0.9, waveFreq: 6, whip: 1, stiffness: 0.8 };

  it('caps how fast any joint bend can change, even when asked to whip frantically', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    settle(tail, lively, 60);
    const bends = () => {
      const out: number[] = [];
      for (let i = 2; i < tail.count; i++) {
        const a0 = Math.atan2(tail.nodes[i - 1].y - tail.nodes[i - 2].y, tail.nodes[i - 1].x - tail.nodes[i - 2].x);
        const a1 = Math.atan2(tail.nodes[i].y - tail.nodes[i - 1].y, tail.nodes[i].x - tail.nodes[i - 1].x);
        out.push(wrapAngle(a1 - a0));
      }
      return out;
    };
    let prev = bends();
    let maxRate = 0;
    for (let i = 0; i < 240; i++) {
      tail.step(1 / 60, 0, 0, lively);
      const cur = bends();
      cur.forEach((b, k) => (maxRate = Math.max(maxRate, Math.abs(wrapAngle(b - prev[k])) * 60)));
      prev = cur;
    }
    expect(maxRate).toBeLessThanOrEqual(6.5 + 0.05);
  });

  it('caps node speed relative to the root, but lets the whole tail move with a fast cat', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    settle(tail, { ...lively, maxNodeSpeed: 200 }, 60);
    let x = 0;
    let maxRel = 0;
    for (let i = 0; i < 120; i++) {
      const before = tail.nodes.map((n) => ({ x: n.x, y: n.y }));
      x += 20; // the cat sprints at 1200 px/s
      tail.step(1 / 60, x, 0, { ...lively, maxNodeSpeed: 200 });
      for (let k = 1; k < tail.count; k++) {
        const vx = (tail.nodes[k].x - before[k].x) * 60 - 1200;
        const vy = (tail.nodes[k].y - before[k].y) * 60;
        maxRel = Math.max(maxRel, Math.hypot(vx, vy));
      }
    }
    // The tail keeps up with the body (it isn't left behind)…
    expect(tail.tip().x).toBeGreaterThan(x - 60);
    // …and never flails faster than the cap relative to it (plus what the constraints add).
    expect(maxRel).toBeLessThan(200 * 2.2);
  });

  it('a seated / resting tail settles and then does not move at all', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    settle(tail, lively, 120);
    const still: TailParams = { ...lively, still: 1 };
    for (let i = 0; i < 30; i++) tail.step(1 / 60, 0, 0, still);
    expect(tail.locked).toBe(true);
    const snap = tail.nodes.map((n) => [n.x, n.y, n.px, n.py]);
    // Breathing nudges the anchor a fraction of a pixel: the tail still doesn't budge.
    for (let i = 0; i < 300; i++) tail.step(1 / 60, Math.sin(i * 0.1) * 0.3, Math.cos(i * 0.1) * 0.3, still);
    tail.nodes.forEach((n, i) => {
      expect(n.x).toBe(snap[i][0]);
      expect(n.y).toBe(snap[i][1]);
      expect(n.px).toBe(n.x); // zero velocity
    });
    // It sits in its rest shape (no wave, no whip).
    const rest = tail.restShape(0, 0, still);
    tail.nodes.forEach((n, i) => {
      expect(n.x).toBeCloseTo(rest[i].x, 6);
      expect(n.y).toBeCloseTo(rest[i].y, 6);
    });
    // When the cat gets up, the tail comes back to life.
    for (let i = 0; i < 60; i++) tail.step(1 / 60, 0, 0, lively);
    expect(tail.locked).toBe(false);
  });

  it('eases into the still pose instead of snapping', () => {
    const tail = new VerletTail(6, 10, 0, 0, Math.PI);
    settle(tail, lively, 90);
    const still: TailParams = { ...lively, still: 1 };
    let maxJump = 0;
    for (let i = 0; i < 40; i++) {
      const before = tail.nodes.map((n) => ({ x: n.x, y: n.y }));
      tail.step(1 / 60, 0, 0, still);
      tail.nodes.forEach((n, k) => (maxJump = Math.max(maxJump, Math.hypot(n.x - before[k].x, n.y - before[k].y))));
    }
    expect(maxJump).toBeLessThan(25);
    expect(tail.locked).toBe(true);
  });
});
