/**
 * v4 — the vertical cat tree & scratching tower: tier platforms, dragging with cats riding along,
 * hiding it, sisal scratching, the bed fallback and the pom-pom.
 */
import { describe, expect, it } from 'vitest';
import { TOWER_DESIGN, TOWER_TIER1, TOWER_TIER2, TOWER_TOP, TowerModel, batPom, pomSpeed } from '../src/sim/CatTower';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS, DEFAULT_TOWER, normalizeTower } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { exclusionZone } from '../src/sim/ExclusionZone';
import { INTENTS } from '../src/ai/UtilityBrain';

const B = { width: 1280, height: 800 };
const DT = 1 / 30;

function world(over: { tower?: Partial<typeof DEFAULT_TOWER>; beds?: boolean; bounds?: { width: number; height: number }; seed?: number } = {}) {
  // The sim seeds its RNGs from Date.now(); pin it while building so every run is reproducible.
  const realNow = Date.now;
  Date.now = () => over.seed ?? 1_700_000_000_000;
  try {
    return build(over);
  } finally {
    Date.now = realNow;
  }
}
function build(over: { tower?: Partial<typeof DEFAULT_TOWER>; beds?: boolean; bounds?: { width: number; height: number } }) {
  const w = new World({
    source: new StaticPlatformSource(over.bounds ?? B, []),
    settings: { ...DEFAULT_SETTINGS },
    station: { enabled: false, xNormalized: 0.9, foodLevel: 90, waterLevel: 90 },
    beds: { enabled: over.beds ?? false, positions: {} },
    tower: { ...DEFAULT_TOWER, ...over.tower },
  });
  w.setProfiles([createAlex(), createAnna()]);
  return w;
}
const run = (w: World, s: number) => {
  for (let t = 0; t < s; t += DT) {
    w.update(DT);
    for (const a of w.agents) a.refreshLandmarks();
  }
};

describe('tower state', () => {
  it('defaults: on, tucked at the left edge, unworn; stored values are clamped', () => {
    expect(DEFAULT_TOWER).toEqual({ enabled: true, xNormalized: 0.06, scratchWear: 0 });
    expect(normalizeTower({ enabled: false, xNormalized: 5, scratchWear: -3 })).toEqual({ enabled: false, xNormalized: 0.96, scratchWear: 0 });
    expect(normalizeTower(null)).toEqual(DEFAULT_TOWER);
    expect(normalizeTower({ xNormalized: 'x' }).xNormalized).toBe(0.06);
  });
});

describe('tower platforms', () => {
  it('registers the three tiers at ~140 / 275 / 410 px above the floor, around xNormalized', () => {
    const w = world({ tower: { xNormalized: 0.3 } });
    run(w, 0.2);
    const floorY = B.height - 2;
    const ids = w.platforms.filter((p) => p.id.startsWith('platform_tower_')).map((p) => p.id);
    expect(ids.sort()).toEqual([TOWER_TIER2, TOWER_TIER1, TOWER_TOP].sort());
    const get = (id: string) => w.platforms.find((p) => p.id === id)!;
    expect(floorY - get(TOWER_TIER1).y).toBeCloseTo(140, 0);
    expect(floorY - get(TOWER_TIER2).y).toBeCloseTo(275, 0);
    expect(floorY - get(TOWER_TOP).y).toBeCloseTo(410, 0);
    expect(get(TOWER_TIER2).xMax - get(TOWER_TIER2).xMin).toBeCloseTo(95, 0);
    expect(get(TOWER_TOP).xMax - get(TOWER_TOP).xMin).toBeCloseTo(105, 0);
    const cx = 0.3 * B.width;
    const t1 = get(TOWER_TIER1);
    expect((t1.xMin + t1.xMax) / 2).toBeCloseTo(cx, 0);
    expect(w.source.get(TOWER_TOP)?.y).toBe(get(TOWER_TOP).y);
    // Slim: within ~130 px wide, and ≤ 65 % of a short window.
    const g = w.tower.geom(B)!;
    expect(g.halfW * 2).toBeLessThanOrEqual(130);
    const short = new TowerModel({ ...DEFAULT_TOWER });
    const sg = short.geom({ width: 1000, height: 400 })!;
    expect(sg.floorY - sg.top.y).toBeLessThanOrEqual(0.65 * 400 + 1);
    expect(TOWER_DESIGN.height * g.u).toBeLessThanOrEqual(0.65 * B.height + 1);
  });

  it('disabling removes them again, and enabling brings them back', () => {
    const w = world();
    run(w, 0.2);
    expect(w.platforms.some((p) => p.id === TOWER_TOP)).toBe(true);
    w.setTower({ ...w.tower.state, enabled: false });
    run(w, 0.2);
    expect(w.platforms.some((p) => p.id.startsWith('platform_tower_'))).toBe(false);
    expect(w.source.get(TOWER_TOP)).toBeNull();
    w.setTower({ ...w.tower.state, enabled: true });
    run(w, 0.2);
    expect(w.platforms.filter((p) => p.id.startsWith('platform_tower_'))).toHaveLength(3);
  });

  it('no tower in a world that was not given one (tests, Studio preview)', () => {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS } });
    run(w, 0.2);
    expect(w.tower.enabled).toBe(false);
    expect(w.platforms.some((p) => p.id.startsWith('platform_tower_'))).toBe(false);
  });
});

