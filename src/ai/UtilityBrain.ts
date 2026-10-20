/**
 * UtilityBrain — chooses what a cat wants to do next.
 *
 *   U(a) = Σ_i w_i · f_i(d_i, context) + ε
 *
 * Each candidate intent a is scored as a weighted sum of response curves f_i
 * over the drives d_i and the situation (cursor, typing, partner, toys, warm or
 * narrow ledges, time of day …), where the weights w_i come from the cat's
 * immutable personality. ε is small seeded noise. Hysteresis — a commitment
 * bonus for the current intent plus a switching margin — prevents jitter.
 *
 * Hunger and thirst trump everything else once they pass their thresholds (and
 * the bowl has something in it); with an empty bowl a very hungry or thirsty
 * cat goes and asks for a refill instead.
 */
import { clamp01, smoothstep } from '../shared/math';
import { Rng } from '../shared/rng';
import type { CatTraits, Drives, Personality, SignatureBehaviors, ToyKind } from '../shared/types';
import { BEG_LEVEL, HUNGER_SEEK, THIRST_SEEK } from './Drives';

export const INTENTS = [
  'sleep',
  'rest',
  'perch',
  'groom',
  'explore',
  'zoomies',
  'gaze',
  'hunt',
  'keyboard',
  'social',
  'toy',
  'treat',
  'climb',
  'peek',
  'eat',
  'drink',
] as const;
export type IntentKind = (typeof INTENTS)[number];

export interface BrainContext {
  drives: Drives;
  personality: Personality;
  signature: SignatureBehaviors;
  cursor: {
    present: boolean;
    /** px from the cat */
    dist: number;
    /** px/s */
    speed: number;
    /** 0..1 how erratic / prey-like the recent motion is */
    erratic: number;
    /** seconds since the cursor last moved */
    idle: number;
  };
  typing: { active: boolean; dist: number };
  partner: { exists: boolean; dist: number; asleep: boolean; available: boolean };
  toy: { kind: ToyKind | null; dist: number };
  warmSpot: boolean;
  narrowLedge: boolean;
  edgeSpot: boolean;
  timeSinceGroom: number;
  timeSinceZoomies: number;
  timeSinceClimb: number;
  /** 0..23 local hour (cats nap more at night & early afternoon). */
  hour: number;
  calm: boolean;
  /** Already being petted. */
  petted: boolean;
  /** Individual quirks (appetite, play, social initiative). Optional for older callers. */
  traits?: Partial<CatTraits>;
  /** The food & water station, if it is out. Levels are 0..100. */
  station?: { exists: boolean; food: number; water: number; dist: number; begReady: boolean };
}

/** A bowl with this much or less counts as empty. */
export const EMPTY_BOWL = 5;

export interface Decision {
  intent: IntentKind;
  scores: Record<IntentKind, number>;
  switched: boolean;
}

/** Minimum time an intent is "committed" to (seconds) before it can be dropped cheaply. */
export const MIN_COMMIT: Record<IntentKind, number> = {
  sleep: 40,
  rest: 10,
  perch: 14,
  groom: 6,
  explore: 6,
  zoomies: 4,
  gaze: 4,
  hunt: 5,
  keyboard: 8,
  social: 10,
  toy: 3,
  treat: 3,
  climb: 6,
  peek: 6,
  eat: 8,
  drink: 8,
};

const COMMIT_BONUS = 0.28;
const STICKY_BONUS = 0.1;
const SWITCH_MARGIN = 0.08;
const NOISE = 0.07;
/** Scores saturate here (meals above their threshold sit near the top of the range). */
const SCORE_CAP = 3.5;

function sleepiness(hour: number): number {
  // Night + post-lunch dip.
  const night = hour >= 23 || hour < 6 ? 1 : hour >= 21 ? 0.5 : 0;
  const siesta = hour >= 13 && hour < 16 ? 0.4 : 0;
  return Math.max(night, siesta);
}

/**
 * Score for heading to a bowl: dominant above the seek threshold when there is
 * food / water to have; a strong "ask for a refill" urge when very hungry or
 * thirsty in front of an empty bowl (unless the cat recently gave up asking);
 * a mild urge to snack before the threshold.
 */
export function mealScore(need: number, level: number, seek: number, begReady: boolean): number {
  const n = need / 100;
  if (level > EMPTY_BOWL) {
    if (need > seek) return 2.6 + 1.5 * (n - seek / 100);
    return 0.7 * smoothstep(seek - 20, seek, need);
  }
  if (need > BEG_LEVEL && begReady) return 2.05 + 2 * (n - BEG_LEVEL / 100);
  return 0;
}

