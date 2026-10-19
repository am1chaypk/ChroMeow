/**
 * v3 #3 / #8 — the toy mouse with its dangling string, and toys you pick
 * straight up off the page (ball, mouse) plus "clear all".
 */
import { describe, expect, it } from 'vitest';
import { MOUSE_ALERT, MOUSE_LIVES, ROPE_SEGMENTS, ROPE_SEG_LEN, StringRope, catchMouse, createMouse, holdMouse, stepMouse } from '../src/sim/MouseToy';
import { ToyManager } from '../src/content/ToyManager';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { makeFloor, type Platform } from '../src/engine/Physics';
import { Rng } from '../src/shared/rng';

const B = { width: 1200, height: 700 };
const floor = makeFloor(B);
const ledge: Platform = { id: 'shelf', kind: 'dom', xMin: 400, xMax: 700, y: 400, warm: 0, narrow: false, tag: 'div', elementRef: null };
const MAX_LEN = (ROPE_SEGMENTS - 1) * ROPE_SEG_LEN;

describe('the dangling string (Verlet rope)', () => {
  it('hangs straight down below a held anchor, never stretched', () => {
    const r = new StringRope(300, 200);
    for (let i = 0; i < 400; i++) r.step(1 / 60, 300, 200, [floor], B);
    expect(r.length()).toBeLessThanOrEqual(MAX_LEN * 1.02);
    expect(r.tip().y).toBeGreaterThan(200 + MAX_LEN * 0.95);
    expect(Math.abs(r.tip().x - 300)).toBeLessThan(1);
    expect(r.hangDepth()).toBeGreaterThan(MAX_LEN * 0.9);
  });

  it('lies on the floor and drags along behind a moving anchor', () => {
    const r = new StringRope(600, floor.y - 2, ROPE_SEGMENTS, ROPE_SEG_LEN, 0);
    let x = 600;
    for (let i = 0; i < 240; i++) {
      x -= 2;
      r.step(1 / 60, x, floor.y - 2, [floor], B);
    }
    // Every node rests on (not in) the floor, trailing behind the anchor in a line.
    for (const n of r.nodes) expect(n.y).toBeLessThanOrEqual(floor.y);
    expect(r.nodes.filter((n) => n.grounded).length).toBeGreaterThanOrEqual(ROPE_SEGMENTS - 3);
    expect(r.tip().x).toBeGreaterThan(x + MAX_LEN * 0.8);
    expect(r.length()).toBeLessThanOrEqual(MAX_LEN * 1.02);
  });

  it('rests on DOM ledges and dangles off their edge', () => {
    const r = new StringRope(690, ledge.y - 2);
    for (let i = 0; i < 600; i++) r.step(1 / 60, 692, ledge.y - 2, [ledge, floor], B);
    // Anchored at the very edge: the string falls over it.
    expect(r.tip().y).toBeGreaterThan(ledge.y + 20);
    // Laid across the ledge instead, it rests on top of it.
    const flat = new StringRope(600, ledge.y - 2, ROPE_SEGMENTS, ROPE_SEG_LEN, 0);
    let x = 600;
    for (let i = 0; i < 300; i++) {
      x = Math.max(450, x - 1.5);
      flat.step(1 / 60, x, ledge.y - 2, [ledge, floor], B);
    }
    for (const n of flat.nodes) expect(n.y).toBeLessThanOrEqual(ledge.y);
    expect(flat.nodes.filter((n) => n.grounded).length).toBeGreaterThan(ROPE_SEGMENTS - 3);
  });

  it('swings when batted', () => {
    const r = new StringRope(300, 200);
    for (let i = 0; i < 300; i++) r.step(1 / 60, 300, 200, [floor], B);
    r.bat(ROPE_SEGMENTS - 1, 300, -100);
    r.step(1 / 60, 300, 200, [floor], B);
    expect(r.speed(1 / 60)).toBeGreaterThan(20);
    let maxX = 0;
    for (let i = 0; i < 30; i++) {
      r.step(1 / 60, 300, 200, [floor], B);
      maxX = Math.max(maxX, r.tip().x - 300);
    }
    expect(maxX).toBeGreaterThan(8);
  });
});

