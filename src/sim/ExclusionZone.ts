/**
 * Typing exclusion zones (v3.1): while you are typing in a text field the cats
 * keep well clear of it — they never sit on it, hang over its label, block the
 * caret or walk across it.
 *
 * The zone is the focused field's box expanded by a generous margin (90 px left
 * and right, 110 px above, 70 px below). While it is active:
 *  • ledges whose standing area reaches into it can't be stood on or jumped to,
 *  • the stretch of floor under it (when the field is near the bottom) is a
 *    no-go strip that cats neither stop in nor walk across,
 *  • any cat inside it (or heading into it) gets up and moves at least 140 px
 *    from the field, then sits down and watches from there.
 *
 * Pure geometry, shared by the page, the Studio preview and the tests.
 */
import { clamp } from '../shared/math';
import type { Platform } from '../engine/Physics';

export interface NoGoRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ElementBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const ZONE_PADDING = { x: 90, top: 110, bottom: 70 } as const;
/** How far (px) an evacuated cat moves from the field it was near, at least. */
export const EVADE_DISTANCE = 140;
/** How tall a standing cat is for "does its standing area reach into the zone" (px at scale 1). */
const STANDING_HEIGHT = 64;
/** Keep the zone at least this long after the last keystroke while the field stays focused (ms). */
export const TYPING_LINGER_MS = 8000;

/** The field's box expanded by the safety margins. */
export function exclusionZone(r: ElementBox, pad = ZONE_PADDING): NoGoRect {
  return { minX: r.left - pad.x, minY: r.top - pad.top, maxX: r.right + pad.x, maxY: r.bottom + pad.bottom };
}

export function rectsIntersect(a: NoGoRect, b: NoGoRect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function pointInZone(x: number, y: number, z: NoGoRect): boolean {
  return x >= z.minX && x <= z.maxX && y >= z.minY && y <= z.maxY;
}

/** True when a cat standing anywhere on this ledge would be in the zone. */
function standingBand(p: Platform, scale: number): { top: number; bottom: number } {
  return { top: p.y - STANDING_HEIGHT * scale, bottom: p.y };
}

/** The part of a platform that is off-limits ([lo, hi] in x), or null when none of it is. */
export function blockedSpan(p: Platform, z: NoGoRect, scale = 1): { lo: number; hi: number } | null {
  const band = standingBand(p, scale);
  if (band.bottom < z.minY || band.top > z.maxY) return null;
  const lo = Math.max(p.xMin, z.minX);
  const hi = Math.min(p.xMax, z.maxX);
  return hi > lo ? { lo, hi } : null;
}

/**
 * Platforms a cat may use while the zone is active: every ledge whose standing
 * area reaches into the zone is dropped (the floor always stays — its blocked
 * stretch is handled by `blockedSpan`).
 */
export function filterPlatforms<T extends Platform>(platforms: readonly T[], z: NoGoRect | null, scale = 1): T[] {
  if (!z) return [...platforms];
  return platforms.filter((p) => p.kind === 'floor' || !blockedSpan(p, z, scale));
}

/**
 * A safe x on the floor at least EVADE_DISTANCE from the field (the zone edge
 * plus whatever the padding leaves), on the side nearer to `x` unless there is
 * no room there.
 */
export function safeFloorX(x: number, z: NoGoRect, width: number, margin = 24, pad = ZONE_PADDING): number {
  // At least 140 px from the field, and far enough that the whole cat (margin ≈ half its length) is clear of the zone.
  const extra = Math.max(margin + 16, EVADE_DISTANCE - pad.x);
  const left = z.minX - extra;
  const right = z.maxX + extra;
  const leftOk = left >= margin;
  const rightOk = right <= width - margin;
  const preferLeft = Math.abs(x - left) <= Math.abs(x - right);
  if (leftOk && (preferLeft || !rightOk)) return left;
  if (rightOk) return right;
  // The field spans the whole width: as far from it as the screen allows.
  return clamp(x < (z.minX + z.maxX) / 2 ? margin : width - margin, margin, width - margin);
}

/**
 * Where a walk toward `targetX` on platform `p` may end: never inside the blocked
 * stretch, and never on the far side of it (no crossing through).
 */
export function clampWalk(fromX: number, targetX: number, p: Platform, z: NoGoRect | null, scale = 1, margin = 6): number {
  if (!z) return targetX;
  const span = blockedSpan(p, z, scale);
  if (!span) return targetX;
  // Left of the strip: stay left of it; right of it: stay right. (A cat caught inside walks out freely.)
  if (fromX < span.lo) return Math.min(targetX, span.lo - margin);
  if (fromX > span.hi) return Math.max(targetX, span.hi + margin);
  return targetX;
}

/** Input types that are not for typing text. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image', 'hidden']);
const TEXTBOX_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

export interface EditableInfo {
  tag: string;
  type?: string | null;
  contentEditable?: boolean;
  role?: string | null;
  readOnly?: boolean;
  disabled?: boolean;
}

/** Is this an element you type text into? (<input> text-like types, <textarea>, contenteditable, role=textbox/searchbox/combobox.) */
export function isEditableInfo(e: EditableInfo): boolean {
  if (e.disabled) return false;
  const tag = e.tag.toLowerCase();
  if (tag === 'input') return !e.readOnly && !NON_TEXT_INPUTS.has((e.type ?? 'text').toLowerCase());
  if (tag === 'textarea') return !e.readOnly;
  if (e.contentEditable) return true;
  return !!e.role && TEXTBOX_ROLES.has(e.role.toLowerCase());
}
