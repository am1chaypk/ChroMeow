/**
 * PlayMode — hand-held toys on a real page.
 *
 * While a toy is picked (from the popup or the floating toolbar), a transparent
 * layer inside ChroMeow's shadow root takes the left mouse button so clicks play
 * with the cats instead of following links: click to drop treats, hold to shine
 * the laser, press-drag-release to throw the ball. The mouse wheel still
 * scrolls the page. Esc, a right-click or "Done" puts the toy away and the page
 * behaves normally again.
 */
import { lang, t } from '../shared/i18n';
import { TOOL_KINDS, ToyTool, type ToolKind } from '../sim/ToyTool';

/** The feather wand: a slim rod, a string and a bright feather. */
export const WAND_ICON =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M27 3L13 14" stroke="#5A4636" stroke-width="2.2" stroke-linecap="round"/><path d="M13 14c-2 4 1 7-1 10" stroke="#CDBF9F" stroke-width="1.2" fill="none"/><circle cx="12" cy="24" r="1.8" fill="#E2B13C"/><path d="M12 24c-5 1-7 4-8 6 3-1 6-2 8-6z" fill="#F2557A"/><path d="M12 24c-2 3-2 5-1 7 2-2 2-4 1-7z" fill="#3BA7D9"/></svg>';
import type { World } from '../sim/World';

const STYLE = `
.play-layer {
  position: fixed; inset: 0; z-index: 2147483646;
  pointer-events: auto; background: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.play-layer[data-tool="treat"] { cursor: copy; }
.play-layer[data-tool="laser"] { cursor: crosshair; }
.play-layer[data-tool="ball"] { cursor: grab; }
.play-layer[data-tool="ball"].is-down { cursor: grabbing; }
.play-layer[data-tool="feather_wand"] { cursor: none; }
.play-hud {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; pointer-events: auto;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 6px 6px 8px; border-radius: 14px;
  background: rgba(250, 251, 252, 0.96); color: #2a241e;
  box-shadow: 0 6px 24px rgba(30, 24, 18, 0.18), 0 0 0 1px rgba(42, 36, 30, 0.08);
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif;
  max-width: calc(100vw - 24px);
}
.play-hud__tools { display: flex; gap: 2px; }
.play-hud button {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 10px; border-radius: 10px;
  font: inherit; color: inherit; white-space: nowrap;
}
.play-hud button:hover { background: #eef2f5; }
.play-hud button:focus-visible { outline: 2px solid #3f6fa8; outline-offset: 1px; }
.play-hud button[aria-pressed="true"] { background: #2a241e; color: #fffaf2; }
.play-hud svg { width: 18px; height: 18px; flex: none; }
.play-hud__hint { color: #6e6255; padding: 0 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.play-hud__hint small { display: block; font-size: 11px; opacity: 0.85; }
.play-hud__done { background: #e3e9ed; font-weight: 600; }
@media (max-width: 620px) { .play-hud__hint { display: none; } }
`;

const ICONS: Record<ToolKind, string> = {
  treat: '<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="14" cy="17" rx="9" ry="6" fill="#C9803E"/><path d="M21 17l7-5v10z" fill="#C9803E"/><circle cx="10.5" cy="15.5" r="1.3" fill="#5B3A1E"/></svg>',
  laser: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="10" fill="#FF3B3B" opacity=".18"/><circle cx="16" cy="16" r="5" fill="#FF3B3B" opacity=".45"/><circle cx="16" cy="16" r="2.2" fill="#FFF2F2"/></svg>',
  ball: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="17" r="9" fill="#D9435E"/><path d="M10 13c4 3 8 3 12 0M10 21c4-3 8-3 12 0" stroke="#FFE08A" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  feather_wand: WAND_ICON,
};

const LABEL: Record<ToolKind, string> = { treat: 'toolTreat', laser: 'toolLaser', ball: 'toolBall', feather_wand: 'toolWand' };
const HINT: Record<ToolKind, string> = { treat: 'playTreat', laser: 'playLaser', ball: 'playBall', feather_wand: 'playWand' };

export class PlayMode {
  private readonly tool: ToyTool;
  private layer: HTMLDivElement | null = null;
  private hud: HTMLDivElement | null = null;
  private hint: HTMLElement | null = null;
  private buttons = new Map<ToolKind, HTMLButtonElement>();
  private styled = false;

