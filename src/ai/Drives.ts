/**
 * Dynamic drives d_i ∈ [0, 100]: energy, playfulness, affection, curiosity,
 * irritation, socialNeed, hunger and thirst. They evolve continuously with what
 * the cat is doing and are shaped by its immutable personality weights and traits.
 */
import type { CatState } from '../shared/catStates';
import { clamp } from '../shared/math';
import type { CatTraits, Drives, Personality } from '../shared/types';
import { STATE_META, isSleep } from './States';

/**
 * Hunger and thirst per second for an average cat at rest. A cat that starts a
 * session fed gets hungry (65) after roughly a quarter of an hour of browsing;
 * zoomies and play make that much sooner.
 */
export const HUNGER_RATE = 0.055;
export const THIRST_RATE = 0.065;

/** Hunger / thirst above which a cat heads for the station (if the bowl has some left). */
export const HUNGER_SEEK = 65;
export const THIRST_SEEK = 60;
/** Hunger / thirst above which a cat sits by an empty bowl and asks for a refill. */
export const BEG_LEVEL = 75;

/** Scratch urge per second for an average awake cat: from calm (≈20) to the post (60) in about three minutes. */
export const SCRATCH_RATE = 0.22;
/** Above this urge a cat heads for the scratching post (if the tower is out). */
export const SCRATCH_SEEK = 60;
/** The urge jumps by this much when a cat wakes from sleep (a good morning stretch at the post). */
export const WAKE_SCRATCH_SPIKE = 38;

export function defaultDrives(p: Personality, traits?: Pick<CatTraits, 'playfulness'>): Drives {
  const play = traits ? traits.playfulness : 0.3 + 0.6 * (1 - p.laziness);
  return {
    energy: 70 - p.laziness * 15,
    playfulness: 30 + play * 40,
    affection: 40 + p.affection * 30,
    curiosity: 50,
    irritation: 5,
    socialNeed: 30 + p.sociability * 20,
    hunger: 22,
    thirst: 20,
    scratchUrge: 18 + 20 * (1 - p.laziness),
  };
}

/** Fills in drives missing from older snapshots (v1 had no hunger / thirst). */
export function completeDrives(d: Partial<Drives> | undefined, p: Personality, traits?: Pick<CatTraits, 'playfulness'>): Drives {
  const base = defaultDrives(p, traits);
  const out = { ...base };
  if (d) for (const k of Object.keys(base) as (keyof Drives)[]) if (typeof d[k] === 'number' && Number.isFinite(d[k])) out[k] = clamp(d[k] as number, 0, 100);
  return out;
}

export interface DriveContext {
  /** Currently interacting socially with another cat. */
  social: boolean;
  /** Being petted in a pleasant zone this frame. */
  pettedNicely: boolean;
  /** Other cat far away / absent. */
  alone: boolean;
  /** Appetite multipliers from the cat's traits (default 1). */
  hungerRate?: number;
  thirstRate?: number;
  /** Baseline playfulness trait 0..1 (default derived from laziness). */
  playTrait?: number;
}

/** How much faster a cat burns through food and water in this state. */
export function activityFactor(state: CatState): number {
  if (state === 'ZOOMIES_SPRINT' || state === 'PLAY_TAG_CHASE' || state === 'PLAY_WRESTLE' || state === 'POUNCE_AND_PIN' || state === 'BUNNY_KICK_SWAT' || state === 'STALK_CURSOR' || state === 'WALL_CLIMB') return 2.5;
  if (isSleep(state)) return 0.45;
  const meta = STATE_META[state];
  if (meta.locomotion || meta.posture === 'air') return 1.4;
  return 1;
}

function clampDrives(d: Drives): void {
  d.energy = clamp(d.energy, 0, 100);
  d.playfulness = clamp(d.playfulness, 0, 100);
  d.affection = clamp(d.affection, 0, 100);
  d.curiosity = clamp(d.curiosity, 0, 100);
  d.irritation = clamp(d.irritation, 0, 100);
  d.socialNeed = clamp(d.socialNeed, 0, 100);
  d.hunger = clamp(d.hunger, 0, 100);
  d.thirst = clamp(d.thirst, 0, 100);
  d.scratchUrge = clamp(d.scratchUrge, 0, 100);
}

