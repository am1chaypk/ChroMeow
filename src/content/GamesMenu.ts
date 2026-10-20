/**
 * GamesMenu — the mini-games / play panel that opens when you right-click a cat
 * (v3). It replaces the browser's context menu on the cats only; everywhere
 * else the page's own right-click works as usual.
 *
 * The panel lists the games: drop treats, shine the laser, throw the ball (each
 * puts that toy in your hand — PlayMode), let the toy mouse loose, call the
 * cats, and clear every toy off the page. Esc, a click outside or picking an
 * item closes it. Lives in ChroMeow's shadow root, so page CSS can't touch it.
 */
import { clamp } from '../shared/math';
import { lang, t, tf } from '../shared/i18n';
import { WAND_ICON } from './PlayMode';

export type GameAction = 'treat' | 'laser' | 'ball' | 'feather_wand' | 'mouse' | 'call' | 'clear';

export interface GameItem {
  action: GameAction;
  /** i18n key of the label. */
  label: string;
  /** i18n key of the one-line description. */
  hint: string;
  icon: string;
}

const ICON = {
  treat: '<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="14" cy="17" rx="9" ry="6" fill="#C9803E"/><path d="M21 17l7-5v10z" fill="#C9803E"/><circle cx="10.5" cy="15.5" r="1.3" fill="#5B3A1E"/></svg>',
  laser: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="10" fill="#FF3B3B" opacity=".18"/><circle cx="16" cy="16" r="5" fill="#FF3B3B" opacity=".45"/><circle cx="16" cy="16" r="2.2" fill="#FFF2F2"/></svg>',
  ball: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="17" r="9" fill="#D9435E"/><path d="M10 13c4 3 8 3 12 0M10 21c4-3 8-3 12 0" stroke="#FFE08A" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  mouse: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 18c-4 0-7 2-9 1" stroke="#C79A9A" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M27 18c-1-6-11-7-14-2-1 2 0 3 2 3h10c1.4 0 2.2-.4 2-1z" fill="#8F8B88"/><circle cx="19.5" cy="12.5" r="3" fill="#8E8A87"/><circle cx="19.6" cy="12.5" r="1.8" fill="#F1B6B9"/><circle cx="23" cy="15.2" r=".9" fill="#1E1A18"/><circle cx="27" cy="17.6" r="1" fill="#E58B98"/></svg>',
  call: '<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="21" rx="6.5" ry="5.2" fill="#E58B88"/><circle cx="9" cy="13.5" r="2.6" fill="#E58B88"/><circle cx="13.5" cy="9.5" r="2.6" fill="#E58B88"/><circle cx="18.5" cy="9.5" r="2.6" fill="#E58B88"/><circle cx="23" cy="13.5" r="2.6" fill="#E58B88"/></svg>',
  clear: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 25l12-12 3 3-12 12H9z" fill="#B9A288"/><path d="M21 13l3-6 3 3-6 3z" fill="#7A6A58"/><path d="M6 27h20" stroke="#7A6A58" stroke-width="1.6" stroke-linecap="round"/><circle cx="24" cy="23" r="1.4" fill="#C9803E"/><circle cx="20" cy="26" r="1.1" fill="#D9435E"/></svg>',
};

/** The games, in menu order. */
export const GAME_ITEMS: readonly GameItem[] = [
  { action: 'treat', label: 'toolTreat', hint: 'playTreat', icon: ICON.treat },
  { action: 'laser', label: 'toolLaser', hint: 'playLaser', icon: ICON.laser },
  { action: 'ball', label: 'toolBall', hint: 'playBallDirect', icon: ICON.ball },
  { action: 'feather_wand', label: 'toolWand', hint: 'playWand', icon: WAND_ICON },
  { action: 'mouse', label: 'toolMouse', hint: 'playMouse', icon: ICON.mouse },
  { action: 'call', label: 'call', hint: 'callHint', icon: ICON.call },
  { action: 'clear', label: 'clearAll', hint: 'clearHint', icon: ICON.clear },
];

export const MENU_WIDTH = 300;
export const MENU_ITEM_H = 46;
const MENU_HEAD_H = 40;

/** Height of the open menu (px). */
export function menuHeight(items = GAME_ITEMS.length): number {
  return MENU_HEAD_H + items * MENU_ITEM_H + 12;
}

/**
 * Where the menu opens for a right-click at (x, y): just below-right of the
 * pointer (below-left in right-to-left layouts), flipped and clamped so it is
 * always fully on screen with an 8 px margin.
 */
