/**
 * DomPlatformScanner — turns the live webpage into a physical playground.
 *
 * Discovery (idle, throttled): semantic & structural elements (header, nav,
 * article, img, video, pre, input, button, dialogs …) plus prominent "card"
 * containers that have a visible border, shadow or rounded filled background.
 *
 * Tracking: an IntersectionObserver keeps the set of on-screen candidates, a
 * ResizeObserver + MutationObserver flag layout changes, and throttled scroll
 * listeners re-measure geometry. Occlusion is verified with elementsFromPoint so
 * cats never stand on ledges hidden under sticky headers. The viewport bottom is
 * always present as the primary floor.
 *
 * Between measurements (every 50 ms while scrolling) the cached ledges are shifted
 * by the scroll delta, so landing tests never use stale positions; elements that
 * are fixed or sticky (they don't scroll) are left in place. While the user is
 * away (idle cuddle) discovery and measuring run four times less often.
 */
import { buildPlatforms, makeFloor, type Platform, type PlatformCandidate, type PlatformSource, type WorldBounds } from './Physics';

const SEMANTIC_SELECTOR = [
  'header',
  'nav',
  'article',
  'aside',
  'main > section',
  'section',
  'footer',
  'figure',
  'img',
  'picture',
  'video',
  'canvas',
  'iframe',
  'pre',
  'table',
  'blockquote',
  'input:not([type=hidden]):not([type=checkbox]):not([type=radio])',
  'textarea',
  'select',
  'button',
  '[role="dialog"]',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="article"]',
  '[role="search"]',
  'h1',
  'h2',
  'dialog[open]',
].join(',');

const CARD_SELECTOR = 'div, li, form, ul, ol, details, fieldset';

const MAX_SEMANTIC = 420;
const MAX_CARD_CHECKS = 900;
const DISCOVERY_INTERVAL = 1600;
const MEASURE_INTERVAL = 220;
const SCROLL_MEASURE_INTERVAL = 50;

interface CandidateInfo {
  id: string;
  tag: string;
  warm: number;
  /** Result of the last occlusion test (true = top edge actually visible). */
  unoccluded: boolean;
  /** position: fixed / sticky on the element or an ancestor: it doesn't move with the page. */
  fixed: boolean;
}

function isPinned(el: Element): boolean {
  let n: Element | null = el;
  for (let depth = 0; n && n !== document.body && n !== document.documentElement && depth < 14; depth++) {
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') return true;
    n = n.parentElement;
  }
  return false;
}

function warmthFor(el: Element): number {
  const tag = el.tagName.toLowerCase();
  if (tag === 'video') return 1;
  if (tag === 'iframe') {
    const src = (el as HTMLIFrameElement).src || '';
    return /youtube|vimeo|player|video|twitch/i.test(src) ? 0.9 : 0.25;
  }
  if (tag === 'img' || tag === 'picture' || tag === 'canvas') return 0.55;
  if (tag === 'pre') return 0.4;
  if (tag === 'header' || tag === 'nav') return 0.2;
  return 0.1;
}

function isVisibleStyle(cs: CSSStyleDeclaration): boolean {
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && parseFloat(cs.opacity || '1') > 0.15;
}

function looksLikeCard(cs: CSSStyleDeclaration): boolean {
  const borderTop = parseFloat(cs.borderTopWidth || '0');
  if (borderTop >= 1 && cs.borderTopStyle !== 'none' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(cs.borderTopColor)) return true;
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  const radius = parseFloat(cs.borderTopLeftRadius || '0');
  const bg = cs.backgroundColor;
  if (radius >= 4 && bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(bg)) return true;
  return false;
}

