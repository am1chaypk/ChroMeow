/**
 * v3 #9 — one Alex and one Anna in the whole browser: leader election across
 * tabs and windows, migration between windows, roaming visits to other tabs.
 */
import { describe, expect, it } from 'vitest';
import { AWAY_MAX_MS, AWAY_MIN_MS, InstanceRegistry, mergeSnapshot, migrationSides } from '../src/shared/instance';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import type { WorldSnapshot } from '../src/shared/types';

const on = { visible: true, focused: true };
const visibleOnly = { visible: true, focused: false };
const hidden = { visible: false, focused: false };

function leaders(r: InstanceRegistry): number[] {
  return r.tabIds.filter((id) => r.role(id).leader);
}

describe('single instance across tabs (leader election)', () => {
  it('exactly one tab hosts the cats, whatever the tabs report', () => {
    const r = new InstanceRegistry();
    let now = 1000;
    const events: [number, number, typeof on][] = [
      [1, 10, on],
      [2, 10, hidden],
      [3, 20, visibleOnly],
      [2, 10, on],
      [1, 10, hidden],
      [3, 20, on],
      [4, 30, hidden],
      [3, 20, hidden],
    ];
    for (const [tab, win, p] of events) {
      r.report(tab, win, p, (now += 500));
      expect(leaders(r)).toHaveLength(1);
    }
  });

  it('the cats follow you to the tab you switch to', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    expect(r.leader).toBe(1);
    // Switch tab in the same window: the old one is hidden, the new one visible + focused.
    r.report(1, 10, hidden, 2000);
    const ch = r.report(2, 10, on, 2001);
    expect(r.leader).toBe(2);
    expect(ch?.visibleHandoff ?? false).toBe(false); // no run-off animation for a hidden tab
    expect(r.role(1).leader).toBe(false);
    expect(r.role(2).leader).toBe(true);
  });

  it('keeps the cats in place when the browser merely loses focus', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 20, visibleOnly, 1100); // another window, on screen, not focused
    expect(r.report(1, 10, visibleOnly, 1200)).toBeNull(); // e.g. the popup took focus
    expect(r.leader).toBe(1);
  });

  it('focusing another window on screen migrates the cats (visible handoff)', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 20, visibleOnly, 1100);
    r.report(1, 10, visibleOnly, 1500);
    const ch = r.report(2, 20, on, 1600);
    expect(ch).not.toBeNull();
    expect(ch?.from).toBe(1);
    expect(ch?.to).toBe(2);
    expect(ch?.visibleHandoff).toBe(true);
    expect(r.epoch).toBeGreaterThan(1);
    // They run off toward the new window and come in from the facing edge.
    expect(migrationSides({ left: 0, width: 800 }, { left: 900, width: 800 })).toEqual({ exit: 1, enter: -1 });
    expect(migrationSides({ left: 900, width: 800 }, { left: 0, width: 800 })).toEqual({ exit: -1, enter: 1 });
  });

  it('closing the leader hands the cats to the most recently focused visible tab', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 20, on, 1500);
    r.report(3, 30, visibleOnly, 1600);
    expect(r.leader).toBe(2);
    r.remove(2, 2000);
    expect(r.leader).toBe(1);
    r.remove(1, 2100);
    expect(r.leader).toBe(3);
    r.remove(3, 2200);
    expect(r.leader).toBeNull();
  });

  it('with no tab on screen the cats stay where they were', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 10, hidden, 1100);
    r.report(1, 10, hidden, 1200);
    expect(r.leader).toBe(1);
  });

  it('survives the service worker being suspended (snapshot round trip)', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 20, visibleOnly, 1100);
    const copy = InstanceRegistry.from(JSON.parse(JSON.stringify(r.snapshot())));
    expect(copy.leader).toBe(1);
    expect(copy.epoch).toBe(r.epoch);
    expect(copy.tabIds.sort()).toEqual([1, 2]);
    expect(InstanceRegistry.from(null).leader).toBeNull();
  });

  it('a roaming cat visits another tab, comes back later — or is waiting there when you switch to it', () => {
    const r = new InstanceRegistry();
    r.report(1, 10, on, 1000);
    r.report(2, 10, hidden, 1001);
    expect(r.sendAway('anna', 1, 2000, -1, () => 0)).toBe(2);
    expect(r.isAway('anna')).toBe(true);
    expect(r.role(1).away).toEqual(['anna']);
    expect(r.takeReturning(2000 + AWAY_MIN_MS - 1)).toEqual([]);
    expect(r.takeReturning(2000 + AWAY_MAX_MS)).toEqual([{ catId: 'anna', side: -1 }]);
    expect(r.isAway('anna')).toBe(false);
    // Again — this time the user switches to the tab she went to: she is simply there.
    r.sendAway('anna', 1, 3000, 1, () => 0);
    r.report(1, 10, hidden, 3100);
    r.report(2, 10, on, 3101);
    expect(r.leader).toBe(2);
    expect(r.isAway('anna')).toBe(false);
    // Nowhere to go with a single tab.
    const solo = new InstanceRegistry();
    solo.report(5, 1, on, 1);
    expect(solo.sendAway('alex', 5, 2)).toBeNull();
    // A visited tab that closes sends the cat straight home.
    r.sendAway('alex', 2, 5000, 1, () => 0);
    r.report(3, 10, hidden, 5001);
    r.sendAway('alex', 2, 5002, 1, () => 0.99);
    const visited = r.snapshot().away.alex.tabId;
    r.remove(visited, 6000);
    expect(r.takeReturning(6000).map((x) => x.catId)).toContain('alex');
  });

  it('merges the leader’s snapshot, keeping the last state of a cat that is away', () => {
    const prev: WorldSnapshot = { updatedAt: 1, href: 'a', cats: [{ id: 'alex', name: 'Alex', state: 'IDLE_SIT', drives: {} as never, relX: 0.1, relY: 1, facing: 1, onFloor: true }, { id: 'anna', name: 'Anna', state: 'TROT', drives: {} as never, relX: 1, relY: 1, facing: 1, onFloor: true }] };
    const next: WorldSnapshot = { updatedAt: 2, href: 'b', cats: [{ ...prev.cats[0], relX: 0.5 }] };
    const merged = mergeSnapshot(prev, next);
    expect(merged.cats.map((c) => [c.id, c.relX])).toEqual([
      ['alex', 0.5],
      ['anna', 1],
    ]);
    expect(merged.href).toBe('b');
  });
});

