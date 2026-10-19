import { describe, expect, it } from 'vitest';
import { INTENTS, UtilityBrain, mealScore, scoreIntents, type BrainContext, type IntentKind } from '../src/ai/UtilityBrain';
import { HUNGER_SEEK, activityFactor, completeDrives, updateDrives } from '../src/ai/Drives';
import { createAlex, createAnna } from '../src/shared/presets';

function ctx(over: Partial<BrainContext> = {}): BrainContext {
  const cat = createAlex();
  return {
    drives: { energy: 60, playfulness: 40, affection: 60, curiosity: 40, irritation: 5, socialNeed: 30, hunger: 20, thirst: 20 },
    personality: cat.personality,
    signature: cat.signature,
    cursor: { present: false, dist: Infinity, speed: 0, erratic: 0, idle: 99 },
    typing: { active: false, dist: Infinity },
    partner: { exists: false, dist: Infinity, asleep: false, available: false },
    toy: { kind: null, dist: Infinity },
    warmSpot: false,
    narrowLedge: false,
    edgeSpot: true,
    timeSinceGroom: 30,
    timeSinceZoomies: 300,
    timeSinceClimb: 300,
    hour: 11,
    calm: false,
    petted: false,
    ...over,
  };
}

function best(scores: Record<IntentKind, number>): IntentKind {
  return INTENTS.reduce((a, b) => (scores[b] > scores[a] ? b : a));
}

describe('UtilityBrain scoring  U(a) = Σ wᵢ·fᵢ(dᵢ, context) + ε', () => {
  it('a tired, lazy cat wants to sleep', () => {
    const s = scoreIntents(ctx({ drives: { energy: 8, playfulness: 10, affection: 60, curiosity: 20, irritation: 0, socialNeed: 10, hunger: 20, thirst: 20 } }));
    expect(best(s)).toBe('sleep');
  });

  it('a rested cat with prey-like cursor movement nearby wants to hunt', () => {
    const cat = createAnna();
    const s = scoreIntents(
      ctx({
        personality: { ...cat.personality, huntDrive: 0.9, laziness: 0.2 },
        drives: { energy: 90, playfulness: 95, affection: 50, curiosity: 30, irritation: 0, socialNeed: 10, hunger: 20, thirst: 20 },
        cursor: { present: true, dist: 140, speed: 600, erratic: 0.9, idle: 0.1 },
      }),
    );
    expect(best(s)).toBe('hunt');
  });

  it('food beats everything', () => {
    const s = scoreIntents(ctx({ toy: { kind: 'treat', dist: 300 }, drives: { energy: 5, playfulness: 0, affection: 10, curiosity: 0, irritation: 0, socialNeed: 0, hunger: 20, thirst: 20 } }));
    expect(best(s)).toBe('treat');
  });

  it('typing nearby makes a curious cat want to watch the keyboard', () => {
    const s = scoreIntents(ctx({ typing: { active: true, dist: 150 }, drives: { energy: 70, playfulness: 20, affection: 50, curiosity: 85, irritation: 0, socialNeed: 10, hunger: 20, thirst: 20 } }));
    expect(best(s)).toBe('keyboard');
  });

  it('personality weights shift utilities (sociability → social)', () => {
    const base = ctx({ partner: { exists: true, dist: 200, asleep: false, available: true }, drives: { energy: 60, playfulness: 40, affection: 60, curiosity: 30, irritation: 0, socialNeed: 80, hunger: 20, thirst: 20 } });
    const shy = scoreIntents({ ...base, personality: { ...base.personality, sociability: 0.1 } });
    const social = scoreIntents({ ...base, personality: { ...base.personality, sociability: 0.95 } });
    expect(social.social).toBeGreaterThan(shy.social + 0.5);
  });

  it('never returns negative utilities', () => {
    const s = scoreIntents(ctx({ drives: { energy: 100, playfulness: 100, affection: 0, curiosity: 0, irritation: 100, socialNeed: 0, hunger: 20, thirst: 20 } }));
    for (const k of INTENTS) expect(s[k]).toBeGreaterThanOrEqual(0);
  });
});

describe('UtilityBrain decisions', () => {
  it('is deterministic for a given seed', () => {
    const a = new UtilityBrain('seed');
    const b = new UtilityBrain('seed');
    for (let i = 0; i < 20; i++) expect(a.decide(ctx()).intent).toBe(b.decide(ctx()).intent);
  });

  it('hysteresis keeps a committed intent against a marginally better one', () => {
    const brain = new UtilityBrain(3);
    brain.set('rest');
    // Rest vs explore roughly tied:
    const c = ctx({ drives: { energy: 55, playfulness: 30, affection: 50, curiosity: 55, irritation: 0, socialNeed: 0, hunger: 20, thirst: 20 } });
    let switches = 0;
    for (let i = 0; i < 30; i++) {
      brain.tick(0.5);
      if (brain.decide(c).switched) switches++;
    }
    expect(switches).toBeLessThanOrEqual(2);
  });

  it('switches decisively when the situation changes a lot', () => {
    const brain = new UtilityBrain(4);
    brain.set('rest');
    const d = brain.decide(ctx({ toy: { kind: 'treat', dist: 100 } }));
    expect(d.intent).toBe('treat');
    expect(d.switched).toBe(true);
  });
});

