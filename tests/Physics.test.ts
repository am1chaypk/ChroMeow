import { describe, expect, it } from 'vitest';
import { GRAVITY, MAX_JUMP_UP, MAX_THROW_DOWN, MAX_THROW_UP, MAX_THROW_VX, PENDULUM_MAX_ANGLE, buildPlatforms, clampThrow, fallStep, findLanding, isScrollViolent, makeFloor, mergePlatforms, pendulumStep, pendulumTarget, solveJump, trajectoryAt, type Platform } from '../src/engine/Physics';
import { planHop, planRoute } from '../src/engine/Navigator';

const bounds = { width: 1200, height: 800 };

function ledge(id: string, xMin: number, xMax: number, y: number): Platform {
  return { id, kind: 'dom', xMin, xMax, y, warm: 0, narrow: false, tag: 'div', elementRef: null };
}

describe('jump planning', () => {
  it('lands exactly on a target above', () => {
    const plan = solveJump(100, 780, 340, 420);
    expect(plan).not.toBeNull();
    const end = trajectoryAt(plan!, plan!.duration);
    expect(end.x).toBeCloseTo(340, 6);
    expect(end.y).toBeCloseTo(420, 6);
    expect(plan!.apexY).toBeLessThan(420);
    expect(end.vy).toBeGreaterThan(0); // descending onto the ledge (one-way platform)
  });

  it('lands exactly on a target below', () => {
    const plan = solveJump(500, 200, 600, 780)!;
    const end = trajectoryAt(plan, plan.duration);
    expect(end.x).toBeCloseTo(600, 6);
    expect(end.y).toBeCloseTo(780, 6);
  });

  it('follows a true parabola under g = 980 px/s²', () => {
    const plan = solveJump(0, 500, 200, 500)!;
    const a = trajectoryAt(plan, 0.1);
    const b = trajectoryAt(plan, 0.2);
    const c = trajectoryAt(plan, 0.3);
    expect(c.y - 2 * b.y + a.y).toBeCloseTo(GRAVITY * 0.01, 6);
  });

  it('refuses jumps beyond a cat’s athletic envelope', () => {
    expect(solveJump(100, 780, 120, 780 - MAX_JUMP_UP - 50)).toBeNull();
  });
});

describe('one-way landings', () => {
  it('lands on the highest ledge crossed while descending', () => {
    const ps = [ledge('a', 0, 300, 400), ledge('b', 0, 300, 450), makeFloor(bounds)];
    expect(findLanding(390, 460, 100, ps)?.id).toBe('a');
    expect(findLanding(410, 460, 100, ps)?.id).toBe('b');
  });

  it('passes up through ledges (no landing while rising) and ignores ledges to the side', () => {
    const ps = [ledge('a', 0, 300, 400)];
    expect(findLanding(460, 390, 100, ps)).toBeNull();
    expect(findLanding(390, 410, 500, ps)).toBeNull();
  });
});

describe('scroll physics', () => {
  it('detects violent scrolling that knocks a cat off its ledge', () => {
    expect(isScrollViolent(80, 1 / 60)).toBe(true);
    expect(isScrollViolent(8, 1 / 60)).toBe(false);
  });
});

