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
 *  • Every frame clears the whole canvas at the identity transform before
 *    drawing, so nothing a cat drew last frame (soft shadows, tail blur,
 *    particles) can ever be left behind as a smear.
 *  • Picking a cat up locks the pointer: a full-viewport drag shield takes
 *    pointer capture (pointer-events: auto, cursor: grabbing) until the button is
 *    released, cancelled or the window loses focus — so a fast drag can never
 *    escape the cat and start selecting text on the page.
 *  • A hitbox over the food & water station lets you click a bowl to refill it
 *    and drag the mat along the floor.
 *  • v3: right-clicking a cat opens the mini-games menu instead of the
 *    browser's context menu; each cat's bed has a hitbox to drag it along the
 *    floor; small round hitboxes over the ball and the toy mouse let you pick
 *    them straight up off the page.
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
.hit-layer.locked .cat-hitbox, .hit-layer.locked .station-hitbox, .hit-layer.locked .bed-hitbox, .hit-layer.locked .toy-hitbox { pointer-events: none; display: none; }
.bed-hitbox {
  position: fixed; left: 0; top: 0; width: 1px; height: 1px;
  pointer-events: auto; background: transparent; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.bed-hitbox.is-dragging { cursor: grabbing; }
.toy-hitbox {
  position: fixed; left: 0; top: 0; width: 1px; height: 1px; border-radius: 50%;
  pointer-events: auto; background: transparent; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.station-hitbox {
  position: fixed; left: 0; top: 0; width: 1px; height: 1px; display: none;
  pointer-events: auto; background: transparent; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.drag-shield {
  position: fixed; inset: 0; display: none; pointer-events: none;
  cursor: grabbing; touch-action: none; user-select: none; -webkit-user-select: none;
  z-index: 2147483647; background: transparent;
}
.drag-shield.on { display: block; pointer-events: auto; }
`;

export interface HitboxHandlers {
  down(x: number, y: number, e: PointerEvent): void;
  up(x: number, y: number, e: PointerEvent): void;
  /** Pointer capture was lost mid-drag without a pointerup. */
  lost?(): void;
  /** Right-click on a cat (the browser's own context menu is suppressed). */
  context?(catId: string, x: number, y: number): void;
}

export interface BedHandlers {
  /** Dragging a bed: x is the bed centre's new viewport x. */
  drag(id: string, x: number, phase: 'start' | 'move' | 'end'): void;
}

export interface StationHandlers {
  /** Returns what is under the point: a bowl, the mat or nothing. */
  hit(x: number, y: number): 'food' | 'water' | 'mat' | null;
  refill(kind: 'food' | 'water'): void;
  /** Dragging the mat: x is the pointer's viewport x. */
  drag(x: number, phase: 'start' | 'move' | 'end'): void;
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
  private readonly shield: HTMLDivElement;
  private readonly stationBox: HTMLDivElement;
  private stationHandlers: StationHandlers | null = null;
  private stationDrag: { pointerId: number; offset: number } | null = null;
  private lockedPointer: number | null = null;
  private readonly blockSelect = (e: Event) => e.preventDefault();
  private readonly bedBoxes = new Map<string, HTMLDivElement>();
  private bedHandlers: BedHandlers | null = null;
  private bedDrag: { id: string; pointerId: number; offset: number } | null = null;
  private readonly toyBoxes = new Map<number, HTMLDivElement>();

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
    this.stationBox = document.createElement('div');
    this.stationBox.className = 'station-hitbox';
    this.hitLayer.appendChild(this.stationBox);
    this.shield = document.createElement('div');
    this.shield.className = 'drag-shield';
    this.root.append(style, this.canvas, this.hitLayer, this.shield);
    this.bindShield();
    this.bindStation();
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
    this.bedBoxes.clear();
    this.toyBoxes.clear();
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

  /**
   * Starts a frame: resets to the identity matrix and clears the *whole* backing
   * store, then applies the device-pixel-ratio transform for drawing. (Clearing
   * only last frame's cat rectangles left slices of soft ground shadows, blurred
   * tails and particles behind whenever they reached past those rectangles.)
   */
  beginFrame(): CanvasRenderingContext2D {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  endFrame(rects: Rect[]): void {
    this.prevRects = rects;
  }

  /* ------------------------------------------------------- pointer lock */

  /** Locks the pointer to the overlay for the rest of a cat drag (capture survives any speed). */
  lockPointer(pointerId: number): void {
    this.lockedPointer = pointerId;
    this.shield.classList.add('on');
    try {
      this.shield.setPointerCapture(pointerId);
    } catch {
      /* the pointer may already be up */
    }
    document.addEventListener('selectstart', this.blockSelect, true);
    document.addEventListener('dragstart', this.blockSelect, true);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  }

  unlockPointer(): void {
    const id = this.lockedPointer;
    this.lockedPointer = null;
    this.shield.classList.remove('on');
    if (id !== null) {
      try {
        if (this.shield.hasPointerCapture(id)) this.shield.releasePointerCapture(id);
      } catch {
        /* ignore */
      }
    }
    document.removeEventListener('selectstart', this.blockSelect, true);
    document.removeEventListener('dragstart', this.blockSelect, true);
  }

  get pointerLocked(): boolean {
    return this.lockedPointer !== null;
  }

  private bindShield(): void {
    const sh = this.shield;
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      sh.addEventListener(type, (e) => {
        e.preventDefault();
      });
    }
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick', 'contextmenu']) {
      sh.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    sh.addEventListener('lostpointercapture', () => {
      if (this.lockedPointer !== null) this.handlers.lost?.();
    });
  }

  /* ----------------------------------------------------- station hitbox */

  setStationHandlers(h: StationHandlers | null): void {
    this.stationHandlers = h;
  }

  /** Places the station hitbox (null hides it). */
  syncStation(rect: { minX: number; minY: number; maxX: number; maxY: number } | null): void {
    const el = this.stationBox;
    if (!rect || this.clickThrough) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.transform = `translate(${Math.floor(rect.minX)}px, ${Math.floor(rect.minY)}px)`;
    el.style.width = `${Math.ceil(rect.maxX - rect.minX)}px`;
    el.style.height = `${Math.ceil(rect.maxY - rect.minY)}px`;
  }

  private bindStation(): void {
    const el = this.stationBox;
    el.addEventListener('pointermove', (e) => {
      const h = this.stationHandlers;
      if (!h) return;
      if (this.stationDrag && e.pointerId === this.stationDrag.pointerId) {
        e.preventDefault();
        h.drag(e.clientX - this.stationDrag.offset, 'move');
        return;
      }
      const what = h.hit(e.clientX, e.clientY);
      el.style.cursor = what === 'mat' ? 'grab' : what ? 'pointer' : 'default';
    });
    el.addEventListener('pointerdown', (e) => {
      const h = this.stationHandlers;
      if (!h || e.button !== 0) return;
      const what = h.hit(e.clientX, e.clientY);
      if (!what) return;
      e.preventDefault();
      e.stopPropagation();
      if (what === 'mat') {
        const r = el.getBoundingClientRect();
        this.stationDrag = { pointerId: e.pointerId, offset: e.clientX - (r.left + r.width / 2) };
        el.style.cursor = 'grabbing';
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        h.drag(e.clientX - this.stationDrag.offset, 'start');
      } else h.refill(what);
    });
    const end = (e: PointerEvent) => {
      if (!this.stationDrag || e.pointerId !== this.stationDrag.pointerId) return;
      this.stationHandlers?.drag(e.clientX - this.stationDrag.offset, 'end');
      this.stationDrag = null;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick']) {
      el.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
  }

  /* -------------------------------------------------------- bed hitboxes */

  setBedHandlers(h: BedHandlers | null): void {
    this.bedHandlers = h;
  }

  /** Places one drag hitbox per bed (an empty list removes them). */
  syncBeds(beds: { id: string; rect: { minX: number; minY: number; maxX: number; maxY: number } }[]): void {
    const seen = new Set<string>();
    for (const { id, rect } of beds) {
      seen.add(id);
      let el = this.bedBoxes.get(id);
      if (!el) {
        el = this.createBedBox(id);
        this.bedBoxes.set(id, el);
      }
      el.style.display = this.clickThrough ? 'none' : 'block';
      el.style.transform = `translate(${Math.floor(rect.minX)}px, ${Math.floor(rect.minY)}px)`;
      el.style.width = `${Math.ceil(rect.maxX - rect.minX)}px`;
      el.style.height = `${Math.ceil(rect.maxY - rect.minY)}px`;
    }
    for (const [id, el] of this.bedBoxes) {
      if (seen.has(id) || this.bedDrag?.id === id) continue;
      el.remove();
      this.bedBoxes.delete(id);
    }
  }

  private createBedBox(id: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'bed-hitbox';
    el.dataset.bed = id;
    el.addEventListener('pointerdown', (e) => {
      const h = this.bedHandlers;
      if (!h || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      this.bedDrag = { id, pointerId: e.pointerId, offset: e.clientX - (r.left + r.width / 2) };
      el.classList.add('is-dragging');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      h.drag(id, e.clientX - this.bedDrag.offset, 'start');
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.bedDrag;
      if (!d || d.id !== id || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      this.bedHandlers?.drag(id, e.clientX - d.offset, 'move');
    });
    const end = (e: PointerEvent) => {
      const d = this.bedDrag;
      if (!d || d.id !== id || e.pointerId !== d.pointerId) return;
      this.bedHandlers?.drag(id, e.clientX - d.offset, 'end');
      this.bedDrag = null;
      el.classList.remove('is-dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick']) {
      el.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    this.hitLayer.appendChild(el);
    return el;
  }

  /* -------------------------------------------------------- toy hitboxes */

  /**
   * Round hitboxes over toys that can be picked up (the ball, the mouse). The
   * press itself is handled by the world through the page-wide pointer
   * listener; the hitbox just keeps the click from reaching the page below.
   */
  syncToys(toys: { id: number; x: number; y: number; r: number }[]): void {
    const seen = new Set<number>();
    for (const t of toys) {
      seen.add(t.id);
      let el = this.toyBoxes.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'toy-hitbox';
        el.dataset.toy = String(t.id);
        for (const type of ['pointerdown', 'click', 'dblclick', 'mousedown', 'mouseup', 'auxclick']) {
          el.addEventListener(type, (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
        }
        this.hitLayer.appendChild(el);
        this.toyBoxes.set(t.id, el);
      }
      el.style.display = this.clickThrough ? 'none' : 'block';
      const d = Math.ceil(t.r * 2);
      el.style.transform = `translate(${Math.floor(t.x - t.r)}px, ${Math.floor(t.y - t.r)}px)`;
      el.style.width = `${d}px`;
      el.style.height = `${d}px`;
    }
    for (const [id, el] of this.toyBoxes) {
      if (seen.has(id)) continue;
      el.remove();
      this.toyBoxes.delete(id);
    }
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
    // While a cat is held its hitbox stays put under the shield (the shield owns the pointer).
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
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick']) {
      el.addEventListener(type, (e) => {
        e.preventDefault();
        stop(e);
      });
    }
    // Right-click on a cat: the mini-games menu instead of the browser's context menu.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      stop(e);
      const me = e as MouseEvent;
      this.handlers.context?.(id, me.clientX, me.clientY);
    });
    el.addEventListener('wheel', () => undefined, { passive: true });
    this.hitLayer.appendChild(el);
    return el;
  }
}
