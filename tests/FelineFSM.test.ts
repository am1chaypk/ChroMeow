import { describe, expect, it } from 'vitest';
import { ALL_STATES, SLEEP_STATES, type CatState } from '../src/shared/catStates';
import { FelineFSM } from '../src/ai/FelineFSM';
import { STATE_META, TRANSITIONS, canTransition, findPath, isPhysicsInterrupt, restorableState } from '../src/ai/States';

function runUntil(fsm: FelineFSM, target: CatState, maxSeconds = 30): CatState[] {
  const seen: CatState[] = [fsm.current];
  for (let t = 0; t < maxSeconds; t += 0.05) {
    fsm.update(0.05);
    if (seen[seen.length - 1] !== fsm.current) seen.push(fsm.current);
    if (fsm.current === target && fsm.queue.length === 0) break;
  }
  return seen;
}

describe('transition graph', () => {
  it('defines metadata and outgoing edges for every state', () => {
    for (const s of ALL_STATES) {
      expect(STATE_META[s]).toBeDefined();
      // Being held is the one state a cat never leaves on its own (only by being let go).
      if (s === 'SCRUFF_HELD') {
        expect(TRANSITIONS[s]).toEqual([]);
        continue;
      }
      expect(TRANSITIONS[s].length).toBeGreaterThan(0);
      for (const n of TRANSITIONS[s]) expect(ALL_STATES).toContain(n);
    }
  });

  it('enforces the full rest & wake chain from curled sleep to walking', () => {
    expect(findPath('CURLED_SLEEP', 'SAUNTER_WALK')).toEqual(['CURLED_SLEEP', 'SPRAWLED_SLEEP', 'WAKE_ARCH_STRETCH', 'BIG_YAWN', 'IDLE_SIT', 'IDLE_STAND', 'SAUNTER_WALK']);
  });

  it('every voluntary state is reachable from IDLE_SIT and every state can find its way back', () => {
    for (const s of ALL_STATES) {
      if (s === 'IDLE_SIT') continue;
      if (s === 'SCRUFF_HELD') {
        // Involuntary both ways: a hand picks the cat up from anything, letting go drops it.
        expect(findPath('IDLE_SIT', s)).toBeNull();
        expect(canTransition('CURLED_SLEEP', s)).toBe(true);
        expect(canTransition(s, 'FALL_DESCEND')).toBe(true);
        expect(findPath('FALL_DESCEND', 'IDLE_SIT')).not.toBeNull();
        continue;
      }
      if (s === 'STARTLED_AIRBORNE') {
        // Involuntary: only physics (a violent scroll, a vanished ledge) can startle a cat.
        expect(findPath('IDLE_SIT', s)).toBeNull();
        expect(canTransition('CURLED_SLEEP', s)).toBe(true);
        expect(findPath(s, 'IDLE_SIT')).not.toBeNull();
        continue;
      }
      expect(findPath('IDLE_SIT', s)).not.toBeNull();
      expect(findPath(s, 'IDLE_SIT')).not.toBeNull();
    }
  });

  it('never lets a sleeping cat reach an awake posture without the stretch (no squint shortcut)', () => {
    const awake = ALL_STATES.filter((s) => !SLEEP_STATES.has(s) && s !== 'JUDGMENTAL_AIRPLANE_SQUINT' && s !== 'WAKE_ARCH_STRETCH' && STATE_META[s].posture !== 'air' && STATE_META[s].posture !== 'held');
    for (const sleep of SLEEP_STATES) {
      for (const target of awake) {
        const path = findPath(sleep, target) as CatState[];
        expect(path).not.toBeNull();
        expect(path).toContain('WAKE_ARCH_STRETCH');
        expect(path.indexOf('BIG_YAWN')).toBeGreaterThan(path.indexOf('WAKE_ARCH_STRETCH'));
      }
    }
  });

  it('never teleports: consecutive path steps are always direct edges', () => {
    const samples: [CatState, CatState][] = [
      ['MELTED_LOAF_SLEEP', 'POUNCE_AND_PIN'],
      ['BELLY_UP_ROLL', 'ZOOMIES_SPRINT'],
      ['KEYBOARD_WATCH', 'WALL_CLIMB'],
      ['PILLOW_STACK_CUDDLE', 'EAT_TREAT'],
    ];
    for (const [a, b] of samples) {
      const p = findPath(a, b) as CatState[];
      for (let i = 1; i < p.length; i++) expect(TRANSITIONS[p[i - 1]]).toContain(p[i]);
    }
  });

  it('only allows physics interrupts for falls, startles and landings', () => {
    expect(isPhysicsInterrupt('CURLED_SLEEP', 'STARTLED_AIRBORNE')).toBe(true);
    expect(isPhysicsInterrupt('SAUNTER_WALK', 'FALL_DESCEND')).toBe(true);
    expect(isPhysicsInterrupt('FALL_DESCEND', 'LAND_RECOVERY')).toBe(true);
    expect(isPhysicsInterrupt('IDLE_SIT', 'LAND_RECOVERY')).toBe(false);
    expect(isPhysicsInterrupt('CURLED_SLEEP', 'FALL_DESCEND')).toBe(false);
    expect(canTransition('CURLED_SLEEP', 'SAUNTER_WALK')).toBe(false);
  });
});