export function menuPosition(x: number, y: number, w: number, h: number, vw: number, vh: number, rtl = false): { left: number; top: number } {
  const m = 8;
  let left = rtl ? x - w - 4 : x + 4;
  if (left + w > vw - m) left = x - w - 4;
  if (left < m) left = x + 4;
  let top = y + 4;
  if (top + h > vh - m) top = y - h - 4;
  return { left: clamp(left, m, Math.max(m, vw - w - m)), top: clamp(top, m, Math.max(m, vh - h - m)) };
}

const STYLE = `
.games-backdrop { position: fixed; inset: 0; z-index: 2147483646; background: transparent; pointer-events: auto; }
.games {
  position: fixed; z-index: 2147483647; width: ${MENU_WIDTH}px; box-sizing: border-box;
  padding: 6px; border-radius: 14px; pointer-events: auto;
  background: rgba(250, 251, 252, 0.98); color: #2a241e;
  box-shadow: 0 10px 32px rgba(30, 24, 18, 0.22), 0 0 0 1px rgba(42, 36, 30, 0.08);
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif;
  animation: games-in 120ms ease-out;
}
@keyframes games-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .games { animation: none; } }
.games__head { display: flex; align-items: center; gap: 8px; height: ${MENU_HEAD_H - 6}px; padding: 0 8px 4px; font-weight: 650; }
.games__head span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.games__head small { font-weight: 500; color: #6e6255; }
.games button {
  all: unset; box-sizing: border-box; cursor: pointer; width: 100%;
  display: flex; align-items: center; gap: 10px; min-height: ${MENU_ITEM_H}px; padding: 5px 10px; border-radius: 10px;
}
.games button:hover, .games button:focus-visible { background: #eef2f5; }
.games button:focus-visible { outline: 2px solid #3f6fa8; outline-offset: -2px; }
.games svg { width: 26px; height: 26px; flex: none; }
.games__txt { display: flex; flex-direction: column; min-width: 0; }
.games__txt b { font-weight: 600; }
.games__txt small { color: #6e6255; font-size: 11.5px; line-height: 1.25; }
.games button[data-action="clear"] { margin-top: 2px; border-top: 1px solid rgba(42, 36, 30, 0.08); border-radius: 0 0 10px 10px; }
`;

export class GamesMenu {
  private el: HTMLDivElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private styled = false;

  constructor(
    private readonly root: ShadowRoot,
    private readonly onPick: (action: GameAction) => void,
  ) {}

  get open(): boolean {
    return !!this.el;
  }

  /** Opens the panel at a right-click on the cat called `name`. */
  show(x: number, y: number, name: string): void {
    this.close();
    if (!this.styled) {
      const style = document.createElement('style');
      style.textContent = STYLE;
      this.root.append(style);
      this.styled = true;
    }
    const rtl = lang() === 'he';
    const backdrop = document.createElement('div');
    backdrop.className = 'games-backdrop';
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    };
    backdrop.addEventListener('pointerdown', swallow);
    backdrop.addEventListener('contextmenu', swallow);
    backdrop.addEventListener('wheel', () => this.close(), { passive: true });

    const el = document.createElement('div');
    el.className = 'games';
    el.dir = rtl ? 'rtl' : 'ltr';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', tf('gamesTitle', { name }));
    const head = document.createElement('div');
    head.className = 'games__head';
    const title = document.createElement('span');
    title.textContent = tf('gamesTitle', { name });
    const small = document.createElement('small');
    small.textContent = t('gamesEsc');
    head.append(title, small);
    el.append(head);
    for (const item of GAME_ITEMS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.action = item.action;
      b.innerHTML = `${item.icon}<span class="games__txt"><b></b><small></small></span>`;
      (b.querySelector('b') as HTMLElement).textContent = t(item.label);
      (b.querySelector('small') as HTMLElement).textContent = t(item.hint);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.onPick(item.action);
      });
      el.append(b);
    }
    for (const type of ['pointerdown', 'mousedown', 'contextmenu']) el.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'contextmenu') e.preventDefault();
    });
    el.addEventListener('keydown', this.onKeyNav);
    el.style.left = '-9999px';
    el.style.top = '0px';
    this.root.append(backdrop, el);
    // Place it once its real height is known (hints may wrap, e.g. in Hebrew).
    const h = el.getBoundingClientRect().height || menuHeight();
    const pos = menuPosition(x, y, MENU_WIDTH, h, window.innerWidth, window.innerHeight, rtl);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    this.el = el;
    this.backdrop = backdrop;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
    (el.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    this.el?.remove();
    this.backdrop?.remove();
    this.el = null;
    this.backdrop = null;
  }

  private readonly onBlur = () => this.close();

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  /** Arrow keys / Home / End move between the items. */
  private readonly onKeyNav = (e: KeyboardEvent) => {
    const items = [...(this.el?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(this.root.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[next].focus();
    }
  };
}
