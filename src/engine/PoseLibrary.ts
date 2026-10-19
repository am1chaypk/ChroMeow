/**
 * PoseLibrary — procedural key poses and motion cycles for every CatState.
 * Pure functions: (state, context) → Pose. The agent blends successive poses,
 * layers blinking / ear twitches / gaze on top, and the renderer draws the rig.
 */
import type { CatState } from '../shared/catStates';
import { TAU, clamp, clamp01, fract, lerp, smoothstep } from '../shared/math';
import { makePose, blendPose, type Pose } from './Pose';

export interface PoseContext {
  /** Seconds spent in the current state. */
  t: number;
  /** 0..1 progress for timed states (t / duration); looping states pass fract-based values. */
  progress: number;
  /** Walk-cycle phase in cycles. */
  gaitPhase: number;
  /** Horizontal speed in local units/s (positive = forward). */
  vx: number;
  /** Vertical velocity in local units/s (+ = down). */
  vy: number;
  /** Gaze direction, −1..1 each (relative to the head, local frame). */
  lookX: number;
  lookY: number;
  /** 0..1 how strongly the head follows the gaze target. */
  lookActive: number;
  /** Distance (local units) from the feet origin to the ledge edge ahead, or Infinity. */
  edgeAhead: number;
  /** Local y of the partner's back (pillow stack), NaN if none. */
  partnerTopY: number;
  /** Local x offset to partner (forward positive), NaN if none. */
  partnerDX: number;
  /** Social role: 0 = initiator / Cat A, 1 = receiver / Cat B. */
  role: 0 | 1;
  /** Per-cat constant in 0..1 for variation. */
  seed: number;
  chonk: number;
  /** Whether the posture this state grew out of was seated / lying. */
  sitting: boolean;
  lying: boolean;
}

export const DEFAULT_POSE_CONTEXT: PoseContext = {
  t: 0,
  progress: 0,
  gaitPhase: 0,
  vx: 0,
  vy: 0,
  lookX: 0,
  lookY: 0,
  lookActive: 0,
  edgeAhead: Infinity,
  partnerTopY: NaN,
  partnerDX: NaN,
  role: 0,
  seed: 0.5,
  chonk: 1,
  sitting: false,
  lying: false,
};

export interface GaitSpec {
  /** Ground speed in local units / s at size 1. */
  speed: number;
  stride: number;
  /** Fraction of the cycle each foot is planted. */
  stance: number;
  lift: number;
  /** Phase offsets: front-near, front-far, hind-near, hind-far. */
  offsets: [number, number, number, number];
  bob: number;
}

export const GAITS: Partial<Record<CatState, GaitSpec>> = {
  SAUNTER_WALK: { speed: 46, stride: 22, stance: 0.62, lift: 6, offsets: [0.25, 0.75, 0, 0.5], bob: 1 },
  TROT: { speed: 128, stride: 30, stance: 0.5, lift: 8, offsets: [0.5, 0, 0, 0.5], bob: 1.6 },
  ZOOMIES_SPRINT: { speed: 330, stride: 44, stance: 0.36, lift: 10, offsets: [0.5, 0.6, 0, 0.1], bob: 3 },
  STALK_CURSOR: { speed: 20, stride: 13, stance: 0.72, lift: 3, offsets: [0.25, 0.75, 0, 0.5], bob: 0.3 },
  PLAY_TAG_CHASE: { speed: 200, stride: 36, stance: 0.42, lift: 10, offsets: [0.5, 0.6, 0, 0.1], bob: 2.4 },
  JEALOUSY_INTERVENTION: { speed: 40, stride: 20, stance: 0.62, lift: 5, offsets: [0.25, 0.75, 0, 0.5], bob: 1 },
  WALL_CLIMB: { speed: 64, stride: 20, stance: 0.55, lift: 7, offsets: [0.5, 0, 0, 0.5], bob: 0.6 },
};

/* ------------------------------------------------------------ base poses */

const SIT: Partial<Pose> = {
  hipX: -14,
  hipY: -12,
  shX: 6,
  shY: -41,
  arch: 3,
  thickTop: 13.5,
  thickBot: 14.5,
  haunch: 1.4,
  headX: 12,
  headY: -60,
  faceTurn: 0.3,
  fnX: 14,
  fnY: 0,
  ffX: 9,
  ffY: 0,
  hnX: 5,
  hnY: 0,
  hfX: 0,
  hfY: 0,
  tailAngle: Math.PI * 0.94,
  tailCurl: -0.42,
  tailWave: 0.05,
  tailFreq: 0.5,
  tailStiff: 0.3,
  tailGravity: 380,
  tailFront: 0.8,
};

const LOAF: Partial<Pose> = {
  hipX: -19,
  hipY: -16,
  shX: 17,
  shY: -17,
  arch: -5,
  thickTop: 16.5,
  thickBot: 9,
  haunch: 0.7,
  headX: 28,
  headY: -32,
  headRot: 0.04,
  faceTurn: 0.25,
  fnX: 20,
  fnY: -4,
  ffX: 16,
  ffY: -4,
  hnX: -14,
  hnY: -4,
  hfX: -18,
  hfY: -4,
  frontHidden: 1,
  hindHidden: 1,
  tuck: 1,
  eyeOpen: 0.8,
  tailAngle: Math.PI * 0.98,
  tailCurl: -0.36,
  tailWave: 0.04,
  tailStiff: 0.25,
  tailGravity: 420,
  tailFront: 0.8,
};