export class DomPlatformScanner implements PlatformSource {
  private readonly info = new Map<Element, CandidateInfo>();
  private readonly byId = new Map<string, Element>();
  private readonly onScreen = new Set<Element>();
  private list: Platform[] = [];
  private floorPlatform: Platform;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private counter = 0;
  private discoveryDirty = true;
  private geometryDirty = true;
  private occlusionDirty = true;
  private lastDiscovery = -Infinity;
  private lastMeasure = -Infinity;
  private lastScroll = -Infinity;
  private idleHandle: number | null = null;
  private running = false;
  /** Scroll position when `list` was measured, and the shifted copy for the current scroll. */
  private measuredScroll = { x: 0, y: 0 };
  private shifted: { key: string; list: Platform[] } | null = null;
  /** Slower discovery / measuring while nobody is at the computer. */
  private throttle = 1;
  private readonly onScroll = () => {
    this.geometryDirty = true;
    this.occlusionDirty = true;
    this.lastScroll = performance.now();
  };
  private readonly onResize = () => {
    this.floorPlatform = makeFloor(this.bounds());
    this.geometryDirty = true;
    this.discoveryDirty = true;
  };

  constructor(private readonly host: Element) {
    this.floorPlatform = makeFloor(this.bounds());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.onScreen.add(e.target);
          else this.onScreen.delete(e.target);
        }
        this.geometryDirty = true;
        this.occlusionDirty = true;
      },
      { root: null, rootMargin: '120px 0px 120px 0px', threshold: 0 },
    );
    this.ro = new ResizeObserver(() => {
      this.geometryDirty = true;
      this.occlusionDirty = true;
    });
    this.mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target === this.host || this.host.contains(r.target as Node)) continue;
        this.discoveryDirty = true;
        this.geometryDirty = true;
        return;
      }
    });
    if (document.body) {
      this.ro.observe(document.body);
      this.mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    }
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    window.addEventListener('resize', this.onResize, { passive: true });
    this.discover();
    this.measure(performance.now(), true);
  }

  stop(): void {
    this.running = false;
    this.io?.disconnect();
    this.ro?.disconnect();
    this.mo?.disconnect();
    this.io = this.ro = this.mo = null;
    window.removeEventListener('scroll', this.onScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', this.onResize);
    if (this.idleHandle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(this.idleHandle);
    this.info.clear();
    this.byId.clear();
    this.onScreen.clear();
    this.list = [];
  }

  bounds(): WorldBounds {
    return { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
  }

  floor(): Platform {
    return this.floorPlatform;
  }

  platforms(): readonly Platform[] {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const dx = sx - this.measuredScroll.x;
    const dy = sy - this.measuredScroll.y;
    if ((dx === 0 && dy === 0) || this.list.length === 0) return this.list;
    const key = `${sx},${sy},${this.lastMeasure}`;
    if (this.shifted?.key === key) return this.shifted.list;
    const list = this.list.map((p) => {
      const info = p.elementRef ? this.info.get(p.elementRef) : undefined;
      return info?.fixed ? p : { ...p, y: p.y - dy, xMin: p.xMin - dx, xMax: p.xMax - dx };
    });
    this.shifted = { key, list };
    return list;
  }

  scrollOffset(): { x: number; y: number } {
    return { x: window.scrollX, y: window.scrollY };
  }

  /** Throttles discovery and measuring (×4 slower) while the user is idle. */
  setThrottled(on: boolean): void {
    this.throttle = on ? 4 : 1;
  }

  /** Called every animation frame by the world loop. */
  update(now: number): void {
    if (!this.running) return;
    if (this.discoveryDirty && now - this.lastDiscovery > DISCOVERY_INTERVAL * this.throttle) this.scheduleDiscovery();
    const scrolling = now - this.lastScroll < 160;
    const interval = (scrolling ? SCROLL_MEASURE_INTERVAL : MEASURE_INTERVAL) * this.throttle;
    if (this.geometryDirty && now - this.lastMeasure > interval) {
      // Skip the (more expensive) occlusion test while the user is mid-scroll.
      this.measure(now, !scrolling && this.occlusionDirty);
    }
  }

  get(id: string): Platform | null {
    if (id === 'floor') return this.floorPlatform;
    const el = this.byId.get(id);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 4) return null;
    const b = this.bounds();
    const info = this.info.get(el);
    return {
      id,
      kind: 'dom',
      xMin: Math.max(0, r.left),
      xMax: Math.min(b.width, r.right),
      y: r.top,
      warm: info?.warm ?? 0.1,
      narrow: r.width < 300 && r.top < b.height - 160,
      tag: info?.tag ?? el.tagName.toLowerCase(),
      elementRef: el,
    };
  }

  /** Registers an arbitrary element (e.g. the focused text field) as a candidate ledge. */
  track(el: Element): string {
    const existing = this.info.get(el);
    if (existing) return existing.id;
    const id = `p${++this.counter}`;
    this.info.set(el, { id, tag: el.tagName.toLowerCase(), warm: warmthFor(el), unoccluded: true, fixed: isPinned(el) });
    this.byId.set(id, el);
    this.io?.observe(el);
    this.geometryDirty = true;
    return id;
  }

  idFor(el: Element): string | null {
    return this.info.get(el)?.id ?? null;
  }

  private scheduleDiscovery(): void {
    this.lastDiscovery = performance.now();
    this.discoveryDirty = false;
    const run = () => {
      this.idleHandle = null;
      if (this.running) this.discover();
    };
    if ('requestIdleCallback' in window) this.idleHandle = window.requestIdleCallback(run, { timeout: 900 });
    else setTimeout(run, 30);
  }

  private consider(el: Element, requireCard: boolean, vh: number): void {
    if (this.info.has(el)) return;
    if (el === this.host || this.host.contains(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 14) return;
    if (r.bottom < -vh || r.top > vh * 2) return;
    const cs = getComputedStyle(el);
    if (!isVisibleStyle(cs)) return;
    if (requireCard && !looksLikeCard(cs)) return;
    this.track(el);
  }

  private discover(): void {
    const start = performance.now();
    // Forget detached elements.
    for (const [el, info] of this.info) {
      if (!el.isConnected) {
        this.info.delete(el);
        this.byId.delete(info.id);
        this.onScreen.delete(el);
        this.io?.unobserve(el);
      }
    }
    const vh = window.innerHeight;
    const semantic = document.querySelectorAll(SEMANTIC_SELECTOR);
    for (let i = 0; i < semantic.length && i < MAX_SEMANTIC; i++) this.consider(semantic[i], false, vh);
    const cards = document.querySelectorAll(CARD_SELECTOR);
    let checks = 0;
    for (let i = 0; i < cards.length && checks < MAX_CARD_CHECKS; i++) {
      if (performance.now() - start > 14) {
        this.discoveryDirty = true; // finish on the next idle slice
        break;
      }
      const el = cards[i];
      if (this.info.has(el)) continue;
      checks++;
      this.consider(el, true, vh);
    }
    this.geometryDirty = true;
    this.occlusionDirty = true;
  }

  private occlusionTest(el: Element, x: number, y: number): boolean {
    const stack = document.elementsFromPoint(x, y);
    for (const top of stack) {
      if (top === this.host) continue;
      if (top === el || el.contains(top) || top.contains(el)) return true;
      return false;
    }
    return false;
  }

  private measure(now: number, withOcclusion: boolean): void {
    this.lastMeasure = now;
    this.geometryDirty = false;
    this.measuredScroll = { x: window.scrollX, y: window.scrollY };
    this.shifted = null;
    const b = this.bounds();
    const candidates: PlatformCandidate[] = [];
    for (const el of this.onScreen) {
      const info = this.info.get(el);
      if (!info) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > b.height) continue;
      if (withOcclusion) {
        const y = r.top + 3;
        if (y > 0 && y < b.height) {
          const cx = Math.min(b.width - 2, Math.max(2, (r.left + r.right) / 2));
          const lx = Math.min(b.width - 2, Math.max(2, r.left + 24));
          info.unoccluded = this.occlusionTest(el, cx, y) || this.occlusionTest(el, lx, y);
        } else info.unoccluded = false;
      }
      if (!info.unoccluded) continue;
      candidates.push({ id: info.id, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, tag: info.tag, warm: info.warm, elementRef: el });
    }
    if (withOcclusion) this.occlusionDirty = false;
    this.list = buildPlatforms(candidates, b);
  }
}
