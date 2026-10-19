/**
 * ShadowDOMOverlay — the cats' stage on top of any page.
 *
 *  • <div id="chromeow-host"> with an open Shadow Root: page CSS can't leak in,
 *    ChroMeow can't affect page layout (fixed, zero-size host).
 *  • A full-viewport <canvas> with pointer-events: none — scrolling, selecting
 *    and clicking links work exactly as if ChroMeow weren't there.
 *  • One interactive proxy hitbox per cat (<div class="cat-hitbox">) with
 *    pointer-events: auto, positioned over the cat every frame and shaped with a
 *    clip-path polygon (the cat's convex hull) so only the cat itself catches the
 *    mouse. Click-Through Lock hides all hitboxes.
 *  • Dirty-rectangle clearing keeps the per-frame cost proportional to the cats,
 *    not the screen.
 */
import type { Landmarks } from '../engine/ArticulatedCatRenderer';
import type { Rect } from '../sim/World';

const STYLE = `
:host { all: initial; }
canvas.stage {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 2147483647; pointer-events: none; display: block;
  contain: strict;
}
.hit-layer { position: fixed; inset: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
.cat-hitbox {
  position: fixed; left: 0; top: 0; width: 1px; height: 1px;
  pointer-events: auto; background: transparent; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.cat-hitbox:active { cursor: grabbing; }
.hit-layer.locked .cat-hitbox { pointer-events: none; display: none; }
`;

export interface HitboxHandlers {
  down(x: number, y: number, e: PointerEvent): void;
  up(x: number, y: number, e: PointerEvent): void;
}

export class ShadowDOMOverlay {
  readonly host: HTMLDivElement;
  readonly root: ShadowRoot;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private readonly hitLayer: HTMLDivElement;
  private readonly hitboxes = new Map<string, HTMLDivElement>();
  private prevRects: Rect[] = [];
  private dpr = 1;
  width = 0;
  height = 0;
  private clickThrough = false;
  private readonly onResize = () => this.resize();

  constructor(private readonly handlers: HitboxHandlers) {
    this.host = document.createElement('div');
    this.host.id = 'chromeow-host';
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText = 'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage';
    this.hitLayer = document.createElement('div');
    this.hitLayer.className = 'hit-layer';
    this.root.append(style, this.canvas, this.hitLayer);
    const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('ChroMeow: 2D canvas unavailable');
    this.ctx = ctx;
  }

  mount(): void {
    (document.documentElement || document.body).appendChild(this.host);
    this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  unmount(): void {
    window.removeEventListener('resize', this.onResize);
    this.host.remove();
    this.hitboxes.clear();
  }

  /** Re-attaches the host if a single-page app wiped <html>'s children. */
  ensureMounted(): void {
    if (!this.host.isConnected) (document.documentElement || document.body).appendChild(this.host);
  }

  resize(): void {
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.prevRects = [];
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  setClickThrough(on: boolean): void {
    this.clickThrough = on;
    this.hitLayer.classList.toggle('locked', on);
  }

  /** Clears last frame's dirty rectangles and prepares the transform for drawing. */
  beginFrame(): CanvasRenderingContext2D {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let area = 0;
    for (const r of this.prevRects) area += (r.maxX - r.minX) * (r.maxY - r.minY);
    if (area > this.width * this.height * 0.45) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else {
      for (const r of this.prevRects) {
        const x = Math.floor(r.minX * this.dpr) - 2;
        const y = Math.floor(r.minY * this.dpr) - 2;
        ctx.clearRect(x, y, Math.ceil((r.maxX - r.minX) * this.dpr) + 4, Math.ceil((r.maxY - r.minY) * this.dpr) + 4);
      }
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  endFrame(rects: Rect[]): void {
    this.prevRects = rects;
  }

  /** Positions each cat's interactive proxy hitbox over its body (clip-path = convex hull). */
  syncHitboxes(cats: { id: string; lm: Landmarks | null; state?: string; ground?: string | null }[]): void {
    const seen = new Set<string>();
    for (const { id, lm, state, ground } of cats) {
      seen.add(id);
      let el = this.hitboxes.get(id);
      if (!el) {
        el = this.createHitbox(id);
        this.hitboxes.set(id, el);
      }
      if (!lm || this.clickThrough) {
        el.style.display = 'none';
        continue;
      }
      const b = lm.bounds;
      const pad = 4;
      const left = Math.floor(b.minX - pad);
      const top = Math.floor(b.minY - pad);
      const w = Math.max(2, Math.ceil(b.maxX - b.minX + pad * 2));
      const h = Math.max(2, Math.ceil(b.maxY - b.minY + pad * 2));
      el.style.display = 'block';
      // Lightweight introspection hooks (handy for automated tests and debugging).
      if (state && el.dataset.state !== state) el.dataset.state = state;
      const g = ground ?? 'air';
      if (el.dataset.ground !== g) el.dataset.ground = g;
      el.style.transform = `translate(${left}px, ${top}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      const poly = lm.hull.map((p) => `${(p.x - left).toFixed(1)}px ${(p.y - top).toFixed(1)}px`).join(',');
      el.style.clipPath = lm.hull.length >= 3 ? `polygon(${poly})` : 'none';
    }
    for (const [id, el] of this.hitboxes) {
      if (!seen.has(id)) {
        el.remove();
        this.hitboxes.delete(id);
      }
    }
  }

  private createHitbox(id: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'cat-hitbox';
    el.dataset.cat = id;
    const stop = (e: Event) => {
      e.stopPropagation();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.handlers.down(e.clientX, e.clientY, e);
    });
    el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handlers.up(e.clientX, e.clientY, e);
    });
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu', 'auxclick']) {
      el.addEventListener(type, (e) => {
        if (type === 'contextmenu') return; // keep the browser context menu available
        e.preventDefault();
        stop(e);
      });
    }
    el.addEventListener('wheel', () => undefined, { passive: true });
    this.hitLayer.appendChild(el);
    return el;
  }
}
