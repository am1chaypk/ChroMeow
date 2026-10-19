/**
 * A Pose fully describes the articulated rig for one frame, in cat-local units
 * (size 1 ≈ px, origin on the ground between the feet, +x = facing direction,
 * +y = down). Every field is numeric so any two poses can be blended — that is
 * what makes state changes glide instead of snapping.
 */
export interface Pose {
  // root
  rootX: number;
  rootY: number;
  rot: number;
  // spine / torso
  hipX: number;
  hipY: number;
  shX: number;
  shY: number;
  /** Spine bow along the ventral normal; negative arches the back upward. */
  arch: number;
  thickTop: number;
  thickBot: number;
  /** Sitting haunch bulge 0..1. */
  haunch: number;
  /** 0 upright · 0.5 on its side (belly to viewer) · 1 belly-up. */
  roll: number;
  /** Breathing amplitude multiplier (sleep = deeper, slower). */
  breath: number;
  breathRate: number;
  // head & face
  headX: number;
  headY: number;
  headRot: number;
  /** 0 frontal · 1 profile toward the facing direction. */
  faceTurn: number;
  /** Ear angles in degrees: 0 alert, −40 flattened "airplane" ears. */
  earL: number;
  earR: number;
  eyeOpen: number;
  squint: number;
  /** Pupil dilation 0 (slit) .. 1 (round, huge). */
  pupil: number;
  lookX: number;
  lookY: number;
  mouth: number;
  tongue: number;
  // paws (targets for 2-bone IK)
  fnX: number;
  fnY: number;
  ffX: number;
  ffY: number;
  hnX: number;
  hnY: number;
  hfX: number;
  hfY: number;
  /** Paw flex / curl 0..1 per leg (lifted paws curl). */
  fnCurl: number;
  ffCurl: number;
  hnCurl: number;
  hfCurl: number;
  frontHidden: number;
  hindHidden: number;
  /** Tucked white mittens visible under the chest (loaf). */
  tuck: number;
  /** >0.5 draws the near hind leg in front of the torso (grooming poses). */
  hindNearFront: number;
  /** Show pink toe beans. */
  pads: number;
  // tail (local space; converted to world by the agent)
  tailAngle: number;
  tailCurl: number;
  tailWave: number;
  tailFreq: number;
  tailWhip: number;
  tailStiff: number;
  tailGravity: number;
  /** >0.5 draws the tail in front of the body (wrapped around the paws). */
  tailFront: number;
  /** Bottle-brush puff 0..1 when startled. */
  tailPuff: number;
  /** High-frequency body vibration (purring / startle shiver). */
  shiver: number;
}

export const POSE_KEYS = [
  'rootX', 'rootY', 'rot',
  'hipX', 'hipY', 'shX', 'shY', 'arch', 'thickTop', 'thickBot', 'haunch', 'roll', 'breath', 'breathRate',
  'headX', 'headY', 'headRot', 'faceTurn', 'earL', 'earR', 'eyeOpen', 'squint', 'pupil', 'lookX', 'lookY', 'mouth', 'tongue',
  'fnX', 'fnY', 'ffX', 'ffY', 'hnX', 'hnY', 'hfX', 'hfY', 'fnCurl', 'ffCurl', 'hnCurl', 'hfCurl',
  'frontHidden', 'hindHidden', 'tuck', 'hindNearFront', 'pads',
  'tailAngle', 'tailCurl', 'tailWave', 'tailFreq', 'tailWhip', 'tailStiff', 'tailGravity', 'tailFront', 'tailPuff',
  'shiver',
] as const satisfies readonly (keyof Pose)[];

/** Angle-valued keys are blended along the shortest arc. */
const ANGLE_KEYS = new Set<keyof Pose>(['rot', 'headRot', 'tailAngle']);

export const STAND_POSE: Pose = {
  rootX: 0,
  rootY: 0,
  rot: 0,
  hipX: -22,
  hipY: -36,
  shX: 20,
  shY: -37,
  arch: -2,
  thickTop: 14,
  thickBot: 14.5,
  haunch: 0.6,
  roll: 0,
  breath: 1,
  breathRate: 0.45,
  headX: 33,
  headY: -55,
  headRot: 0,
  faceTurn: 0.35,
  earL: 0,
  earR: 0,
  eyeOpen: 1,
  squint: 0,
  pupil: 0.45,
  lookX: 0,
  lookY: 0,
  mouth: 0,
  tongue: 0,
  fnX: 20,
  fnY: 0,
  ffX: 14,
  ffY: 0,
  hnX: -20,
  hnY: 0,
  hfX: -26,
  hfY: 0,
  fnCurl: 0,
  ffCurl: 0,
  hnCurl: 0,
  hfCurl: 0,
  frontHidden: 0,
  hindHidden: 0,
  tuck: 0,
  hindNearFront: 0,
  pads: 0,
  tailAngle: -2.25,
  tailCurl: 0.14,
  tailWave: 0.14,
  tailFreq: 0.4,
  tailWhip: 0,
  tailStiff: 0.38,
  tailGravity: 320,
  tailFront: 0,
  tailPuff: 0,
  shiver: 0,
};

export function makePose(overrides: Partial<Pose> = {}): Pose {
  return { ...STAND_POSE, ...overrides };
}

export function clonePose(p: Pose): Pose {
  return { ...p };
}

function wrap(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/** Blends `from` → `to` by t into `out` (out may alias from). */
export function blendPose(from: Pose, to: Pose, t: number, out: Pose): Pose {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  for (const k of POSE_KEYS) {
    const a = from[k];
    const b = to[k];
    out[k] = ANGLE_KEYS.has(k) ? a + wrap(b - a) * tt : a + (b - a) * tt;
  }
  return out;
}

/** Exponential follow: moves `cur` toward `target` with a per-second rate (frame-rate independent). */
export function followPose(cur: Pose, target: Pose, rate: number, dt: number): Pose {
  const t = 1 - Math.exp(-rate * dt);
  return blendPose(cur, target, t, cur);
}
