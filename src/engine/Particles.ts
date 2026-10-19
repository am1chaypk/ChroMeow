/** Lightweight particle effects: purr hearts, sleepy z's, boop sparkles, landing dust, "!" startles. */
import type { AnyCtx } from './canvas';

export type ParticleKind = 'heart' | 'z' | 'spark' | 'puff' | 'bang' | 'note';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  rot: number;
  vr: number;
}

const MAX_PARTICLES = 160;

export class ParticleSystem {
  private items: Particle[] = [];

  get count(): number {
    return this.items.length;
  }

  emit(kind: ParticleKind, x: number, y: number, n = 1, scale = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.items.length >= MAX_PARTICLES) this.items.shift();
      const base: Particle = { kind, x, y, vx: 0, vy: 0, life: 0, max: 1, size: 6 * scale, rot: 0, vr: 0 };
      switch (kind) {
        case 'heart':
          base.vx = (Math.random() - 0.5) * 24 * scale;
          base.vy = -(28 + Math.random() * 18) * scale;
          base.max = 1.6 + Math.random() * 0.5;
          base.size = (5 + Math.random() * 3) * scale;
          break;
        case 'z':
          base.vx = (8 + Math.random() * 6) * scale;
          base.vy = -(14 + Math.random() * 6) * scale;
          base.max = 2.6;
          base.size = (6 + Math.random() * 4) * scale;
          break;
        case 'spark':
          base.vx = (Math.random() - 0.5) * 70 * scale;
          base.vy = -(20 + Math.random() * 50) * scale;
          base.max = 0.7;
          base.size = (2.5 + Math.random() * 2) * scale;
          base.vr = (Math.random() - 0.5) * 8;
          break;
        case 'puff':
          base.vx = (Math.random() - 0.5) * 60 * scale;
          base.vy = -(4 + Math.random() * 14) * scale;
          base.max = 0.55;
          base.size = (3 + Math.random() * 4) * scale;
          break;
        case 'bang':
          base.vy = -22 * scale;
          base.max = 0.9;
          base.size = 11 * scale;
          break;
        case 'note':
          base.vx = (Math.random() - 0.5) * 16 * scale;
          base.vy = -22 * scale;
          base.max = 1.4;
          base.size = 7 * scale;
          break;
      }
      this.items.push(base);
    }
  }

  update(dt: number): void {
    const out: Particle[] = [];
    for (const p of this.items) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === 'puff') {
        p.vx *= Math.exp(-4 * dt);
        p.vy *= Math.exp(-3 * dt);
      }
      if (p.kind === 'heart' || p.kind === 'z' || p.kind === 'note') p.vx += Math.sin(p.life * 4 + p.y * 0.05) * 6 * dt;
      out.push(p);
    }
    this.items = out;
  }

  /** Returns the bounding box of everything drawn (for dirty-rect clearing). */
  draw(ctx: AnyCtx): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.items.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ctx.save();
    for (const p of this.items) {
      const f = p.life / p.max;
      const alpha = f < 0.15 ? f / 0.15 : 1 - (f - 0.15) / 0.85;
      ctx.globalAlpha = Math.max(0, alpha);
      const s = p.size * (p.kind === 'puff' ? 1 + f * 1.4 : 1);
      switch (p.kind) {
        case 'heart': {
          ctx.fillStyle = '#F06A8A';
          ctx.beginPath();
          const x = p.x;
          const y = p.y;
          ctx.moveTo(x, y + s * 0.35);
          ctx.bezierCurveTo(x - s, y - s * 0.4, x - s * 0.45, y - s, x, y - s * 0.45);
          ctx.bezierCurveTo(x + s * 0.45, y - s, x + s, y - s * 0.4, x, y + s * 0.35);
          ctx.fill();
          break;
        }
        case 'z': {
          ctx.fillStyle = 'rgba(110,120,150,0.9)';
          ctx.font = `600 ${Math.round(s * 1.6)}px ui-rounded, system-ui, sans-serif`;
          ctx.fillText('z', p.x, p.y);
          break;
        }
        case 'note': {
          ctx.fillStyle = 'rgba(120,100,160,0.9)';
          ctx.font = `600 ${Math.round(s * 1.6)}px system-ui, sans-serif`;
          ctx.fillText('♪', p.x, p.y);
          break;
        }
        case 'spark': {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = '#FFD45E';
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
            ctx.lineTo(Math.cos(a + Math.PI / 4) * s * 0.35, Math.sin(a + Math.PI / 4) * s * 0.35);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'puff': {
          ctx.fillStyle = 'rgba(200,190,175,0.55)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'bang': {
          ctx.fillStyle = '#E8553B';
          ctx.font = `800 ${Math.round(s * 1.7)}px system-ui, sans-serif`;
          ctx.fillText('!', p.x, p.y);
          break;
        }
      }
      minX = Math.min(minX, p.x - s * 2);
      minY = Math.min(minY, p.y - s * 2.5);
      maxX = Math.max(maxX, p.x + s * 2);
      maxY = Math.max(maxY, p.y + s * 1.5);
    }
    ctx.restore();
    return { minX, minY, maxX, maxY };
  }
}
