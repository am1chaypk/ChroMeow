/**
 * Integration tests: the real World, agents, brain, FSM, physics and social
 * coordinator running headless on a mock page (no canvas needed — the coat
 * texture is only built when a cat is drawn).
 */
import { describe, expect, it } from 'vitest';
import { World, GRAB_DISTANCE } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { makeFloor, type Platform, type PlatformSource, type WorldBounds } from '../src/engine/Physics';
import type { CatState } from '../src/shared/catStates';
import type { CatAgent } from '../src/sim/CatAgent';

const B: WorldBounds = { width: 1200, height: 700 };
const DT = 1 / 30;

function makeWorld(cats = [createAlex()], source: PlatformSource = new StaticPlatformSource(B, [])): World {
  const w = new World({ source, settings: { ...DEFAULT_SETTINGS }, station: { enabled: true, xNormalized: 0.75, foodLevel: 80, waterLevel: 80 } });
  w.setProfiles(cats);
  return w;
}

/** Steps the world; returns every state each agent passed through (in order, de-duplicated). */
function run(w: World, seconds: number, until?: () => boolean): Map<string, CatState[]> {
  const seen = new Map<string, CatState[]>();
  for (let t = 0; t < seconds; t += DT) {
    w.update(DT);
    for (const a of w.agents) {
      a.refreshLandmarks(); // stands in for drawing (landmarks drive hit-tests and particles)
      const list = seen.get(a.id) ?? [];
      if (list[list.length - 1] !== a.state) list.push(a.state);
      seen.set(a.id, list);
    }
    if (until?.()) break;
  }
  return seen;
}

const agent = (w: World, id: string) => w.agents.find((a) => a.id === id) as CatAgent;

describe('food & water station', () => {
  it('a hungry cat walks to the food bowl, eats, then washes its face', () => {
    const w = makeWorld();
    const a = agent(w, 'alex');
    a.placeOn(w.source.floor(), 200);
    a.drives.hunger = 80;
    const food0 = w.station.level('food');
    const seen = run(w, 90, () => a.state === 'GROOM_WASH_FACE').get('alex') as CatState[];
    expect(seen).toContain('SEEKING_FOOD');
    expect(seen).toContain('EATING');
    expect(seen[seen.length - 1]).toBe('GROOM_WASH_FACE');
    expect(a.drives.hunger).toBeLessThan(20);
    expect(w.station.level('food')).toBeLessThan(food0);
    expect(w.station.dirty).toBe(true);
    // It ate standing just beside the food bowl, facing it.
    const app = w.station.approach('food', a.S, B);
    expect(Math.abs(a.x - app.x)).toBeLessThan(40);
  });

  it('a thirsty cat drinks from the water bowl', () => {
    const w = makeWorld();
    const a = agent(w, 'alex');
    a.placeOn(w.source.floor(), 400);
    a.drives.thirst = 75;
    const seen = run(w, 90, () => a.state === 'GROOM_WASH_FACE').get('alex') as CatState[];
    expect(seen).toContain('SEEKING_WATER');
    expect(seen).toContain('DRINKING');
    expect(a.drives.thirst).toBeLessThan(20);
    expect(w.station.level('water')).toBeLessThan(80);
  });

  it('at an empty bowl a very hungry cat sits, looks up and asks — and eats once it is refilled', () => {
    const w = makeWorld();
    const a = agent(w, 'alex');
    a.placeOn(w.source.floor(), 300);
    w.station.consume('food', 100);
    a.drives.hunger = 88;
    run(w, 60, () => a.state === 'EMPTY_BOWL_WAIT');
    expect(a.state).toBe('EMPTY_BOWL_WAIT');
    let bubbles = 0;
    run(w, 9, () => {
      bubbles = Math.max(bubbles, w.particles.count);
      return false;
    });
    expect(bubbles).toBeGreaterThan(0); // the fish thought bubble
    w.refill('food');
    expect(w.station.level('food')).toBe(100);
    const seen = run(w, 40, () => a.state === 'EATING').get('alex') as CatState[];
    expect(seen).toContain('EATING');
  });

  it('two cats never eat from the same bowl at once', () => {
    const w = makeWorld([createAlex(), createAnna()]);
    const [a, b] = w.agents;
    a.placeOn(w.source.floor(), 150);
    b.placeOn(w.source.floor(), 260);
    a.drives.hunger = 85;
    b.drives.hunger = 85;
    let both = 0;
    run(w, 60, () => {
      if (a.state === 'EATING' && b.state === 'EATING') both++;
      return false;
    });
    expect(both).toBe(0);
  });

  it('hit-tests bowls and the mat, and slides along the floor', () => {
    const w = makeWorld();
    const g = w.station.geom(B);
    expect(w.stationHit(g.bowls.food.x, g.bowls.food.rimY + 4)).toBe('food');
    expect(w.stationHit(g.bowls.water.x, g.bowls.water.rimY + 4)).toBe('water');
    expect(w.stationHit(g.cx, g.floorY - 2)).toBe('mat');
    expect(w.stationHit(20, 20)).toBeNull();
    w.station.moveTo(0.3);
    expect(w.station.geom(B).cx).toBeCloseTo(360, 0);
    w.station.moveTo(1.4);
    expect(w.station.state.xNormalized).toBe(1);
    expect(w.station.geom(B).cx).toBeLessThan(B.width - 100); // room left for a cat beside the water bowl
  });
});

