/**
 * v3 #5 / #6 — personal named beds along the floor: one per cat, labelled with
 * its name, draggable sideways, persisted, toggled from the popup; every cat
 * prefers its own bed for naps and the pair cuddles up in one.
 */
import { describe, expect, it } from 'vitest';
import { BED_LIFT, BedsModel } from '../src/sim/CatBeds';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_BEDS, DEFAULT_SETTINGS, normalizeBeds } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { setLanguage } from '../src/shared/i18n';

const B = { width: 1200, height: 700 };
const DT = 1 / 30;

function world(beds = DEFAULT_BEDS) {
  const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: { enabled: true, xNormalized: 0.9, foodLevel: 90, waterLevel: 90 }, beds });
  w.setProfiles([createAlex(), createAnna()]);
  return w;
}

describe('named beds', () => {
  it('gives each cat its own bed on the floor, labelled with its name', () => {
    setLanguage('en');
    const w = world();
    const all = w.beds.all(B);
    expect(all.map((g) => [g.id, g.name])).toEqual([
      ['alex', 'Alex'],
      ['anna', 'Anna'],
    ]);
    for (const g of all) {
      expect(g.floorY).toBe(B.height - 2);
      expect(g.cx - g.w / 2).toBeGreaterThanOrEqual(0);
    }
    // Side by side, not on top of each other, and clear of the food & water station.
    const [a, b] = all;
    expect(Math.abs(a.cx - b.cx)).toBeGreaterThan(a.w);
    const st = w.station.rect(B);
    for (const g of all) expect(g.cx + g.w / 2 < st.minX || g.cx - g.w / 2 > st.maxX).toBe(true);
    // Labels follow the UI language for the built-in names.
    setLanguage('he');
    w.refreshBedOwners();
    expect(w.beds.all(B).map((g) => g.name)).toEqual(['אלכס', 'אנה']);
    setLanguage('en');
  });

  it('drags along the floor (clamped on screen), hit-tests and persists positions', () => {
    const m = new BedsModel(DEFAULT_BEDS);
    m.setOwners([{ id: 'alex', name: 'Alex', slot: 1 }]);
    m.moveTo('alex', 0.5);
    expect(m.dirty).toBe(true);
    const g = m.geom('alex', B)!;
    expect(g.cx).toBeCloseTo(600, 3);
    expect(m.hit(600, B.height - 8, B)).toBe('alex');
    expect(m.hit(600, 100, B)).toBeNull();
    m.moveTo('alex', 1.5);
    expect(m.geom('alex', B)!.cx + m.geom('alex', B)!.w / 2).toBeLessThanOrEqual(B.width);
    expect(m.bedAt(m.geom('alex', B)!.cx, B)).toBe('alex');
    // Stored shape survives a round trip, rejecting junk.
    expect(normalizeBeds({ enabled: false, positions: { alex: 0.25, 'bad id!': 0.5, anna: 'x' } })).toEqual({ enabled: false, positions: { alex: 0.25 } });
    expect(normalizeBeds(undefined)).toEqual({ enabled: true, positions: {} });
  });

  it('can be hidden (popup quick toggle): no beds drawn, none chosen for naps', () => {
    const w = world({ enabled: false, positions: {} });
    expect(w.beds.enabled).toBe(false);
    expect(w.beds.all(B)).toEqual([]);
    expect(w.beds.spotFor('alex', B)).toBeNull();
    w.beds.setState({ enabled: true, positions: {} });
    expect(w.beds.all(B)).toHaveLength(2);
  });

  it('a sleepy cat curls up in its own bed (never in the other cat’s)', () => {
    let inOwn = 0;
    let inOther = 0;
    for (let trial = 0; trial < 12; trial++) {
      const w = world();
      const [alex, anna] = w.agents;
      w.setProfiles([createAlex()]);
      const a = w.agents[0];
      void alex;
      void anna;
      a.placeOn(w.source.floor(), 800);
      a.drives.energy = 3;
      a.command('sleep', w.env());
      for (let t = 0; t < 40 && !a.isAsleep(); t += DT) w.update(DT);
      for (let t = 0; t < 2; t += DT) w.update(DT);
      const bed = w.beds.bedAt(a.x, B);
      if (bed === 'alex') inOwn++;
      if (bed === 'anna') inOther++;
      if (bed === 'alex') {
        expect(a.isAsleep()).toBe(true);
        expect(a.bedLift).toBeGreaterThan(BED_LIFT * a.S * 0.8);
      }
    }
    expect(inOwn).toBeGreaterThanOrEqual(5); // its own bed is the clear favourite
    expect(inOther).toBe(0);
  });

  it('when you step away the pair cuddles up in a bed', () => {
    const w = world();
    const [alex, anna] = w.agents;
    alex.placeOn(w.source.floor(), 700);
    anna.placeOn(w.source.floor(), 500);
    for (let i = 0; i < 20; i++) w.update(DT);
    w.setUserIdle(true);
    for (let t = 0; t < 90; t += DT) {
      w.update(DT);
      if (alex.state === 'CUDDLE_SLEEP' && anna.state === 'CUDDLE_SLEEP') break;
    }
    expect(alex.state).toBe('CUDDLE_SLEEP');
    expect(anna.state).toBe('CUDDLE_SLEEP');
    const beds = [w.beds.bedAt(alex.x, B), w.beds.bedAt(anna.x, B)];
    expect(beds.some((b) => b === 'alex' || b === 'anna')).toBe(true);
  });
});