describe('the leader page’s side of it', () => {
  const B = { width: 1200, height: 700 };
  function world() {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS } });
    w.setProfiles([createAlex(), createAnna()]);
    w.agents[0].placeOn(w.source.floor(), 300);
    w.agents[1].placeOn(w.source.floor(), 800);
    return w;
  }

  it('a page that is not the leader shows no cats at all (but keeps every cat’s bed)', () => {
    const w = world();
    w.setProfiles([], [createAlex(), createAnna()]);
    expect(w.agents).toHaveLength(0);
    expect(w.beds.all(B)).toHaveLength(2);
    // …and the bowls only empty where the cats are.
    const f0 = w.station.level('food');
    for (let i = 0; i < 300; i++) w.update(1 / 30);
    expect(w.station.level('food')).toBe(f0);
  });

  it('cats migrating to another window run off the edge, then the new window’s cats walk in', () => {
    const w = world();
    let gone = false;
    let xs: number[] = [];
    w.exitAll(1, () => {
      gone = true;
      xs = w.agents.map((a) => a.x);
    });
    for (let t = 0; t < 12 && !gone; t += 1 / 30) w.update(1 / 30);
    expect(gone).toBe(true);
    for (const x of xs) expect(x).toBeGreaterThan(B.width);
    const w2 = world();
    w2.arriveAll(-1);
    for (const a of w2.agents) expect(a.x).toBeLessThan(0);
    for (let t = 0; t < 16; t += 1 / 30) w2.update(1 / 30);
    for (const a of w2.agents) {
      expect(a.x).toBeGreaterThan(0);
      expect(a.x).toBeLessThan(B.width);
    }
  });

  it('a roaming cat walks off the screen and is handed to another tab', () => {
    const w = world();
    const left: string[] = [];
    w.hooks = { canRoam: () => true, catLeft: (id) => left.push(id) };
    w.now = 1000; // well past the warm-up
    const anna = w.agents[1];
    let tries = 0;
    while (anna.planLabel !== 'roam' && tries++ < 400) anna.makePlan('explore', w.env());
    expect(anna.planLabel).toBe('roam');
    for (let t = 0; t < 20 && !left.length; t += 1 / 30) w.update(1 / 30);
    expect(left).toEqual(['anna']);
    expect(w.agents.map((a) => a.id)).toEqual(['alex']);
    // No second visit right away, and never with roaming switched off.
    expect(w.env().wander?.allowed(w.agents[0])).toBe(true);
    w.settings = { ...w.settings, tabRoaming: false };
    expect(w.env().wander?.allowed(w.agents[0])).toBe(false);
  });
});
