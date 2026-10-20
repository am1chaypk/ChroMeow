/**
 * Feather wand / teaser rod (v3.1, "חכת נוצה"): a slim rod held at the user's
 * cursor, a 14-segment Verlet string hanging from its tip and a fluttering
 * feather lure (with a little bead and bell) at the end.
 *
 *  • The rod tilts with the hand's horizontal speed:
 *      rodAngle = clamp(mouseVx · 0.03, −0.5, 0.5)   (mouseVx in px per 60 Hz frame)
 *  • The string: gravity 0.45 px/frame², air drag 0.97, 7 relaxation passes,
 *    and collisions with the floor and the page's ledges — lower the wand and
 *    the string and feather lie down and slide along the surface.
 *  • A cat's swat kicks the feather (an impulse on the tip node and its
 *    neighbours) so the string visibly jerks and swings away.
 *
 * DOM-free: the page, the Studio preview and the tests share it.
 */
import { clamp, type Vec2 } from '../shared/math';
import type { AnyCtx } from '../engine/canvas';
import { platformBelow, type Platform, type WorldBounds } from '../engine/Physics';
import { StringRope } from '../engine/VerletRope';

export const WAND_SEGMENTS = 14;
export const WAND_SEG_LEN = 10;
/** Drawn length of the rod from the cursor to the end of the handle (px). */
export const ROD_LENGTH = 96;
/** The feather counts as "on the floor" within this distance of the surface below it (px). */
export const FLOOR_DRAG = 25;

export interface FeatherWand {
  /** The rod tip (= the cursor), where the string is tied on. */
  x: number;
  y: number;
  /** Smoothed hand speed (px/s). */
  vx: number;
  vy: number;
  /** Current rod tilt (radians). */
  rodAngle: number;
  /** Frame counter for the feather's flutter. */
  tick: number;
  rope: StringRope;
}

export function createWand(x: number, y: number): FeatherWand {
  return { x, y, vx: 0, vy: 0, rodAngle: 0, tick: 0, rope: new StringRope(x, y, WAND_SEGMENTS + 1, WAND_SEG_LEN) };
}

/** Rod tilt for a horizontal hand speed in px per 60 Hz frame. */
export function rodAngleFor(mouseVxPerFrame: number): number {
  return clamp(mouseVxPerFrame * 0.03, -0.5, 0.5);
}

/** Moves the rod to the cursor and steps the string. */
export function updateWand(w: FeatherWand, dt: number, x: number, y: number, platforms: readonly Platform[], bounds: WorldBounds): void {
  if (dt <= 0) return;
  const k = 1 - Math.exp(-12 * dt);
  w.vx += ((x - w.x) / dt - w.vx) * k;
  w.vy += ((y - w.y) / dt - w.vy) * k;
  w.x = x;
  w.y = y;
  w.rodAngle += (rodAngleFor(w.vx / 60) - w.rodAngle) * (1 - Math.exp(-10 * dt));
  w.tick += dt * 60;
  w.rope.step(dt, x, y, platforms, bounds);
}

/** The feather lure (last node). */
export function wandTip(w: FeatherWand): Vec2 {
  return w.rope.tip();
}

/** Height of the feather above the ledge or floor under it (px). */
export function tipHeight(w: FeatherWand, platforms: readonly Platform[], bounds: WorldBounds): number {
  const t = wandTip(w);
  const p = platformBelow(t.x, t.y - 1, platforms, 2);
  return Math.max(0, (p ? p.y : bounds.height - 2) - t.y);
}

/** True while the feather drags along a surface (within FLOOR_DRAG px of it). */
export function onSurface(w: FeatherWand, platforms: readonly Platform[], bounds: WorldBounds): boolean {
  return tipHeight(w, platforms, bounds) <= FLOOR_DRAG;
}

/** Tip speed (px/s): how lively the feather is. */
export function tipSpeed(w: FeatherWand, dt = 1 / 60): number {
  const n = w.rope.nodes[w.rope.nodes.length - 1];
  return Math.hypot(n.x - n.px, n.y - n.py) / (dt / 3);
}

/**
 * A paw swat at `paw`: if it reaches the lure (or the last stretch of string),
 * kick the feather away from the cat with velocity (vx, vy) px/s. Returns
 * whether it connected.
 */
export function swatWand(w: FeatherWand, paw: Vec2, vx: number, vy: number, reach = 34): boolean {
  const nodes = w.rope.nodes;
  const last = nodes.length - 1;
  const i = w.rope.nearest(paw.x, paw.y, reach);
  if (i < last - 4) return false;
  w.rope.bat(last, vx, vy);
  return true;
}