/** Pure scoring function (exported for tests). */
export function scoreIntents(c: BrainContext): Record<IntentKind, number> {
  const d = c.drives;
  const p = c.personality;
  const energy = d.energy / 100;
  const tired = 1 - energy;
  const play = d.playfulness / 100;
  const curious = d.curiosity / 100;
  const social = d.socialNeed / 100;
  const irritated = d.irritation / 100;
  const calm = c.calm ? 1 : 0;
  const cursorNear = c.cursor.present ? 1 - smoothstep(120, 520, c.cursor.dist) : 0;
  const cursorMoving = c.cursor.present ? smoothstep(40, 400, c.cursor.speed) * (1 - smoothstep(1.5, 4, c.cursor.idle)) : 0;

  const s: Record<IntentKind, number> = {
    sleep: 0,
    rest: 0,
    perch: 0,
    groom: 0,
    explore: 0,
    zoomies: 0,
    gaze: 0,
    hunt: 0,
    keyboard: 0,
    social: 0,
    toy: 0,
    treat: 0,
    climb: 0,
    peek: 0,
    eat: 0,
    drink: 0,
  };
  const tr = c.traits ?? {};
  const initiative = tr.socialInitiative ?? 0.5;

  s.sleep = 0.55 * p.laziness + 1.25 * Math.pow(tired, 1.4) + 0.3 * sleepiness(c.hour) + (c.warmSpot ? 0.18 * p.laziness : 0) + ((c.signature.meltedLoafSleep && c.narrowLedge) || (c.signature.chinPropSleep && c.edgeSpot) ? 0.1 : 0) - 0.5 * play - 0.3 * irritated - 0.25;
  s.rest = 0.3 + 0.35 * p.laziness + 0.4 * tired - 0.2 * curious + 0.1 * calm;
  s.perch = 0.15 + 0.35 * curious * (1 - p.laziness * 0.5) + 0.2 * energy + (c.narrowLedge || c.edgeSpot ? 0.12 : 0);
  s.groom = 0.12 + 0.45 * smoothstep(40, 200, c.timeSinceGroom) + 0.25 * irritated;
  s.explore = 0.75 * curious + 0.3 * energy + 0.25 * (1 - p.laziness) - 0.15;
  s.zoomies = c.timeSinceZoomies > 90 && energy > 0.62 ? 1.25 * play * (1 - p.laziness) * energy * (1 - 0.7 * calm) : 0;
  s.gaze = 0.75 * cursorNear * (0.4 + 0.6 * curious) + 0.15 * cursorMoving;
  s.hunt = cursorNear > 0.05 ? (1.1 * p.huntDrive * play + 0.25 * energy) * c.cursor.erratic * (0.4 + 0.6 * cursorNear) * (1 - 0.5 * calm) : 0;
  s.keyboard = c.typing.active ? 0.55 + 0.6 * curious + 0.15 * (1 - smoothstep(200, 900, c.typing.dist)) : 0;
  s.social = c.partner.exists && c.partner.available ? 1.05 * social * p.sociability * (0.75 + 0.5 * initiative) + 0.15 * (c.partner.asleep ? tired : play) + (c.partner.dist < 160 ? 0.1 : 0) - 0.15 : 0;
  // A scurrying toy mouse on a string is the most irresistible toy of all.
  // A feather wand dancing in front of them is the highest-priority prey there is.
  const toyBonus = c.toy.kind === 'feather_wand' ? 0.7 : c.toy.kind === 'mouse' ? 0.35 : 0;
  s.toy = c.toy.kind && c.toy.kind !== 'treat' ? 0.9 + 0.7 * p.huntDrive + 0.5 * play - 0.6 * tired + toyBonus : 0;
  s.treat = c.toy.kind === 'treat' ? 2.2 : 0;
  s.climb = c.timeSinceClimb > 120 ? 0.32 * curious * (1 - p.laziness) * energy + 0.05 : 0;
  s.peek = c.timeSinceClimb > 60 ? 0.22 * curious * (1 - p.laziness * 0.6) : 0;
  const st = c.station;
  if (st?.exists) {
    s.eat = mealScore(d.hunger, st.food, HUNGER_SEEK, st.begReady);
    s.drink = mealScore(d.thirst, st.water, THIRST_SEEK, st.begReady);
  }

  // While being petted, the cat simply wants to stay put.
  if (c.petted) {
    s.rest += 0.6;
    s.explore -= 0.4;
    s.zoomies = 0;
  }
  for (const k of INTENTS) s[k] = Math.max(0, s[k]);
  return s;
}

export class UtilityBrain {
  current: IntentKind | null = null;
  age = 0;
  private rng: Rng;

  constructor(seed: number | string) {
    this.rng = new Rng(seed);
  }

  tick(dt: number): void {
    this.age += dt;
  }

  /** Forces an intent (e.g. a popup "call cats" or a social directive). */
  set(intent: IntentKind): void {
    if (intent !== this.current) this.age = 0;
    this.current = intent;
  }

  decide(c: BrainContext): Decision {
    const raw = scoreIntents(c);
    const scores = { ...raw };
    for (const k of INTENTS) scores[k] = clamp01(scores[k] / SCORE_CAP) * SCORE_CAP + (this.rng.next() * 2 - 1) * NOISE;
    if (this.current) {
      const committed = this.age < MIN_COMMIT[this.current];
      scores[this.current] += committed ? COMMIT_BONUS : STICKY_BONUS;
    }
    let best: IntentKind = 'rest';
    let bestScore = -Infinity;
    for (const k of INTENTS) {
      if (scores[k] > bestScore) {
        bestScore = scores[k];
        best = k;
      }
    }
    let switched = false;
    if (this.current && best !== this.current) {
      if (bestScore < scores[this.current] + SWITCH_MARGIN) best = this.current;
    }
    if (best !== this.current) {
      switched = true;
      this.current = best;
      this.age = 0;
    }
    return { intent: best, scores, switched };
  }
}
