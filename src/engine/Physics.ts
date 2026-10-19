/**
 * Physics primitives for cats living on a webpage.
 *
 *  • Gravity g = 980 px/s², capped terminal velocity for "soft" falls.
 *  • Exact parabolic jump planning (closed form) so a cat lands precisely on a
 *    target DOM platform above or below it.
 *  • One-way platforms: cats pass up through ledges and land on their top edge
 *    only while descending.
 *  • Platform list utilities (pure functions, unit-tested).
 *  • The scruff pendulum: a held cat's body swings under the hand with a damped
 *    spring and settles straight down when the hand is still.
 */
import { clamp } from '../shared/math';

export const GRAVITY = 980;
export const TERMINAL_VELOCITY = 1500;
export const SOFT_FALL_VELOCITY = 1100;
export const MAX_JUMP_UP = 430;
export const MAX_JUMP_DX = 560;
export const MAX_GAP = 300;
export const SCROLL_VIOLENCE_THRESHOLD = 2600; // px/s of platform motion that knocks a cat off

export type PlatformKind = 'floor' | 'dom' | 'virtual';

export interface Platform {
  id: string;
  kind: PlatformKind;
  xMin: number;
  xMax: number;
  y: number;
  /** 0..1 — video players and images are "warm" spots lazy cats love. */
  warm: number;
  /** Narrow elevated ledge (Cat 2's favourite melted-loaf spot). */
  narrow: boolean;
  tag: string;
  elementRef: Element | null;
}

export interface WorldBounds {
  width: number;
  height: number;
}

/** Anything that can tell the simulation where the ledges are (real DOM or Studio mock). */
export interface PlatformSource {
  platforms(): readonly Platform[];
  /** Fresh geometry for a platform a cat is standing on (re-measured each frame). */
  get(id: string): Platform | null;
  floor(): Platform;
  bounds(): WorldBounds;
  /** Document scroll position, when the source is a real scrolling page. */
  scrollOffset?(): { x: number; y: number };
}

export interface JumpPlan {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  vx: number;
  vy: number;
  duration: number;
  apexY: number;
}

/**
 * Plans a parabolic jump from (x0,y0) to (x1,y1) (screen coordinates, +y down)
 * whose apex clears the higher of the two points by `clearance` px.
 * Returns null when the jump exceeds a cat's athletic envelope.
 */
export function solveJump(x0: number, y0: number, x1: number, y1: number, clearance = 36, g = GRAVITY): JumpPlan | null {
  const rise = y0 - y1; // >0 means target is above
  if (rise > MAX_JUMP_UP) return null;
  if (Math.abs(x1 - x0) > MAX_JUMP_DX && rise > -200) return null;
  const apexY = Math.min(y0, y1) - Math.max(8, clearance);
  const hUp = y0 - apexY;
  const hDown = y1 - apexY;
  const tUp = Math.sqrt((2 * hUp) / g);
  const tDown = Math.sqrt((2 * hDown) / g);
  const duration = tUp + tDown;
  const vy = -g * tUp;
  const vx = (x1 - x0) / duration;
  return { x0, y0, x1, y1, vx, vy, duration, apexY };
}

/** How high a cat's feet can get when it leaps straight up at something (px, at scale 1). */
export const MAX_LEAP_UP = 190;
/** How far it drifts sideways in such a leap (px, at scale 1). */
export const MAX_LEAP_DX = 150;
/** How far above its feet a cat's front paws reach at full stretch (px, at scale 1). */
export const LEAP_REACH = 64;

export interface LeapPlan {
  /** The target is behind the cat: it has to turn around before it may leap. */
  turn: boolean;
  /** The jump (lands back on the same ledge), or null when there is nothing to leap at. */
  plan: JumpPlan | null;
}

/**
 * Plans a vertical pounce at something in the air (a dangling string, a laser on
 * a wall, a ball in flight): a jump from (x, y) that lands back on the same ledge,
 * peaking where the outstretched front paws meet the target at (tx, ty). The leap
 * goes straight up or *forward* — never backward: a target behind the cat
 * (relative to `facing`) returns `turn: true` so it turns around first.
 */
