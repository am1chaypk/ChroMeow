/**
 * Personal cat beds (v3): one round, cushioned bed per cat along the viewport
 * floor, its owner's name stitched on the front bolster ("Alex", "Anna").
 * DOM-free like the food & water station — the page adds a hitbox on top so a
 * bed can be dragged sideways along the floor; Cat Studio's preview uses it as is.
 *
 *  • Each cat prefers its own bed for naps (and the pair cuddles up in one of
 *    their beds when you step away).
 *  • Drawn in two layers: the back bolster and cushion behind the cats, the
 *    front bolster (with the name) in front, so a cat lying in its bed sinks
 *    into it.
 *  • Positions are shared by every tab through chrome.storage.local.
 */
import { clamp, clamp01 } from '../shared/math';
import type { CatBedsState } from '../shared/types';
import type { AnyCtx } from '../engine/canvas';
import type { WorldBounds } from '../engine/Physics';

export interface BedOwner {
  id: string;
  /** Name stitched on the bed (already localised). */
  name: string;
  slot: number;
}

export interface BedGeom {
  id: string;
  name: string;
  cx: number;
  floorY: number;
  s: number;
  /** Outer width / height of the bed. */
  w: number;
  h: number;
  /** Width of the cushion a cat can lie on. */
  inner: number;
  colors: BedColors;
}

interface BedColors {
  shell: [string, string];
  cushion: [string, string];
  thread: string;
}

/** Bed colours by cat slot: warm rust for the first cat, dusty teal for the second, then plum and mustard. */
const BED_COLORS: BedColors[] = [
  { shell: ['#C47A57', '#9C5638'], cushion: ['#F4E7D6', '#E0CBB2'], thread: '#FFF6EA' },
  { shell: ['#6E9A97', '#4B7472'], cushion: ['#EEF3EF', '#D3DFD9'], thread: '#F6FFFC' },
  { shell: ['#977AA8', '#6F5683'], cushion: ['#F3ECF5', '#DCCFE2'], thread: '#FFF8FF' },
  { shell: ['#C9A24A', '#9E7A2C'], cushion: ['#F7EED6', '#E5D5AF'], thread: '#FFFBEF' },
];

/** How far a cat lying in a bed sits above the floor (the cushion), in cat-scale px. */
export const BED_LIFT = 7;

export class BedsModel {
  state: CatBedsState;
  /** Scale of the drawing (follows the cats' size setting). */
  scale = 1;
  /** Set when a bed was moved; the page persists and clears it. */
  dirty = false;
  private owners: BedOwner[] = [];

  constructor(state: CatBedsState) {
    this.state = { enabled: state.enabled, positions: { ...state.positions } };
  }

  get enabled(): boolean {
    return this.state.enabled && this.owners.length > 0;
  }

  setState(next: CatBedsState): void {
    this.state = { enabled: next.enabled, positions: { ...next.positions } };
  }

  /** The cats that get a bed (the enabled ones), in slot order. */
  setOwners(list: BedOwner[]): void {
    this.owners = [...list].sort((a, b) => a.slot - b.slot);
  }

  get ownerIds(): string[] {
    return this.owners.map((o) => o.id);
  }

  has(id: string): boolean {
    return this.enabled && this.owners.some((o) => o.id === id);
  }

  /** Default spot: the beds sit side by side near the left of the floor, away from the food & water. */
  defaultX(index: number): number {
    return clamp(0.1 + index * 0.13, 0.05, 0.75);
  }

  xNormalized(id: string): number {
    const i = this.owners.findIndex((o) => o.id === id);
    const v = this.state.positions[id];
    return typeof v === 'number' ? v : this.defaultX(Math.max(0, i));
  }

  moveTo(id: string, xNormalized: number): void {
    this.state.positions = { ...this.state.positions, [id]: clamp01(xNormalized) };
    this.dirty = true;
  }

  /* ---------------------------------------------------------- geometry */

