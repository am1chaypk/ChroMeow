/**
 * v3 #2 — the food and water bowls empty gradually: on their own over time
 * (while the cats are around, and at a capped half rate while no page shows
 * them) and as the cats eat and drink. Low bowls make hungry / thirsty cats
 * keep thinking about them (and ask) until they are refilled.
 */
import { describe, expect, it } from 'vitest';
import { FOOD_DECAY, LOW_BOWL, OFFLINE_DECAY_CAP, StationModel, WATER_DECAY, catchUpStation, decayLevels } from '../src/sim/FeedingStation';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS, normalizeStation } from '../src/shared/storage';
import { createAlex } from '../src/shared/presets';
import type { FeedingStation } from '../src/shared/types';

const B = { width: 1200, height: 700 };
const full: FeedingStation = { enabled: true, xNormalized: 0.8, foodLevel: 100, waterLevel: 100 };

describe('gradual bowl depletion', () => {
  it('decays food and water continuously at their own rates', () => {
    const hour = decayLevels(full, 3600);
    expect(hour.foodLevel).toBeCloseTo(100 - 3600 * FOOD_DECAY, 6);
    expect(hour.waterLevel).toBeCloseTo(100 - 3600 * WATER_DECAY, 6);
    // Water evaporates faster than the kibble goes.
    expect(hour.waterLevel).toBeLessThan(hour.foodLevel);
    // Gradual: a minute changes little, and it never goes below empty.
    const minute = decayLevels(full, 60);
    expect(100 - minute.foodLevel).toBeLessThan(1);
    expect(decayLevels(full, 1e7).foodLevel).toBe(0);
  });

  it('keeps emptying (half rate, capped) for the time no page showed the cats', () => {
    const t0 = 1_000_000;
    const st = { ...full, updatedAt: t0 };
    expect(catchUpStation(st, t0 + 5000)).toMatchObject({ foodLevel: 100, waterLevel: 100 }); // a tab switch
    const twoHours = catchUpStation(st, t0 + 2 * 3600 * 1000);
    expect(twoHours.foodLevel).toBeCloseTo(100 - 7200 * FOOD_DECAY * 0.5, 4);
    const week = catchUpStation(st, t0 + 7 * 24 * 3600 * 1000);
    expect(week.foodLevel).toBe(100 - OFFLINE_DECAY_CAP);
    expect(week.waterLevel).toBe(100 - OFFLINE_DECAY_CAP);
    // Levels without a timestamp (older data) are left alone.
    expect(catchUpStation(full, t0).foodLevel).toBe(100);
  });

  it('the station model depletes frame by frame and asks to be saved every half point or so', () => {
    const m = new StationModel(full);
    let dirtyAt = -1;
    for (let i = 0; i < 60 * 120; i++) {
      m.update(1 / 60, i / 60);
      if (m.dirty && dirtyAt < 0) dirtyAt = i / 60;
    }
    expect(m.state.foodLevel).toBeCloseTo(100 - 120 * FOOD_DECAY, 3);
    expect(m.state.waterLevel).toBeCloseTo(100 - 120 * WATER_DECAY, 3);
    expect(dirtyAt).toBeGreaterThan(30); // not every frame
    // Switched off (or a tab that isn't hosting the cats): no depletion.
    const off = new StationModel({ ...full, enabled: false });
    const idle = new StationModel(full);
    idle.depleting = false;
    for (let i = 0; i < 600; i++) {
      off.update(1 / 60, i / 60);
      idle.update(1 / 60, i / 60);
    }
    expect(off.state.foodLevel).toBe(100);
    expect(idle.state.foodLevel).toBe(100);
  });

  it('empties in the running world even with no cat eating, and faster when they do', () => {
    const idleWorld = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: full });
    idleWorld.setProfiles([createAlex()]);
    const eatWorld = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: full });
    eatWorld.setProfiles([createAlex()]);
    idleWorld.agents[0].drives.hunger = 0;
    eatWorld.agents[0].drives.hunger = 90;
    eatWorld.agents[0].placeOn(eatWorld.source.floor(), 700);
    for (let t = 0; t < 60; t += 1 / 30) {
      idleWorld.agents[0].drives.hunger = 0;
      idleWorld.update(1 / 30);
      eatWorld.update(1 / 30);
    }
    expect(idleWorld.station.level('food')).toBeLessThan(100);
    expect(idleWorld.station.level('food')).toBeGreaterThan(99);
    expect(eatWorld.station.level('food')).toBeLessThan(idleWorld.station.level('food') - 3);
  });

  it('a hungry cat by a low bowl keeps thinking about food until the bowl is refilled', () => {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS }, station: { ...full, foodLevel: LOW_BOWL - 15 } });
    w.setProfiles([createAlex()]);
    const a = w.agents[0];
    a.placeOn(w.source.floor(), 300);
    a.drives.hunger = 92;
    let begged = false;
    let bubbles = 0;
    for (let t = 0; t < 90; t += 1 / 30) {
      w.update(1 / 30);
      a.refreshLandmarks();
      bubbles = Math.max(bubbles, w.particles.count);
      if (a.state === 'EMPTY_BOWL_WAIT') begged = true;
      if (begged && t > 40) break;
    }
    // It ate what was left, the bowl ran dry, and it sat asking for more.
    expect(w.station.level('food')).toBeLessThan(6);
    expect(begged).toBe(true);
    expect(bubbles).toBeGreaterThan(0);
    w.refill('food');
    let ate = false;
    for (let t = 0; t < 40 && !ate; t += 1 / 30) {
      w.update(1 / 30);
      a.refreshLandmarks();
      ate = a.state === 'EATING';
    }
    expect(ate).toBe(true);
  });

  it('stores the timestamp alongside the levels', () => {
    expect(normalizeStation({ ...full, updatedAt: 1234 }).updatedAt).toBe(1234);
    expect(normalizeStation({ ...full, updatedAt: 'x' }).updatedAt).toBeUndefined();
  });
});