describe('drives', () => {
  it('sleep restores energy, play spends it and lowers playfulness', () => {
    const p = createAlex().personality;
    const d = { energy: 40, playfulness: 70, affection: 50, curiosity: 50, irritation: 20, socialNeed: 40, hunger: 20, thirst: 20 };
    updateDrives(d, 'CURLED_SLEEP', 10, p, { social: false, pettedNicely: false, alone: false });
    expect(d.energy).toBeGreaterThan(44);
    const e0 = d.energy;
    const p0 = d.playfulness;
    updateDrives(d, 'ZOOMIES_SPRINT', 10, p, { social: false, pettedNicely: false, alone: false });
    expect(d.energy).toBeLessThan(e0);
    expect(d.playfulness).toBeLessThan(p0);
  });

  it('petting raises affection and social interaction satisfies social need', () => {
    const p = createAnna().personality;
    const d = { energy: 50, playfulness: 50, affection: 30, curiosity: 50, irritation: 0, socialNeed: 80, hunger: 20, thirst: 20 };
    updateDrives(d, 'PURRING', 5, p, { social: true, pettedNicely: true, alone: false });
    expect(d.affection).toBeGreaterThan(50);
    expect(d.socialNeed).toBeLessThan(75);
  });
});

describe('hunger, thirst and the food & water station', () => {
  const station = (food: number, water: number, begReady = true) => ({ exists: true, food, water, dist: 300, begReady });
  const hungry = { energy: 60, playfulness: 40, affection: 60, curiosity: 40, irritation: 5, socialNeed: 30, hunger: 70, thirst: 20 };

  it('a hungry cat heads for the food bowl above everything else', () => {
    const s = scoreIntents(ctx({ drives: hungry, station: station(60, 60), toy: { kind: 'treat', dist: 100 } }));
    expect(best(s)).toBe('eat');
    expect(s.eat).toBeGreaterThan(s.treat);
  });

  it('a thirsty cat heads for the water bowl', () => {
    const s = scoreIntents(ctx({ drives: { ...hungry, hunger: 20, thirst: 64 }, station: station(60, 60) }));
    expect(best(s)).toBe('drink');
  });

  it('stays put below the thresholds and when there is no station', () => {
    const calm = scoreIntents(ctx({ drives: { ...hungry, hunger: 30, thirst: 30 }, station: station(60, 60) }));
    expect(best(calm)).not.toBe('eat');
    expect(best(calm)).not.toBe('drink');
    const none = scoreIntents(ctx({ drives: { ...hungry, hunger: 95 } }));
    expect(none.eat).toBe(0);
  });

  it('asks for a refill at an empty bowl only when very hungry, and not again right after giving up', () => {
    expect(mealScore(70, 0, HUNGER_SEEK, true)).toBe(0); // hungry, but not hungry enough to beg
    expect(mealScore(82, 0, HUNGER_SEEK, true)).toBeGreaterThan(2);
    expect(mealScore(82, 3, HUNGER_SEEK, true)).toBeGreaterThan(2); // ≤ 5 % counts as empty
    expect(mealScore(82, 0, HUNGER_SEEK, false)).toBe(0); // cooling down after a long wait
    const s = scoreIntents(ctx({ drives: { ...hungry, hunger: 85 }, station: station(0, 60) }));
    expect(best(s)).toBe('eat');
  });

  it('a hungry brain switches to eating even while committed to something else', () => {
    const brain = new UtilityBrain(7);
    brain.set('rest');
    const d = brain.decide(ctx({ drives: hungry, station: station(80, 80) }));
    expect(d.intent).toBe('eat');
  });

  it('appetite builds over time, faster when active and for hungrier cats', () => {
    const alex = createAlex();
    const anna = createAnna();
    const idleA = { ...hungry, hunger: 0, thirst: 0 };
    const idleB = { ...idleA };
    updateDrives(idleA, 'IDLE_SIT', 100, alex.personality, { social: false, pettedNicely: false, alone: false, hungerRate: alex.traits.hungerRateMultiplier });
    updateDrives(idleB, 'IDLE_SIT', 100, anna.personality, { social: false, pettedNicely: false, alone: false, hungerRate: anna.traits.hungerRateMultiplier });
    expect(idleA.hunger).toBeGreaterThan(idleB.hunger); // Alex: hungerRateMultiplier 1.15
    const busy = { ...hungry, hunger: 0, thirst: 0 };
    updateDrives(busy, 'ZOOMIES_SPRINT', 100, alex.personality, { social: false, pettedNicely: false, alone: false, hungerRate: 1 });
    const still = { ...hungry, hunger: 0, thirst: 0 };
    updateDrives(still, 'IDLE_SIT', 100, alex.personality, { social: false, pettedNicely: false, alone: false, hungerRate: 1 });
    expect(busy.hunger).toBeGreaterThan(still.hunger * 2);
    expect(busy.thirst).toBeGreaterThan(still.thirst * 2);
    expect(activityFactor('POUNCE_AND_PIN')).toBeGreaterThan(activityFactor('SAUNTER_WALK'));
    expect(activityFactor('CURLED_SLEEP')).toBeLessThan(1);
  });

  it('fills in hunger and thirst for drives saved by v1', () => {
    const d = completeDrives({ energy: 33, playfulness: 10, affection: 50, curiosity: 50, irritation: 0, socialNeed: 5 } as never, createAlex().personality);
    expect(d.energy).toBe(33);
    expect(d.hunger).toBeGreaterThan(0);
    expect(d.thirst).toBeGreaterThan(0);
  });
});