  geom(id: string, bounds: WorldBounds): BedGeom | null {
    const idx = this.owners.findIndex((o) => o.id === id);
    if (idx < 0) return null;
    const o = this.owners[idx];
    const s = this.scale;
    const w = 118 * s;
    const lo = Math.min(w / 2 + 4, bounds.width / 2);
    const hi = Math.max(lo, bounds.width - w / 2 - 4);
    const cx = clamp(this.xNormalized(id) * bounds.width, lo, hi);
    return { id, name: o.name, cx, floorY: bounds.height - 2, s, w, h: 30 * s, inner: 86 * s, colors: BED_COLORS[(Math.max(1, o.slot) - 1) % BED_COLORS.length] };
  }

  all(bounds: WorldBounds): BedGeom[] {
    if (!this.enabled) return [];
    return this.owners.map((o) => this.geom(o.id, bounds)).filter((g): g is BedGeom => !!g);
  }

  /** Centre of a cat's own bed (where it lies down), or null without one. */
  spotFor(id: string, bounds: WorldBounds): { x: number; y: number; inner: number } | null {
    if (!this.has(id)) return null;
    const g = this.geom(id, bounds);
    return g ? { x: g.cx, y: g.floorY, inner: g.inner } : null;
  }

  /** The bed whose cushion is under floor position x, if any. */
  bedAt(x: number, bounds: WorldBounds): string | null {
    for (const g of this.all(bounds)) if (Math.abs(x - g.cx) <= g.inner / 2) return g.id;
    return null;
  }

  /** Bed under a pointer (for the page's drag hitbox). */
  hit(x: number, y: number, bounds: WorldBounds): string | null {
    for (const g of this.all(bounds).reverse()) {
      if (x >= g.cx - g.w / 2 && x <= g.cx + g.w / 2 && y >= g.floorY - g.h - 2 && y <= g.floorY + 2) return g.id;
    }
    return null;
  }

  /** Clickable area of one bed. */
  hitRect(id: string, bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const g = this.geom(id, bounds);
    if (!g) return null;
    return { minX: g.cx - g.w / 2, minY: g.floorY - g.h - 2, maxX: g.cx + g.w / 2, maxY: g.floorY + 2 };
  }

  /* ----------------------------------------------------------- drawing */