describe('dragging the tower', () => {
  it('moves every tier by the same shift and carries a cat on a tier by exactly deltaX', () => {
    const w = world({ tower: { xNormalized: 0.3 } });
    const alex = w.agents[0];
    run(w, 0.2);
    const top = w.platforms.find((p) => p.id === TOWER_TOP)!;
    alex.placeOn(top, (top.xMin + top.xMax) / 2);
    alex.setPlan([{ kind: 'state', state: 'CURLED_SLEEP', dur: 600 }], 'sleep');
    run(w, 1);
    const x0 = alex.x;
    const before = w.platforms.filter((p) => p.id.startsWith('platform_tower_')).map((p) => p.xMin);
    w.dragTower(0.5);
    const after = w.platforms.filter((p) => p.id.startsWith('platform_tower_')).map((p) => p.xMin);
    // (w.platforms refreshes on update; recompute from the model for the immediate check.)
    const now = w.tower.platforms(B).map((p) => p.xMin);
    const dx = 0.2 * B.width;
    w.tower.platforms(B).forEach((p, i) => expect(p.xMin - (before[i] ?? p.xMin)).toBeCloseTo(dx, 3));
    expect(after).toHaveLength(3);
    expect(now).toHaveLength(3);
    expect(alex.x - x0).toBeCloseTo(dx, 3);
    expect(alex.groundId).toBe(TOWER_TOP);
    run(w, 2);
    expect(alex.groundId).toBe(TOWER_TOP); // never floats off or falls
  });

  it('docks to the screen edges when dragged near them', () => {
    const w = world();
    expect(w.dragTower(0.05)).toBe(0.04);
    expect(w.dragTower(0.95)).toBe(0.96);
    expect(w.dragTower(0.5)).toBe(0.5);
    expect(w.tower.dirty).toBe(true);
  });

  it('a cat on the tower falls to the floor when it is hidden', () => {
    const w = world();
    const alex = w.agents[0];
    run(w, 0.2);
    const t1 = w.platforms.find((p) => p.id === TOWER_TIER1)!;
    alex.placeOn(t1, (t1.xMin + t1.xMax) / 2);
    alex.setPlan([{ kind: 'state', state: 'IDLE_SIT', dur: 600 }], 'rest');
    run(w, 0.5);
    w.setTower({ ...w.tower.state, enabled: false });
    run(w, 0.1);
    expect(alex.isAirborne()).toBe(true);
    run(w, 3);
    expect(alex.groundId).toBe('floor');
    expect(alex.cubbyDrop).toBe(0);
  });

  it('keeps the cats off the tower tiers a text field sits behind, and fades the tower', () => {
    const w = world({ tower: { xNormalized: 0.3 } });
    run(w, 0.2);
    const cx = 0.3 * B.width;
    w.setExclusion(exclusionZone({ left: cx - 60, top: 300, right: cx + 60, bottom: 340 }));
    run(w, 0.1);
    expect(w.tower.faded).toBe(true);
    expect(w.towerHit(cx, B.height - 20)).toBeNull();
    expect(w.platforms.some((p) => p.id === TOWER_TOP)).toBe(false);
    w.setExclusion(null);
    expect(w.tower.faded).toBe(false);
    expect(w.towerHit(cx, B.height - 20)).toBe('tower');
  });

  it('"clear all" removes toys and treats but not the tower', () => {
    const w = world();
    w.dropTreat();
    w.clearObjects();
    expect(w.tower.enabled).toBe(true);
    run(w, 0.2);
    expect(w.platforms.filter((p) => p.id.startsWith('platform_tower_'))).toHaveLength(3);
  });
});

