/**
 * The food & water station: a woven mat on the viewport floor with a terracotta
 * kibble bowl and a blue water bowl. DOM-free (the content script adds a hitbox
 * element on top; Cat Studio's preview uses it as is).
 *
 *  • Levels (0..100) go down as cats eat and drink and are saved to
 *    chrome.storage.local by the page, so every tab shares the same bowls.
 *  • v3: the bowls also empty slowly on their own (kibble gets nibbled and goes
 *    stale, water evaporates and gets splashed) — continuously while the cats
 *    are on screen, and at half rate (capped) for the time no page showed them.
 *  • Clicking a bowl refills it; dragging the mat slides it along the floor.
 *  • Drawn in two layers: the mat, bowl insides and contents behind the cats,
 *    the bowls' front walls in front of them — so a cat's muzzle dips *into*
 *    the bowl when it eats or drinks.
 */
import { clamp, clamp01, hash1 } from '../shared/math';
import type { BowlKind, FeedingStation } from '../shared/types';
import type { AnyCtx } from '../engine/canvas';
import type { WorldBounds } from '../engine/Physics';

export interface StationGeom {
  cx: number;
  floorY: number;
  s: number;
  matW: number;
  matH: number;
  /** Bowl centre x, rim y, rim half-width, foot half-width, wall height, rim ellipse half-height. */
  bowls: Record<BowlKind, { x: number; rimY: number; rw: number; bw: number; h: number; ry: number }>;
}

export type StationHit = BowlKind | 'mat' | null;

/** How long a cat's claim on a bowl lasts without being renewed (s). */
const CLAIM_TTL = 1.5;

/** Passive depletion per second while the cats are around: ≈ 14 % of the food and ≈ 22 % of the water per hour. */
export const FOOD_DECAY = 0.004;
export const WATER_DECAY = 0.006;
/** A bowl at or below this is running low: hungry / thirsty cats keep checking it and asking for more. */
export const LOW_BOWL = 20;
/** While no page shows the cats, bowls empty at this fraction of the normal rate… */
export const OFFLINE_DECAY_RATE = 0.5;
/** …but never by more than this many points per absence. */
export const OFFLINE_DECAY_CAP = 35;

/** Pure: the levels after `seconds` of passive depletion at `rate`× the normal speed. */
export function decayLevels(st: FeedingStation, seconds: number, rate = 1, cap = Infinity): FeedingStation {
  const s = Math.max(0, seconds) * Math.max(0, rate);
  const food = Math.min(cap, s * FOOD_DECAY);
  const water = Math.min(cap, s * WATER_DECAY);
  return { ...st, foodLevel: Math.max(0, st.foodLevel - food), waterLevel: Math.max(0, st.waterLevel - water) };
}

/** Pure: applies the (half-rate, capped) depletion for the time since the levels were last written. */
export function catchUpStation(st: FeedingStation, nowMs: number): FeedingStation {
  if (!st.updatedAt || nowMs <= st.updatedAt) return { ...st };
  const away = (nowMs - st.updatedAt) / 1000;
  // Short gaps (switching tabs, a reload) are already covered by the running page.
  if (away < 20) return { ...st };
  return decayLevels(st, away, OFFLINE_DECAY_RATE, OFFLINE_DECAY_CAP);
}

export class StationModel {
  state: FeedingStation;
  /** Scale of the station drawing (follows the cats' size setting). */
  scale = 1;
  /** Set whenever levels or position change; the page persists and clears it. */
  dirty = false;
  /** Bowls empty slowly on their own (only the page hosting the cats runs this). */
  depleting = true;
  /** Passive depletion accumulated since the levels were last marked dirty. */
  private drift = 0;
  private claims: Record<BowlKind, { id: string; at: number } | null> = { food: null, water: null };
  private now = 0;
  /** Visual "just refilled" pulse per bowl (s remaining). */
  private refillGlow: Record<BowlKind, number> = { food: 0, water: 0 };

