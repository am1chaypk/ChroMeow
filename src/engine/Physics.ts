/**
 * Physics primitives for cats living on a webpage.
 *
 *  • Gravity g = 980 px/s², capped terminal velocity for "soft" falls.
 *  • Exact parabolic jump planning (closed form) so a cat lands precisely on a
 *    target DOM platform above or below it.
 *  • One-way platforms: cats pass up through ledges and land on their top edge
 *    only while descending.
 *  • Platform list utilities (pure functions, unit-tested).
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