export function planLeap(x: number, y: number, facing: 1 | -1, tx: number, ty: number, scale = 1): LeapPlan {
  const dx = tx - x;
  const dir: 1 | -1 = Math.abs(dx) < 6 * scale ? facing : dx > 0 ? 1 : -1;
  if (dir !== facing) return { turn: true, plan: null };
  const reach = LEAP_REACH * scale;
  const rise = y - ty;
  if (rise > MAX_LEAP_UP * scale + reach || rise < -10) return { turn: false, plan: null };
  const clearance = Math.max(12 * scale, rise - reach);
  // The paws are ~20 px ahead of the feet: aim the apex there, landing as far again beyond it.
  const apexX = tx - dir * 20 * scale;
  const drift = clamp((apexX - x) * 2 * dir, 0, MAX_LEAP_DX * scale);
  const plan = solveJump(x, y, x + dir * drift, y, clearance);
  return { turn: false, plan };
}

export function trajectoryAt(plan: JumpPlan, t: number, g = GRAVITY): { x: number; y: number; vx: number; vy: number } {
  return {
    x: plan.x0 + plan.vx * t,
    y: plan.y0 + plan.vy * t + 0.5 * g * t * t,
    vx: plan.vx,
    vy: plan.vy + g * t,
  };
}

/**
 * One-way platform landing test: returns the highest platform whose top edge was
 * crossed while moving downward from prevY to newY at horizontal position x.
 */
export function findLanding(prevY: number, newY: number, x: number, platforms: readonly Platform[], ignoreId: string | null = null, margin = 4): Platform | null {
  if (newY < prevY) return null;
  let best: Platform | null = null;
  for (const p of platforms) {
    if (p.id === ignoreId) continue;
    if (x < p.xMin - margin || x > p.xMax + margin) continue;
    if (p.y >= prevY - 0.5 && p.y <= newY + 0.5) {
      if (!best || p.y < best.y) best = p;
    }
  }
  return best;
}

/** Semi-implicit Euler free-fall step with capped terminal velocity. */
export function fallStep(y: number, vy: number, dt: number, soft = false, g = GRAVITY): { y: number; vy: number } {
  const cap = soft ? SOFT_FALL_VELOCITY : TERMINAL_VELOCITY;
  const nvy = clamp(vy + g * dt, -cap * 2, cap);
  return { y: y + nvy * dt, vy: nvy };
}

/** Horizontal friction decay toward 0 (exponential). */
export function applyFriction(vx: number, friction: number, dt: number): number {
  return vx * Math.exp(-friction * dt);
}

/** True when the platform under a cat moves faster than a cat can hold on. */
export function isScrollViolent(dy: number, dt: number, threshold = SCROLL_VIOLENCE_THRESHOLD): boolean {
  if (dt <= 0) return false;
  return Math.abs(dy / dt) > threshold;
}

export function platformWidth(p: Platform): number {
  return p.xMax - p.xMin;
}

export function containsX(p: Platform, x: number, margin = 0): boolean {
  return x >= p.xMin - margin && x <= p.xMax + margin;
}

/** The platform directly below (x, y) — the first top edge at or under y. */
export function platformBelow(x: number, y: number, platforms: readonly Platform[], tolerance = 2): Platform | null {
  let best: Platform | null = null;
  for (const p of platforms) {
    if (!containsX(p, x)) continue;
    if (p.y >= y - tolerance && (!best || p.y < best.y)) best = p;
  }
  return best;
}

export interface RawRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlatformCandidate {
  id: string;
  rect: RawRect;
  tag: string;
  warm: number;
  elementRef: Element | null;
}

/**
 * Turns measured element rectangles into usable ledges: filters tiny, hidden or
 * off-screen boxes, clips to the viewport, de-duplicates near-identical edges
 * (nested wrappers) and keeps the most useful ones.
 */