  constructor(
    private readonly root: ShadowRoot,
    private readonly world: () => World | null,
    private readonly onChange: (tool: ToolKind | null) => void = () => undefined,
  ) {
    this.tool = new ToyTool(world);
  }

  get current(): ToolKind | null {
    return this.tool.kind;
  }

  get active(): boolean {
    return this.tool.active;
  }

  set(kind: ToolKind | null): void {
    this.tool.select(kind);
    if (kind) this.mount();
    else this.unmount();
    // The wand appears in hand right where the pointer is.
    const w = this.world();
    if (kind === 'feather_wand' && w && w.cursor.x > -1000) this.tool.hover(w.cursor.x, w.cursor.y);
    this.render();
    this.onChange(kind);
  }

  private mount(): void {
    if (!this.styled) {
      const style = document.createElement('style');
      style.textContent = STYLE;
      this.root.append(style);
      this.styled = true;
    }
    if (this.layer) return;
    const layer = document.createElement('div');
    layer.className = 'play-layer';
    layer.addEventListener('pointerdown', this.onDown);
    layer.addEventListener('pointermove', this.onMove);
    layer.addEventListener('pointerup', this.onUp);
    layer.addEventListener('pointercancel', this.onCancel);
    layer.addEventListener('lostpointercapture', this.onCancel);
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick']) layer.addEventListener(type, swallow);
    layer.addEventListener('contextmenu', this.onContext);
    this.layer = layer;

    const hud = document.createElement('div');
    hud.className = 'play-hud';
    hud.setAttribute('role', 'toolbar');
    const tools = document.createElement('div');
    tools.className = 'play-hud__tools';
    for (const kind of TOOL_KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${ICONS[kind]}<span></span>`;
      b.addEventListener('click', () => this.set(kind));
      this.buttons.set(kind, b);
      tools.append(b);
    }
    const hint = document.createElement('div');
    hint.className = 'play-hud__hint';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'play-hud__done';
    done.addEventListener('click', () => this.set(null));
    hud.append(tools, hint, done);
    for (const type of ['pointerdown', 'click', 'mousedown']) hud.addEventListener(type, (e) => e.stopPropagation());
    this.hud = hud;
    this.hint = hint;
    this.root.append(layer, hud);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('blur', this.onCancel);
  }

  private unmount(): void {
    this.tool.cancel();
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('blur', this.onCancel);
    this.layer?.remove();
    this.hud?.remove();
    this.layer = null;
    this.hud = null;
    this.hint = null;
    this.buttons.clear();
  }

  /** Re-renders labels (also after a language change). */
  render(): void {
    const kind = this.tool.kind;
    if (!this.hud || !kind) return;
    this.hud.dir = lang() === 'he' ? 'rtl' : 'ltr';
    for (const [k, b] of this.buttons) {
      (b.querySelector('span') as HTMLElement).textContent = t(LABEL[k]);
      b.setAttribute('aria-pressed', String(k === kind));
    }
    if (this.layer) this.layer.dataset.tool = kind;
    if (this.hint) {
      this.hint.textContent = t(HINT[kind]);
      const small = document.createElement('small');
      small.textContent = t('playEsc');
      this.hint.append(small);
    }
    const done = this.hud.querySelector('.play-hud__done') as HTMLElement;
    done.textContent = t('playDone');
  }

  destroy(): void {
    this.tool.select(null);
    this.unmount();
  }

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      this.layer?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.layer?.classList.add('is-down');
    this.tool.down(e.clientX, e.clientY, e.timeStamp / 1000);
  };

  private readonly onMove = (e: PointerEvent) => {
    // The feather wand follows the pointer the whole time, button or not.
    this.tool.hover(e.clientX, e.clientY);
    if (!this.tool.holding) return;
    // Coalesced events give the throw velocity full precision on fast flicks.
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (events.length) for (const c of events) this.tool.move(c.clientX, c.clientY, c.timeStamp / 1000);
    else this.tool.move(e.clientX, e.clientY, e.timeStamp / 1000);
  };

  private readonly onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.layer?.classList.remove('is-down');
    this.tool.up(e.clientX, e.clientY, e.timeStamp / 1000);
  };

  private readonly onCancel = () => {
    this.layer?.classList.remove('is-down');
    this.tool.cancel();
  };

  private readonly onContext = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    this.set(null);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.set(null);
    }
  };
}

function swallow(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}