describe('scruff grab & drag', () => {
  function grabbedWorld(): { w: World; a: CatAgent } {
    const w = makeWorld();
    const a = agent(w, 'alex');
    a.placeOn(w.source.floor(), 500);
    run(w, 0.5);
    a.refreshLandmarks();
    return { w, a };
  }

  it('a press on the scruff picks the cat up at once and locks the pointer', () => {
    const { w, a } = grabbedWorld();
    let locks = 0;
    let unlocks = 0;
    w.hooks = { grabStart: () => locks++, grabEnd: () => unlocks++ };
    const sc = a.lm!.scruff;
    expect(w.zoneAt(a, sc.x, sc.y)).toBe('SCRUFF');
    w.pointerDown(sc.x, sc.y, 1);
    expect(w.held).toBe(a);
    expect(a.isHeld()).toBe(true);
    expect(locks).toBe(1);
    run(w, 0.2);
    expect(a.state).toBe('SCRUFF_HELD');
    w.pointerUp(sc.x, sc.y);
    expect(unlocks).toBe(1);
    expect(w.held).toBeNull();
  });

  it('a press elsewhere on the body only becomes a grab after dragging more than 5 px', () => {
    const { w, a } = grabbedWorld();
    const p = a.lm!.backTop;
    const x = p.x;
    const y = p.y + 6;
    w.pointerDown(x, y, 1);
    expect(w.held).toBeNull();
    w.pointerMove(x + 3, y, 1.02);
    expect(w.held).toBeNull();
    w.pointerMove(x + 3 + GRAB_DISTANCE, y, 1.04);
    expect(w.held).toBe(a);
  });

  it('hangs from the hand: the nape follows the cursor, the body sways and settles, the tail droops', () => {
    const { w, a } = grabbedWorld();
    const sc = a.lm!.scruff;
    w.pointerDown(sc.x, sc.y, 1);
    let t = 1;
    // Lift and sweep right quickly.
    for (let i = 1; i <= 15; i++) {
      t += DT;
      w.pointerMove(sc.x + i * 18, sc.y - i * 8, t);
      w.update(DT);
    }
    expect(a.holdAngle).toBeLessThan(-0.15); // body trails to the left
    expect(Math.abs(a.holdAngle)).toBeLessThanOrEqual(0.65);
    // Hold still: it settles hanging straight down.
    for (let i = 0; i < 90; i++) {
      t += DT;
      w.pointerMove(sc.x + 270, sc.y - 120, t);
      w.update(DT);
    }
    expect(Math.abs(a.holdAngle)).toBeLessThan(0.03);
    a.refreshLandmarks();
    const lm = a.lm!;
    expect(Math.hypot(lm.scruff.x - (sc.x + 270), lm.scruff.y - (sc.y - 120))).toBeLessThan(2);
    // Body hangs below the nape; the tail tip is the lowest point-ish (gravity).
    expect(lm.bounds.maxY).toBeGreaterThan(lm.scruff.y + 40 * a.S);
    const tip = lm.tail[lm.tail.length - 1];
    expect(tip.y).toBeGreaterThan(lm.scruff.y + 30 * a.S);
  });

  it('a toss carries momentum; the cat falls, lands on the floor and tidies its fur', () => {
    const { w, a } = grabbedWorld();
    const sc = a.lm!.scruff;
    w.pointerDown(sc.x, sc.y, 1);
    let t = 1;
    for (let i = 1; i <= 12; i++) {
      t += DT;
      w.pointerMove(sc.x - 200 + i * 2, sc.y - 200 - i * 2, t);
      w.update(DT);
    }
    // Quick flick to the right, then let go mid-motion.
    for (let i = 1; i <= 4; i++) {
      t += DT;
      w.pointerMove(sc.x - 176 + i * 30, sc.y - 224, t);
      w.update(DT);
    }
    const x0 = a.x;
    w.pointerUp(sc.x - 56, sc.y - 224);
    expect(a.isHeld()).toBe(false);
    expect(a.vx).toBeGreaterThan(300);
    const seen = run(w, 6, () => a.state === 'GROOM_LICK_PAW').get('alex') as CatState[];
    expect(seen).toContain('FALL_DESCEND');
    expect(seen).toContain('LAND_RECOVERY');
    expect(a.state).toBe('GROOM_LICK_PAW');
    expect(a.groundId).toBe('floor');
    expect(a.x).toBeGreaterThan(x0 + 50);
  });

  it('losing focus mid-drag sets the cat down gently', () => {
    const { w, a } = grabbedWorld();
    const sc = a.lm!.scruff;
    w.pointerDown(sc.x, sc.y, 1);
    w.pointerMove(sc.x + 40, sc.y - 80, 1.1);
    w.update(DT);
    w.pointerCancel();
    expect(a.isHeld()).toBe(false);
    expect(Math.abs(a.vx)).toBeLessThan(1);
    run(w, 4, () => a.groundId === 'floor');
    expect(a.groundId).toBe('floor');
  });
});

