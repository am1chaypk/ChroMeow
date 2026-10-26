/**
 * The cat tree & scratching tower (v4): a slim, tall, multi-tier playground that
 * stands on the viewport floor (by default tucked against the left edge) and that
 * you can drag sideways along the bottom of the window like the beds.
 *
 *   Tier 3  top crown bolster bed / lookout      ~410 px above the floor
 *   Tier 2  staggered side perch (hammock ledge)  ~275 px
 *           dangling pom-pom on an elastic cord underneath it
 *   Tier 1  cosy cubby (roof platform + a hole to curl up in)  ~140 px
 *           two sisal scratching posts rising from the base plate
 *   Base    weighted wooden plate with a paw plaque
 *
 * DOM-free like the food & water station and the beds. The three tiers are
 * registered as platforms (`platform_tower_tier1`, `platform_tower_tier2`,
 * `platform_tower_top`) through `TowerPlatformSource`, which wraps whatever
 * platform source the world uses (the real page scanner or the Studio's mock).
 */
import { clamp, clamp01 } from '../shared/math';
import type { CatTowerState } from '../shared/types';
import type { AnyCtx } from '../engine/canvas';
import type { Platform, PlatformSource, WorldBounds } from '../engine/Physics';

export const TOWER_TIER1 = 'platform_tower_tier1';
export const TOWER_TIER2 = 'platform_tower_tier2';
export const TOWER_TOP = 'platform_tower_top';
export const TOWER_PLATFORM_IDS: readonly string[] = [TOWER_TIER1, TOWER_TIER2, TOWER_TOP];

export function isTowerPlatform(id: string | null | undefined): id is string {
  return !!id && id.startsWith('platform_tower_');
}

/** The tower's design (px at scale 1): heights are measured from the floor to each tier's standing surface. */
export const TOWER_DESIGN = {
  baseW: 120,
  baseH: 14,
  footprint: 130,
  tier1: 140,
  tier2: 275,
  top: 410,
  /** The cubby's body (below the roof), and the cat-sized hole in its front. */
  cubbyH: 62,
  /** Tier 2 and the top bed. */
  tier1W: 108,
  tier2W: 95,
  topW: 105,
  /** Post positions relative to the centre. */
  postX: 34,
  midPostX: 34,
  upperPostX: 20,
  /** Total drawn height, and the largest share of the window the tower may take. */
  height: 432,
} as const;

/** Largest share of the window height the tower may use. */
export const TOWER_MAX_HEIGHT_SHARE = 0.65;
/** Dragging near the screen edges docks the tower against the border. */
export const TOWER_SNAP_LEFT = 0.08;
export const TOWER_SNAP_RIGHT = 0.92;
export const TOWER_X_MIN = 0.04;
export const TOWER_X_MAX = 0.96;
/** Cats never climb more than this (px at scale 1) in one jump onto / off the tower: step by step. */
export const TOWER_STEP_UP = 170;
export const TOWER_STEP_DOWN = 200;
/** How far (px at scale 1) a cat's body is lowered into the cubby, and the top bed's cushion lift. */
export const TOP_BED_LIFT = 6;

/** Wear added per second of scratching (0..100 over ~5 minutes of scratching). */
const WEAR_PER_SECOND = 0.35;

export interface TierGeom {
  xMin: number;
  xMax: number;
  /** Standing surface (top edge). */
  y: number;
}

export interface TowerGeom {
  cx: number;
  floorY: number;
  /** Overall scale (follows the cats' size, shrinks to keep the tower within 65 % of the window height). */
  u: number;
  halfW: number;
  tier1: TierGeom;
  tier2: TierGeom;
  top: TierGeom;
  /** x of the scratching posts, the mid post (tier 1 → 2) and the upper post (tier 2 → top). */
  postL: number;
  postR: number;
  midPost: number;
  upperPost: number;
  /** Where the pom-pom cord is tied under tier 2. */
  pomAnchor: { x: number; y: number };
  /** The cubby's body, its floor (where a cat curls up) and the hole's centre x. */
  cubby: { xMin: number; xMax: number; yTop: number; yBottom: number; holeX: number; holeW: number; holeH: number };
}