describe('DOM platform list', () => {
  it('filters tiny, off-screen and too-high boxes and merges nested wrappers', () => {
    const list = buildPlatforms(
      [
        { id: 'tiny', rect: { left: 10, top: 300, right: 40, bottom: 330 }, tag: 'button', warm: 0, elementRef: null },
        { id: 'card', rect: { left: 100, top: 300, right: 500, bottom: 600 }, tag: 'article', warm: 0, elementRef: null },
        { id: 'wrapper', rect: { left: 98, top: 302, right: 502, bottom: 640 }, tag: 'div', warm: 0, elementRef: null },
        { id: 'header', rect: { left: 0, top: 0, right: 1200, bottom: 60 }, tag: 'header', warm: 0, elementRef: null },
        { id: 'video', rect: { left: 600, top: 200, right: 900, bottom: 380 }, tag: 'video', warm: 1, elementRef: null },
      ],
      bounds,
    );
    const ids = list.map((p) => p.id);
    expect(ids).not.toContain('tiny');
    expect(ids).not.toContain('header');
    expect(ids.filter((id) => id === 'card' || id === 'wrapper')).toHaveLength(1);
    expect(list.find((p) => p.id === 'video')?.warm).toBe(1);
  });

  it('keeps the warmest attribute when merging duplicates', () => {
    const merged = mergePlatforms([
      { ...ledge('img', 100, 400, 300), warm: 0.55 },
      { ...ledge('div', 102, 398, 302), warm: 0.1 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].warm).toBe(0.55);
  });
});

describe('navigation across ledges', () => {
  const floor = makeFloor(bounds);
  const low = ledge('low', 100, 400, 520);
  const mid = ledge('mid', 450, 750, 300);
  const high = ledge('high', 800, 1100, 120);
  const all = [low, mid, high, floor];

  it('plans a single hop with takeoff and landing on the correct ledges', () => {
    const hop = planHop(floor, low, 50, bounds)!;
    expect(hop).not.toBeNull();
    expect(hop.landX).toBeGreaterThanOrEqual(low.xMin);
    expect(hop.landX).toBeLessThanOrEqual(low.xMax);
  });

  it('chains jumps to reach a ledge too high for one leap', () => {
    const plan = planRoute(all, 'floor', 60, 'high', 950, bounds)!;
    expect(plan).not.toBeNull();
    expect(plan.hops.length).toBeGreaterThanOrEqual(2);
    expect(plan.hops[plan.hops.length - 1].to).toBe('high');
    for (const h of plan.hops) {
      const from = all.find((p) => p.id === h.from)!;
      const to = all.find((p) => p.id === h.to)!;
      expect(from.y - to.y).toBeLessThanOrEqual(MAX_JUMP_UP);
      expect(solveJump(h.takeoffX, from.y, h.landX, to.y)).not.toBeNull();
    }
  });

  it('steps off an edge with open air to get down', () => {
    const plan = planRoute(all, 'mid', 600, 'floor', 300, bounds)!;
    expect(plan.hops).toHaveLength(1);
    const hop = plan.hops[0];
    expect(hop.through).toBe(false);
    expect(hop.landX < mid.xMin || hop.landX > mid.xMax).toBe(true);
  });

  it('walks without jumping when already on the target ledge', () => {
    const plan = planRoute(all, 'low', 150, 'low', 350, bounds)!;
    expect(plan.hops).toHaveLength(0);
    expect(plan.finalX).toBeCloseTo(350, 6);
  });
});

describe('scruff pendulum & throw', () => {
  it('swings the body away from the hand’s motion, clamped to ±0.65 rad', () => {
    expect(pendulumTarget(10)).toBeCloseTo(-0.45, 6); // hand moving right → body trails to the left
    expect(pendulumTarget(-10)).toBeCloseTo(0.45, 6);
    expect(pendulumTarget(400)).toBe(-PENDULUM_MAX_ANGLE);
    expect(pendulumTarget(-400)).toBe(PENDULUM_MAX_ANGLE);
    const s = { angle: 0, angVel: 0 };
    let min = 0;
    for (let i = 0; i < 120; i++) {
      pendulumStep(s, 60, 1 / 60);
      min = Math.min(min, s.angle);
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(PENDULUM_MAX_ANGLE + 1e-9);
    }
    expect(min).toBeLessThan(-0.5);
  });

  it('sways a little and settles vertically once the hand stops', () => {
    const s = { angle: 0, angVel: 0 };
    for (let i = 0; i < 30; i++) pendulumStep(s, 8, 1 / 60);
    const swung = s.angle;
    expect(swung).toBeLessThan(-0.2);
    let crossed = false;
    for (let i = 0; i < 180; i++) {
      pendulumStep(s, 0, 1 / 60);
      if (s.angle > 0.005) crossed = true; // a natural overshoot past vertical
    }
    expect(crossed).toBe(true);
    expect(Math.abs(s.angle)).toBeLessThan(0.01);
    expect(Math.abs(s.angVel)).toBeLessThan(0.05);
  });

  it('stays stable at low frame rates', () => {
    const s = { angle: 0.6, angVel: 3 };
    for (let i = 0; i < 40; i++) pendulumStep(s, 0, 1 / 8);
    expect(Math.abs(s.angle)).toBeLessThan(0.01);
  });

  it('caps throw speeds and ignores garbage input', () => {
    expect(clampThrow(5000, -5000)).toEqual({ vx: MAX_THROW_VX, vy: -MAX_THROW_UP });
    expect(clampThrow(-5000, 9000)).toEqual({ vx: -MAX_THROW_VX, vy: MAX_THROW_DOWN });
    expect(clampThrow(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ vx: 0, vy: 0 });
    expect(clampThrow(300, -200)).toEqual({ vx: 300, vy: -200 });
  });

  it('a released cat falls under gravity and lands on the first ledge below it', () => {
    const shelf = ledge('shelf', 300, 700, 500);
    const plats = [shelf, makeFloor(bounds)];
    let x = 420;
    let y = 260;
    let vx = 240;
    let vy = -180; // tossed up and to the right
    let landed: Platform | null = null;
    for (let i = 0; i < 400 && !landed; i++) {
      const prevY = y;
      const st = fallStep(y, vy, 1 / 60);
      y = st.y;
      vy = st.vy;
      x += vx / 60;
      landed = vy > 0 ? findLanding(prevY, y, x, plats) : null;
    }
    expect(landed?.id).toBe('shelf');
    expect(x).toBeGreaterThan(420);
  });
});
