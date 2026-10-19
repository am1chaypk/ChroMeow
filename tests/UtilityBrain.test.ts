import { describe, expect, it } from 'vitest';
import { INTENTS, UtilityBrain, scoreIntents, type BrainContext, type IntentKind } from '../src/ai/UtilityBrain';
import { updateDrives } from '../src/ai/Drives';
import { createCat1, createCat2 } from '../src/shared/presets';

function ctx(over: Partial<BrainContext> = {}): BrainContext {
  const cat = createCat1();
  return {
    drives: { energy: 60, playfulness: 40, affection: 60, curiosity: 40, irritation: 5, socialNeed: 30 },
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
    const s = scoreIntents(ctx({ drives: { energy: 8, playfulness: 10, affection: 60, curiosity: 20, irritation: 0, socialNeed: 10 } }));
    expect(best(s)).toBe('sleep');
  });

  it('a rested cat with prey-like cursor movement nearby wants to hunt', () => {
    const cat = createCat2();
    const s = scoreIntents(
      ctx({
        personality: { ...cat.personality, huntDrive: 0.9, laziness: 0.2 },
        drives: { energy: 90, playfulness: 95, affection: 50, curiosity: 30, irritation: 0, socialNeed: 10 },
        cursor: { present: true, dist: 140, speed: 600, erratic: 0.9, idle: 0.1 },
      }),
    );
    expect(best(s)).toBe('hunt');
  });

  it('food beats everything', () => {
    const s = scoreIntents(ctx({ toy: { kind: 'treat', dist: 300 }, drives: { energy: 5, playfulness: 0, affection: 10, curiosity: 0, irritation: 0, socialNeed: 0 } }));
    expect(best(s)).toBe('treat');
  });

  it('typing nearby makes a curious cat want to watch the keyboard', () => {
    const s = scoreIntents(ctx({ typing: { active: true, dist: 150 }, drives: { energy: 70, playfulness: 20, affection: 50, curiosity: 85, irritation: 0, socialNeed: 10 } }));
    expect(best(s)).toBe('keyboard');
  });

  it('personality weights shift utilities (sociability → social)', () => {
    const base = ctx({ partner: { exists: true, dist: 200, asleep: false, available: true }, drives: { energy: 60, playfulness: 40, affection: 60, curiosity: 30, irritation: 0, socialNeed: 80 } });
    const shy = scoreIntents({ ...base, personality: { ...base.personality, sociability: 0.1 } });
    const social = scoreIntents({ ...base, personality: { ...base.personality, sociability: 0.95 } });
    expect(social.social).toBeGreaterThan(shy.social + 0.5);
  });

  it('never returns negative utilities', () => {
    const s = scoreIntents(ctx({ drives: { energy: 100, playfulness: 100, affection: 0, curiosity: 0, irritation: 100, socialNeed: 0 } }));
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
    const c = ctx({ drives: { energy: 55, playfulness: 30, affection: 50, curiosity: 55, irritation: 0, socialNeed: 0 } });
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
    const p = createCat1().personality;
    const d = { energy: 40, playfulness: 70, affection: 50, curiosity: 50, irritation: 20, socialNeed: 40 };
    updateDrives(d, 'CURLED_SLEEP', 10, p, { social: false, pettedNicely: false, alone: false });
    expect(d.energy).toBeGreaterThan(44);
    const e0 = d.energy;
    const p0 = d.playfulness;
    updateDrives(d, 'ZOOMIES_SPRINT', 10, p, { social: false, pettedNicely: false, alone: false });
    expect(d.energy).toBeLessThan(e0);
    expect(d.playfulness).toBeLessThan(p0);
  });

  it('petting raises affection and social interaction satisfies social need', () => {
    const p = createCat2().personality;
    const d = { energy: 50, playfulness: 50, affection: 30, curiosity: 50, irritation: 0, socialNeed: 80 };
    updateDrives(d, 'PURRING', 5, p, { social: true, pettedNicely: true, alone: false });
    expect(d.affection).toBeGreaterThan(50);
    expect(d.socialNeed).toBeLessThan(75);
  });
});
