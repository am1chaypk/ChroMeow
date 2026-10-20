/**
 * v3 #10 — Alex and Anna keep their personal space (separation steering) and
 * never mirror each other: reactions to the same event are staggered by 2–5 s.
 * #7 — vertical pounces at things in the air, never leaping backward.
 */
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { PERSONAL_SPACE } from '../src/sim/CatAgent';
import { STAGGER_MAX, STAGGER_MIN } from '../src/ai/SocialCoordinator';
import { LEAP_REACH, planLeap } from '../src/engine/Physics';

const B = { width: 1200, height: 700 };
const DT = 1 / 30;

function world() {
  const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: { enabled: false, xNormalized: 0.9, foodLevel: 90, waterLevel: 90 }, beds: { enabled: false, positions: {} } });
  w.setProfiles([createAlex(), createAnna()]);
  return w;
}

describe('personal space (separation steering)', () => {
  it('two cats settled on top of each other nudge apart', () => {
    const w = world();
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 600);
    b.placeOn(w.source.floor(), 604);
    a.setPlan([{ kind: 'state', state: 'IDLE_SIT', dur: 30 }], 'rest');
    b.setPlan([{ kind: 'state', state: 'IDLE_SIT', dur: 30 }], 'rest');
    w.update(DT);
    expect(Math.sign(a.separation)).toBe(-Math.sign(b.separation));
    const ps = ((a.bodyLen() + b.bodyLen()) / 2) * PERSONAL_SPACE;
    // Within a few seconds they have made room (whenever they aren't deliberately together, e.g. grooming).
    let apart = false;
    for (let t = 0; t < 15 && !apart; t += DT) {
      w.update(DT);
      const together = !!w.social.sessionOf(a) || !!w.social.sessionOf(b);
      if (t > 3 && !together && !a.isAirborne() && !b.isAirborne() && Math.abs(a.x - b.x) > ps * 0.95) apart = true;
    }
    expect(apart).toBe(true);
  });

  it('two cats heading for the same spot don’t end up on top of each other', () => {
    const w = world();
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 300);
    b.placeOn(w.source.floor(), 160);
    a.setPlan([{ kind: 'goto', spot: { platformId: 'floor', x: 600 }, gait: 'TROT' }, { kind: 'state', state: 'IDLE_SIT', dur: 20 }], 'test', true);
    b.setPlan([{ kind: 'state', state: 'IDLE_STAND', dur: 0.5 }, { kind: 'goto', spot: { platformId: 'floor', x: 600 }, gait: 'TROT' }, { kind: 'state', state: 'IDLE_SIT', dur: 20 }], 'test', true);
    const ps = ((a.bodyLen() + b.bodyLen()) / 2) * PERSONAL_SPACE;
    // The second one to pick the spot sits down beside the first (its destination is moved out of the way).
    let minSettled = Infinity;
    let settledFrames = 0;
    for (let t = 0; t < 10; t += DT) {
      w.update(DT);
      const together = !!w.social.sessionOf(a) || !!w.social.sessionOf(b);
      const settled = (c: typeof a) => !c.isAirborne() && c.state !== 'TROT' && c.state !== 'SAUNTER_WALK' && c.state !== 'IDLE_STAND';
      if (t > 3 && !together && settled(a) && settled(b)) {
        settledFrames++;
        minSettled = Math.min(minSettled, Math.abs(a.x - b.x));
      }
    }
    expect(settledFrames).toBeGreaterThan(0);
    expect(minSettled).toBeGreaterThan(ps * 0.9);
  });

  it('leaves cuddling, grooming and playing pairs alone', () => {
    const w = world();
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 600);
    b.placeOn(w.source.floor(), 640);
    for (let i = 0; i < 5; i++) w.update(DT);
    expect(w.social.startAllogroom(a, b, w.env())).toBe(true);
    w.update(DT);
    expect(a.separation).toBe(0);
    expect(b.separation).toBe(0);
  });
});