/* --------------------------------------------------------------- pom-pom */

/** A plush pom-pom on a short elastic cord: Verlet point + a springy distance constraint. */
export interface Pom {
  x: number;
  y: number;
  px: number;
  py: number;
  /** Where the cord is tied. */
  ax: number;
  ay: number;
  /** Rest length of the cord (px). */
  len: number;
  /** Seconds since it was last disturbed (drives "interest" for the cats). */
  sinceDisturbed: number;
  tick: number;
}

export const POM_GRAVITY = 1700;
/** Stretch stiffness of the cord per sub-step: a bit springy, so the ball bounces on it. */
const POM_STIFFNESS = 0.32;
const POM_DAMPING = 0.55;
export const POM_RADIUS = 8;

export function createPom(ax: number, ay: number, len: number): Pom {
  return { x: ax, y: ay + len, px: ax, py: ay + len, ax, ay, len, sinceDisturbed: 99, tick: 0 };
}

export function stepPom(p: Pom, dt: number, ax: number, ay: number): void {
  const h = clamp(dt, 0, 1 / 20);
  if (h <= 0) return;
  p.ax = ax;
  p.ay = ay;
  p.sinceDisturbed += h;
  p.tick += h * 60;
  const sub = 4;
  const sh = h / sub;
  for (let i = 0; i < sub; i++) {
    const vx = (p.x - p.px) * Math.exp(-POM_DAMPING * sh);
    const vy = (p.y - p.py) * Math.exp(-POM_DAMPING * sh);
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy + POM_GRAVITY * sh * sh;
    // The cord pulls back only when stretched (it goes slack when the ball is closer than its length).
    const dx = p.x - p.ax;
    const dy = p.y - p.ay;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d > p.len) {
      const k = POM_STIFFNESS * (d - p.len);
      p.x -= (dx / d) * k;
      p.y -= (dy / d) * k;
    }
    // A hard limit: it can never stretch to more than 125 % of its length.
    const dx2 = p.x - p.ax;
    const dy2 = p.y - p.ay;
    const d2 = Math.hypot(dx2, dy2) || 1e-6;
    if (d2 > p.len * 1.25) {
      const f = (p.len * 1.25) / d2;
      p.x = p.ax + dx2 * f;
      p.y = p.ay + dy2 * f;
    }
  }
}

/** A paw or a hand sets the ball moving with velocity (vx, vy) px/s. */
export function batPom(p: Pom, vx: number, vy: number, dt = 1 / 60): void {
  p.px = p.x - vx * dt;
  p.py = p.y - vy * dt;
  p.sinceDisturbed = 0;
}

/** Ball speed in px/s. */
export function pomSpeed(p: Pom, dt = 1 / 60): number {
  return Math.hypot(p.x - p.px, p.y - p.py) / dt;
}

/* ----------------------------------------------------------------- model */

export class TowerModel {
  state: CatTowerState;
  /** Scale of the drawing (follows the cats' size setting). */
  scale = 1;
  /** Set when the tower was moved / worn; the page persists and clears it. */
  dirty = false;
  /** Drawn see-through (and not grabbable) while a text field right behind it is being typed in. */
  faded = false;
  pom: Pom | null = null;
  private pomU = 0;