describe('the toy mouse', () => {
  const rng = new Rng(3);

  it('falls in, then scuttles, pauses and darts about on its own', () => {
    const m = createMouse(500, 100, 1);
    const modes = new Set<string>();
    let moved = 0;
    let lastX = m.x;
    for (let i = 0; i < 60 * 20; i++) {
      stepMouse(m, 1 / 60, [floor], B, [], rng);
      modes.add(m.mode);
      moved += Math.abs(m.x - lastX);
      lastX = m.x;
    }
    expect(m.ground).toBe('floor');
    expect(modes.has('pause')).toBe(true);
    expect(modes.has('scuttle')).toBe(true);
    expect(modes.has('dart')).toBe(true);
    expect(moved).toBeGreaterThan(300);
    expect(m.x).toBeGreaterThan(0);
    expect(m.x).toBeLessThan(B.width);
  });

  it('bolts away from (or freezes at) a cat that comes close, but a stalking cat gets much closer unnoticed', () => {
    /** How many of 20 mice notice the cat (bolt away from it, or freeze), and how many bolt. */
    const react = (vx: number, gap: number) => {
      let noticed = 0;
      let bolted = 0;
      for (let k = 0; k < 20; k++) {
        const m = createMouse(600, floor.y, 1);
        m.ground = 'floor';
        stepMouse(m, 1 / 60, [floor], B, [{ x: 600 - gap, y: floor.y, vx }], new Rng(k));
        if (m.mode === 'flee') {
          bolted++;
          expect(m.dir).toBe(1); // away from the cat
        }
        if (m.mode === 'flee' || m.calm > 0) noticed++;
      }
      return { noticed, bolted };
    };
    const trot = react(200, MOUSE_ALERT - 20);
    expect(trot.noticed).toBe(20);
    expect(trot.bolted).toBeGreaterThan(8); // mostly running, sometimes freezing
    expect(react(30, MOUSE_ALERT - 20).noticed).toBe(0); // a creeping cat isn't noticed…
    const close = react(30, 40);
    expect(close.noticed).toBe(20); // …until it's right there
    expect(close.bolted).toBeLessThan(close.noticed); // surprised up close, many freeze
  });

  it('is caught by a pin, wriggles free, and after its last escape lies still (toy debris)', () => {
    const m = createMouse(600, floor.y, 1);
    m.ground = 'floor';
    for (let n = 1; n <= MOUSE_LIVES; n++) {
      catchMouse(m, rng);
      expect(m.mode).toBe('caught');
      expect(m.catches).toBe(n);
      for (let i = 0; i < 90; i++) stepMouse(m, 1 / 60, [floor], B, [], rng);
    }
    expect(m.mode).toBe('limp');
    const x = m.x;
    for (let i = 0; i < 120; i++) stepMouse(m, 1 / 60, [floor], B, [], rng);
    expect(m.x).toBe(x);
  });

  it('dangles its string when lifted', () => {
    const m = createMouse(600, floor.y, 1);
    for (let i = 0; i < 240; i++) holdMouse(m, 600, 300, 1 / 60, [floor], B);
    expect(m.rope.hangDepth()).toBeGreaterThan(MAX_LEN * 0.8);
  });

  it('the toy manager keeps one mouse, which a hand can pick up and throw', () => {
    const tm = new ToyManager();
    tm.spawnMouse(B, 500);
    tm.spawnMouse(B, 600);
    expect(tm.toys.filter((t) => t.kind === 'mouse')).toHaveLength(1);
    const toy = tm.toys[0];
    for (let i = 0; i < 120; i++) tm.update(1 / 60, [floor], B);
    expect(toy.ground).toBe('floor');
    expect(tm.grabbableAt(toy.x, toy.y - 5)).toBe(toy);
    expect(tm.grabbableAt(toy.x + 60, toy.y - 5)).toBeNull();
    tm.holdToy(toy, 300, 200);
    expect(tm.heldToy).toBe(toy);
    tm.throwToy(500, -300);
    expect(tm.heldToy).toBeNull();
    for (let i = 0; i < 180; i++) tm.update(1 / 60, [floor], B);
    expect(toy.ground).toBe('floor');
    expect(toy.x).toBeGreaterThan(330);
  });
});