export function updateDrives(d: Drives, state: CatState, dt: number, p: Personality, ctx: DriveContext): void {
  const meta = STATE_META[state];
  // Energy
  if (isSleep(state)) d.energy += dt * (0.55 + 0.25 * p.laziness);
  else if (state === 'ZOOMIES_SPRINT' || state === 'PLAY_TAG_CHASE' || state === 'PLAY_WRESTLE' || state === 'BUNNY_KICK_SWAT') d.energy -= dt * 0.9;
  else if (meta.locomotion || meta.posture === 'air' || meta.posture === 'wall') d.energy -= dt * (0.16 + 0.12 * (1 - p.laziness));
  else if (meta.posture === 'lie') d.energy += dt * 0.08;
  else d.energy -= dt * 0.02;

  // Playfulness grows when idle and rested; spent by play.
  const playing = state === 'ZOOMIES_SPRINT' || state === 'PLAY_TAG_CHASE' || state === 'PLAY_WRESTLE' || state === 'POUNCE_AND_PIN' || state === 'STALK_CURSOR';
  const playTrait = ctx.playTrait ?? 0.3 + 0.6 * (1 - p.laziness);
  if (playing) d.playfulness -= dt * 1.1;
  else if (!isSleep(state)) d.playfulness += dt * 0.12 * (d.energy / 100) * (0.5 + playTrait);

  // Affection: petting raises it, slow decay otherwise.
  if (ctx.pettedNicely) d.affection += dt * 4.5;
  else d.affection -= dt * 0.03;
  d.affection = Math.max(d.affection, p.affection * 25);

  // Curiosity: refills while idle, spent exploring.
  if (meta.locomotion && !playing) d.curiosity -= dt * 0.5;
  else if (!isSleep(state)) d.curiosity += dt * 0.18;

  // Irritation decays; sassy cats hold grudges a bit longer.
  d.irritation -= dt * (0.6 - p.sassiness * 0.3) * (isSleep(state) ? 1.5 : 1);

  // Social need: builds when apart, satisfied by interaction.
  if (ctx.social) d.socialNeed -= dt * 2.4;
  else if (ctx.alone) d.socialNeed += dt * 0.22 * (0.4 + p.sociability);
  else d.socialNeed += dt * 0.08 * p.sociability;

  // Hunger & thirst build steadily, faster when the cat is busy; meals are handled by the station.
  if (state !== 'EATING') d.hunger += dt * HUNGER_RATE * (ctx.hungerRate ?? 1) * activityFactor(state);
  if (state !== 'DRINKING') d.thirst += dt * THIRST_RATE * (ctx.thirstRate ?? 1) * activityFactor(state);

  // Scratch urge: builds slowly while awake (a good scratch every few minutes); it spikes on waking up (see
  // `WAKE_SCRATCH_SPIKE`) and a session at the post resets it. Asleep, it rests.
  if (state === 'SCRATCH_POST') d.scratchUrge = 0;
  else if (!isSleep(state)) d.scratchUrge += dt * SCRATCH_RATE * (0.7 + 0.6 * (1 - p.laziness));

  clampDrives(d);
}

/** Passive drift for time spent in a background tab (seconds, capped). */
export function driftDrives(d: Drives, seconds: number, p: Personality, traits?: Pick<CatTraits, 'hungerRateMultiplier' | 'thirstRateMultiplier'>): void {
  const s = Math.min(seconds, 3600);
  d.energy += s * 0.02 * (0.5 + p.laziness);
  d.playfulness += s * 0.01;
  d.curiosity += s * 0.02;
  d.irritation -= s * 0.05;
  d.socialNeed += s * 0.005 * p.sociability;
  // Mostly napping while you were away: appetite builds at the sleeping rate, and never past "very hungry".
  if (d.hunger < 80) d.hunger = Math.min(80, d.hunger + s * HUNGER_RATE * 0.45 * (traits?.hungerRateMultiplier ?? 1));
  if (d.thirst < 80) d.thirst = Math.min(80, d.thirst + s * THIRST_RATE * 0.45 * (traits?.thirstRateMultiplier ?? 1));
  clampDrives(d);
}