  constructor(state: CatTowerState) {
    this.state = { enabled: state.enabled, xNormalized: clampX(state.xNormalized), scratchWear: clamp(state.scratchWear, 0, 100) };
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  setState(next: CatTowerState): void {
    this.state = { enabled: next.enabled, xNormalized: clampX(next.xNormalized), scratchWear: clamp(next.scratchWear, 0, 100) };
  }

  /** Drag the tower to a new position (0..1 of the window width), docking to the near edge when close to it. Returns the stored value. */
  dragTo(xNormalized: number): number {
    let x = clampX(xNormalized);
    if (xNormalized < TOWER_SNAP_LEFT) x = TOWER_X_MIN;
    else if (xNormalized > TOWER_SNAP_RIGHT) x = TOWER_X_MAX;
    this.state = { ...this.state, xNormalized: x };
    this.dirty = true;
    return x;
  }

  /** Scratching a post wears the sisal a little. */
  scratch(dt: number): void {
    const w = Math.min(100, this.state.scratchWear + dt * WEAR_PER_SECOND);
    if (w !== this.state.scratchWear) {
      this.state = { ...this.state, scratchWear: w };
      this.dirty = true;
    }
  }

  /* ---------------------------------------------------------- geometry */

  /** Overall scale: cat size, but never taller than 65 % of the window. */
  unit(bounds: WorldBounds): number {
    const s = clamp(this.scale, 0.6, 1.6);
    const fit = (TOWER_MAX_HEIGHT_SHARE * bounds.height) / TOWER_DESIGN.height;
    return Math.max(0.25, Math.min(s, fit));
  }

  /** Horizontal centre in px (kept fully on screen). */
  centerX(bounds: WorldBounds): number {
    const u = this.unit(bounds);
    const half = (TOWER_DESIGN.footprint / 2) * u;
    const lo = Math.min(half + 4, bounds.width / 2);
    const hi = Math.max(lo, bounds.width - half - 4);
    return clamp(this.state.xNormalized * bounds.width, lo, hi);
  }

  geom(bounds: WorldBounds): TowerGeom | null {
    if (!this.enabled) return null;
    const u = this.unit(bounds);
    const D = TOWER_DESIGN;
    const cx = this.centerX(bounds);
    const floorY = bounds.height - 2;
    const t1 = floorY - D.tier1 * u;
    const t2 = floorY - D.tier2 * u;
    const t3 = floorY - D.top * u;
    const tier1: TierGeom = { xMin: cx - (D.tier1W / 2) * u, xMax: cx + (D.tier1W / 2) * u, y: t1 };
    // Tier 2 sticks out to the right, the top bed to the left: a staggered climb.
    const tier2: TierGeom = { xMin: cx + 65 * u - D.tier2W * u, xMax: cx + 65 * u, y: t2 };
    const top: TierGeom = { xMin: cx - 65 * u, xMax: cx - 65 * u + D.topW * u, y: t3 };
    const yTop = t1 + 8 * u;
    const holeW = 44 * u;
    return {
      cx,
      floorY,
      u,
      halfW: (D.footprint / 2) * u,
      tier1,
      tier2,
      top,
      postL: cx - D.postX * u,
      postR: cx + D.postX * u,
      midPost: cx + D.midPostX * u,
      upperPost: cx + D.upperPostX * u,
      pomAnchor: { x: cx - 14 * u, y: t2 + 12 * u },
      cubby: { xMin: cx - 50 * u, xMax: cx + 50 * u, yTop, yBottom: t1 + D.cubbyH * u, holeX: cx, holeW, holeH: 42 * u },
    };
  }

  /** The three tiers as platforms (empty while the tower is hidden). */
  platforms(bounds: WorldBounds): Platform[] {
    const g = this.geom(bounds);
    if (!g) return [];
    const mk = (id: string, t: TierGeom, warm: number, narrow: boolean): Platform => ({ id, kind: 'dom', xMin: t.xMin, xMax: t.xMax, y: t.y, warm, narrow, tag: 'cat-tower', elementRef: null });
    return [mk(TOWER_TIER1, g.tier1, 0.7, false), mk(TOWER_TIER2, g.tier2, 0.3, true), mk(TOWER_TOP, g.top, 0.65, true)];
  }

  platform(id: string, bounds: WorldBounds): Platform | null {
    return this.platforms(bounds).find((p) => p.id === id) ?? null;
  }

  /** The x of the cubby's hole, and how far a cat settles into it (px). */
  cubbySpot(bounds: WorldBounds): { x: number; drop: number; fits: (catHeight: number) => boolean } | null {
    const g = this.geom(bounds);
    if (!g) return null;
    const drop = g.cubby.yBottom - g.tier1.y - 3 * g.u;
    return { x: g.cubby.holeX, drop, fits: (h) => drop - 4 * g.u >= h };
  }

  /**
   * Where a cat stands to scratch a post: just beside the outer post on the side
   * that has room (the nearer one), facing it. `reach` is how far a cat's front
   * paws reach from its body centre.
   */
  scratchSpot(fromX: number, reach: number, bounds: WorldBounds, side?: 1 | -1): { x: number; face: 1 | -1; postX: number } | null {
    const g = this.geom(bounds);
    if (!g) return null;
    const gap = reach + 7 * g.u;
    const left = { x: g.postL - gap, face: 1 as const, postX: g.postL };
    const right = { x: g.postR + gap, face: -1 as const, postX: g.postR };
    // A cat that already picked a side (it faces the post it chose) keeps it, even if the tower is dragged about.
    if (side) return side > 0 ? left : right;
    const ok = (s: { x: number }) => s.x >= 24 && s.x <= bounds.width - 24;
    const cands = [left, right].filter(ok);
    if (!cands.length) return left;
    cands.sort((a, b) => Math.abs(a.x - fromX) - Math.abs(b.x - fromX));
    return cands[0];
  }

  /**
   * How a cat resting at x on a tier sits in the furniture: on the crown's bolster it is lifted onto the
   * cushion (`lift`), and curled up at the cubby's hole it sinks into the cubby (`drop`) so only its
   * head and paws peek out. Both are in px; (0, 0) anywhere else.
   */
  restOffset(platformId: string | null, x: number, posture: string, bounds: WorldBounds): { lift: number; drop: number } {
    const g = platformId ? this.geom(bounds) : null;
    if (!g) return { lift: 0, drop: 0 };
    const resting = posture === 'sleep' || posture === 'lie' || posture === 'sit';
    if (!resting) return { lift: 0, drop: 0 };
    if (platformId === TOWER_TOP) {
      const c = (g.top.xMin + g.top.xMax) / 2;
      if (Math.abs(x - c) <= (g.top.xMax - g.top.xMin) * 0.34) return { lift: TOP_BED_LIFT * g.u, drop: 0 };
    } else if (platformId === TOWER_TIER1 && posture !== 'sit') {
      if (Math.abs(x - g.cubby.holeX) <= g.cubby.holeW * 0.4) return { lift: 0, drop: g.cubby.yBottom - g.tier1.y - 3 * g.u };
    }
    return { lift: 0, drop: 0 };
  }

  /** The tower's whole column (base to crown), for "is a text field right behind it?". */
  footprint(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const g = this.geom(bounds);
    if (!g) return null;
    return { minX: g.cx - g.halfW, minY: g.top.y - 18 * g.u, maxX: g.cx + g.halfW, maxY: g.floorY + 2 };
  }

  /* ----------------------------------------------------------- pom-pom */

  /** Keeps the pom-pom tied under tier 2 and steps its cord. */
  updatePom(dt: number, bounds: WorldBounds): Pom | null {
    const g = this.geom(bounds);
    if (!g) {
      this.pom = null;
      return null;
    }
    const len = 50 * g.u;
    if (!this.pom || Math.abs(this.pomU - g.u) > 0.02) {
      this.pom = createPom(g.pomAnchor.x, g.pomAnchor.y, len);
      this.pomU = g.u;
    } else this.pom.len = len;
    // Moving the tower carries the ball along with it.
    const shift = g.pomAnchor.x - this.pom.ax;
    if (shift !== 0 && Math.abs(shift) < 600) {
      this.pom.x += shift;
      this.pom.px += shift;
    }
    stepPom(this.pom, dt, g.pomAnchor.x, g.pomAnchor.y);
    return this.pom;
  }

  /* ----------------------------------------------------------- hitboxes */

  /** Grab handles: the base with its posts, and the two upper posts (cats and the pom-pom sit above these). */
  hitRects(bounds: WorldBounds): { id: string; rect: { minX: number; minY: number; maxX: number; maxY: number } }[] {
    const g = this.geom(bounds);
    if (!g) return [];
    const u = g.u;
    const slim = Math.max(10, 11 * u);
    return [
      { id: 'base', rect: { minX: g.cx - g.halfW, minY: g.cubby.yBottom, maxX: g.cx + g.halfW, maxY: g.floorY + 2 } },
      { id: 'mid', rect: { minX: g.midPost - slim, minY: g.tier2.y + 12 * u, maxX: g.midPost + slim, maxY: g.tier1.y } },
      { id: 'upper', rect: { minX: g.upperPost - slim, minY: g.top.y + 10 * u, maxX: g.upperPost + slim, maxY: g.tier2.y } },
    ];
  }

  hit(x: number, y: number, bounds: WorldBounds): boolean {
    return this.hitRects(bounds).some(({ rect: r }) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY);
  }

  /** A small box around the pom-pom (for clicking it). */
  pomRect(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.enabled || !this.pom) return null;
    const u = this.unit(bounds);
    const r = (POM_RADIUS + 6) * u;
    return { minX: this.pom.x - r, minY: this.pom.y - r, maxX: this.pom.x + r, maxY: this.pom.y + r };
  }

