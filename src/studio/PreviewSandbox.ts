/**
 * PreviewSandbox — a 60 FPS live sandbox inside Cat Studio: a miniature mock
 * web page whose cards are real ledges for the full simulation (same World,
 * brain, FSM, physics and renderer as on real pages). Pet the cat, toss toys,
 * or trigger any of the states directly.
 */
import type { CatState } from '../shared/catStates';
import type { CatProfile, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/storage';
import { SoundSynthesizer } from '../engine/SoundSynthesizer';
import { StaticPlatformSource, type StaticLedge } from '../sim/StaticPlatformSource';
import { ToyTool } from '../sim/ToyTool';
import { World } from '../sim/World';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'card' | 'image' | 'video' | 'code' | 'shelf';
}

export class PreviewSandbox {
  readonly world: World;
  private readonly source: StaticPlatformSource;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sound = new SoundSynthesizer();
  private boxes: Box[] = [];
  private raf = 0;
  private last = 0;
  private running = false;
  private w = 800;
  private h = 360;
  private dpr = 1;
  private ro: ResizeObserver;
  selectedId: string | null = null;
  /** Left-click toy in hand (treat / laser / ball), or null for petting. */
  readonly tool: ToyTool;

  constructor(private readonly canvas: HTMLCanvasElement, settings: Settings = DEFAULT_SETTINGS) {
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.source = new StaticPlatformSource({ width: this.w, height: this.h }, []);
    this.world = new World({ source: this.source, sound: this.sound, settings: { ...settings, showNameTags: true } });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.tool = new ToyTool(() => this.world);
    canvas.addEventListener('pointermove', (e) => {
      const p = this.local(e);
      this.world.pointerMove(p.x, p.y, performance.now() / 1000);
      if (this.tool.holding) this.tool.move(p.x, p.y, e.timeStamp / 1000);
    });
    canvas.addEventListener('pointerdown', (e) => {
      const p = this.local(e);
      this.sound.unlock();
      if (this.tool.active) {
        if (e.button !== 0) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        this.tool.down(p.x, p.y, e.timeStamp / 1000);
        return;
      }
      if (this.world.pointerDown(p.x, p.y)) canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      const p = this.local(e);
      if (this.tool.active) {
        this.tool.up(p.x, p.y, e.timeStamp / 1000);
        return;
      }
      this.world.pointerUp(p.x, p.y);
    });
    canvas.addEventListener('lostpointercapture', () => this.tool.cancel());
    canvas.addEventListener('pointerleave', () => this.world.pointerLeave());
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private resize(): void {
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.w = Math.max(320, this.canvas.clientWidth);
    this.h = Math.max(240, this.canvas.clientHeight);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.layoutPage();
  }

  /** Lays out the mock page; every card top becomes a ledge. */
  private layoutPage(): void {
    const W = this.w;
    const H = this.h;
    this.boxes = [
      { x: W * 0.05, y: H * 0.36, w: W * 0.36, h: H * 0.36, kind: 'image' },
      { x: W * 0.53, y: H * 0.24, w: W * 0.32, h: H * 0.28, kind: 'video' },
      { x: W * 0.12, y: H * 0.78, w: W * 0.3, h: H * 0.14, kind: 'code' },
      { x: W * 0.6, y: H * 0.66, w: Math.max(130, W * 0.16), h: H * 0.06, kind: 'shelf' },
    ];
    const ledges: StaticLedge[] = this.boxes.map((b, i) => ({
      id: `mock${i}`,
      xMin: b.x,
      xMax: b.x + b.w,
      y: b.y,
      warm: b.kind === 'video' ? 1 : b.kind === 'image' ? 0.55 : 0.2,
      narrow: b.kind === 'shelf',
      tag: b.kind,
    }));
    this.source.resize({ width: W, height: H });
    this.source.setLedges(ledges);
  }

  setSettings(settings: Settings): void {
    this.world.setSettings({ ...settings, showNameTags: true, catScale: Math.min(1.1, settings.catScale) });
  }

  setProfiles(all: CatProfile[], selectedId: string, both: boolean): void {
    this.selectedId = selectedId;
    const sel = all.find((p) => p.id === selectedId);
    let shown: CatProfile[] = [];
    if (both) shown = all.filter((p) => p.enabled || p.id === selectedId).slice(0, 6);
    else if (sel) shown = [sel];
    this.world.setProfiles(shown.map((p) => ({ ...p, enabled: true })));
  }

  get selected() {
    return this.world.agents.find((a) => a.id === this.selectedId) ?? this.world.agents[0] ?? null;
  }

  trigger(state: CatState): void {
    const a = this.selected;
    if (a) this.world.triggerState(a, state);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private readonly loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.world.update(dt);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawPage(ctx);
    this.world.render(ctx);
  };

  private drawPage(ctx: CanvasRenderingContext2D): void {
    const W = this.w;
    const H = this.h;
    ctx.fillStyle = '#F3F5F7';
    ctx.fillRect(0, 0, W, H);
    // header bar
    ctx.fillStyle = '#2E3A44';
    ctx.fillRect(0, 0, W, Math.max(28, H * 0.09));
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.roundRect(16, Math.max(28, H * 0.09) / 2 - 5, 70, 10, 5);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.roundRect(W - 60 - i * 54, Math.max(28, H * 0.09) / 2 - 4, 40, 8, 4);
      ctx.fill();
    }
    // text lines in the background
    ctx.fillStyle = '#E2E7EB';
    for (let y = H * 0.16; y < H * 0.95; y += 15) {
      for (const [x0, x1] of [
        [0.47, 0.5],
        [0.88, 0.97],
      ]) {
        ctx.fillRect(W * x0, y, W * (x1 - x0), 5);
      }
    }
    for (const b of this.boxes) {
      ctx.save();
      ctx.shadowColor = 'rgba(42,36,30,0.12)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, b.kind === 'shelf' ? 4 : 10);
      if (b.kind === 'video') ctx.fillStyle = '#1D2329';
      else if (b.kind === 'code') ctx.fillStyle = '#272C34';
      else if (b.kind === 'shelf') ctx.fillStyle = '#C8B49A';
      else ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.restore();
      if (b.kind === 'image') {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(b.x + 10, b.y + 10, b.w - 20, b.h * 0.62, 7);
        ctx.clip();
        const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h * 0.7);
        g.addColorStop(0, '#BFD6E6');
        g.addColorStop(1, '#A7C4A0');
        ctx.fillStyle = g;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = '#F3E19A';
        ctx.beginPath();
        ctx.arc(b.x + b.w * 0.75, b.y + b.h * 0.22, b.h * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#E2E7EB';
        ctx.fillRect(b.x + 12, b.y + b.h * 0.76, b.w * 0.7, 6);
        ctx.fillRect(b.x + 12, b.y + b.h * 0.86, b.w * 0.5, 6);
      } else if (b.kind === 'video') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        ctx.moveTo(cx - 9, cy - 12);
        ctx.lineTo(cx + 13, cy);
        ctx.lineTo(cx - 9, cy + 12);
        ctx.closePath();
        ctx.fill();
      } else if (b.kind === 'code') {
        const cols = ['#8FB8DE', '#E5C07B', '#98C379', '#C678DD'];
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = cols[i % cols.length];
          ctx.fillRect(b.x + 12 + i * 8, b.y + 12 + i * 12, b.w * (0.45 - i * 0.08), 5);
        }
      }
    }
    // floor
    ctx.fillStyle = '#E3E9ED';
    ctx.fillRect(0, H - 3, W, 3);
  }

  dispose(): void {
    this.stop();
    this.ro.disconnect();
    this.world.dispose();
    this.sound.dispose();
  }
}
