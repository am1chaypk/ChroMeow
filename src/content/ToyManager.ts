/**
 * ToyManager — treats, a bouncy toy ball and a laser dot. Toys live in the same
 * physical world as the cats (they land on DOM ledges, bounce off the viewport
 * edges) and cats chase, bat, pounce on and eat them. DOM-free, so the Cat
 * Studio preview sandbox reuses it.
 */
import { clamp, lerp } from '../shared/math';
import { Rng } from '../shared/rng';
import type { ToyKind } from '../shared/types';
import type { AnyCtx } from '../engine/canvas';
import { GRAVITY, findLanding, type Platform, type WorldBounds } from '../engine/Physics';

export interface Toy {
  id: number;
  kind: ToyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ground: string | null;
  age: number;
  life: number;
  /** Treat: 0..1 eaten. */
  eaten: number;
  claimedBy: string | null;
  /** Laser path target. */
  tx: number;
  ty: number;
  retarget: number;
  spin: number;
  idle: number;
}

const BALL_R = 8;

export class ToyManager {
  toys: Toy[] = [];
  private nextId = 1;
  private rng = new Rng(7);

  get count(): number {
    return this.toys.length;
  }

  private make(kind: ToyKind, x: number, y: number): Toy {
    const t: Toy = { id: this.nextId++, kind, x, y, vx: 0, vy: 0, ground: null, age: 0, life: kind === 'treat' ? 90 : kind === 'ball' ? 60 : 16, eaten: 0, claimedBy: null, tx: x, ty: y, retarget: 0, spin: 0, idle: 0 };
    this.toys.push(t);
    return t;
  }

  spawnTreat(bounds: WorldBounds, x?: number): Toy {
    const px = x ?? bounds.width * (0.3 + this.rng.next() * 0.4);
    const t = this.make('treat', px, -12);
    t.vx = this.rng.range(-20, 20);
    return t;
  }

  spawnBall(bounds: WorldBounds): Toy {
    const fromLeft = this.rng.chance(0.5);
    const t = this.make('ball', fromLeft ? 20 : bounds.width - 20, bounds.height * 0.35);
    t.vx = (fromLeft ? 1 : -1) * this.rng.range(260, 420);
    t.vy = -this.rng.range(150, 320);
    return t;
  }

  spawnLaser(bounds: WorldBounds): Toy {
    // One laser at a time.
    this.toys = this.toys.filter((t) => t.kind !== 'laser');
    const t = this.make('laser', bounds.width * 0.5, bounds.height - 6);
    t.tx = t.x;
    t.ty = t.y;
    return t;
  }

  remove(toy: Toy): void {
    this.toys = this.toys.filter((t) => t !== toy);
  }