describe('cats and the toy mouse', () => {
  it('hunt it — stalk, pounce and pin it', () => {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: { enabled: false, xNormalized: 0.9, foodLevel: 80, waterLevel: 80 } });
    w.setProfiles([createAlex()]);
    const a = w.agents[0];
    a.placeOn(w.source.floor(), 200);
    a.drives.energy = 95;
    a.drives.playfulness = 95;
    const toy = w.releaseMouse(650);
    const seen = new Set<string>();
    for (let t = 0; t < 40 && (toy.mouse?.catches ?? 0) === 0; t += 1 / 30) {
      w.update(1 / 30);
      a.refreshLandmarks();
      seen.add(a.state);
    }
    expect(seen.has('STALK_CURSOR') || seen.has('TROT')).toBe(true);
    expect(seen.has('POUNCE_AND_PIN') || seen.has('JUMP_ASCEND')).toBe(true);
    expect(toy.mouse?.catches).toBeGreaterThan(0);
  });
});

describe('toys straight off the page + clear all', () => {
  function world() {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS } });
    w.setProfiles([createAlex(), createAnna()]);
    w.agents[0].placeOn(w.source.floor(), 200);
    w.agents[1].placeOn(w.source.floor(), 1000);
    return w;
  }

  it('press on the ball picks it up, a flick throws it — no play mode needed', () => {
    const w = world();
    w.tossBall();
    const ball = w.toys.toys.find((t) => t.kind === 'ball')!;
    for (let i = 0; i < 200; i++) w.update(1 / 60);
    let grabbed = false;
    w.hooks = { toyGrabStart: () => (grabbed = true) };
    expect(w.toyAt(ball.x, ball.y)).toBe(ball);
    expect(w.pointerDown(ball.x, ball.y, 10)).toBe(true);
    expect(grabbed).toBe(true);
    expect(w.heldToy).toBe(ball);
    // The cats aren't grabbed instead, and the ball follows the hand.
    expect(w.held).toBeNull();
    let t = 10;
    const x0 = ball.x;
    const y0 = ball.y;
    for (let i = 1; i <= 8; i++) {
      t += 1 / 60;
      w.pointerMove(x0 + i * 25, y0 - i * 10, t);
      w.update(1 / 60);
    }
    expect(ball.held).toBe(true);
    expect(Math.abs(ball.x - w.cursor.x)).toBeLessThan(1);
    w.pointerUp(x0 + 200, y0 - 80);
    expect(w.heldToy).toBeNull();
    expect(ball.held).toBe(false);
    expect(ball.vx).toBeGreaterThan(300);
    expect(ball.vy).toBeLessThan(0);
  });

  it('clears every treat, ball, laser dot and mouse — but never the cats', () => {
    const w = world();
    w.dropTreat();
    w.tossBall();
    w.tossLaser();
    w.releaseMouse();
    for (let i = 0; i < 30; i++) w.update(1 / 30);
    expect(w.toys.count).toBeGreaterThanOrEqual(4);
    const cats = w.agents.map((a) => [a.id, a.x]);
    w.clearObjects();
    expect(w.toys.count).toBe(0);
    expect(w.particles.count).toBe(0);
    expect(w.agents.map((a) => [a.id, a.x])).toEqual(cats);
    for (const a of w.agents) expect(a.planLabel).not.toBe('toy');
    // Nothing comes back by itself.
    for (let i = 0; i < 300; i++) w.update(1 / 30);
    expect(w.toys.count).toBe(0);
    expect(w.agents).toHaveLength(2);
  });
});