const SPHINX: Partial<Pose> = {
  hipX: -20,
  hipY: -15,
  shX: 17,
  shY: -19,
  arch: -3,
  thickTop: 15.5,
  thickBot: 9.5,
  haunch: 0.6,
  headX: 31,
  headY: -38,
  faceTurn: 0.3,
  fnX: 36,
  fnY: 0,
  ffX: 31,
  ffY: 0,
  fnCurl: 0.1,
  ffCurl: 0.1,
  hnX: -14,
  hnY: -4,
  hfX: -18,
  hfY: -4,
  hindHidden: 1,
  tailAngle: Math.PI * 0.99,
  tailCurl: -0.1,
  tailWave: 0.06,
  tailStiff: 0.2,
  tailGravity: 420,
};

const CURL: Partial<Pose> = {
  hipX: -14,
  hipY: -14,
  shX: 12,
  shY: -14,
  arch: -14,
  thickTop: 17.5,
  thickBot: 8,
  haunch: 0.8,
  headX: 18,
  headY: -12,
  headRot: 0.32,
  faceTurn: 0.12,
  eyeOpen: 0,
  earL: -8,
  earR: -8,
  frontHidden: 1,
  hindHidden: 1,
  tuck: 0.5,
  fnX: 12,
  fnY: -4,
  ffX: 8,
  ffY: -4,
  hnX: -6,
  hnY: -4,
  hfX: -10,
  hfY: -4,
  breath: 1.6,
  breathRate: 0.28,
  tailAngle: Math.PI * 0.95,
  tailCurl: -0.62,
  tailWave: 0.02,
  tailStiff: 0.5,
  tailGravity: 220,
  tailFront: 1,
};

const SPRAWL: Partial<Pose> = {
  roll: 0.34,
  hipX: -25,
  hipY: -14,
  shX: 20,
  shY: -15,
  arch: 2,
  thickTop: 14,
  thickBot: 14,
  haunch: 0.4,
  headX: 38,
  headY: -15,
  headRot: -0.38,
  faceTurn: 0.1,
  eyeOpen: 0,
  earL: -6,
  earR: -6,
  fnX: 58,
  fnY: -4,
  ffX: 53,
  ffY: -1,
  fnCurl: 0.45,
  ffCurl: 0.45,
  hnX: -50,
  hnY: -4,
  hfX: -45,
  hfY: -1,
  hnCurl: 0.5,
  hfCurl: 0.5,
  breath: 1.35,
  breathRate: 0.3,
  tailAngle: Math.PI,
  tailCurl: 0.04,
  tailWave: 0.03,
  tailStiff: 0.15,
  tailGravity: 520,
};

/* ------------------------------------------------------------- helpers */

function legCycle(home: number, phase: number, stride: number, stance: number, lift: number): [number, number] {
  const lp = fract(phase);
  if (lp < stance) {
    // Planted: the paw stays put on the ground while the body passes over it.
    const s = lp / stance;
    return [home + stride * (0.5 - s), 0];
  }
  // Swing: the paw accelerates off the ground and decelerates into the next footfall,
  // lifting quickly after toe-off and lowering gently onto the pads.
  const s = (lp - stance) / (1 - stance);
  const sx = s * s * (3 - 2 * s);
  const sy = Math.sin(Math.PI * Math.pow(s, 0.78));
  return [home + stride * (-0.5 + sx), -lift * sy];
}

function applyGait(p: Pose, phase: number, g: GaitSpec, homes: [number, number, number, number]): void {
  const [fn, ff, hn, hf] = g.offsets;
  [p.fnX, p.fnY] = legCycle(homes[0], phase + fn, g.stride, g.stance, g.lift);
  [p.ffX, p.ffY] = legCycle(homes[1], phase + ff, g.stride, g.stance, g.lift);
  [p.hnX, p.hnY] = legCycle(homes[2], phase + hn, g.stride, g.stance, g.lift);
  [p.hfX, p.hfY] = legCycle(homes[3], phase + hf, g.stride, g.stance, g.lift);
  const b = Math.sin(phase * TAU * 2) * g.bob;
  p.hipY += b * 0.8;
  p.shY += Math.sin(phase * TAU * 2 + 1.2) * g.bob * 0.8;
  // Cats stabilise their heads while walking: only a faint bob reaches the skull.
  p.headY += Math.sin(phase * TAU * 2 + 1.6) * g.bob * 0.22;
  p.headRot -= Math.sin(phase * TAU * 2 + 1.2) * g.bob * 0.006;
  p.fnCurl = clamp01(-p.fnY / Math.max(1, g.lift));
  p.ffCurl = clamp01(-p.ffY / Math.max(1, g.lift));
  p.hnCurl = clamp01(-p.hnY / Math.max(1, g.lift));
  p.hfCurl = clamp01(-p.hfY / Math.max(1, g.lift));
}