export function buildPlatforms(candidates: readonly PlatformCandidate[], bounds: WorldBounds, opts: { minWidth?: number; topMargin?: number; floorMargin?: number; max?: number } = {}): Platform[] {
  const minWidth = opts.minWidth ?? 72;
  const topMargin = opts.topMargin ?? 70;
  const floorMargin = opts.floorMargin ?? 56;
  const max = opts.max ?? 48;
  const floorY = bounds.height;
  const out: Platform[] = [];
  for (const c of candidates) {
    const xMin = Math.max(6, c.rect.left);
    const xMax = Math.min(bounds.width - 6, c.rect.right);
    const y = c.rect.top;
    if (xMax - xMin < minWidth) continue;
    if (y < topMargin || y > floorY - floorMargin) continue;
    if (c.rect.bottom - c.rect.top < 8) continue;
    const width = xMax - xMin;
    out.push({
      id: c.id,
      kind: 'dom',
      xMin,
      xMax,
      y,
      warm: c.warm,
      narrow: width < 300 && y < floorY - 160,
      tag: c.tag,
      elementRef: c.elementRef,
    });
  }
  return mergePlatforms(out).slice(0, max);
}

/** Collapses ledges whose top edges are within `yTol` px and overlap horizontally. */
export function mergePlatforms(list: readonly Platform[], yTol = 5): Platform[] {
  const sorted = list.slice().sort((a, b) => platformWidth(b) - platformWidth(a));
  const kept: Platform[] = [];
  for (const p of sorted) {
    const dup = kept.find((k) => Math.abs(k.y - p.y) <= yTol && Math.min(k.xMax, p.xMax) - Math.max(k.xMin, p.xMin) > 0.6 * Math.min(platformWidth(k), platformWidth(p)));
    if (dup) {
      dup.warm = Math.max(dup.warm, p.warm);
      continue;
    }
    kept.push({ ...p });
  }
  return kept;
}

/** DOM ledges plus the viewport floor (always last). */
export function allPlatforms(src: PlatformSource): Platform[] {
  return [...src.platforms(), src.floor()];
}

export function makeFloor(bounds: WorldBounds, inset = 2): Platform {
  return {
    id: 'floor',
    kind: 'floor',
    xMin: 0,
    xMax: bounds.width,
    y: bounds.height - inset,
    warm: 0,
    narrow: false,
    tag: 'viewport',
    elementRef: null,
  };
}

/* ------------------------------------------------------------ scruff hold */

/** Largest swing either side of vertical while held (radians). */
export const PENDULUM_MAX_ANGLE = 0.65;
/** Hand speed (px per 60 Hz frame) → target swing angle. */
export const PENDULUM_GAIN = 0.045;
/** Spring stiffness (1/s²) and damping (1/s): ω ≈ 6.2 rad/s, ζ ≈ 0.6 — a couple of soft sways, then still. */
export const PENDULUM_K = 38;
export const PENDULUM_C = 7.5;

export interface PendulumState {
  /** Swing angle from vertical (+ = the body swings out to the right). */
  angle: number;
  angVel: number;
}

/** Where the body wants to hang for a given horizontal hand speed: it trails the motion. */
export function pendulumTarget(handVxPerFrame: number): number {
  return clamp(-handVxPerFrame * PENDULUM_GAIN, -PENDULUM_MAX_ANGLE, PENDULUM_MAX_ANGLE);
}

/** One spring-damper step toward the target swing; the angle is always kept within ±PENDULUM_MAX_ANGLE. */
export function pendulumStep(s: PendulumState, handVxPerFrame: number, dt: number): PendulumState {
  if (dt <= 0) return s;
  const target = pendulumTarget(handVxPerFrame);
  // Sub-step for stability at low frame rates.
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.angVel += (PENDULUM_K * (target - s.angle) - PENDULUM_C * s.angVel) * h;
    s.angle += s.angVel * h;
    if (s.angle > PENDULUM_MAX_ANGLE || s.angle < -PENDULUM_MAX_ANGLE) {
      s.angle = clamp(s.angle, -PENDULUM_MAX_ANGLE, PENDULUM_MAX_ANGLE);
      s.angVel = 0;
    }
  }
  return s;
}

/** Throw speeds are capped so a flick never launches a cat into orbit (px/s). */
export const MAX_THROW_VX = 1200;
export const MAX_THROW_UP = 1100;
export const MAX_THROW_DOWN = 1200;

export function clampThrow(vx: number, vy: number): { vx: number; vy: number } {
  const fx = Number.isFinite(vx) ? vx : 0;
  const fy = Number.isFinite(vy) ? vy : 0;
  return { vx: clamp(fx, -MAX_THROW_VX, MAX_THROW_VX), vy: clamp(fy, -MAX_THROW_UP, MAX_THROW_DOWN) };
}
