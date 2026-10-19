/**
 * InputInterceptor — passive, non-blocking observation of the user.
 *
 *  • Pointer position / buttons via passive capture-phase window listeners
 *    (never preventDefault, never interferes with the page).
 *  • Typing: when the user types into an <input>, <textarea> or contenteditable,
 *    reports the element and an estimated caret position so a curious cat can
 *    come and watch the caret move (KEYBOARD_WATCH).
 *
 *  • Activity: any pointer, key, wheel or scroll input marks the user as
 *    present (for the idle cuddle); window blur / pointercancel end a drag.
 *
 * No keystroke content is stored or sent anywhere — only "typing happened here".
 */
import type { Vec2 } from '../shared/math';

export interface InputCallbacks {
  move(x: number, y: number, t: number): void;
  down(x: number, y: number, e: PointerEvent): void;
  up(x: number, y: number): void;
  leave(): void;
  typing(el: HTMLElement, caret: Vec2): void;
  /** Pointer cancelled or the window lost focus (drop anything being dragged). */
  cancel?(): void;
  /** The user did something (moved, clicked, typed, scrolled). */
  activity?(): void;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

function isEditable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return el.isContentEditable;
}

let measureCanvas: HTMLCanvasElement | null = null;

function textWidth(text: string, font: string): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Best-effort caret position in viewport coordinates. */
export function caretPosition(el: HTMLElement): Vec2 {
  const rect = el.getBoundingClientRect();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const cs = getComputedStyle(el);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const pos = el.selectionStart ?? el.value.length;
    const before = el.type === 'password' ? '•'.repeat(pos) : el.value.slice(0, pos);
    const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const padT = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const rtl = cs.direction === 'rtl';
    if (el instanceof HTMLTextAreaElement) {
      const lines = before.split('\n');
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      const lastLine = lines[lines.length - 1];
      const w = Math.min(rect.width - padL * 2, textWidth(lastLine, font));
      const x = rtl ? rect.right - padL - w : rect.left + padL + w;
      const y = rect.top + padT + (lines.length - 0.5) * lineH - el.scrollTop;
      return { x, y: Math.min(rect.bottom - 4, Math.max(rect.top + 4, y)) };
    }
    const w = textWidth(before, font) - el.scrollLeft;
    const x = rtl ? rect.right - padL - w : rect.left + padL + w;
    return { x: Math.min(rect.right - 4, Math.max(rect.left + 4, x)), y: rect.top + rect.height / 2 };
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return { x: r.right, y: r.top + r.height / 2 };
  }
  return { x: rect.left + 16, y: rect.top + Math.min(20, rect.height / 2) };
}

export class InputInterceptor {
  private readonly opts: AddEventListenerOptions = { passive: true, capture: true };
  private readonly onMove = (e: PointerEvent) => {
    this.cb.activity?.();
    if (e.pointerType === 'touch' && e.buttons === 0) return;
    this.cb.move(e.clientX, e.clientY, performance.now() / 1000);
  };
  private readonly onDown = (e: PointerEvent) => {
    this.cb.activity?.();
    this.cb.down(e.clientX, e.clientY, e);
  };
  private readonly onUp = (e: PointerEvent) => this.cb.up(e.clientX, e.clientY);
  private readonly onCancel = () => this.cb.cancel?.();
  private readonly onActivity = () => this.cb.activity?.();
  private readonly onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) this.cb.leave();
  };
  private readonly onInput = (e: Event) => {
    const el = e.target;
    if (isEditable(el)) this.cb.typing(el, caretPosition(el));
  };
  private readonly onKey = (e: KeyboardEvent) => {
    this.cb.activity?.();
    const el = (e.composedPath()[0] as EventTarget | undefined) ?? document.activeElement;
    if (isEditable(el ?? null) && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) {
      requestAnimationFrame(() => this.cb.typing(el as HTMLElement, caretPosition(el as HTMLElement)));
    }
  };

  constructor(private readonly cb: InputCallbacks) {}

  start(): void {
    window.addEventListener('pointermove', this.onMove, this.opts);
    window.addEventListener('pointerdown', this.onDown, this.opts);
    window.addEventListener('pointerup', this.onUp, this.opts);
    window.addEventListener('pointerout', this.onOut, this.opts);
    window.addEventListener('input', this.onInput, this.opts);
    window.addEventListener('keydown', this.onKey, this.opts);
    window.addEventListener('pointercancel', this.onCancel, this.opts);
    window.addEventListener('blur', this.onCancel);
    window.addEventListener('wheel', this.onActivity, this.opts);
    window.addEventListener('scroll', this.onActivity, this.opts);
  }

  stop(): void {
    window.removeEventListener('pointermove', this.onMove, this.opts);
    window.removeEventListener('pointerdown', this.onDown, this.opts);
    window.removeEventListener('pointerup', this.onUp, this.opts);
    window.removeEventListener('pointerout', this.onOut, this.opts);
    window.removeEventListener('input', this.onInput, this.opts);
    window.removeEventListener('keydown', this.onKey, this.opts);
    window.removeEventListener('pointercancel', this.onCancel, this.opts);
    window.removeEventListener('blur', this.onCancel);
    window.removeEventListener('wheel', this.onActivity, this.opts);
    window.removeEventListener('scroll', this.onActivity, this.opts);
  }
}
