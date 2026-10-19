/**
 * Dynamic drives d_i ∈ [0, 100]: energy, playfulness, affection, curiosity,
 * irritation, socialNeed. They evolve continuously with what the cat is doing
 * and are shaped by its immutable personality weights.
 */
import type { CatState } from '../shared/catStates';
import { clamp } from '../shared/math';
import type { Drives, Personality } from '../shared/types';
import { STATE_META, isSleep } from './States';

export function defaultDrives(p: Personality): Drives {
  return {
    energy: 70 - p.laziness * 15,
    playfulness: 40 + (1 - p.laziness) * 25,
    affection: 40 + p.affection * 30,
    curiosity: 50,
    irritation: 5,
    socialNeed: 30 + p.sociability * 20,
  };
}

export interface DriveContext {
  /** Currently interacting socially with another cat. */
  social: boolean;
  /** Being petted in a pleasant zone this frame. */
  pettedNicely: boolean;
  /** Other cat far away / absent. */
  alone: boolean;
}

function clampDrives(d: Drives): void {
  d.energy = clamp(d.energy, 0, 100);
  d.playfulness = clamp(d.playfulness, 0, 100);
  d.affection = clamp(d.affection, 0, 100);
  d.curiosity = clamp(d.curiosity, 0, 100);
  d.irritation = clamp(d.irritation, 0, 100);
  d.socialNeed = clamp(d.socialNeed, 0, 100);
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
  if (playing) d.playfulness -= dt * 1.1;
  else if (!isSleep(state)) d.playfulness += dt * 0.12 * (d.energy / 100) * (1.2 - p.laziness * 0.6);

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

  clampDrives(d);
}

/** Passive drift for time spent in a background tab (seconds, capped). */
export function driftDrives(d: Drives, seconds: number, p: Personality): void {
  const s = Math.min(seconds, 3600);
  d.energy += s * 0.02 * (0.5 + p.laziness);
  d.playfulness += s * 0.01;
  d.curiosity += s * 0.02;
  d.irritation -= s * 0.05;
  d.socialNeed += s * 0.005 * p.sociability;
  clampDrives(d);
}