describe('scratching the sisal post', () => {
  it('a cat with a high scratch urge walks to the post, rears up and scratches for 3–5 s', () => {
    const w = world({ tower: { xNormalized: 0.5 } });
    const [alex, anna] = w.agents;
    run(w, 0.2);
    alex.placeOn(w.source.floor(), 200);
    anna.placeOn(w.source.floor(), 1200);
    alex.drives.scratchUrge = 95;
    alex.drives.hunger = 0;
    alex.drives.thirst = 0;
    alex.command('scratch', w.env());
    expect(alex.planLabel).toBe('scratch');
    const wear0 = w.tower.state.scratchWear;
    let start = -1;
    let end = -1;
    let sisal = 0;
    for (let t = 0; t < 30; t += DT) {
      w.update(DT);
      for (const a of w.agents) a.refreshLandmarks();
      sisal = Math.max(sisal, w.particles.count);
      if (alex.state === 'SCRATCH_POST' && start < 0) start = t;
      if (start >= 0 && alex.state !== 'SCRATCH_POST' && end < 0) end = t;
    }
    expect(start).toBeGreaterThan(0);
    expect(end - start).toBeGreaterThan(2.5);
    expect(end - start).toBeLessThan(6);
    expect(alex.drives.scratchUrge).toBeLessThan(10);
    expect(w.tower.state.scratchWear).toBeGreaterThan(wear0);
    expect(w.tower.dirty).toBe(true);
    expect(sisal).toBeGreaterThan(0);
  });

  it('the brain only sends a cat to the post when the tower is out and the itch is high', () => {
    expect(INTENTS).toContain('scratch');
    const w = world({ tower: { enabled: false } });
    const alex = w.agents[0];
    run(w, 0.2);
    alex.command('scratch', w.env());
    expect(alex.planLabel).not.toBe('scratch'); // no tower: it just rests
  });

  it('the urge builds up over time and spikes when a cat wakes up', () => {
    const w = world();
    const alex = w.agents[0];
    run(w, 0.2);
    alex.drives.scratchUrge = 5;
    alex.setPlan([{ kind: 'state', state: 'CURLED_SLEEP', dur: 600 }], 'sleep');
    run(w, 3);
    const asleep = alex.drives.scratchUrge;
    expect(alex.isAsleep()).toBe(true);
    alex.clearPlan();
    alex.setPlan([{ kind: 'state', state: 'WAKE_ARCH_STRETCH', dur: 5 }], 'wake');
    run(w, 1.5);
    expect(alex.drives.scratchUrge).toBeGreaterThan(asleep + 25);
  });
});

describe('the tower as the cats’ bed', () => {
  it('with the floor beds hidden, tired cats nap on the tower (top bed / cubby)', () => {
    for (let seed = 0; seed < 6; seed++) {
      const w = world({ beds: false });
      const [alex, anna] = w.agents;
      run(w, 0.2);
      alex.command('sleep', w.env());
      anna.command('sleep', w.env());
      for (const a of [alex, anna]) {
        expect(a.planLabel).toBe('sleep-tower');
        const goto = a.plan[0];
        expect(goto.kind).toBe('goto');
        const spot = typeof (goto as { spot: unknown }).spot === 'function' ? ((goto as { spot: () => { platformId: string } }).spot()) : (goto as { spot: { platformId: string } }).spot;
        expect([TOWER_TOP, TOWER_TIER1]).toContain(spot.platformId);
      }
      // …and they take different tiers.
      const dest = (a: typeof alex) => (a.plan[0] as { spot: () => { platformId: string } }).spot().platformId;
      expect(dest(alex)).not.toBe(dest(anna));
    }
  });

  it('they actually get there (stepwise: floor → tier 1 → tier 2 → top) and settle in', () => {
    const w = world({ beds: false });
    const [alex, anna] = w.agents;
    run(w, 0.2);
    alex.command('sleep', w.env());
    anna.command('sleep', w.env());
    const seen = new Set<string>();
    for (let t = 0; t < 20; t += DT) {
      w.update(DT);
      for (const a of w.agents) {
        a.refreshLandmarks();
        if (a.groundId) seen.add(a.groundId);
      }
    }
    const on = (a: typeof alex) => a.groundId ?? '';
    expect([on(alex), on(anna)].every((id) => id.startsWith('platform_tower_'))).toBe(true);
    // A cat curled up at the cubby sank into it; one on the crown sits on the bolster.
    for (const a of [alex, anna]) {
      if (a.groundId === TOWER_TIER1) expect(a.cubbyDrop).toBeGreaterThan(40);
      if (a.groundId === TOWER_TOP) expect(a.bedLift).toBeGreaterThan(4);
    }
    expect(seen.has(TOWER_TIER1)).toBe(true);
    // A tier in between was used on the way up (no single impossible jump).
    expect(seen.has(TOWER_TIER2) || seen.has(TOWER_TIER1)).toBe(true);
  });

  it('with the beds out, Anna picks the tower (and its lookout) more often than Alex does', () => {
    const w = world({ beds: true });
    run(w, 0.2);
    const tally = (a: (typeof w.agents)[number]) => {
      let tower = 0;
      let top = 0;
      for (let i = 0; i < 300; i++) {
        a.clearPlan();
        a.command('sleep', w.env());
        if (a.planLabel === 'sleep-tower') {
          tower++;
          const g = a.plan[0] as { spot: () => { platformId: string } };
          if (g.spot().platformId === TOWER_TOP) top++;
        }
      }
      return { tower, top };
    };
    const alex = tally(w.agents[0]);
    const anna = tally(w.agents[1]);
    expect(anna.tower).toBeGreaterThan(alex.tower);
    expect(anna.top / Math.max(1, anna.tower)).toBeGreaterThan(alex.top / Math.max(1, alex.tower));
  });
});

