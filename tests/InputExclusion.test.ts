/**
 * v3.1 — typing exclusion zones: while you type in a text field the cats keep
 * clear of it (and of a generous margin around it).
 */
import { describe, expect, it } from 'vitest';
import { EVADE_DISTANCE, ZONE_PADDING, blockedSpan, clampWalk, exclusionZone, filterPlatforms, isEditableInfo, pointInZone, rectsIntersect, safeFloorX } from '../src/sim/ExclusionZone';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { makeFloor, type Platform } from '../src/engine/Physics';

const B = { width: 1200, height: 700 };
const DT = 1 / 30;

describe('which elements count as text fields', () => {
  it('text-like inputs, textareas, contenteditable and textbox roles — not buttons, checkboxes & co.', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', null]) expect(isEditableInfo({ tag: 'INPUT', type })).toBe(true);
    for (const type of ['button', 'checkbox', 'radio', 'range', 'submit', 'color', 'file']) expect(isEditableInfo({ tag: 'input', type })).toBe(false);
    expect(isEditableInfo({ tag: 'TEXTAREA' })).toBe(true);
    expect(isEditableInfo({ tag: 'DIV', contentEditable: true })).toBe(true);
    for (const role of ['textbox', 'searchbox', 'combobox']) expect(isEditableInfo({ tag: 'div', role })).toBe(true);
    expect(isEditableInfo({ tag: 'div', role: 'button' })).toBe(false);
    expect(isEditableInfo({ tag: 'div' })).toBe(false);
    // You can't type into a disabled or read-only field.
    expect(isEditableInfo({ tag: 'input', type: 'text', disabled: true })).toBe(false);
    expect(isEditableInfo({ tag: 'textarea', readOnly: true })).toBe(false);
  });
});

describe('the exclusion zone', () => {
  it('is the field’s box expanded by 90 px left/right, 110 px above and 70 px below', () => {
    const z = exclusionZone({ left: 300, top: 400, right: 700, bottom: 440 });
    expect(z).toEqual({ minX: 300 - 90, minY: 400 - 110, maxX: 700 + 90, maxY: 440 + 70 });
    expect(ZONE_PADDING).toEqual({ x: 90, top: 110, bottom: 70 });
    expect(pointInZone(500, 350, z)).toBe(true); // a cat sitting on top of the field
    expect(pointInZone(150, 420, z)).toBe(false);
    expect(rectsIntersect(z, { minX: 780, minY: 300, maxX: 850, maxY: 340 })).toBe(true);
  });

  it('takes ledges in or near the zone out of play (and the floor strip under a low field)', () => {
    const z = exclusionZone({ left: 300, top: 560, right: 700, bottom: 600 });
    const near: Platform = { id: 'card', kind: 'dom', xMin: 250, xMax: 600, y: 520, warm: 0, narrow: false, tag: 'div', elementRef: null };
    const far: Platform = { id: 'aside', kind: 'dom', xMin: 900, xMax: 1150, y: 200, warm: 0, narrow: false, tag: 'aside', elementRef: null };
    const floor = makeFloor(B);
    expect(filterPlatforms([near, far, floor], z).map((p) => p.id)).toEqual(['aside', 'floor']);
    expect(filterPlatforms([near, far, floor], null)).toHaveLength(3);
    expect(blockedSpan(floor, z)).toEqual({ lo: 210, hi: 790 });
    expect(blockedSpan(far, z)).toBeNull();
    // Walks never stop in the strip or cross it.
    expect(clampWalk(100, 500, floor, z)).toBeLessThan(210);
    expect(clampWalk(1000, 300, floor, z)).toBeGreaterThan(790);
    expect(clampWalk(1000, 1100, floor, z)).toBe(1100);
    // A safe spot is at least 140 px from the field, on the nearer side.
    const left = safeFloorX(350, z, B.width);
    const right = safeFloorX(650, z, B.width);
    expect(300 - left).toBeGreaterThanOrEqual(EVADE_DISTANCE);
    expect(right - 700).toBeGreaterThanOrEqual(EVADE_DISTANCE);
  });
});

