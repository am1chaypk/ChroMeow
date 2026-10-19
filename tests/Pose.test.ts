import { describe, expect, it } from 'vitest';
import { PoseSpring, makePose } from '../src/engine/Pose';

describe('PoseSpring (critically damped pose blending)', () => {
  it('eases in: the first frames move less than an exponential follow would', () => {
    const cur = makePose({ headY: 0 });
    const target = makePose({ headY: -20 });
    const spring = new PoseSpring();
    spring.step(cur, target, 8, 1 / 60);
    const expoFirst = -20 * (1 - Math.exp(-8 / 60));
    expect(cur.headY).toBeLessThan(0);
    expect(Math.abs(cur.headY)).toBeLessThan(Math.abs(expoFirst));
  });

  it('converges without overshooting', () => {
    const cur = makePose({ hipX: 0 });
    const target = makePose({ hipX: 30 });
    const spring = new PoseSpring();
    let max = -Infinity;
    for (let i = 0; i < 240; i++) {
      spring.step(cur, target, 6, 1 / 60);
      max = Math.max(max, cur.hipX);
    }
    expect(max).toBeLessThanOrEqual(30 + 1e-9);
    expect(cur.hipX).toBeCloseTo(30, 2);
  });

  it('keeps velocity when the target changes mid-motion (no kink)', () => {
    const cur = makePose({ shY: 0 });
    const spring = new PoseSpring();
    const a = makePose({ shY: -10 });
    const b = makePose({ shY: -14 });
    const ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      spring.step(cur, i < 10 ? a : b, 6, 1 / 60);
      ys.push(cur.shY);
    }
    const v9 = ys[9] - ys[8];
    const v10 = ys[10] - ys[9];
    // Frame-to-frame speed changes smoothly across the target switch.
    expect(Math.abs(v10 - v9)).toBeLessThan(Math.abs(v9) * 0.6);
  });

  it('blends angles along the shortest arc', () => {
    const cur = makePose({ headRot: 3.0 });
    const target = makePose({ headRot: -3.0 });
    const spring = new PoseSpring();
    for (let i = 0; i < 120; i++) spring.step(cur, target, 8, 1 / 60);
    // 3.0 → −3.0 the short way passes through ±π, not through 0.
    expect(Math.abs(Math.cos(cur.headRot) - Math.cos(-3.0))).toBeLessThan(0.01);
  });

  it('pinned keys follow exactly', () => {
    const cur = makePose();
    const spring = new PoseSpring();
    spring.pin(cur, 'fnX', 12.5);
    expect(cur.fnX).toBe(12.5);
  });
});