describe('idle cuddle', () => {
  it('when the user is away, Alex and Anna gather, lick, and fall asleep pressed together', () => {
    const w = makeWorld([createAlex(), createAnna()]);
    const alex = agent(w, 'alex');
    const anna = agent(w, 'anna');
    alex.placeOn(w.source.floor(), 150);
    anna.placeOn(w.source.floor(), 650);
    run(w, 1);
    w.setUserIdle(true);
    const seen = run(w, 120, () => alex.state === 'CUDDLE_SLEEP' && anna.state === 'CUDDLE_SLEEP');
    expect(alex.state).toBe('CUDDLE_SLEEP');
    expect(anna.state).toBe('CUDDLE_SLEEP');
    // A brief mutual lick first.
    expect(seen.get('alex')).toContain('ALLOGROOMING');
    expect(seen.get('anna')).toContain('ALLOGROOMING');
    // Anna (the snuggler) drapes over Alex (the pillow); both face the same way, close together.
    expect(alex.poseRole).toBe(0);
    expect(anna.poseRole).toBe(1);
    expect(alex.facing).toBe(anna.facing);
    expect(Math.abs(alex.x - anna.x)).toBeLessThan(alex.bodyLen());
    // …and clear of the food & water station.
    const r = w.station.rect(B);
    expect(Math.min(alex.x, anna.x) > r.maxX || Math.max(alex.x, anna.x) < r.minX).toBe(true);
    // Shared, synchronised breathing once they have settled.
    run(w, 10);
    expect(alex.state).toBe('CUDDLE_SLEEP');
    expect(alex.pose.breathRate).toBeCloseTo(anna.pose.breathRate, 2);
  });

  it('when the user comes back they blink, stretch, yawn, and one trots over to greet', () => {
    const w = makeWorld([createAlex(), createAnna()]);
    const alex = agent(w, 'alex');
    const anna = agent(w, 'anna');
    alex.placeOn(w.source.floor(), 300);
    anna.placeOn(w.source.floor(), 420);
    w.setUserIdle(true);
    run(w, 120, () => alex.state === 'CUDDLE_SLEEP' && anna.state === 'CUDDLE_SLEEP');
    w.pointerMove(1000, 500, 1);
    w.setUserIdle(false);
    const seen = run(w, 30, () => alex.state === 'CURSOR_GAZE');
    for (const id of ['alex', 'anna']) {
      const s = seen.get(id) as CatState[];
      expect(s.indexOf('WAKE_ARCH_STRETCH')).toBeGreaterThan(-1);
      expect(s.indexOf('BIG_YAWN')).toBeGreaterThan(s.indexOf('WAKE_ARCH_STRETCH'));
    }
    // Alex (the more affectionate) greets: trots to the cursor and looks up at it.
    expect(seen.get('alex')).toContain('TROT');
    expect(alex.state).toBe('CURSOR_GAZE');
    expect(Math.abs(alex.x - 1000)).toBeLessThan(80);
  });
});