describe('cats keep clear of the field you type in', () => {
  function world(ledges: { id: string; xMin: number; xMax: number; y: number }[] = []) {
    const w = new World({ source: new StaticPlatformSource(B, ledges), settings: { ...DEFAULT_SETTINGS }, station: { enabled: false, xNormalized: 0.9, foodLevel: 90, waterLevel: 90 }, beds: { enabled: false, positions: {} } });
    w.setProfiles([createAlex(), createAnna()]);
    return w;
  }
  const settle = (w: World, s: number) => {
    for (let t = 0; t < s; t += DT) {
      w.update(DT);
      for (const a of w.agents) a.refreshLandmarks();
    }
  };

  it('a cat asleep on top of the focused field wakes, gets off and goes at least 140 px away', () => {
    // A search box (the ledge "field") the cat is napping on.
    const w = world([{ id: 'field', xMin: 400, xMax: 760, y: 300 }]);
    const [alex, anna] = w.agents;
    alex.placeOn(w.source.get('field') as Platform, 580);
    anna.placeOn(w.source.floor(), 1100);
    alex.setPlan([{ kind: 'state', state: 'CURLED_SLEEP', dur: 120 }], 'sleep');
    settle(w, 3);
    const z = exclusionZone({ left: 400, top: 300, right: 760, bottom: 336 });
    w.setExclusion(z);
    w.update(DT);
    expect(alex.planLabel).toBe('evade');
    expect(alex.isAsleep()).toBe(false); // woken straight away
    expect(w.platforms.some((p) => p.id === 'field')).toBe(false); // the field is no ledge right now
    settle(w, 12);
    expect(alex.groundId).not.toBe('field');
    expect(alex.inZone(z, w.env())).toBe(false);
    expect(Math.min(Math.abs(alex.x - 400), Math.abs(alex.x - 760))).toBeGreaterThanOrEqual(EVADE_DISTANCE - 1);
    // It sits down and watches from there, and doesn't come back while you type.
    for (let t = 0; t < 40; t += DT) {
      w.update(DT);
      for (const a of w.agents) {
        a.refreshLandmarks();
        if (a.planLabel !== 'evade' && a.groundId && !a.isAirborne()) expect(a.groundId).not.toBe('field');
      }
    }
    // Typing done (focus gone): the field is a ledge again.
    w.setExclusion(null);
    w.update(DT);
    expect(w.platforms.some((p) => p.id === 'field')).toBe(true);
  });

  it('a cat sitting on the floor under a field at the bottom of the page moves out of the strip', () => {
    const w = world();
    const [alex, anna] = w.agents;
    alex.placeOn(w.source.floor(), 600);
    anna.placeOn(w.source.floor(), 80);
    alex.setPlan([{ kind: 'state', state: 'IDLE_SIT', dur: 60 }], 'rest');
    settle(w, 2);
    const z = exclusionZone({ left: 450, top: 610, right: 750, bottom: 650 });
    w.setExclusion(z);
    settle(w, 10);
    for (const a of w.agents) {
      expect(a.inZone(z, w.env())).toBe(false);
      expect(a.x < 450 - EVADE_DISTANCE + 1 || a.x > 750 + EVADE_DISTANCE - 1).toBe(true);
    }
    // Nobody wanders back in (or across) while the zone stays up.
    for (let t = 0; t < 45; t += DT) {
      w.update(DT);
      for (const a of w.agents) {
        a.refreshLandmarks();
        if (!a.isAirborne() && a.planLabel !== 'evade') expect(a.x > z.minX && a.x < z.maxX).toBe(false);
      }
    }
  });

  it('no destination is ever picked inside the zone: a cat called there stops at its edge', () => {
    const w = world();
    const [alex, anna] = w.agents;
    alex.placeOn(w.source.floor(), 150);
    anna.placeOn(w.source.floor(), 1150);
    const z = exclusionZone({ left: 500, top: 610, right: 700, bottom: 650 });
    w.setExclusion(z);
    alex.setPlan([{ kind: 'goto', spot: { platformId: 'floor', x: 600 }, gait: 'TROT' }, { kind: 'state', state: 'IDLE_SIT', dur: 10 }], 'test', true);
    settle(w, 8);
    expect(alex.x).toBeLessThan(z.minX);
    expect(alex.inZone(z, w.env())).toBe(false);
  });
});