describe('FelineFSM', () => {
  it('walks the natural chain over time when asked to walk while asleep', () => {
    const fsm = new FelineFSM('CURLED_SLEEP', 42);
    const seen: CatState[] = [fsm.current];
    fsm.onTransition((_from, to) => seen.push(to));
    expect(fsm.request('SAUNTER_WALK')).toBe(true);
    runUntil(fsm, 'SAUNTER_WALK');
    expect(seen).toEqual(['CURLED_SLEEP', 'SPRAWLED_SLEEP', 'WAKE_ARCH_STRETCH', 'BIG_YAWN', 'IDLE_SIT', 'IDLE_STAND', 'SAUNTER_WALK']);
  });

  it('dwells long enough in a stretch and a yawn to animate them', () => {
    const fsm = new FelineFSM('SPRAWLED_SLEEP', 1);
    fsm.request('IDLE_SIT');
    let stretch = 0;
    let yawn = 0;
    for (let i = 0; i < 400 && !(fsm.current === 'IDLE_SIT'); i++) {
      fsm.update(0.02);
      if (fsm.current === 'WAKE_ARCH_STRETCH') stretch += 0.02;
      if (fsm.current === 'BIG_YAWN') yawn += 0.02;
    }
    expect(stretch).toBeGreaterThanOrEqual(1.9);
    expect(yawn).toBeGreaterThanOrEqual(1.2);
  });

  it('defers requests while a committed state plays out', () => {
    const fsm = new FelineFSM('SPRAWLED_SLEEP', 3);
    fsm.request('IDLE_SIT');
    runUntil(fsm, 'WAKE_ARCH_STRETCH', 1);
    expect(fsm.current).toBe('WAKE_ARCH_STRETCH');
    fsm.request('CAT_LOAF');
    fsm.update(0.1);
    expect(fsm.current).toBe('WAKE_ARCH_STRETCH');
    const seen = runUntil(fsm, 'CAT_LOAF', 10);
    expect(seen).toContain('BIG_YAWN');
    expect(fsm.current).toBe('CAT_LOAF');
  });

  it('accepts physics interrupts and rejects illegal ones', () => {
    const fsm = new FelineFSM('CURLED_SLEEP', 5);
    expect(fsm.force('LAND_RECOVERY')).toBe(false);
    expect(fsm.force('STARTLED_AIRBORNE')).toBe(true);
    expect(fsm.force('LAND_RECOVERY')).toBe(true);
    runUntil(fsm, 'IDLE_STAND', 2);
    expect(fsm.current).toBe('IDLE_STAND');
  });

  it('returns from the judgmental squint to the exact sleep it interrupted', () => {
    const fsm = new FelineFSM('MELTED_LOAF_SLEEP', 9);
    fsm.request('JUDGMENTAL_AIRPLANE_SQUINT');
    expect(fsm.current).toBe('JUDGMENTAL_AIRPLANE_SQUINT');
    for (let i = 0; i < 200; i++) fsm.update(0.05);
    expect(fsm.current).toBe('MELTED_LOAF_SLEEP');
  });

  it('returns from a squint started while sitting back to sitting', () => {
    const fsm = new FelineFSM('IDLE_SIT', 9);
    fsm.request('JUDGMENTAL_AIRPLANE_SQUINT');
    for (let i = 0; i < 200; i++) fsm.update(0.05);
    expect(fsm.current).toBe('IDLE_SIT');
  });

  it('collapses transient states when restoring a cross-tab snapshot', () => {
    expect(restorableState('JUMP_ASCEND')).toBe('IDLE_STAND');
    expect(restorableState('BIG_YAWN')).toBe('IDLE_SIT');
    expect(restorableState('CHIN_PROP_SLEEP')).toBe('CHIN_PROP_SLEEP');
    const fsm = new FelineFSM('IDLE_SIT', 1);
    fsm.restore('ZOOMIES_SPRINT');
    expect(fsm.current).toBe('IDLE_STAND');
  });
});