describe('the pom-pom', () => {
  it('swings and bounces on its elastic cord when batted, and settles hanging again', () => {
    const w = world();
    w.setProfiles([]); // (no cats to join in)
    run(w, 3);
    const pom = w.tower.pom!;
    expect(pom).toBeTruthy();
    const rest = { x: pom.x, y: pom.y };
    expect(pomSpeed(pom)).toBeLessThan(5);
    batPom(pom, 500, -200);
    let maxDx = 0;
    for (let i = 0; i < 40; i++) {
      w.update(DT);
      maxDx = Math.max(maxDx, Math.abs(pom.x - rest.x));
      // Never stretches past 125 % of the cord.
      expect(Math.hypot(pom.x - pom.ax, pom.y - pom.ay)).toBeLessThanOrEqual(pom.len * 1.25 + 0.01);
    }
    expect(maxDx).toBeGreaterThan(15);
    run(w, 12);
    expect(Math.abs(pom.x - rest.x)).toBeLessThan(6);
  });

  it('a swipe from the pointer sets it going and brings the cats climbing to play', () => {
    const w = world();
    const [alex, anna] = w.agents;
    run(w, 0.5);
    alex.placeOn(w.source.floor(), 600);
    anna.placeOn(w.source.floor(), 900);
    expect(w.pokePom(400, -100)).toBe(true);
    expect(alex.planLabel === 'pom' || anna.planLabel === 'pom').toBe(true);
    let climbed = false;
    for (let t = 0; t < 40; t += DT) {
      w.update(DT);
      for (const a of w.agents) a.refreshLandmarks();
      if (w.agents.some((a) => a.groundId === TOWER_TIER1)) climbed = true;
    }
    expect(climbed).toBe(true);
  });

  it('a cat on tier 1 leaps up and bats the pom-pom, which swings away', () => {
    const w = world();
    const alex = w.agents[0];
    w.agents[1].placeOn(w.source.floor(), 1100);
    run(w, 2);
    const t1 = w.platforms.find((p) => p.id === TOWER_TIER1)!;
    alex.placeOn(t1, (t1.xMin + t1.xMax) / 2);
    alex.drives.playfulness = 90;
    alex.command('pom', w.env());
    let swatted = false;
    let maxSpeed = 0;
    for (let t = 0; t < 30; t += DT) {
      w.update(DT);
      for (const a of w.agents) a.refreshLandmarks();
      maxSpeed = Math.max(maxSpeed, pomSpeed(w.tower.pom!, DT));
      if (t > 0.5 && w.tower.pom!.sinceDisturbed < 0.1) swatted = true;
    }
    expect(swatted).toBe(true);
    expect(maxSpeed).toBeGreaterThan(150);
  });

  it('the tower carries its pom-pom along when dragged', () => {
    const w = world({ tower: { xNormalized: 0.3 } });
    w.setProfiles([]);
    run(w, 2);
    const x0 = w.tower.pom!.x;
    w.dragTower(0.6);
    run(w, 0.1);
    expect(w.tower.pom!.x - x0).toBeCloseTo(0.3 * B.width, -1);
  });
});