  constructor(state: FeedingStation) {
    this.state = { ...state };
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  /** Replaces the persisted state (from storage / another tab), keeping claims. */
  setState(next: FeedingStation): void {
    this.state = { ...next };
  }

  update(dt: number, now: number): void {
    this.now = now;
    if (this.depleting && this.state.enabled && dt > 0) {
      const next = decayLevels(this.state, dt);
      this.drift += this.state.foodLevel - next.foodLevel + (this.state.waterLevel - next.waterLevel);
      this.state.foodLevel = next.foodLevel;
      this.state.waterLevel = next.waterLevel;
      // Persist every half point or so (a couple of minutes), not every frame.
      if (this.drift >= 0.5) {
        this.drift = 0;
        this.dirty = true;
      }
    }
    for (const k of ['food', 'water'] as BowlKind[]) {
      if (this.refillGlow[k] > 0) this.refillGlow[k] = Math.max(0, this.refillGlow[k] - dt);
      const c = this.claims[k];
      if (c && now - c.at > CLAIM_TTL) this.claims[k] = null;
    }
  }

  level(kind: BowlKind): number {
    return kind === 'food' ? this.state.foodLevel : this.state.waterLevel;
  }

  /** True when the bowl is running low (≤ LOW_BOWL). */
  low(kind: BowlKind): boolean {
    return this.level(kind) <= LOW_BOWL;
  }

  /** Takes up to `amount` from a bowl; returns what was actually taken. */
  consume(kind: BowlKind, amount: number): number {
    const cur = this.level(kind);
    const got = Math.min(cur, Math.max(0, amount));
    if (got <= 0) return 0;
    if (kind === 'food') this.state.foodLevel = cur - got;
    else this.state.waterLevel = cur - got;
    this.dirty = true;
    return got;
  }

  refill(kind: BowlKind): void {
    if (kind === 'food') this.state.foodLevel = 100;
    else this.state.waterLevel = 100;
    this.refillGlow[kind] = 0.6;
    this.dirty = true;
  }

  /** Slides the station along the floor (0..1 of the viewport width). */
  moveTo(xNormalized: number): void {
    this.state.xNormalized = clamp01(xNormalized);
    this.dirty = true;
  }

  /* ------------------------------------------------------------ claims */

  claim(kind: BowlKind, id: string): boolean {
    const c = this.claims[kind];
    if (c && c.id !== id && this.now - c.at <= CLAIM_TTL) return false;
    this.claims[kind] = { id, at: this.now };
    return true;
  }

  release(kind: BowlKind, id: string): void {
    if (this.claims[kind]?.id === id) this.claims[kind] = null;
  }

  releaseAll(id: string): void {
    this.release('food', id);
    this.release('water', id);
  }

  occupiedBy(kind: BowlKind, notId: string): boolean {
    const c = this.claims[kind];
    return !!c && c.id !== notId && this.now - c.at <= CLAIM_TTL;
  }

  /* ---------------------------------------------------------- geometry */

  geom(bounds: WorldBounds): StationGeom {
    const s = this.scale;
    const matW = 138 * s;
    const matH = 5.5 * s;
    // Leave room on both sides for a cat to stand at either bowl.
    const margin = matW / 2 + 70 * s;
    const lo = Math.min(margin, bounds.width / 2);
    const hi = Math.max(lo, bounds.width - margin);
    const cx = clamp(this.state.xNormalized * bounds.width, lo, hi);
    const floorY = bounds.height - 2;
    const rimY = floorY - matH - 16 * s;
    const bowl = (x: number) => ({ x, rimY, rw: 22 * s, bw: 14.5 * s, h: 16 * s, ry: 4.4 * s });
    return { cx, floorY, s, matW, matH, bowls: { food: bowl(cx - 32 * s), water: bowl(cx + 32 * s) } };
  }

  centerX(bounds: WorldBounds): number {
    return this.geom(bounds).cx;
  }

  /**
   * Where a cat stands to reach a bowl: food from the left (facing right), water
   * from the right (facing left), so two cats can be at the station at once.
   */
  approach(kind: BowlKind, catScale: number, bounds: WorldBounds): { x: number; face: 1 | -1 } {
    const g = this.geom(bounds);
    const b = g.bowls[kind];
    const face: 1 | -1 = kind === 'food' ? 1 : -1;
    return { x: b.x - face * 38 * catScale, face };
  }

  /** What is under a point: a bowl, the mat, or nothing. */
  hit(x: number, y: number, bounds: WorldBounds): StationHit {
    if (!this.state.enabled) return null;
    const g = this.geom(bounds);
    for (const k of ['food', 'water'] as BowlKind[]) {
      const b = g.bowls[k];
      if (x >= b.x - b.rw - 3 * g.s && x <= b.x + b.rw + 3 * g.s && y >= b.rimY - 12 * g.s && y <= g.floorY + 2) return k;
    }
    if (x >= g.cx - g.matW / 2 && x <= g.cx + g.matW / 2 && y >= g.floorY - g.matH - 10 * g.s && y <= g.floorY + 2) return 'mat';
    return null;
  }

  /** Screen rectangle covering the whole station (hitbox / dirty-rect). */
  rect(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number } {
    const g = this.geom(bounds);
    // Covers everything drawn: the soft shadow reaches past the mat, the kibble heap and refill glow above the rims.
    return { minX: g.cx - g.matW * 0.66 - 2, minY: g.bowls.food.rimY - 18 * g.s, maxX: g.cx + g.matW * 0.66 + 2, maxY: g.floorY + 2 };
  }

  /** Just the clickable part (mat and bowls), for the page hitbox. */
  hitRect(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number } {
    const g = this.geom(bounds);
    return { minX: g.cx - g.matW / 2 - 2, minY: g.bowls.food.rimY - 12 * g.s, maxX: g.cx + g.matW / 2 + 2, maxY: g.floorY + 2 };
  }

  /* ----------------------------------------------------------- drawing */

  /** Mat, bowl interiors and their contents (behind the cats). */
  drawBack(ctx: AnyCtx, bounds: WorldBounds, time: number): void {
    if (!this.state.enabled) return;
    const g = this.geom(bounds);
    const s = g.s;
    ctx.save();
    // Soft contact shadow under the mat.
    const sh = ctx.createRadialGradient(g.cx, g.floorY, 2, g.cx, g.floorY, g.matW * 0.62);
    sh.addColorStop(0, 'rgba(30,22,16,0.22)');
    sh.addColorStop(1, 'rgba(30,22,16,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(g.cx - g.matW * 0.65, g.floorY - 10 * s, g.matW * 1.3, 12 * s);
    // Woven mat.
    const mx = g.cx - g.matW / 2;
    const my = g.floorY - g.matH;
    ctx.beginPath();
    ctx.roundRect(mx, my, g.matW, g.matH + 1, 2.5 * s);
    const mg = ctx.createLinearGradient(0, my, 0, my + g.matH);
    mg.addColorStop(0, '#A9BCAB');
    mg.addColorStop(1, '#839C89');
    ctx.fillStyle = mg;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(0.6, 0.8 * s);
    for (let x = mx + 3 * s; x < mx + g.matW; x += 5 * s) {
      ctx.beginPath();
      ctx.moveTo(x, my);
      ctx.lineTo(x - 2 * s, my + g.matH + 1);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(60,78,64,0.45)';
    ctx.lineWidth = Math.max(0.6, 0.7 * s);
    ctx.setLineDash([2.2 * s, 1.6 * s]);
    ctx.beginPath();
    ctx.roundRect(mx + 2.2 * s, my + 1.2 * s, g.matW - 4.4 * s, Math.max(1, g.matH - 2.2 * s), 1.6 * s);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const k of ['food', 'water'] as BowlKind[]) {
      const b = g.bowls[k];
      const lvl = clamp01(this.level(k) / 100);
      // Bowl shadow on the mat.
      const bs = ctx.createRadialGradient(b.x, my, 1, b.x, my, b.rw * 1.15);
      bs.addColorStop(0, 'rgba(25,18,12,0.28)');
      bs.addColorStop(1, 'rgba(25,18,12,0)');
      ctx.fillStyle = bs;
      ctx.fillRect(b.x - b.rw * 1.2, my - 3 * s, b.rw * 2.4, 6 * s);
      // Inside of the bowl seen over the rim.
      ctx.beginPath();
      ctx.ellipse(b.x, b.rimY, b.rw * 0.96, b.ry, 0, 0, Math.PI * 2);
      const inner = ctx.createLinearGradient(0, b.rimY - b.ry, 0, b.rimY + b.ry);
      if (k === 'food') {
        inner.addColorStop(0, '#E7D7C2');
        inner.addColorStop(1, '#B9A288');
      } else {
        inner.addColorStop(0, '#E6EEF3');
        inner.addColorStop(1, '#B8C8D3');
      }
      ctx.fillStyle = inner;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      // Contents may heap above the rim (kibble), so clip to the rim ellipse plus the space above it.
      ctx.ellipse(b.x, b.rimY, b.rw * 0.93, b.ry * 0.92, 0, 0, Math.PI);
      ctx.lineTo(b.x - b.rw * 0.93, b.rimY - 14 * s);
      ctx.lineTo(b.x + b.rw * 0.93, b.rimY - 14 * s);
      ctx.closePath();
      ctx.clip();
      if (k === 'food') this.drawKibble(ctx, b, lvl, s);
      else this.drawWater(ctx, b, lvl, s, time);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawKibble(ctx: AnyCtx, b: StationGeom['bowls']['food'], lvl: number, s: number): void {
    if (lvl <= 0.005) return;
    // Mound rises above the rim when the bowl is full; sinks out of sight as it empties.
    const heap = Math.max(0, (lvl - 0.5) / 0.5) * 5.5 * s;
    const sink = (1 - Math.min(1, lvl / 0.5)) * b.ry * 1.6;
    const count = Math.round(14 + 46 * lvl);
    const cols = ['#9A5A2C', '#B06A35', '#7E4724', '#C27B42'];
    for (let i = 0; i < count; i++) {
      const u = hash1(i * 3.7 + 1) * 2 - 1;
      const v = hash1(i * 5.3 + 2);
      const x = b.x + u * b.rw * 0.86 * Math.sqrt(1 - v * 0.35);
      const dome = heap * (1 - u * u) * (0.55 + 0.45 * v);
      const y = b.rimY + sink + (v - 0.5) * b.ry * 1.3 - dome;
      const r = (1.35 + hash1(i * 7.1) * 0.7) * s;
      ctx.fillStyle = cols[i % cols.length];
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.15, r * 0.85, hash1(i) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // Light from the upper left on the heap.
    ctx.fillStyle = 'rgba(255,235,200,0.16)';
    ctx.beginPath();
    ctx.ellipse(b.x - b.rw * 0.25, b.rimY + sink - heap * 0.7, b.rw * 0.45, b.ry * 0.6 + heap * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWater(ctx: AnyCtx, b: StationGeom['bowls']['water'], lvl: number, s: number, time: number): void {
    if (lvl <= 0.005) return;
    const drop = (1 - lvl) * b.ry * 1.5;
    const w = b.rw * (0.8 + 0.13 * lvl);
    ctx.beginPath();
    ctx.ellipse(b.x, b.rimY + drop * 0.6, w, b.ry * (0.55 + 0.35 * lvl), 0, 0, Math.PI * 2);
    const wg = ctx.createLinearGradient(0, b.rimY - b.ry, 0, b.rimY + b.ry + drop);
    wg.addColorStop(0, 'rgba(120,175,215,0.75)');
    wg.addColorStop(1, 'rgba(62,118,168,0.85)');
    ctx.fillStyle = wg;
    ctx.fill();
    // Surface shimmer: two soft highlights drifting slowly.
    for (let i = 0; i < 2; i++) {
      const ph = time * (0.6 + i * 0.37) + i * 2.1;
      const hx = b.x + Math.sin(ph) * w * 0.45;
      ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.2 * Math.sin(ph * 1.7)})`;
      ctx.lineWidth = Math.max(0.6, 0.9 * s);
      ctx.beginPath();
      ctx.ellipse(hx, b.rimY + drop * 0.6 - b.ry * 0.15, w * 0.22, b.ry * 0.18, 0, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
  }

  /** The bowls' outer walls and rims (in front of the cats). */
  drawFront(ctx: AnyCtx, bounds: WorldBounds): void {
    if (!this.state.enabled) return;
    const g = this.geom(bounds);
    const s = g.s;
    const baseY = g.floorY - g.matH;
    ctx.save();
    for (const k of ['food', 'water'] as BowlKind[]) {
      const b = g.bowls[k];
      const glaze = k === 'food' ? ['#D2805C', '#B5603F', '#8E4630'] : ['#6C9CC4', '#4A79A3', '#33597C'];
      // Outer wall: rim → rounded belly → small foot.
      const wall = new Path2D();
      wall.moveTo(b.x - b.rw, b.rimY);
      wall.bezierCurveTo(b.x - b.rw * 1.02, b.rimY + b.h * 0.55, b.x - b.bw * 1.12, baseY - b.h * 0.12, b.x - b.bw, baseY - 1.2 * s);
      wall.lineTo(b.x - b.bw * 0.92, baseY);
      wall.lineTo(b.x + b.bw * 0.92, baseY);
      wall.lineTo(b.x + b.bw, baseY - 1.2 * s);
      wall.bezierCurveTo(b.x + b.bw * 1.12, baseY - b.h * 0.12, b.x + b.rw * 1.02, b.rimY + b.h * 0.55, b.x + b.rw, b.rimY);
      // the near half of the rim ellipse closes the shape
      wall.ellipse(b.x, b.rimY, b.rw, b.ry, 0, 0, Math.PI, false);
      const lg = ctx.createLinearGradient(b.x - b.rw, 0, b.x + b.rw, 0);
      lg.addColorStop(0, glaze[0]);
      lg.addColorStop(0.45, glaze[1]);
      lg.addColorStop(1, glaze[2]);
      ctx.fillStyle = lg;
      ctx.fill(wall);
      // Vertical shading (darker toward the foot) and a soft key-light highlight.
      ctx.save();
      ctx.clip(wall);
      const vg = ctx.createLinearGradient(0, b.rimY, 0, baseY);
      vg.addColorStop(0, 'rgba(255,255,255,0.10)');
      vg.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = vg;
      ctx.fillRect(b.x - b.rw - 2, b.rimY - b.ry, b.rw * 2 + 4, b.h + b.ry * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.ellipse(b.x - b.rw * 0.5, b.rimY + b.h * 0.42, b.rw * 0.16, b.h * 0.26, -0.15, 0, Math.PI * 2);
      ctx.fill();
      // A painted band for character (paw prints on the food bowl, a wave on the water bowl).
      ctx.fillStyle = 'rgba(250,240,228,0.75)';
      if (k === 'food') {
        for (const dx of [-0.32, 0.1]) {
          const px = b.x + dx * b.rw;
          const py = b.rimY + b.h * 0.5;
          ctx.beginPath();
          ctx.ellipse(px, py, 2.1 * s, 1.7 * s, 0, 0, Math.PI * 2);
          ctx.fill();
          for (let t = 0; t < 3; t++) {
            ctx.beginPath();
            ctx.arc(px - 2 * s + t * 2 * s, py - 2.6 * s - (t === 1 ? 0.5 * s : 0), 0.8 * s, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        ctx.strokeStyle = 'rgba(240,248,255,0.7)';
        ctx.lineWidth = Math.max(0.6, 1 * s);
        ctx.beginPath();
        for (let i = 0; i <= 12; i++) {
          const x = b.x - b.rw * 0.7 + (i / 12) * b.rw * 1.4;
          const y = b.rimY + b.h * 0.5 + Math.sin(i * 1.3) * 1.1 * s;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
      // Rim lip (front edge) catches the light.
      ctx.strokeStyle = k === 'food' ? 'rgba(255,226,206,0.85)' : 'rgba(225,240,252,0.9)';
      ctx.lineWidth = Math.max(0.8, 1.3 * s);
      ctx.beginPath();
      ctx.ellipse(b.x, b.rimY, b.rw, b.ry, 0, 0.05, Math.PI - 0.05);
      ctx.stroke();
      if (this.refillGlow[k] > 0) {
        ctx.globalAlpha = this.refillGlow[k] / 0.6;
        ctx.strokeStyle = 'rgba(255,240,170,0.9)';
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.ellipse(b.x, b.rimY, b.rw + 3 * s, b.ry + 3 * s, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }
}
