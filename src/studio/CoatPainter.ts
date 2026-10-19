/**
 * CoatPainter — paint custom spots and patches straight onto the cat's 2D UV
 * template (the same 512×512 atlas the renderer texture-maps onto the rig).
 * A smudge on the nose or an asymmetric leg marking shows up on the live cat
 * immediately and is saved as a transparent PNG layer in the profile.
 */
import { lang } from '../shared/i18n';
import type { CatProfile } from '../shared/types';
import { dataUrlToBitmap } from '../shared/zip';
import { buildCoatTexture } from '../engine/CoatTexture';
import { ATLAS_SIZE, UV_LABELS } from '../engine/UVLayout';

export interface BrushSettings {
  color: string;
  size: number;
  opacity: number;
  erase: boolean;
}

export class CoatPainter {
  readonly view: HTMLCanvasElement;
  private readonly base: HTMLCanvasElement;
  private readonly paint: HTMLCanvasElement;
  private readonly pctx: CanvasRenderingContext2D;
  brush: BrushSettings = { color: '#2A241E', size: 10, opacity: 0.9, erase: false };
  showGuides = true;
  private drawing = false;
  private last: { x: number; y: number } | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private profileId = '';

  constructor(private readonly onChange: (dataUrl: string | null) => void) {
    this.view = document.createElement('canvas');
    this.view.width = this.view.height = ATLAS_SIZE;
    this.view.className = 'painter__canvas';
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = ATLAS_SIZE;
    this.paint = document.createElement('canvas');
    this.paint.width = this.paint.height = ATLAS_SIZE;
    this.pctx = this.paint.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.view.addEventListener('pointerdown', (e) => this.down(e));
    this.view.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', () => this.up());
  }

  async setProfile(profile: CatProfile): Promise<void> {
    const tex = buildCoatTexture({ ...profile, paintMask: null }, null);
    const bctx = this.base.getContext('2d') as CanvasRenderingContext2D;
    bctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    bctx.drawImage(tex.canvas as CanvasImageSource, 0, 0);
    if (profile.id !== this.profileId) {
      this.profileId = profile.id;
      this.pctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
      if (profile.paintMask) {
        try {
          const bmp = await dataUrlToBitmap(profile.paintMask);
          this.pctx.drawImage(bmp, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
          bmp.close();
        } catch {
          /* ignore broken mask */
        }
      }
    }
    this.composite();
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * ATLAS_SIZE, y: ((e.clientY - r.top) / r.height) * ATLAS_SIZE };
  }

  private down(e: PointerEvent): void {
    this.drawing = true;
    this.view.setPointerCapture(e.pointerId);
    this.last = this.pos(e);
    this.dab(this.last, this.last);
  }

  private move(e: PointerEvent): void {
    if (!this.drawing) return;
    const p = this.pos(e);
    if (this.last) this.dab(this.last, p);
    this.last = p;
  }

  private up(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.last = null;
    this.emit();
  }

  private dab(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const ctx = this.pctx;
    ctx.save();
    ctx.globalCompositeOperation = this.brush.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = this.brush.erase ? 1 : this.brush.opacity;
    ctx.strokeStyle = this.brush.color;
    ctx.lineWidth = this.brush.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A soft edge reads as fur rather than a vector stroke.
    ctx.filter = this.brush.erase ? 'none' : 'blur(0.8px)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + 0.01, b.y);
    ctx.stroke();
    ctx.restore();
    this.composite();
  }

  composite(): void {
    const ctx = this.view.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.paint, 0, 0);
    if (!this.showGuides) return;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(42,36,30,0.55)';
    ctx.lineWidth = 1;
    ctx.font = '600 11px system-ui, sans-serif';
    const he = lang() === 'he';
    for (const l of UV_LABELS) {
      ctx.strokeRect(l.rect.x + 0.5, l.rect.y + 0.5, l.rect.w - 1, l.rect.h - 1);
      const text = he ? l.labelHe : l.label;
      const short = l.rect.w < 100 ? text.split(' (')[0] : text;
      const tw = ctx.measureText(short).width;
      ctx.fillStyle = 'rgba(250,251,252,0.85)';
      ctx.fillRect(l.rect.x + 3, l.rect.y + 3, Math.min(l.rect.w - 6, tw + 8), 16);
      ctx.fillStyle = '#2A241E';
      ctx.fillText(short, l.rect.x + 7, l.rect.y + 15, l.rect.w - 12);
    }
    ctx.restore();
  }

  isEmpty(): boolean {
    const d = this.pctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 4) return false;
    return true;
  }

  clear(): void {
    this.pctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.composite();
    this.emit();
  }

  private emit(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.onChange(this.isEmpty() ? null : this.paint.toDataURL('image/png'));
    }, 120);
  }
}