/** Turns the head and eyes toward the gaze target. */
function applyLook(p: Pose, c: PoseContext, headWeight = 1): void {
  const w = c.lookActive * headWeight;
  if (w <= 0) return;
  p.headRot += clamp(c.lookY * 0.38 - (c.lookX < -0.2 ? 0.08 : 0), -0.45, 0.5) * w;
  p.faceTurn = lerp(p.faceTurn, c.lookX > 0.15 ? 0.45 : c.lookX < -0.3 ? 0.0 : 0.2, w);
  p.lookX = clamp(c.lookX, -1, 1) * w;
  p.lookY = clamp(c.lookY, -1, 1) * w;
}

function breathingTail(p: Pose, t: number, seed: number): void {
  // Occasional idle tail-tip flick.
  const flick = Math.max(0, Math.sin(t * 0.9 + seed * 20)) ** 12;
  p.tailWhip = Math.max(p.tailWhip, flick * 0.35);
}

/* ------------------------------------------------------------ the library */

export function computePose(state: CatState, c: PoseContext): Pose {
  const t = c.t;
  const pr = clamp01(c.progress);
  switch (state) {
    /* ---------- rest & wake chain ---------- */
    case 'CURLED_SLEEP': {
      const p = makePose(CURL);
      p.tailWave = 0.015;
      return p;
    }
    case 'SPRAWLED_SLEEP': {
      const p = makePose(SPRAWL);
      p.fnX += Math.sin(t * 0.3 + c.seed * 9) * 1.2;
      return p;
    }
    case 'WAKE_ARCH_STRETCH': {
      const front = makePose({
        hipX: -20,
        hipY: -45,
        shX: 20,
        shY: -20,
        arch: 2,
        thickTop: 12,
        thickBot: 11,
        fnX: 49,
        fnY: 0,
        ffX: 45,
        ffY: 0,
        fnCurl: 0.1,
        ffCurl: 0.1,
        hnX: -20,
        hnY: 0,
        hfX: -26,
        hfY: 0,
        headX: 39,
        headY: -27,
        headRot: -0.28,
        eyeOpen: 0.25,
        earL: -10,
        earR: -10,
        tailAngle: -1.9,
        tailCurl: 0.2,
        tailStiff: 0.5,
        pads: 0.4,
      });
      const arch = makePose({
        hipX: -18,
        hipY: -45,
        shX: 16,
        shY: -45,
        arch: -17,
        thickTop: 12,
        thickBot: 11,
        fnX: 9,
        fnY: 0,
        ffX: 5,
        ffY: 0,
        hnX: -9,
        hnY: 0,
        hfX: -13,
        hfY: 0,
        headX: 28,
        headY: -45,
        headRot: 0.35,
        eyeOpen: 0.2,
        tailAngle: -1.7,
        tailCurl: 0.35,
        tailStiff: 0.55,
      });
      const p = makePose();
      blendPose(front, arch, smoothstep(0.38, 0.68, pr), p);
      // ease in from / out to a neutral stance at the ends of the stretch
      const neutral = makePose();
      const edge = Math.min(smoothstep(0, 0.12, pr), 1 - smoothstep(0.88, 1, pr));
      return blendPose(neutral, p, edge, p);
    }
    case 'BIG_YAWN': {
      const p = makePose(SIT);
      const m = Math.sin(Math.PI * smoothstep(0.05, 0.85, pr));
      p.headY -= 3 * m;
      p.headRot = -0.42 * m;
      p.mouth = m;
      p.tongue = m * m;
      p.eyeOpen = 1 - m;
      p.squint = m;
      p.earL = p.earR = -14 * m;
      p.shY -= 1.5 * m;
      return p;
    }
    /* ---------- posture & idle ---------- */
    case 'IDLE_SIT': {
      const p = makePose(SIT);
      p.headRot = Math.sin(t * 0.35 + c.seed * 6) * 0.06;
      breathingTail(p, t, c.seed);
      applyLook(p, c, 0.6);
      return p;
    }
    case 'IDLE_STAND': {
      const p = makePose();
      p.tailAngle = -2.2;
      p.tailCurl = 0.18;
      breathingTail(p, t, c.seed);
      applyLook(p, c, 0.6);
      return p;
    }
    case 'CAT_LOAF': {
      const p = makePose(LOAF);
      p.eyeOpen = 0.75 + Math.sin(t * 0.25 + c.seed) * 0.1;
      breathingTail(p, t, c.seed);
      applyLook(p, c, 0.5);
      return p;
    }
    case 'SPHINX_POSE': {
      const p = makePose(SPHINX);
      applyLook(p, c, 0.8);
      return p;
    }
    case 'DANGLE_PAWS': {
      const p = makePose(SPHINX);
      const e = Number.isFinite(c.edgeAhead) ? clamp(c.edgeAhead, 16, 40) : 26;
      p.shX = e - 8;
      p.hipX = p.shX - 40;
      p.fnX = e + 5;
      p.fnY = 15 + Math.sin(t * 1.3) * 1.5;
      p.ffX = e - 1;
      p.ffY = 13 + Math.sin(t * 1.3 + 2) * 1.5;
      p.fnCurl = p.ffCurl = 0.25;
      p.headX = e - 4;
      p.headY = -24;
      p.headRot = 0.48;
      p.lookY = 0.8;
      p.eyeOpen = 0.85;
      return p;
    }
    /* ---------- grooming ---------- */
    case 'GROOM_LICK_PAW': {
      const p = makePose(SIT);
      p.fnX = 16;
      p.fnY = -47;
      p.fnCurl = 0.9;
      p.pads = 0.8;
      p.headX = 17;
      p.headY = -58;
      p.headRot = 0.28;
      const lick = Math.max(0, Math.sin(t * TAU * 2.6));
      p.tongue = lick;
      p.mouth = lick * 0.35;
      p.eyeOpen = 0.35;
      p.headY += lick * 1.2;
      return p;
    }
    case 'GROOM_WASH_FACE': {
      const p = makePose(SIT);
      const w = t * TAU * 1.5;
      p.fnX = 15 + Math.cos(w) * 7;
      p.fnY = -60 + Math.sin(w) * 8;
      p.fnCurl = 1;
      p.headX = 13;
      p.headY = -60;
      p.headRot = 0.3 + Math.sin(w) * 0.16;
      p.eyeOpen = 0.15;
      p.earL = -6 + Math.sin(w) * 8;
      return p;
    }
    case 'GROOM_BACK_LEG': {
      // Sitting on the rump, body leaning back, one hind leg raised straight up, head bowed to it.
      // hindNearFront = 1 draws the raised leg in front of the bowed head.
      const p = makePose(SIT);
      p.hipX = -4;
      p.hipY = -11;
      p.shX = -13;
      p.shY = -38;
      p.arch = 4;
      p.haunch = 1.2;
      p.hindNearFront = 1;
      p.hnX = 17;
      p.hnY = -58;
      p.hnCurl = 0.7;
      p.hfX = 9;
      p.hfY = 0;
      p.fnX = 3;
      p.ffX = -2;
      p.headX = 5;
      p.headY = -34;
      p.headRot = 0.95;
      p.faceTurn = 0.45;
      const lick = Math.max(0, Math.sin(t * TAU * 2.2));
      p.tongue = lick;
      p.mouth = lick * 0.3;
      p.headY += lick * 1.5;
      p.eyeOpen = 0.2;
      p.tailCurl = -0.2;
      return p;
    }
    case 'SCRATCH_EAR_HIND_LEG': {
      const p = makePose(SIT);
      const s = t * TAU * 4.6;
      p.shX = 3;
      p.shY = -39;
      p.hindNearFront = 0.7;
      p.hnX = 2 + Math.sin(s) * 3;
      p.hnY = -63 + Math.cos(s) * 3.5;
      p.hnCurl = 0.85;
      p.headX = 14;
      p.headY = -57;
      p.headRot = -0.32;
      p.eyeOpen = 0.35;
      p.squint = 0.4;
      p.earL = -14 + Math.sin(s) * 6;
      p.earR = -4;
      return p;
    }
    /* ---------- locomotion ---------- */
    case 'SAUNTER_WALK':
    case 'TROT':
    case 'JEALOUSY_INTERVENTION':
    case 'PLAY_TAG_CHASE':
    case 'ZOOMIES_SPRINT':
    case 'STALK_CURSOR': {
      const g = GAITS[state] as GaitSpec;
      const p = makePose();
      let homes: [number, number, number, number] = [19, 15, -21, -25];
      if (state === 'STALK_CURSOR') {
        p.hipY = -27;
        p.shY = -23;
        p.hipX = -24;
        p.shX = 20;
        p.headX = 37;
        p.headY = -33;
        p.headRot = 0.08;
        p.pupil = 1;
        p.earL = p.earR = 4;
        p.tailAngle = Math.PI * 0.97;
        p.tailCurl = 0.03;
        p.tailWhip = 0.3;
        p.thickBot = 11.5;
        homes = [21, 16, -18, -23];
      } else if (state === 'ZOOMIES_SPRINT' || state === 'PLAY_TAG_CHASE') {
        const flex = Math.sin(c.gaitPhase * TAU);
        p.hipX = -24 + flex * 5;
        p.shX = 23 - flex * 4;
        p.hipY = -36 + Math.abs(flex) * -2;
        p.headX = 38 - flex * 3;
        p.headY = -52;
        p.pupil = 1;
        p.earL = p.earR = state === 'ZOOMIES_SPRINT' ? -30 : 2;
        p.tailAngle = state === 'ZOOMIES_SPRINT' ? Math.PI * 1.08 : -2.45;
        p.tailCurl = 0.06;
        p.tailStiff = 0.3;
        p.tailPuff = state === 'ZOOMIES_SPRINT' ? 0.25 : 0;
        p.rot = -0.04 * flex;
        homes = [20, 16, -20, -24];
      } else if (state === 'TROT') {
        p.tailAngle = -2.55;
        p.tailCurl = 0.13;
        p.headY = -55;
      } else if (state === 'JEALOUSY_INTERVENTION') {
        p.tailAngle = -1.75;
        p.tailCurl = 0.32;
        p.eyeOpen = 0.55;
        const bonk = Math.max(0, Math.sin(t * TAU * 0.9)) ** 2;
        p.headX += bonk * 6;
        p.headY -= bonk * 5;
        p.headRot = -0.25 * bonk;
        applyLook(p, c, 0.5);
      } else {
        p.tailAngle = -2.35;
        p.tailCurl = 0.12;
      }
      const moving = Math.abs(c.vx) > 3 || state === 'ZOOMIES_SPRINT';
      if (moving) applyGait(p, c.gaitPhase, g, homes);
      else {
        p.fnX = homes[0];
        p.ffX = homes[1];
        p.hnX = homes[2];
        p.hfX = homes[3];
      }
      if (state === 'SAUNTER_WALK') p.tailWave = 0.2;
      return p;
    }
    case 'CROUCH_PREP_JUMP': {
      const p = makePose();
      const wig = Math.sin(t * 21);
      p.hipX = -22 + wig * 2.2;
      p.hipY = -27 - Math.abs(wig) * 1.2;
      p.shX = 18;
      p.shY = -21;
      p.headX = 33;
      p.headY = -36;
      p.thickBot = 11.5;
      p.fnX = 20;
      p.ffX = 15;
      p.hnX = -18 + wig * 1.2;
      p.hfX = -23 + wig * 1.2;
      p.pupil = 0.95;
      p.earL = p.earR = 5;
      p.tailAngle = Math.PI * 0.95;
      p.tailCurl = 0.02;
      p.tailWhip = 0.45;
      applyLook(p, c, 0.4);
      return p;
    }
    case 'JUMP_ASCEND': {
      const p = makePose({
        hipX: -27,
        hipY: -38,
        shX: 25,
        shY: -41,
        arch: 1,
        headX: 40,
        headY: -53,
        fnX: 43,
        fnY: -30,
        ffX: 38,
        ffY: -25,
        fnCurl: 0.5,
        ffCurl: 0.5,
        hnX: -44,
        hnY: -14,
        hfX: -39,
        hfY: -9,
        hnCurl: 0.7,
        hfCurl: 0.7,
        pupil: 0.9,
        earL: -6,
        earR: -6,
        tailAngle: Math.PI * 1.04,
        tailCurl: 0.04,
        tailStiff: 0.18,
        tailGravity: 120,
      });
      p.rot = clamp(Math.atan2(c.vy, Math.max(30, Math.abs(c.vx))) * 0.55, -0.75, 0.45);
      return p;
    }
    case 'FALL_DESCEND': {
      const p = makePose({
        hipX: -24,
        hipY: -36,
        shX: 22,
        shY: -38,
        headX: 34,
        headY: -55,
        headRot: 0.25,
        fnX: 31,
        fnY: 5,
        ffX: 25,
        ffY: 8,
        hnX: -17,
        hnY: 4,
        hfX: -24,
        hfY: 6,
        lookY: 0.7,
        pupil: 0.85,
        earL: -10,
        earR: -10,
        tailAngle: -2.0,
        tailCurl: 0.2,
        tailStiff: 0.25,
        tailGravity: 60,
      });
      p.rot = clamp(Math.atan2(c.vy, Math.max(30, Math.abs(c.vx))) * 0.3, -0.3, 0.55);
      return p;
    }
    case 'STARTLED_AIRBORNE': {
      const p = makePose({
        hipX: -22,
        hipY: -40,
        shX: 20,
        shY: -40,
        arch: -11,
        headX: 32,
        headY: -57,
        fnX: 35,
        fnY: -6,
        ffX: 28,
        ffY: 7,
        hnX: -31,
        hnY: -4,
        hfX: -24,
        hfY: 8,
        eyeOpen: 1,
        pupil: 1,
        earL: -26,
        earR: -26,
        mouth: 0.25,
        tailAngle: -1.7,
        tailCurl: 0.05,
        tailPuff: 1,
        tailStiff: 0.45,
        tailGravity: 50,
        shiver: 0.6,
      });
      p.rot = Math.sin(t * 9) * 0.12;
      return p;
    }
    case 'LAND_RECOVERY': {
      const crouch = makePose({ hipY: -25, shY: -24, hipX: -23, shX: 21, headY: -40, headX: 34, thickBot: 11.5, fnX: 23, ffX: 17, hnX: -20, hfX: -26, earL: -4, earR: -4, tailAngle: -2.4 });
      const p = makePose();
      return blendPose(crouch, p, smoothstep(0.15, 1, pr), p);
    }
    case 'WALL_CLIMB': {
      const g = GAITS.WALL_CLIMB as GaitSpec;
      const p = makePose({ hipX: -26, hipY: -30, shX: 24, shY: -31, headX: 38, headY: -44, headRot: 1.1, faceTurn: 0.15, thickBot: 11, tailAngle: Math.PI * 1.02, tailStiff: 0.12, tailGravity: 700, earL: 3, earR: 3 });
      applyGait(p, c.gaitPhase, g, [22, 17, -22, -27]);
      p.rot = -Math.PI / 2;
      return p;
    }
    case 'EDGE_PEEK': {
      const p = makePose();
      p.headX = 37;
      p.headY = -55;
      p.faceTurn = 0.02;
      p.headRot = Math.sin(t * 0.8) * 0.12 + 0.12;
      p.pupil = 0.8;
      p.earL = p.earR = 6;
      p.tailAngle = -1.9;
      applyLook(p, c, 1);
      return p;
    }
    /* ---------- cursor & page ---------- */
    case 'CURSOR_GAZE': {
      const p = makePose(SIT);
      p.pupil = 0.65;
      p.earL = p.earR = 5;
      p.headRot = Math.sin(t * 0.6 + c.seed * 3) * 0.12; // curious head tilt
      applyLook(p, c, 1);
      breathingTail(p, t, c.seed);
      return p;
    }
    case 'POUNCE_AND_PIN': {
      const leap = makePose({ hipX: -28, hipY: -34, shX: 26, shY: -30, headX: 42, headY: -40, fnX: 47, fnY: -14, ffX: 43, ffY: -8, fnCurl: 0.6, ffCurl: 0.6, hnX: -40, hnY: -6, hfX: -36, hfY: -2, pupil: 1, earL: 4, earR: 4, tailAngle: Math.PI * 1.02, tailStiff: 0.2, rot: -0.22 });
      const pin = makePose({ hipX: -20, hipY: -37, shX: 18, shY: -22, headX: 32, headY: -25, headRot: 0.35, fnX: 33, fnY: 0, ffX: 29, ffY: 0, hnX: -19, hfX: -24, pupil: 1, earL: 2, earR: 2, tailAngle: -2.6, tailWhip: 0.5, thickBot: 11.5 });
      const p = makePose();
      blendPose(leap, pin, smoothstep(0.22, 0.42, pr), p);
      if (pr > 0.42) {
        const pat = Math.max(0, Math.sin((t - 0.4) * TAU * 3));
        p.fnY = -pat * 6;
        p.fnCurl = pat;
      }
      return p;
    }
    case 'KEYBOARD_WATCH': {
      const p = makePose(SIT);
      p.headRot = 0.18;
      p.pupil = 0.7;
      p.earL = p.earR = 6;
      applyLook(p, c, 1);
      p.headRot += Math.sin(t * 7) * 0.02; // tiny tracking jitter as the caret moves
      return p;
    }
    /* ---------- tactile responses ---------- */
    case 'PURRING': {
      const p = makePose(c.sitting ? SIT : LOAF);
      p.eyeOpen = 0;
      p.headRot = clamp(-0.3 + c.lookY * 0.2, -0.5, 0.2);
      p.headY -= 1.5;
      p.faceTurn = 0.2;
      p.shiver = 0.35;
      p.earL = p.earR = -3;
      p.tailWave = 0.06;
      return p;
    }
    case 'KNEADING_BISCUITS': {
      const p = makePose({ hipX: -18, hipY: -15, shX: 15, shY: -30, haunch: 0.9, thickTop: 12.5, thickBot: 12, headX: 28, headY: -47, headRot: 0.05, eyeOpen: 0.25, earL: -4, earR: -4, hnX: -10, hnY: 0, hfX: -14, hfY: 0, hindHidden: 0.7, tailAngle: -2.1, tailCurl: 0.2 });
      const k = t * TAU * 1.5;
      const l1 = Math.max(0, Math.sin(k));
      const l2 = Math.max(0, -Math.sin(k));
      p.fnX = 22 + l1 * 2;
      p.fnY = -l1 * 7;
      p.ffX = 17 + l2 * 2;
      p.ffY = -l2 * 7;
      p.fnCurl = l1;
      p.ffCurl = l2;
      p.pads = Math.max(l1, l2);
      p.shiver = 0.25;
      return p;
    }
    case 'BELLY_UP_ROLL': {
      const p = makePose({
        roll: 0.9 + Math.sin(t * 1.4) * 0.1,
        hipX: -24,
        hipY: -13,
        shX: 20,
        shY: -14,
        arch: 3,
        thickTop: 12,
        thickBot: 13,
        haunch: 0.2,
        headX: 37,
        headY: -15,
        headRot: -2.45,
        faceTurn: 0.05,
        eyeOpen: 0.8,
        pupil: 0.65,
        fnX: 31,
        fnY: -40,
        ffX: 25,
        ffY: -36,
        fnCurl: 0.7,
        ffCurl: 0.7,
        hnX: -14,
        hnY: -38,
        hfX: -21,
        hfY: -33,
        hnCurl: 0.5,
        hfCurl: 0.5,
        pads: 1,
        tailAngle: Math.PI,
        tailCurl: 0.03,
        tailWave: 0.28,
        tailFreq: 0.8,
        tailStiff: 0.15,
        tailGravity: 500,
      });
      p.fnY += Math.sin(t * 1.4) * 3;
      p.hnY += Math.sin(t * 1.4 + 1) * 3;
      return p;
    }
    case 'BUNNY_KICK_SWAT': {
      const p = computePose('BELLY_UP_ROLL', c);
      const k = t * TAU * 4.2;
      p.hnX = -8 + Math.sin(k) * 9;
      p.hnY = -28 + Math.cos(k) * 5;
      p.hfX = -14 + Math.sin(k + Math.PI) * 9;
      p.hfY = -26 + Math.cos(k + Math.PI) * 5;
      p.fnX = 40;
      p.fnY = -28 + Math.sin(k * 0.5) * 4;
      p.ffX = 36;
      p.ffY = -24;
      p.earL = p.earR = -30;
      p.pupil = 1;
      p.mouth = 0.2;
      p.tailWhip = 0.7;
      p.roll = 0.95;
      return p;
    }
    case 'TAIL_LASH': {
      const p = makePose(c.sitting ? SIT : {});
      p.tailAngle = c.sitting ? Math.PI * 1.02 : -2.6;
      p.tailCurl = 0.05;
      p.tailWave = 0.6;
      p.tailFreq = 2.2;
      p.tailWhip = 1;
      p.tailStiff = 0.55;
      p.earL = p.earR = -38;
      p.eyeOpen = 0.55;
      p.squint = 0.45;
      p.pupil = 0.15;
      applyLook(p, c, 0.8);
      return p;
    }
    case 'ELEVATOR_BUTT': {
      const p = makePose({ hipX: -22, hipY: -48, shX: 21, shY: -36, arch: 2, headX: 33, headY: -52, headRot: 0.12, hnX: -24, hfX: -29, eyeOpen: 0.3, earL: -2, earR: -2, tailAngle: -1.62, tailCurl: 0.04, tailStiff: 0.65, tailWave: 0.05 });
      p.hipY += Math.sin(t * 2.2) * 1.5;
      return p;
    }
    case 'PAW_TUCK': {
      const p = makePose(c.sitting ? SIT : LOAF);
      const k = Math.sin(Math.PI * smoothstep(0, 0.9, pr));
      if (c.sitting) {
        p.fnX = lerp(8, 2, k);
        p.fnY = -9 * k;
        p.fnCurl = k;
      } else {
        p.tuck = 1;
      }
      p.faceTurn = 0.55;
      p.headRot = -0.12 * k;
      p.eyeOpen = 0.6;
      p.earL = p.earR = -6 * k;
      return p;
    }
    case 'EAT_TREAT': {
      const p = makePose({ shY: -33, shX: 21, headX: 37, headY: -15, headRot: 0.62, faceTurn: 0.4, tailAngle: -2.0, tailCurl: 0.25, eyeOpen: 0.5 });
      const chew = (1 + Math.sin(t * 13)) / 2;
      p.mouth = chew * 0.25;
      p.headY += chew * 1.2;
      return p;
    }
    /* ---------- social ---------- */
    case 'NOSE_BOOP_GREETING': {
      const p = makePose({ headX: 41, headY: -51, headRot: 0.05, faceTurn: 0.55, eyeOpen: 0.6, tailAngle: -1.75, tailCurl: 0.35, earL: 3, earR: 3 });
      const reach = Math.sin(Math.PI * smoothstep(0.1, 0.8, pr));
      p.headX += reach * 3;
      p.shX += reach * 1.5;
      return p;
    }
    case 'ALLOGROOMING': {
      const p = makePose(SIT);
      const lick = Math.max(0, Math.sin(t * TAU * 2.4));
      p.headX = 21 + lick * 2;
      p.headY = -58 + lick * 2;
      p.headRot = 0.25 + lick * 0.12;
      p.faceTurn = 0.6;
      p.tongue = lick;
      p.mouth = lick * 0.3;
      p.eyeOpen = 0.35;
      return p;
    }
    case 'ALLOGROOM_RECEIVE': {
      const p = makePose(LOAF);
      p.eyeOpen = 0;
      p.headRot = -0.28;
      p.headY -= 2;
      p.earL = p.earR = -8;
      p.shiver = 0.2;
      return p;
    }
    case 'YIN_YANG_CUDDLE_SLEEP': {
      const p = makePose(CURL);
      if (c.role === 1) {
        p.headRot = 0.75;
        p.headX = 15;
        p.headY = -9;
      }
      return p;
    }
    case 'PLAY_WRESTLE': {
      const phase = Math.floor(t / 1.25 + c.role) % 2;
      if (phase === 0) {
        const p = computePose('BUNNY_KICK_SWAT', c);
        p.earL = p.earR = -12;
        return p;
      }
      const p = makePose({ hipX: -22, hipY: -38, shX: 18, shY: -32, headX: 32, headY: -45, pupil: 1, earL: 0, earR: 0, tailAngle: -2.4, tailWhip: 0.5 });
      const sw = t * TAU * 3.2;
      p.fnX = 34 + Math.sin(sw) * 6;
      p.fnY = -18 - Math.max(0, Math.cos(sw)) * 10;
      p.fnCurl = 0.8;
      p.ffX = 24;
      p.ffY = -6 * Math.max(0, Math.sin(sw + 1));
      return p;
    }
    /* ---------- photo-derived signature states ---------- */
    case 'CHIN_PROP_SLEEP': {
      const p = makePose(SPHINX);
      p.roll = 0.12;
      p.thickBot = 9.5;
      if (Number.isFinite(c.edgeAhead) && c.edgeAhead < 60) {
        const e = clamp(c.edgeAhead, 24, 50);
        p.headX = e - 9;
        p.headY = -15;
        p.fnX = e + 2;
        p.fnY = 10;
        p.ffX = e - 6;
        p.ffY = 0;
      } else {
        p.headX = 35;
        p.headY = -17;
        p.fnX = 44;
        p.ffX = 40;
      }
      p.headRot = 0.08;
      p.eyeOpen = 0;
      p.faceTurn = 0.18;
      p.breath = 1.3;
      p.breathRate = 0.3;
      p.earL = p.earR = -4;
      return p;
    }
    case 'MELTED_LOAF_SLEEP': {
      const p = makePose(LOAF);
      p.hipX = -30;
      p.hipY = -10;
      p.shX = 25;
      p.shY = -11;
      p.arch = -2;
      p.thickTop = 11;
      p.thickBot = 6.5;
      p.haunch = 0.35;
      p.headX = 43;
      p.headY = -11.5;
      p.headRot = 0.12;
      p.faceTurn = 0.3;
      p.eyeOpen = 0;
      p.tuck = 0.85;
      p.tailAngle = Math.PI * 1.01;
      p.tailCurl = 0;
      p.tailStiff = 0.06;
      p.tailGravity = 900;
      p.tailFront = 0;
      p.breath = 1.25;
      p.breathRate = 0.27;
      return p;
    }
    case 'TANDEM_BELLY_HOLD_SLEEP': {
      const p = makePose(SPRAWL);
      if (c.role === 0) {
        p.fnX = 60;
        p.fnY = -12;
        p.ffX = 56;
        p.ffY = -16;
        p.fnCurl = p.ffCurl = 0.6;
        p.hnX = -42;
        p.hnY = -4;
        p.hfX = -48;
        p.hfY = -1;
      } else {
        p.hnX = -40;
        p.hnY = -5;
        p.hfX = -46;
        p.hfY = -2;
      }
      p.pads = 0.3;
      return p;
    }
    case 'PILLOW_STACK_CUDDLE': {
      if (c.role === 0) {
        const p = makePose(CURL);
        p.headRot = 0.45;
        return p;
      }
      const p = makePose(LOAF);
      p.thickTop = 12.5;
      p.thickBot = 7.5;
      const top = Number.isFinite(c.partnerTopY) ? c.partnerTopY : -22;
      p.headX = 38;
      p.headY = clamp(top - 7, -40, -10);
      p.headRot = 0.32;
      p.eyeOpen = 0;
      p.earL = p.earR = -5;
      p.breath = 1.3;
      p.breathRate = 0.28;
      return p;
    }
    case 'LEDGE_CHIN_REST': {
      const p = makePose(LOAF);
      const e = Number.isFinite(c.edgeAhead) ? clamp(c.edgeAhead, 24, 48) : 34;
      p.hipX = -24;
      p.hipY = -12;
      p.shX = e - 18;
      p.shY = -13;
      p.thickTop = 12.5;
      p.thickBot = 8;
      p.headX = e - 6;
      p.headY = -10;
      p.headRot = 0.26;
      p.eyeOpen = 0.45 + Math.sin(t * 0.5) * 0.1;
      p.frontHidden = 0;
      p.fnX = e - 3;
      p.fnY = 0;
      p.ffX = e - 10;
      p.ffY = -2;
      p.fnCurl = 0.2;
      applyLook(p, c, 0.3);
      return p;
    }
    case 'WIDE_PAW_SPLAY': {
      const p = makePose(SPHINX);
      const e = Number.isFinite(c.edgeAhead) ? clamp(c.edgeAhead, 22, 46) : 32;
      p.roll = 0.15;
      p.shX = e - 14;
      p.hipX = p.shX - 40;
      p.fnX = e + 6;
      p.fnY = 19 + Math.sin(t * 0.7) * 1.2;
      p.fnCurl = 0.3;
      p.ffX = e - 2;
      p.ffY = 0;
      p.headX = e - 13;
      p.headY = -14;
      p.headRot = 0.18;
      p.eyeOpen = 0.3;
      p.breath = 1.2;
      return p;
    }
    case 'JUDGMENTAL_AIRPLANE_SQUINT': {
      const base = c.lying ? (SPHINX as Partial<Pose>) : SIT;
      const p = makePose(base);
      p.headY = c.lying ? -40 : -63;
      p.headRot = 0;
      p.earL = p.earR = -38;
      p.eyeOpen = 0.4;
      p.squint = 0.3;
      p.pupil = 0.22;
      p.faceTurn = 0.05;
      p.tailWhip = 0.35;
      applyLook(p, c, 1);
      return p;
    }
    default: {
      const _exhaustive: never = state;
      return makePose(_exhaustive);
    }
  }
}

/** Whether the head/eyes in this state may follow a gaze target. */
export function canLook(state: CatState): boolean {
  switch (state) {
    case 'IDLE_SIT':
    case 'IDLE_STAND':
    case 'CAT_LOAF':
    case 'SPHINX_POSE':
    case 'CURSOR_GAZE':
    case 'KEYBOARD_WATCH':
    case 'CROUCH_PREP_JUMP':
    case 'EDGE_PEEK':
    case 'TAIL_LASH':
    case 'JEALOUSY_INTERVENTION':
    case 'JUDGMENTAL_AIRPLANE_SQUINT':
    case 'LEDGE_CHIN_REST':
    case 'STALK_CURSOR':
      return true;
    default:
      return false;
  }
}