  /** Shadow, back bolster and cushion (behind the cats). */
  drawBack(ctx: AnyCtx, bounds: WorldBounds): void {
    for (const g of this.all(bounds)) {
      const { cx, floorY, s, w, h } = g;
      const half = w / 2;
      ctx.save();
      // Soft contact shadow.
      const sh = ctx.createRadialGradient(cx, floorY, 2, cx, floorY, w * 0.62);
      sh.addColorStop(0, 'rgba(30,22,16,0.26)');
      sh.addColorStop(1, 'rgba(30,22,16,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(cx - w * 0.66, floorY - 10 * s, w * 1.32, 12 * s);
      // Back bolster: a plump round rim seen from slightly above (a donut bed).
      const top = floorY - h;
      ctx.beginPath();
      ctx.moveTo(cx - half, floorY - 6 * s);
      ctx.bezierCurveTo(cx - half, top + 4 * s, cx - half * 0.62, top, cx, top);
      ctx.bezierCurveTo(cx + half * 0.62, top, cx + half, top + 4 * s, cx + half, floorY - 6 * s);
      ctx.closePath();
      const bg = ctx.createLinearGradient(0, top, 0, floorY);
      bg.addColorStop(0, g.colors.shell[0]);
      bg.addColorStop(1, g.colors.shell[1]);
      ctx.fillStyle = bg;
      ctx.fill();
      // Fleece highlight along the top of the rim.
      ctx.strokeStyle = 'rgba(255,255,255,0.24)';
      ctx.lineWidth = Math.max(1, 2.2 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - half * 0.72, top + 5 * s);
      ctx.quadraticCurveTo(cx, top + 0.8 * s, cx + half * 0.72, top + 5 * s);
      ctx.stroke();
      // The hollow inside the rim, then the cushion in it.
      ctx.beginPath();
      ctx.ellipse(cx, floorY - 11 * s, half * 0.8, 8.5 * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40,24,14,0.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, floorY - 10 * s, g.inner / 2, 7 * s, 0, 0, Math.PI * 2);
      const cg = ctx.createLinearGradient(0, floorY - 17 * s, 0, floorY - 3 * s);
      cg.addColorStop(0, g.colors.cushion[0]);
      cg.addColorStop(1, g.colors.cushion[1]);
      ctx.fillStyle = cg;
      ctx.fill();
      // Quilting on the cushion.
      ctx.strokeStyle = 'rgba(90,64,40,0.13)';
      ctx.lineWidth = Math.max(0.6, 0.8 * s);
      ctx.beginPath();
      ctx.ellipse(cx, floorY - 10 * s, g.inner * 0.3, 4 * s, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Front bolster with the owner's name stitched on it (in front of the cats). */
  drawFront(ctx: AnyCtx, bounds: WorldBounds): void {
    for (const g of this.all(bounds)) {
      const { cx, floorY, s, w } = g;
      const half = w / 2;
      const top = floorY - 11 * s;
      ctx.save();
      // A plump front roll: rounded ends, slightly lower in the middle where cats step in.
      ctx.beginPath();
      ctx.moveTo(cx - half, floorY - 1);
      ctx.bezierCurveTo(cx - half - 1.5 * s, top + 2 * s, cx - half + 4 * s, top - 2.5 * s, cx - half * 0.6, top - 0.5 * s);
      ctx.quadraticCurveTo(cx, top + 2.4 * s, cx + half * 0.6, top - 0.5 * s);
      ctx.bezierCurveTo(cx + half - 4 * s, top - 2.5 * s, cx + half + 1.5 * s, top + 2 * s, cx + half, floorY - 1);
      ctx.quadraticCurveTo(cx, floorY + 1.2 * s, cx - half, floorY - 1);
      ctx.closePath();
      const fg = ctx.createLinearGradient(0, top - 2 * s, 0, floorY);
      fg.addColorStop(0, g.colors.shell[0]);
      fg.addColorStop(0.55, g.colors.shell[0]);
      fg.addColorStop(1, g.colors.shell[1]);
      ctx.fillStyle = fg;
      ctx.fill();
      // Light along the top of the roll, and a row of stitches.
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = Math.max(0.9, 1.4 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - half * 0.82, top + 1.2 * s);
      ctx.quadraticCurveTo(cx, top + 3.4 * s, cx + half * 0.82, top + 1.2 * s);
      ctx.stroke();
      ctx.setLineDash([2.4 * s, 2 * s]);
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = Math.max(0.6, 0.8 * s);
      ctx.beginPath();
      ctx.moveTo(cx - half * 0.86, floorY - 2.4 * s);
      ctx.quadraticCurveTo(cx, floorY - 1.2 * s, cx + half * 0.86, floorY - 2.4 * s);
      ctx.stroke();
      ctx.setLineDash([]);
      // The name, embroidered on the front.
      if (g.name) {
        const size = Math.max(8, 9.5 * s);
        ctx.font = `700 ${size}px ui-rounded, "Arial Rounded MT Bold", system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.direction = /[\u0590-\u05ff]/.test(g.name) ? 'rtl' : 'ltr';
        const ty = floorY - 5.6 * s;
        ctx.lineWidth = Math.max(1.6, 2.4 * s);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(40,24,14,0.3)';
        ctx.strokeText(g.name, cx, ty);
        ctx.fillStyle = g.colors.thread;
        ctx.fillText(g.name, cx, ty);
      }
      ctx.restore();
    }
  }

  /** Screen rectangle covering every bed (dirty-rect bookkeeping). */
  rects(bounds: WorldBounds): { minX: number; minY: number; maxX: number; maxY: number }[] {
    return this.all(bounds).map((g) => ({ minX: g.cx - g.w * 0.68, minY: g.floorY - g.h * 1.15, maxX: g.cx + g.w * 0.68, maxY: g.floorY + 2 }));
  }
}
