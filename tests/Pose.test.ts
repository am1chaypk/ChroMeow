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

describe('neck bone limits (v3: no stretched necks in sleep poses)', () => {
  it('clamps the shoulder → head vector length and the head–torso joint angle', async () => {
    const { clampNeck, NECK_MAX, NECK_ANGLE_MIN, NECK_ANGLE_MAX } = await import('../src/engine/ArticulatedCatRenderer');
    const S = { x: 0, y: 0 };
    const d = { x: 1, y: 0 };
    const far = clampNeck(S, { x: 60, y: -30 }, d);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(NECK_MAX, 6);
    const ok = clampNeck(S, { x: 12, y: -10 }, d);
    expect(ok).toEqual({ x: 12, y: -10 });
    // Bent too far back over the spine: clamped to the joint limit.
    const back = clampNeck(S, { x: -15, y: -1 }, d);
    const ang = Math.atan2(back.y, back.x);
    expect(ang).toBeGreaterThanOrEqual(NECK_ANGLE_MIN - 1e-9);
    expect(ang).toBeLessThanOrEqual(NECK_ANGLE_MAX + 1e-9);
  });

  it('keeps every pose — sleeping and cuddling ones included — within the neck limit', async () => {
    const { ArticulatedCatRenderer, NECK_MAX } = await import('../src/engine/ArticulatedCatRenderer');
    const { computePose, DEFAULT_POSE_CONTEXT } = await import('../src/engine/PoseLibrary');
    const { ALL_STATES } = await import('../src/shared/catStates');
    const { createAnna } = await import('../src/shared/presets');
    const r = new ArticulatedCatRenderer(createAnna());
    for (const state of ALL_STATES) {
      for (const role of [0, 1] as const) {
        for (const partner of [
          [-40, 90],
          [-18, 40],
          [NaN, NaN],
        ]) {
          const pose = computePose(state, { ...DEFAULT_POSE_CONTEXT, t: 1.2, progress: 0.5, role, partnerTopY: partner[0], partnerDX: partner[1] });
          const sk = r.skeleton(pose, { x: 0, y: 0, flip: 1, scale: 1 }, 1);
          const sh = { x: pose.shX, y: pose.shY };
          const len = Math.hypot(sk.head.x - sh.x, sk.head.y - sh.y);
          expect(len).toBeLessThanOrEqual(NECK_MAX + 1);
        }
      }
    }
    // The cuddle poses that used to stretch now reach with the shoulders, not the neck.
    for (const state of ['CUDDLE_SLEEP', 'PILLOW_STACK_CUDDLE'] as const) {
      const pose = computePose(state, { ...DEFAULT_POSE_CONTEXT, role: 1, partnerTopY: -40, partnerDX: 90 });
      expect(Math.hypot(pose.headX - pose.shX, pose.headY - pose.shY) * 0.86).toBeLessThan(NECK_MAX);
    }
  });
});
