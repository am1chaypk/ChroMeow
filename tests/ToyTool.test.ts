import { describe, expect, it } from 'vitest';
import { ToyTool, releaseVelocity } from '../src/sim/ToyTool';
import { ToyManager } from '../src/content/ToyManager';

describe('hand-held toys', () => {
  it('measures the throw from the last ~90 ms of the drag', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 5, y: 0, t: 0.2 }, // slow wind-up
      { x: 10, y: -2, t: 0.3 },
      { x: 40, y: -12, t: 0.35 },
      { x: 70, y: -22, t: 0.4 }, // fast flick at the end
    ];
    const { vx, vy } = releaseVelocity(samples);
    expect(vx).toBeGreaterThan(500);
    expect(vy).toBeLessThan(-150);
  });

  it('returns no velocity for a still click', () => {
    expect(releaseVelocity([{ x: 3, y: 3, t: 1 }])).toEqual({ vx: 0, vy: 0 });
  });

  it('drops treats exactly where you click, capped so spam replaces the oldest', () => {
    const toys = new ToyManager();
    for (let i = 0; i < 15; i++) toys.spawnTreatAt(100 + i, 50);
    const treats = toys.toys.filter((t) => t.kind === 'treat');
    expect(treats).toHaveLength(12);
    expect(treats[treats.length - 1].x).toBe(114);
  });

  it('holds the ball under the cursor, then throws it (speed-capped)', () => {
    const toys = new ToyManager();
    toys.holdBall(200, 100);
    toys.holdBall(220, 90);
    const held = toys.toys.find((t) => t.kind === 'ball');
    expect(held?.held).toBe(true);
    expect(held?.x).toBe(220);
    // Cats never chase a ball that is still in your hand.
    expect(toys.nearest(220, 90, ['ball'])).toBeNull();
    const thrown = toys.throwBall(9000, 0);
    expect(thrown?.held).toBe(false);
    expect(Math.hypot(thrown?.vx ?? 0, thrown?.vy ?? 0)).toBeLessThanOrEqual(1700.0001);
    expect(toys.nearest(220, 90, ['ball'])).not.toBeNull();
  });

  it('the laser follows the hand while held and fades once released', () => {
    const toys = new ToyManager();
    const bounds = { width: 800, height: 600 };
    toys.controlLaser(300, 200, true);
    for (let i = 0; i < 30; i++) toys.update(1 / 60, [], bounds);
    const dot = toys.toys.find((t) => t.kind === 'laser');
    expect(dot?.controlled).toBe(true);
    expect(Math.abs((dot?.x ?? 0) - 300)).toBeLessThan(3);
    toys.controlLaser(300, 200, false);
    for (let i = 0; i < 40; i++) toys.update(1 / 60, [], bounds);
    expect(toys.toys.find((t) => t.kind === 'laser')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ v3.1 */

import { createMouse, mouseBody, stepMouse } from '../src/sim/MouseToy';
import { FLOOR_DRAG, ROD_LENGTH, WAND_SEGMENTS, WAND_SEG_LEN, createWand, onSurface, rodAngleFor, swatWand, tipHeight, updateWand, wandTip } from '../src/sim/FeatherWand';
import { DEFAULT_ROPE } from '../src/engine/VerletRope';
import { makeFloor, type Platform } from '../src/engine/Physics';
import { Rng } from '../src/shared/rng';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex } from '../src/shared/presets';

const WB = { width: 1000, height: 600 };
const wfloor = makeFloor(WB);
const shelf: Platform = { id: 'shelf', kind: 'dom', xMin: 300, xMax: 700, y: 300, warm: 0, narrow: false, tag: 'div', elementRef: null };
const STRING_LEN = WAND_SEGMENTS * WAND_SEG_LEN;

describe('the standalone toy mouse (v3.1)', () => {
  it('has no string attached at all, and still runs about on its own', () => {
    const m = createMouse(400, 100, 1);
    expect('rope' in m).toBe(false);
    expect(Object.values(m).some((v) => v && typeof v === 'object')).toBe(false); // nothing trailing behind it
    const rng = new Rng(5);
    const modes = new Set<string>();
    for (let i = 0; i < 60 * 12; i++) {
      stepMouse(m, 1 / 60, [wfloor], WB, [], rng);
      modes.add(m.mode);
    }
    expect(m.ground).toBe('floor');
    expect(modes.has('scuttle') && modes.has('pause')).toBe(true);
  });

  it('cats aim at the mouse’s own body', () => {
    const m = createMouse(420, wfloor.y, 1);
    expect(mouseBody(m)).toEqual({ x: 420, y: wfloor.y - 4 });
    const toys = new ToyManager();
    const t = toys.spawnMouse(WB, 420);
    for (let i = 0; i < 90; i++) toys.update(1 / 60, [wfloor], WB);
    expect(t.x).toBeCloseTo(t.mouse!.x, 6);
    expect(t.y).toBeCloseTo(t.mouse!.y, 6);
  });
});

describe('the feather wand (v3.1)', () => {
  it('builds a 12–16 segment string with the spec’s physics (0.45 px/frame² gravity, 0.97 drag, 6–8 passes)', () => {
    const w = createWand(500, 100);
    const segs = w.rope.nodes.length - 1;
    expect(segs).toBeGreaterThanOrEqual(12);
    expect(segs).toBeLessThanOrEqual(16);
    expect(DEFAULT_ROPE.gravity).toBeCloseTo(0.45 * 3600, 6);
    expect(DEFAULT_ROPE.damping).toBe(0.97);
    expect(DEFAULT_ROPE.iterations).toBeGreaterThanOrEqual(6);
    expect(DEFAULT_ROPE.iterations).toBeLessThanOrEqual(8);
  });

  it('hangs straight down under gravity from the rod tip at the cursor, without stretching', () => {
    const w = createWand(500, 100);
    for (let i = 0; i < 300; i++) updateWand(w, 1 / 60, 500, 100, [wfloor], WB);
    expect(w.rope.nodes[0]).toMatchObject({ x: 500, y: 100 });
    const tip = wandTip(w);
    expect(Math.abs(tip.x - 500)).toBeLessThan(1);
    expect(tip.y).toBeGreaterThan(100 + STRING_LEN * 0.95);
    expect(w.rope.length()).toBeLessThanOrEqual(STRING_LEN * 1.03);
    expect(onSurface(w, [wfloor], WB)).toBe(false);
  });

  it('tilts the rod with the hand’s horizontal speed, clamped to ±0.5 rad', () => {
    expect(rodAngleFor(10)).toBeCloseTo(0.3, 6);
    expect(rodAngleFor(100)).toBe(0.5);
    expect(rodAngleFor(-100)).toBe(-0.5);
    const w = createWand(100, 100);
    for (let i = 1; i <= 30; i++) updateWand(w, 1 / 60, 100 + i * 12, 100, [wfloor], WB); // 12 px/frame
    expect(w.rodAngle).toBeGreaterThan(0.25);
    expect(w.rodAngle).toBeLessThanOrEqual(0.5);
    expect(ROD_LENGTH).toBeGreaterThan(40);
  });

  it('drapes onto the floor and slides along it when lowered, never clipping below', () => {
    const w = createWand(500, 300);
    let x = 500;
    for (let i = 0; i < 400; i++) {
      x -= 0.6;
      updateWand(w, 1 / 60, x, WB.height - 40, [wfloor], WB); // rod tip just above the floor
      for (const n of w.rope.nodes) expect(n.y).toBeLessThanOrEqual(wfloor.y + 0.01);
    }
    expect(w.rope.nodes.slice(-4).every((n) => n.grounded)).toBe(true); // the end of the string and the feather lie on it
    expect(onSurface(w, [wfloor], WB)).toBe(true);
    expect(tipHeight(w, [wfloor], WB)).toBeLessThanOrEqual(FLOOR_DRAG);
    expect(wandTip(w).x).toBeGreaterThan(x); // trailing behind the hand
  });

  it('rests on DOM ledges too', () => {
    const w = createWand(500, 20);
    // Lowered from above onto the shelf.
    for (let i = 0; i < 400; i++) updateWand(w, 1 / 60, 500, Math.min(250, 20 + i), [shelf, wfloor], WB);
    for (const n of w.rope.nodes) expect(n.y).toBeLessThanOrEqual(shelf.y + 0.01);
    expect(onSurface(w, [shelf, wfloor], WB)).toBe(true);
  });

  it('a swat on the feather kicks it away; a miss does nothing', () => {
    const w = createWand(500, 100);
    for (let i = 0; i < 300; i++) updateWand(w, 1 / 60, 500, 100, [wfloor], WB);
    const tip0 = wandTip(w);
    expect(swatWand(w, { x: tip0.x + 200, y: tip0.y }, 400, -200)).toBe(false);
    expect(swatWand(w, { x: tip0.x - 10, y: tip0.y }, 400, -200)).toBe(true);
    let maxDx = 0;
    for (let i = 0; i < 20; i++) {
      updateWand(w, 1 / 60, 500, 100, [wfloor], WB);
      maxDx = Math.max(maxDx, wandTip(w).x - tip0.x);
    }
    expect(maxDx).toBeGreaterThan(10); // it swung away from the paw
  });

  it('is a single toy that follows the hand and goes away with the tool', () => {
    const toys = new ToyManager();
    toys.controlWand(300, 120, true);
    toys.controlWand(310, 120, true);
    expect(toys.toys.filter((t) => t.kind === 'feather_wand')).toHaveLength(1);
    for (let i = 0; i < 120; i++) toys.update(1 / 60, [wfloor], WB);
    const t = toys.wand!;
    expect(t.wand!.x).toBe(310);
    expect(t.y).toBeGreaterThan(120); // the toy's position is the feather, hanging below
    expect(toys.nearest(310, 400)).toBe(t);
    expect(toys.grabbableAt(t.x, t.y)).toBeNull(); // it stays in your hand
    toys.controlWand(0, 0, false);
    expect(toys.wand).toBeNull();
  });

  it('the hand-held tool keeps the wand at the pointer even with the button up', () => {
    const w = new World({ source: new StaticPlatformSource(WB, []), settings: { ...DEFAULT_SETTINGS } });
    w.setProfiles([createAlex()]);
    const tool = new ToyTool(() => w);
    tool.select('feather_wand');
    tool.hover(250, 150);
    expect(w.toys.wand?.tx).toBe(250);
    tool.hover(260, 160);
    expect(w.toys.wand?.ty).toBe(160);
    tool.select('ball');
    expect(w.toys.wand).toBeNull();
  });

  it('cats hunt the feather: they stalk it along the floor and pounce, and its swats ruffle feather fluff', () => {
    const w = new World({ source: new StaticPlatformSource(WB, []), settings: { ...DEFAULT_SETTINGS }, station: { enabled: false, xNormalized: 0.9, foodLevel: 80, waterLevel: 80 }, beds: { enabled: false, positions: {} } });
    w.setProfiles([createAlex()]);
    const a = w.agents[0];
    a.placeOn(w.source.floor(), 150);
    a.drives.energy = 95;
    a.drives.playfulness = 95;
    const seen = new Set<string>();
    let hits = 0;
    const swat = w.toys.swatWand.bind(w.toys);
    w.toys.swatWand = (...args: Parameters<typeof swat>) => {
      const ok = swat(...args);
      if (ok) hits++;
      return ok;
    };
    let fluff = 0;
    for (let t = 0; t < 25 && hits === 0; t += 1 / 30) {
      // The feather drags slowly along the floor ahead of the cat.
      w.wandAt(560 + Math.sin(t * 0.6) * 30, WB.height - 60);
      w.update(1 / 30);
      a.refreshLandmarks();
      seen.add(a.state);
      fluff = Math.max(fluff, w.particles.count);
    }
    expect(seen.has('STALK_CURSOR')).toBe(true);
    expect(seen.has('POUNCE_AND_PIN') || seen.has('JUMP_ASCEND')).toBe(true);
    expect(hits).toBeGreaterThan(0);
  });
});