describe('v2 states: scruff hold, meals, cuddle sleep', () => {
  it('picks a cat up by the scruff from any state, and only physics can enter it', () => {
    for (const from of ['CURLED_SLEEP', 'EATING', 'ZOOMIES_SPRINT', 'JUMP_ASCEND', 'BELLY_UP_ROLL', 'CUDDLE_SLEEP'] as CatState[]) {
      const fsm = new FelineFSM(from, 2);
      expect(fsm.force('SCRUFF_HELD')).toBe(true);
      expect(fsm.current).toBe('SCRUFF_HELD');
    }
    const fsm = new FelineFSM('IDLE_SIT', 2);
    expect(fsm.request('SCRUFF_HELD')).toBe(false);
    expect(fsm.current).toBe('IDLE_SIT');
  });

  it('holds SCRUFF_HELD until released: plans cannot wriggle out, letting go means falling then landing', () => {
    const fsm = new FelineFSM('IDLE_STAND', 4);
    fsm.force('SCRUFF_HELD');
    expect(fsm.request('IDLE_SIT')).toBe(false);
    for (let i = 0; i < 100; i++) fsm.update(0.05);
    expect(fsm.current).toBe('SCRUFF_HELD');
    expect(fsm.force('IDLE_SIT')).toBe(false);
    expect(fsm.force('FALL_DESCEND')).toBe(true);
    expect(fsm.force('LAND_RECOVERY')).toBe(true);
    runUntil(fsm, 'IDLE_STAND', 2);
    expect(fsm.current).toBe('IDLE_STAND');
    expect(isPhysicsInterrupt('SCRUFF_HELD', 'LAND_RECOVERY')).toBe(true);
    expect(isPhysicsInterrupt('SCRUFF_HELD', 'SAUNTER_WALK')).toBe(false);
    expect(restorableState('SCRUFF_HELD')).toBe('IDLE_STAND');
  });

  it('wakes from the cuddle through blink-stretch-yawn', () => {
    expect(findPath('CUDDLE_SLEEP', 'IDLE_SIT')).toEqual(['CUDDLE_SLEEP', 'WAKE_ARCH_STRETCH', 'BIG_YAWN', 'IDLE_SIT']);
    expect(SLEEP_STATES.has('CUDDLE_SLEEP')).toBe(true);
    expect(findPath('CAT_LOAF', 'CUDDLE_SLEEP')).toEqual(['CAT_LOAF', 'CUDDLE_SLEEP']);
  });

  it('eats and drinks standing at the bowl, then sits down to wash', () => {
    expect(canTransition('IDLE_STAND', 'EATING')).toBe(true);
    expect(canTransition('IDLE_STAND', 'DRINKING')).toBe(true);
    expect(findPath('EATING', 'GROOM_WASH_FACE')).toEqual(['EATING', 'IDLE_SIT', 'GROOM_WASH_FACE']);
    expect(findPath('IDLE_SIT', 'EMPTY_BOWL_WAIT')).toEqual(['IDLE_SIT', 'EMPTY_BOWL_WAIT']);
    expect(STATE_META.SEEKING_FOOD.locomotion).toBe(true);
    expect(STATE_META.SEEKING_WATER.locomotion).toBe(true);
  });
});