describe('anti-mirroring (2–5 s stagger)', () => {
  it('global triggers reach the second cat 2–5 s after the first', () => {
    for (const trigger of ['call', 'ball', 'mouse'] as const) {
      const w = world();
      const [a, b] = w.agents;
      a.placeOn(w.source.floor(), 300);
      b.placeOn(w.source.floor(), 800);
      for (let i = 0; i < 5; i++) w.update(DT);
      if (trigger === 'call') w.callCats();
      else if (trigger === 'ball') w.tossBall();
      else w.releaseMouse();
      const waits = [w.pendingFor(a), w.pendingFor(b)];
      // One reacts at once, the other is queued 2–5 s later.
      expect(waits.filter((x) => x === null)).toHaveLength(1);
      const delay = waits.find((x) => x !== null) as number;
      expect(delay).toBeGreaterThanOrEqual(STAGGER_MIN - 1e-9);
      expect(delay).toBeLessThanOrEqual(STAGGER_MAX + 1e-9);
      const late = waits[0] === null ? b : a;
      const want = trigger === 'call' ? 'called' : 'toy';
      // The late cat starts its reaction exactly when its turn comes, not before.
      let reactedAt = -1;
      for (let t = 0; t < delay + 0.5 && reactedAt < 0; t += DT) {
        w.update(DT);
        if (late.planLabel === want) reactedAt = t;
      }
      // (Its own brain may notice a little earlier — but never in lockstep with the first cat.)
      expect(reactedAt).toBeGreaterThanOrEqual(STAGGER_MIN - 0.1);
      expect(reactedAt).toBeLessThanOrEqual(delay + 0.1);
    }
  });

  it('waking up together: the second cat stretches 2–5 s after the first', () => {
    const w = world();
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 700);
    b.placeOn(w.source.floor(), 500);
    for (let i = 0; i < 20; i++) w.update(DT);
    w.setUserIdle(true);
    for (let t = 0; t < 90; t += DT) {
      w.update(DT);
      if (a.state === 'CUDDLE_SLEEP' && b.state === 'CUDDLE_SLEEP') break;
    }
    w.setUserIdle(false);
    const start: Record<string, number> = {};
    for (let t = 0; t < 14; t += DT) {
      w.update(DT);
      for (const c of [a, b]) if (c.state === 'WAKE_ARCH_STRETCH' && start[c.id] === undefined) start[c.id] = t;
    }
    expect(Object.keys(start)).toHaveLength(2);
    const gap = Math.abs(start.alex - start.anna);
    expect(gap).toBeGreaterThanOrEqual(STAGGER_MIN - 0.1);
    expect(gap).toBeLessThanOrEqual(STAGGER_MAX + 0.4);
  });

  it('the idle gathering does not start in lockstep either', () => {
    const w = world();
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 300);
    b.placeOn(w.source.floor(), 900);
    for (let i = 0; i < 10; i++) w.update(DT);
    w.setUserIdle(true);
    const moved: Record<string, number> = {};
    const x0 = { alex: a.x, anna: b.x } as Record<string, number>;
    for (let t = 0; t < 10; t += DT) {
      w.update(DT);
      for (const c of [a, b]) if (moved[c.id] === undefined && Math.abs(c.x - x0[c.id]) > 4) moved[c.id] = t;
    }
    expect(Object.keys(moved)).toHaveLength(2);
    expect(Math.abs(moved.alex - moved.anna)).toBeGreaterThanOrEqual(STAGGER_MIN - 0.5);
  });
});

describe('vertical pounces', () => {
  it('leaps straight up (or forward) at a target in the air and peaks where the paws meet it', () => {
    const lp = planLeap(500, 700, 1, 510, 560);
    expect(lp.turn).toBe(false);
    expect(lp.plan).not.toBeNull();
    const plan = lp.plan!;
    expect(plan.y1).toBe(700); // lands back on its own ledge
    expect(plan.vx).toBeGreaterThanOrEqual(0); // straight up / forward only
    expect(plan.apexY).toBeLessThanOrEqual(560 + LEAP_REACH + 1);
    // Nothing to reach: too high, or below its feet.
    expect(planLeap(500, 700, 1, 510, 100).plan).toBeNull();
    expect(planLeap(500, 700, 1, 510, 760).plan).toBeNull();
  });

  it('never leaps backward: a target behind means turning around first', () => {
    expect(planLeap(500, 700, 1, 420, 560)).toEqual({ turn: true, plan: null });
    expect(planLeap(500, 700, -1, 580, 560)).toEqual({ turn: true, plan: null });
    const fwd = planLeap(500, 700, -1, 430, 560);
    expect(fwd.turn).toBe(false);
    expect(fwd.plan!.vx).toBeLessThanOrEqual(0);
  });

  it('a cat jumps up at the feather wand dangling above it, facing it first, and swats it', () => {
    const w = world();
    w.setProfiles([createAlex()]);
    const a = w.agents[0];
    a.placeOn(w.source.floor(), 500);
    a.facing = 1;
    a.flip = 1;
    a.drives.energy = 95;
    a.drives.playfulness = 95;
    for (let i = 0; i < 10; i++) w.update(DT);
    // The wand behind the cat: the feather dangles at paw height.
    w.wandAt(440, 380);
    const swats: number[] = [];
    const swat = w.toys.swatWand.bind(w.toys);
    w.toys.swatWand = (...args: Parameters<typeof swat>) => {
      swats.push(a.facing);
      return swat(...args);
    };
    let minY = Infinity;
    let backward = 0;
    for (let t = 0; t < 10; t += DT) {
      w.wandAt(440 + Math.sin(t * 2) * 8, 380);
      w.update(DT);
      a.refreshLandmarks();
      minY = Math.min(minY, a.y);
      if ((a.state === 'JUMP_ASCEND' || a.state === 'FALL_DESCEND') && Math.abs(a.vx) > 5 && Math.sign(a.vx) !== a.facing) backward++;
    }
    expect(minY).toBeLessThan(w.source.floor().y - 60); // a real vertical leap
    expect(swats.length).toBeGreaterThan(0);
    expect(backward).toBe(0);
  });
});