  /** Screen rectangle covering the whole tower, with room for the swinging pom-pom (dirty-rect bookkeeping). */
  rects(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number }[] {
    const g = this.geom(bounds);
    if (!g) return [];
    return [{ minX: g.cx - g.halfW - 40 * g.u, minY: g.top.y - 30 * g.u, maxX: g.cx + g.halfW + 40 * g.u, maxY: g.floorY + 4 }];
  }

  /* ----------------------------------------------------------- drawing */

  /** Everything behind the cats: shadow, base, posts, perches, the cubby's interior and the top bed's back rim. */
  drawBack(ctx: AnyCtx, bounds: WorldBounds): void {
    const g = this.geom(bounds);
    if (!g) return;
    const { u, cx, floorY } = g;
    const wear = this.state.scratchWear / 100;
    ctx.save();
    if (this.faded) ctx.globalAlpha = 0.35;
    // Contact shadow.
    const sh = ctx.createRadialGradient(cx, floorY, 4, cx, floorY, g.halfW * 1.1);
    sh.addColorStop(0, 'rgba(30,22,16,0.3)');
    sh.addColorStop(1, 'rgba(30,22,16,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(cx - g.halfW * 1.15, floorY - 12 * u, g.halfW * 2.3, 14 * u);
    // Base plate: weighted wood with a bevelled top and a paw plaque.
    const bw = TOWER_DESIGN.baseW * u;
    const bh = TOWER_DESIGN.baseH * u;
    woodSlab(ctx, cx - bw / 2, floorY - bh, bw, bh, 3 * u);
    drawPlaque(ctx, cx, floorY - bh * 0.5, u);
    // Sisal posts rising from the base to the cubby.
    drawSisalPost(ctx, g.postL, g.cubby.yBottom - 1, floorY - bh + 1, 14 * u, wear, 1);
    drawSisalPost(ctx, g.postR, g.cubby.yBottom - 1, floorY - bh + 1, 14 * u, wear, 2);
    // Mid post from the cubby roof up to tier 2, and the upper post up to the crown.
    drawSisalPost(ctx, g.midPost, g.tier2.y + 10 * u, g.tier1.y + 1, 12 * u, wear * 0.7, 3);
    drawSisalPost(ctx, g.upperPost, g.top.y + 8 * u, g.tier2.y + 1, 12 * u, wear * 0.5, 4);
    // Cubby: dark interior (the front face with the arched hole is drawn over the cats).
    const c = g.cubby;
    ctx.fillStyle = '#3A2A22';
    roundRect(ctx, c.xMin, c.yTop, c.xMax - c.xMin, c.yBottom - c.yTop, 5 * u);
    ctx.fill();
    // Cubby floor cushion, seen through the hole.
    ctx.fillStyle = '#C9B598';
    ctx.fillRect(c.xMin + 4 * u, c.yBottom - 5 * u, c.xMax - c.xMin - 8 * u, 5 * u);
    // Cubby roof: a plush pad on a wooden slab.
    woodSlab(ctx, g.tier1.xMin - 2 * u, g.tier1.y, g.tier1.xMax - g.tier1.xMin + 4 * u, 9 * u, 3 * u);
    plushTop(ctx, g.tier1.xMin + 3 * u, g.tier1.y - 1 * u, g.tier1.xMax - g.tier1.xMin - 6 * u, 3 * u, '#7FA39E');
    // Tier 2: wooden perch with a hammock-like pad.
    woodSlab(ctx, g.tier2.xMin, g.tier2.y, g.tier2.xMax - g.tier2.xMin, 12 * u, 4 * u);
    plushTop(ctx, g.tier2.xMin + 4 * u, g.tier2.y - 1 * u, g.tier2.xMax - g.tier2.xMin - 8 * u, 3.5 * u, '#C98A66');
    // Top crown: slab, then the back of the bolster bed.
    const t = g.top;
    woodSlab(ctx, t.xMin, t.y, t.xMax - t.xMin, 11 * u, 4 * u);
    const tw = t.xMax - t.xMin;
    const tcx = (t.xMin + t.xMax) / 2;
    ctx.beginPath();
    ctx.moveTo(t.xMin + 1 * u, t.y);
    ctx.bezierCurveTo(t.xMin - 1 * u, t.y - 12 * u, t.xMin + tw * 0.2, t.y - 17 * u, tcx, t.y - 17 * u);
    ctx.bezierCurveTo(t.xMax - tw * 0.2, t.y - 17 * u, t.xMax + 1 * u, t.y - 12 * u, t.xMax - 1 * u, t.y);
    ctx.closePath();
    const bg = ctx.createLinearGradient(0, t.y - 17 * u, 0, t.y);
    bg.addColorStop(0, '#6E9A97');
    bg.addColorStop(1, '#4B7472');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(tcx, t.y - 5 * u, tw * 0.4, 5 * u, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#EEF3EF';
    ctx.fill();
    ctx.restore();
  }

  /** The cubby's front (with its arched entrance), the crown's front rim and the pom-pom: over the cats that sit inside. */
  drawFront(ctx: AnyCtx, bounds: WorldBounds): void {
    const g = this.geom(bounds);
    if (!g) return;
    const { u } = g;
    ctx.save();
    if (this.faded) ctx.globalAlpha = 0.35;
    // Cubby front: a plush face with an arched hole cut out (even-odd), so a cat curled up inside peeks out.
    const c = g.cubby;
    const bx = c.xMin;
    const bw = c.xMax - c.xMin;
    const hx = c.holeX - c.holeW / 2;
    const hy = c.yBottom - c.holeH;
    ctx.beginPath();
    roundRectPath(ctx, bx, c.yTop, bw, c.yBottom - c.yTop, 5 * u);
    // The arch: straight sides, round top.
    ctx.moveTo(hx, c.yBottom);
    ctx.lineTo(hx, hy + c.holeW / 2);
    ctx.arc(c.holeX, hy + c.holeW / 2, c.holeW / 2, Math.PI, 0);
    ctx.lineTo(hx + c.holeW, c.yBottom);
    ctx.closePath();
    const fg = ctx.createLinearGradient(0, c.yTop, 0, c.yBottom);
    fg.addColorStop(0, '#8FB0AB');
    fg.addColorStop(1, '#6E9A97');
    ctx.fillStyle = fg;
    ctx.fill('evenodd');
    // Stitched binding around the entrance, and a soft highlight on the top edge.
    ctx.strokeStyle = 'rgba(255,248,236,0.55)';
    ctx.lineWidth = Math.max(0.8, 1.3 * u);
    ctx.setLineDash([3 * u, 2.4 * u]);
    ctx.beginPath();
    ctx.moveTo(hx - 3 * u, c.yBottom - 1);
    ctx.lineTo(hx - 3 * u, hy + c.holeW / 2);
    ctx.arc(c.holeX, hy + c.holeW / 2, c.holeW / 2 + 3 * u, Math.PI, 0);
    ctx.lineTo(hx + c.holeW + 3 * u, c.yBottom - 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, 2 * u);
    ctx.beginPath();
    ctx.moveTo(bx + 6 * u, c.yTop + 3 * u);
    ctx.lineTo(bx + bw - 6 * u, c.yTop + 3 * u);
    ctx.stroke();
    // Crown: the front rim of the bolster bed (cats lie "in" it).
    const t = g.top;
    const tw = t.xMax - t.xMin;
    const tcx = (t.xMin + t.xMax) / 2;
    ctx.beginPath();
    ctx.moveTo(t.xMin - 1 * u, t.y + 1);
    ctx.bezierCurveTo(t.xMin - 2 * u, t.y - 8 * u, t.xMin + 5 * u, t.y - 11 * u, t.xMin + tw * 0.28, t.y - 9 * u);
    ctx.quadraticCurveTo(tcx, t.y - 6.5 * u, t.xMax - tw * 0.28, t.y - 9 * u);
    ctx.bezierCurveTo(t.xMax - 5 * u, t.y - 11 * u, t.xMax + 2 * u, t.y - 8 * u, t.xMax + 1 * u, t.y + 1);
    ctx.quadraticCurveTo(tcx, t.y + 4 * u, t.xMin - 1 * u, t.y + 1);
    ctx.closePath();
    const rg = ctx.createLinearGradient(0, t.y - 11 * u, 0, t.y + 3 * u);
    rg.addColorStop(0, '#7FAAA6');
    rg.addColorStop(1, '#4B7472');
    ctx.fillStyle = rg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(0.9, 1.4 * u);
    ctx.beginPath();
    ctx.moveTo(t.xMin + tw * 0.12, t.y - 7.5 * u);
    ctx.quadraticCurveTo(tcx, t.y - 5.2 * u, t.xMax - tw * 0.12, t.y - 7.5 * u);
    ctx.stroke();
    // The pom-pom on its cord.
    if (this.pom) drawPom(ctx, this.pom, u);
    ctx.restore();
  }
}

function clampX(x: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? clamp(x, TOWER_X_MIN, TOWER_X_MAX) : 0.06;
}

/* ------------------------------------------------- platform source wrapper */

/** Adds the tower's tiers to any platform source (the page scanner, the Studio's mock ledges…). */
export class TowerPlatformSource implements PlatformSource {
  scrollOffset?: () => { x: number; y: number };

  constructor(
    readonly inner: PlatformSource,
    private readonly tower: TowerModel,
  ) {
    if (inner.scrollOffset) this.scrollOffset = () => (inner.scrollOffset as () => { x: number; y: number })();
  }

  platforms(): readonly Platform[] {
    const t = this.tower.platforms(this.inner.bounds());
    return t.length ? [...this.inner.platforms(), ...t] : this.inner.platforms();
  }

  get(id: string): Platform | null {
    return isTowerPlatform(id) ? this.tower.platform(id, this.inner.bounds()) : this.inner.get(id);
  }

  floor(): Platform {
    return this.inner.floor();
  }

  bounds(): WorldBounds {
    return this.inner.bounds();
  }
}

/* ------------------------------------------------------------- drawing bits */

function roundRectPath(ctx: AnyCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function roundRect(ctx: AnyCtx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
}

function woodSlab(ctx: AnyCtx, x: number, y: number, w: number, h: number, r: number): void {
  roundRect(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#C58C58');
  g.addColorStop(0.35, '#B07A4A');
  g.addColorStop(1, '#8A5A33');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,236,205,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + r, y + 0.8);
  ctx.lineTo(x + w - r, y + 0.8);
  ctx.stroke();
  // A hint of grain.
  ctx.strokeStyle = 'rgba(70,40,20,0.14)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.12, y + h * 0.55);
  ctx.lineTo(x + w * 0.5, y + h * 0.5);
  ctx.moveTo(x + w * 0.4, y + h * 0.75);
  ctx.lineTo(x + w * 0.88, y + h * 0.7);
  ctx.stroke();
}

function plushTop(ctx: AnyCtx, x: number, y: number, w: number, h: number, color: string): void {
  roundRect(ctx, x, y, w, h, Math.min(h, 3));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x + 2, y + 0.6);
  ctx.lineTo(x + w - 2, y + 0.6);
  ctx.stroke();
}

function drawPlaque(ctx: AnyCtx, cx: number, cy: number, u: number): void {
  ctx.save();
  ctx.fillStyle = '#EFD9AE';
  roundRect(ctx, cx - 11 * u, cy - 4.2 * u, 22 * u, 8.4 * u, 2.4 * u);
  ctx.fill();
  // A tiny engraved paw.
  ctx.fillStyle = '#7A5230';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1 * u, 2.1 * u, 1.7 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy] of [
    [-3.2, -1.5],
    [-1.1, -3],
    [1.1, -3],
    [3.2, -1.5],
  ] as const) {
    ctx.beginPath();
    ctx.arc(cx + dx * u, cy + dy * u + 0.4 * u, 0.9 * u, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A sisal-wrapped cylinder from y0 (top) to y1 (bottom); wear adds loose, frayed fibres. */
function drawSisalPost(ctx: AnyCtx, cx: number, y0: number, y1: number, w: number, wear: number, seed: number): void {
  if (y1 <= y0) return;
  const x0 = cx - w / 2;
  ctx.save();
  const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
  g.addColorStop(0, '#B79B63');
  g.addColorStop(0.3, '#E6D2A0');
  g.addColorStop(0.7, '#D2B87F');
  g.addColorStop(1, '#9C8250');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, y1 - y0);
  // Rope wraps: slanted twist lines, darker where the post is worn.
  ctx.lineWidth = 0.9;
  const step = Math.max(2.4, w * 0.2);
  ctx.strokeStyle = `rgba(110,82,40,${0.28 + 0.25 * wear})`;
  ctx.beginPath();
  for (let y = y0 + step * 0.5; y < y1; y += step) {
    ctx.moveTo(x0, y + 1);
    ctx.lineTo(x0 + w, y - 1);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,245,215,0.28)';
  ctx.beginPath();
  for (let y = y0 + step; y < y1; y += step) {
    ctx.moveTo(x0, y + 0.2);
    ctx.lineTo(x0 + w, y - 1.8);
  }
  ctx.stroke();
  // Fraying: loose fibres sticking out where the cats scratch, growing with the wear.
  const n = Math.floor(wear * 16);
  ctx.strokeStyle = 'rgba(214,190,140,0.9)';
  ctx.lineWidth = 0.8;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const h = hash(seed * 31 + i);
    const y = y0 + (0.12 + 0.76 * hash(seed * 17 + i * 3)) * (y1 - y0);
    const side = h > 0.5 ? 1 : -1;
    const len = (2 + 4 * hash(seed + i * 7)) * (0.6 + wear);
    const sx = cx + side * (w / 2 - 0.5);
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.quadraticCurveTo(sx + side * len * 0.6, y - 1.5, sx + side * len, y + 1.4 + h * 2);
    ctx.stroke();
  }
  // Caps top and bottom.
  ctx.fillStyle = 'rgba(70,45,25,0.5)';
  ctx.fillRect(x0 - 0.5, y0, w + 1, 1.6);
  ctx.fillRect(x0 - 0.5, y1 - 1.6, w + 1, 1.6);
  ctx.restore();
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function drawPom(ctx: AnyCtx, p: Pom, u: number): void {
  ctx.save();
  // The elastic cord: slightly slack when the ball is close to the anchor.
  const dx = p.x - p.ax;
  const dy = p.y - p.ay;
  const d = Math.hypot(dx, dy);
  const slack = Math.max(0, p.len - d);
  ctx.strokeStyle = '#D8C7A4';
  ctx.lineWidth = Math.max(1.1, 1.6 * u);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.ax, p.ay);
  ctx.quadraticCurveTo((p.ax + p.x) / 2 + slack * 0.35, (p.ay + p.y) / 2 + slack * 0.2, p.x, p.y - 4 * u);
  ctx.stroke();
  // The pom-pom: a fluffy ball of plush with a little fuzz.
  const r = POM_RADIUS * u;
  const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.1, p.x, p.y, r * 1.1);
  g.addColorStop(0, '#FFC8D6');
  g.addColorStop(0.6, '#F0708F');
  g.addColorStop(1, '#C4456B');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,210,222,0.8)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + p.tick * 0.01;
    ctx.moveTo(p.x + Math.cos(a) * r * 0.92, p.y + Math.sin(a) * r * 0.92);
    ctx.lineTo(p.x + Math.cos(a) * r * 1.22, p.y + Math.sin(a) * r * 1.22);
  }
  ctx.stroke();
  ctx.restore();
}

/** Fraction of the wear that is visible (for tests / popup tooltips). */
export function wearFraction(state: CatTowerState): number {
  return clamp01(state.scratchWear / 100);
}