/* --------------------------------------------------------------- drawing */

export function drawWand(ctx: AnyCtx, w: FeatherWand): void {
  const nodes = w.rope.nodes;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The string: a thin smooth curve through the nodes.
  ctx.strokeStyle = '#E9DFC8';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length - 1; i++) {
    const mx = (nodes[i].x + nodes[i + 1].x) / 2;
    const my = (nodes[i].y + nodes[i + 1].y) / 2;
    ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, mx, my);
  }
  const tip = nodes[nodes.length - 1];
  const prev = nodes[nodes.length - 2];
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(90,70,40,0.35)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // The rod: from the cursor up and back to the handle, tilting with the hand.
  const base = -Math.PI * 0.32 + w.rodAngle; // pointing up-right from the tip when still
  const hx = w.x + Math.cos(base) * ROD_LENGTH;
  const hy = w.y + Math.sin(base) * ROD_LENGTH;
  const rg = ctx.createLinearGradient(w.x, w.y, hx, hy);
  rg.addColorStop(0, '#3B3A3F');
  rg.addColorStop(0.55, '#5A4636');
  rg.addColorStop(1, '#8A6440');
  ctx.strokeStyle = rg;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(w.x, w.y);
  ctx.lineTo(w.x + (hx - w.x) * 0.72, w.y + (hy - w.y) * 0.72);
  ctx.stroke();
  // Grip.
  ctx.strokeStyle = '#2D2A2A';
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.moveTo(w.x + (hx - w.x) * 0.72, w.y + (hy - w.y) * 0.72);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = '#C9A15A';
  ctx.beginPath();
  ctx.arc(w.x, w.y, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // The feather lure, along the last stretch of string, fluttering in the air.
  const a = Math.atan2(tip.y - prev.y, tip.x - prev.x);
  const speed = Math.min(1, Math.hypot(tip.x - tip.px, tip.y - tip.py) / 4);
  const flutter = Math.sin(w.tick * 0.25) * (0.06 + 0.3 * speed);
  ctx.translate(tip.x, tip.y);
  ctx.rotate(a);
  // Bead and a tiny bell where the feathers are tied.
  ctx.fillStyle = '#E2B13C';
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#9A6E1C';
  ctx.beginPath();
  ctx.arc(0.6, 0.6, 0.8, 0, Math.PI * 2);
  ctx.fill();
  const plumes: { len: number; w: number; spread: number; colors: [string, string] }[] = [
    { len: 26, w: 5.5, spread: -0.32, colors: ['#3BA7D9', '#1E5F9E'] },
    { len: 30, w: 6, spread: 0.02, colors: ['#F2557A', '#B8274E'] },
    { len: 24, w: 5, spread: 0.34, colors: ['#F7C846', '#D98A1F'] },
    { len: 18, w: 4, spread: 0.12, colors: ['#7AD39A', '#2E9A5E'] },
  ];
  plumes.forEach((pl, i) => {
    ctx.save();
    ctx.rotate(pl.spread + flutter * (i % 2 ? -1 : 1));
    const g = ctx.createLinearGradient(2, 0, pl.len, 0);
    g.addColorStop(0, pl.colors[1]);
    g.addColorStop(1, pl.colors[0]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.quadraticCurveTo(pl.len * 0.5, -pl.w, pl.len, -pl.w * 0.15);
    ctx.quadraticCurveTo(pl.len * 0.55, pl.w * 0.9, 2, 0);
    ctx.fill();
    // Shaft and barbs.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(pl.len * 0.95, -pl.w * 0.12);
    for (let b = 0.3; b < 0.9; b += 0.15) {
      ctx.moveTo(pl.len * b, -pl.w * 0.1);
      ctx.lineTo(pl.len * (b + 0.08), -pl.w * 0.6);
    }
    ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}

/** Screen box around the rod, string and feather (dirty-rect bookkeeping). */
export function wandBounds(w: FeatherWand): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = w.x - ROD_LENGTH;
  let minY = w.y - ROD_LENGTH;
  let maxX = w.x + ROD_LENGTH;
  let maxY = w.y + 10;
  for (const n of w.rope.nodes) {
    minX = Math.min(minX, n.x - 34);
    minY = Math.min(minY, n.y - 34);
    maxX = Math.max(maxX, n.x + 34);
    maxY = Math.max(maxY, n.y + 34);
  }
  return { minX, minY, maxX, maxY };
}