/** A page that scrolls: ledges move up as scrollY grows; `pinned` ledges (fixed / sticky) don't. */
class ScrollingPage implements PlatformSource {
  scrollY = 0;
  private floorP = makeFloor(B);
  constructor(private readonly ledges: { id: string; xMin: number; xMax: number; docY: number; pinned?: boolean }[]) {}
  private at(l: { id: string; xMin: number; xMax: number; docY: number; pinned?: boolean }): Platform {
    return { id: l.id, kind: 'dom', xMin: l.xMin, xMax: l.xMax, y: l.pinned ? l.docY : l.docY - this.scrollY, warm: 0.1, narrow: false, tag: 'div', elementRef: null };
  }
  platforms(): readonly Platform[] {
    return this.ledges.map((l) => this.at(l)).filter((p) => p.y > 0 && p.y < B.height);
  }
  get(id: string): Platform | null {
    if (id === 'floor') return this.floorP;
    const l = this.ledges.find((x) => x.id === id);
    return l ? this.at(l) : null;
  }
  floor(): Platform {
    return this.floorP;
  }
  bounds(): WorldBounds {
    return B;
  }
  scrollOffset(): { x: number; y: number } {
    return { x: 0, y: this.scrollY };
  }
}

describe('scrolling', () => {
  it('a cat on a page element rides it while the page scrolls (no floating, no startle)', () => {
    const page = new ScrollingPage([{ id: 'card', xMin: 300, xMax: 800, docY: 450 }]);
    const w = makeWorld([createAlex()], page);
    const a = agent(w, 'alex');
    a.placeOn(page.get('card') as Platform, 520);
    a.setPlan([{ kind: 'state', state: 'CAT_LOAF', dur: 99 }], 'test', true);
    run(w, 2);
    // A fast wheel flick: 140 px in one frame, then more.
    for (const dy of [140, 60, 40]) {
      page.scrollY += dy;
      w.update(DT);
      expect(a.groundId).toBe('card');
      expect(a.y).toBeCloseTo(450 - page.scrollY, 5);
    }
    expect(a.state).not.toBe('STARTLED_AIRBORNE');
  });

  it('a cat on a fixed header stays put while the page scrolls under it', () => {
    const page = new ScrollingPage([{ id: 'header', xMin: 100, xMax: 1100, docY: 120, pinned: true }]);
    const w = makeWorld([createAlex()], page);
    const a = agent(w, 'alex');
    a.placeOn(page.get('header') as Platform, 500);
    a.setPlan([{ kind: 'state', state: 'CAT_LOAF', dur: 99 }], 'test', true);
    run(w, 1);
    page.scrollY += 200;
    w.update(DT);
    expect(a.groundId).toBe('header');
    expect(a.y).toBeCloseTo(120, 5);
  });

  it('when its ledge scrolls out of the top of the screen, the cat hops down to the floor', () => {
    const page = new ScrollingPage([{ id: 'card', xMin: 300, xMax: 800, docY: 300 }]);
    const w = makeWorld([createAlex()], page);
    const a = agent(w, 'alex');
    a.placeOn(page.get('card') as Platform, 520);
    a.setPlan([{ kind: 'state', state: 'IDLE_SIT', dur: 99 }], 'test', true);
    run(w, 1);
    for (let i = 0; i < 10; i++) {
      page.scrollY += 30;
      w.update(DT);
    }
    const seen = run(w, 5, () => a.groundId === 'floor').get('alex') as CatState[];
    expect(a.groundId).toBe('floor');
    expect(seen).toContain('FALL_DESCEND');
    expect(seen).not.toContain('STARTLED_AIRBORNE');
  });
});