  nearest(x: number, y: number, kinds: readonly ToyKind[] = ['treat', 'ball', 'laser']): Toy | null {
    let best: Toy | null = null;
    let bd = Infinity;
    for (const t of this.toys) {
      if (!kinds.includes(t.kind)) continue;
      if (t.kind === 'treat' && t.eaten >= 1) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  /** A cat bats the ball / lands on the laser. */
  swat(toy: Toy, dirX: number, power = 1): void {
    if (toy.kind === 'ball') {
      toy.vx = dirX * lerp(220, 480, Math.random()) * power;
      toy.vy = -lerp(160, 360, Math.random()) * power;
      toy.ground = null;
      toy.idle = 0;
    } else if (toy.kind === 'laser') {
      toy.retarget = 0;
      toy.tx = clamp(toy.x + dirX * lerp(160, 360, Math.random()), 10, 4000);
    }
  }

  /** Eats `dt` worth of a treat; returns true when it is finished. */
  nibble(toy: Toy, dt: number): boolean {
    toy.eaten = Math.min(1, toy.eaten + dt / 2.6);
    if (toy.eaten >= 1) {
      this.remove(toy);
      return true;
    }
    return false;
  }

  update(dt: number, platforms: readonly Platform[], bounds: WorldBounds): void {
    const keep: Toy[] = [];
    for (const t of this.toys) {
      t.age += dt;
      if (t.age > t.life) continue;
      if (t.kind === 'laser') this.updateLaser(t, dt, platforms, bounds);
      else this.updateBody(t, dt, platforms, bounds);
      keep.push(t);
    }
    this.toys = keep;
  }

  private updateBody(t: Toy, dt: number, platforms: readonly Platform[], bounds: WorldBounds): void {
    if (t.ground) {
      const p = platforms.find((pl) => pl.id === t.ground);
      if (!p || t.x < p.xMin - 2 || t.x > p.xMax + 2) {
        t.ground = null;
      } else {
        t.y = p.y - (t.kind === 'ball' ? BALL_R : 3);
        if (t.kind === 'ball') {
          t.x += t.vx * dt;
          t.vx *= Math.exp(-0.9 * dt);
          t.spin += (t.vx * dt) / BALL_R;
          if (Math.abs(t.vx) < 4) {
            t.vx = 0;
            t.idle += dt;
          }
        }
      }
    }
    if (!t.ground) {
      const prevY = t.y;
      t.vy = Math.min(t.vy + GRAVITY * dt, 1400);
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.spin += (t.vx * dt) / BALL_R;
      const foot = t.kind === 'ball' ? BALL_R : 3;
      const land = findLanding(prevY + foot, t.y + foot, t.x, platforms);
      if (land && t.vy > 0) {
        if (t.kind === 'ball' && t.vy > 140) {
          t.y = land.y - foot;
          t.vy = -t.vy * 0.55;
          t.vx *= 0.85;
        } else {
          t.y = land.y - foot;
          t.vy = 0;
          t.ground = land.id;
        }
      }
    }
    // viewport walls
    const r = t.kind === 'ball' ? BALL_R : 4;
    if (t.x < r) {
      t.x = r;
      t.vx = Math.abs(t.vx) * 0.7;
    } else if (t.x > bounds.width - r) {
      t.x = bounds.width - r;
      t.vx = -Math.abs(t.vx) * 0.7;
    }
    if (t.y > bounds.height + 40) {
      t.y = bounds.height - r;
      t.vy = 0;
    }
    if (t.kind === 'ball' && t.idle > 20) t.age = Math.max(t.age, t.life - 1);
  }

  private updateLaser(t: Toy, dt: number, platforms: readonly Platform[], bounds: WorldBounds): void {
    t.retarget -= dt;
    if (t.retarget <= 0) {
      t.retarget = this.rng.range(0.5, 1.4);
      const p = platforms.length ? this.rng.weighted(platforms, platforms.map((pl) => (pl.kind === 'floor' ? 3 : 1))) : null;
      if (p) {
        t.tx = this.rng.range(p.xMin + 10, p.xMax - 10);
        t.ty = p.y - 2;
      } else {
        t.tx = this.rng.range(20, bounds.width - 20);
        t.ty = bounds.height - 4;
      }
    }
    const k = 1 - Math.exp(-5.5 * dt);
    t.x += (t.tx - t.x) * k + (this.rng.next() - 0.5) * 2.2;
    t.y += (t.ty - t.y) * k + (this.rng.next() - 0.5) * 1.2;
    t.x = clamp(t.x, 4, bounds.width - 4);
    t.y = clamp(t.y, 4, bounds.height - 2);
    // Snap the dot onto the nearest ledge beneath it once it arrives.
    if (Math.abs(t.ty - t.y) < 2) t.ground = platforms.find((p) => Math.abs(p.y - 2 - t.y) < 3 && t.x >= p.xMin && t.x <= p.xMax)?.id ?? null;
    else t.ground = null;
  }

  draw(ctx: AnyCtx): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.toys.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ctx.save();
    for (const t of this.toys) {
      const fade = Math.min(1, (t.life - t.age) / 1.2);
      ctx.globalAlpha = Math.max(0, fade);
      if (t.kind === 'treat') {
        const s = 1 - t.eaten * 0.85;
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.scale(s, s);
        // little fish-shaped kibble
        ctx.fillStyle = '#C9803E';
        ctx.beginPath();
        ctx.ellipse(0, -3, 6.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(5, -3);
        ctx.lineTo(10, -7);
        ctx.lineTo(10, 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#5B3A1E';
        ctx.beginPath();
        ctx.arc(-3, -4, 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (t.kind === 'ball') {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(t.spin);
        const g = ctx.createRadialGradient(-3, -3, 1, 0, 0, BALL_R);
        g.addColorStop(0, '#FF8FA3');
        g.addColorStop(1, '#D9435E');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFE08A';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, BALL_R * 0.62, 0.2, Math.PI - 0.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, BALL_R * 0.62, Math.PI + 0.2, Math.PI * 2 - 0.2);
        ctx.stroke();
        ctx.restore();
      } else {
        const pulse = 0.8 + Math.sin(t.age * 22) * 0.2;
        const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, 12);
        g.addColorStop(0, 'rgba(255,40,40,0.95)');
        g.addColorStop(0.25, `rgba(255,30,30,${0.55 * pulse})`);
        g.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#FFF2F2';
        ctx.beginPath();
        ctx.arc(t.x, t.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      minX = Math.min(minX, t.x - 16);
      minY = Math.min(minY, t.y - 16);
      maxX = Math.max(maxX, t.x + 16);
      maxY = Math.max(maxY, t.y + 16);
    }
    ctx.restore();
    return { minX, minY, maxX, maxY };
  }
}
