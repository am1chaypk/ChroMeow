/**
 * ToyManager — treats, a bouncy toy ball, a laser dot and (v3) a toy mouse on a
 * string. Toys live in the same physical world as the cats (they land on DOM
 * ledges, bounce off the viewport edges) and cats chase, bat, pounce on and eat
 * them. Balls and mice can be picked up and thrown straight from the page.
 * DOM-free, so the Cat Studio preview sandbox reuses it.
 */
import { clamp, lerp } from '../shared/math';
import { Rng } from '../shared/rng';
import type { ToyKind } from '../shared/types';
import type { AnyCtx } from '../engine/canvas';
import { GRAVITY, findLanding, type Platform, type WorldBounds } from '../engine/Physics';
import { catchMouse, createMouse, drawMouse, holdMouse, stepMouse, type MouseBody, type Threat } from '../sim/MouseToy';

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
  /** Laser steered by the user's mouse (no autonomous wandering). */
  controlled?: boolean;
  /** Ball / mouse currently held under the cursor (not yet thrown). */
  held?: boolean;
  /** The toy mouse's body, behaviour and string. */
  mouse?: MouseBody;
}

/** Toys a hand can pick straight up off the page and throw. */
export const GRABBABLE: readonly ToyKind[] = ['ball', 'mouse'];

/** Max simultaneous treats; clicking more replaces the oldest. */
const MAX_TREATS = 12;
/** Fastest a hand can throw the ball (px/s). */
const MAX_THROW = 1700;

const BALL_R = 8;

export class ToyManager {
  toys: Toy[] = [];
  private nextId = 1;
  private rng = new Rng(7);

  get count(): number {
    return this.toys.length;
  }

  private make(kind: ToyKind, x: number, y: number): Toy {
    const life = kind === 'treat' ? 90 : kind === 'ball' ? 60 : kind === 'mouse' ? 150 : 16;
    const t: Toy = { id: this.nextId++, kind, x, y, vx: 0, vy: 0, ground: null, age: 0, life, eaten: 0, claimedBy: null, tx: x, ty: y, retarget: 0, spin: 0, idle: 0 };
    this.toys.push(t);
    return t;
  }

  /** Drops the toy mouse in (one at a time): it lands and starts running about. */
  spawnMouse(bounds: WorldBounds, x?: number, y = -10): Toy {
    this.toys = this.toys.filter((t) => t.kind !== 'mouse');
    const px = x ?? bounds.width * (0.25 + this.rng.next() * 0.5);
    const t = this.make('mouse', px, y);
    t.mouse = createMouse(px, y, this.rng.chance(0.5) ? 1 : -1);
    return t;
  }

  /** The toy under a point that a hand can pick up (a ball or the mouse), if any. */
  grabbableAt(x: number, y: number): Toy | null {
    for (let i = this.toys.length - 1; i >= 0; i--) {
      const t = this.toys[i];
      if (t.held || !GRABBABLE.includes(t.kind)) continue;
      const cy = t.kind === 'mouse' ? t.y - 5 : t.y;
      const r = t.kind === 'mouse' ? 15 : BALL_R + 7;
      if (Math.hypot(x - t.x, y - cy) <= r) return t;
    }
    return null;
  }

  /** Picks up (or carries) a specific toy under the cursor. */
  holdToy(toy: Toy, x: number, y: number): void {
    if (!this.toys.includes(toy)) return;
    for (const o of this.toys) if (o !== toy) o.held = false;
    toy.held = true;
    if (toy.kind === 'ball') toy.spin += (x - toy.x) / BALL_R;
    toy.x = x;
    toy.y = toy.kind === 'mouse' ? y + 5 : y;
    toy.vx = 0;
    toy.vy = 0;
    toy.ground = null;
    toy.age = 0;
    toy.idle = 0;
  }

  /** The toy currently in hand, if any. */
  get heldToy(): Toy | null {
    return this.toys.find((t) => t.held) ?? null;
  }

  /** Lets go of whatever toy is in hand with the hand's velocity. */
  throwToy(vx: number, vy: number): Toy | null {
    const t = this.heldToy;
    if (!t) return null;
    const sp = Math.hypot(vx, vy);
    const k = sp > MAX_THROW ? MAX_THROW / sp : 1;
    t.held = false;
    t.vx = vx * k;
    t.vy = vy * k;
    t.idle = 0;
    t.age = 0;
    if (t.mouse) {
      t.mouse.vx = t.vx;
      t.mouse.vy = t.vy;
      t.mouse.ground = null;
    }
    return t;
  }

  /** A cat pinned the mouse (or its string, right by the mouse). */
  pinMouse(toy: Toy): void {
    if (!toy.mouse) return;
    catchMouse(toy.mouse, this.rng);
    // Worn out after its last escape: it stays as a limp toy for a while, then is tidied away.
    if (toy.mouse.catches >= 3) toy.life = Math.min(toy.life, toy.age + 40);
  }

  /** A paw swat at the mouse's string near (x, y): it swings and the mouse startles. */
  batString(toy: Toy, x: number, y: number, dirX: number): boolean {
    const m = toy.mouse;
    if (!m) return false;
    const i = m.rope.nearest(x, y, 26);
    if (i < 0) return false;
    m.rope.bat(i, dirX * lerp(160, 320, this.rng.next()), -lerp(120, 260, this.rng.next()));
    return true;
  }

  /** Removes every temporary object (treats, balls, the laser dot, the mouse and its leftovers). */
  clear(): number {
    const n = this.toys.length;
    this.toys = [];
    return n;
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

  /** Drops a treat exactly where the user clicked; it falls onto the ledge beneath. */
  spawnTreatAt(x: number, y: number): Toy {
    const treats = this.toys.filter((t) => t.kind === 'treat');
    if (treats.length >= MAX_TREATS) this.remove(treats[0]);
    const t = this.make('treat', x, y);
    t.vy = -40;
    return t;
  }

  /** The user's laser: on while the button is held, exactly under the cursor. */
  controlLaser(x: number, y: number, on: boolean): Toy | null {
    let t = this.toys.find((k) => k.kind === 'laser' && k.controlled) ?? null;
    if (!on) {
      if (t) {
        // Released: the dot freezes and fades out quickly.
        t.controlled = false;
        t.tx = t.x;
        t.ty = t.y;
        t.retarget = 99;
        t.life = Math.min(t.life, t.age + 0.25);
      }
      return null;
    }
    if (!t) {
      this.toys = this.toys.filter((k) => k.kind !== 'laser');
      t = this.make('laser', x, y);
      t.controlled = true;
    }
    t.tx = x;
    t.ty = y;
    t.age = 0;
    t.life = 16;
    return t;
  }

  /** Picks up (or moves) the ball under the cursor. */
  holdBall(x: number, y: number): Toy {
    let t = this.toys.find((k) => k.kind === 'ball' && k.held) ?? null;
    if (!t) {
      this.toys = this.toys.filter((k) => k.kind !== 'ball');
      t = this.make('ball', x, y);
      t.held = true;
    }
    t.spin += (x - t.x) / BALL_R;
    t.x = x;
    t.y = y;
    t.vx = 0;
    t.vy = 0;
    t.ground = null;
    t.age = 0;
    return t;
  }

  /** Lets go of the held ball with the hand's velocity. */
  throwBall(vx: number, vy: number): Toy | null {
    const t = this.toys.find((k) => k.kind === 'ball' && k.held) ?? null;
    if (!t) return null;
    const sp = Math.hypot(vx, vy);
    const k = sp > MAX_THROW ? MAX_THROW / sp : 1;
    t.held = false;
    t.vx = vx * k;
    t.vy = vy * k;
    t.idle = 0;
    t.age = 0;
    return t;
  }

  remove(toy: Toy): void {
    this.toys = this.toys.filter((t) => t !== toy);
  }

  nearest(x: number, y: number, kinds: readonly ToyKind[] = ['treat', 'ball', 'laser', 'mouse']): Toy | null {
    let best: Toy | null = null;
    let bd = Infinity;
    for (const t of this.toys) {
      if (!kinds.includes(t.kind)) continue;
      if (t.kind === 'treat' && t.eaten >= 1) continue;
      // A worn-out mouse is just a toy lying about now.
      if (t.mouse && t.mouse.mode === 'limp') continue;
      // A ball in hand isn't up for grabs — but a mouse dangling from your hand is the best game there is.
      if (t.held && t.kind !== 'mouse') continue;
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
    } else if (toy.mouse) {
      // Batted: the mouse tumbles a little way and lands running.
      const m = toy.mouse;
      if (m.mode === 'caught') return;
      m.ground = null;
      m.vx = dirX * lerp(140, 260, Math.random()) * power;
      m.vy = -lerp(140, 240, Math.random()) * power;
      m.dir = dirX >= 0 ? 1 : -1;
    } else if (toy.kind === 'laser' && !toy.controlled) {
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

  update(dt: number, platforms: readonly Platform[], bounds: WorldBounds, cats: readonly Threat[] = []): void {
    const keep: Toy[] = [];
    for (const t of this.toys) {
      t.age += dt;
      if (t.held) t.age = 0;
      if (t.age > t.life) continue;
      if (t.kind === 'laser') this.updateLaser(t, dt, platforms, bounds);
      else if (t.mouse) this.updateMouse(t, dt, platforms, bounds, cats);
      else if (!t.held) this.updateBody(t, dt, platforms, bounds);
      keep.push(t);
    }
    this.toys = keep;
  }

  private updateMouse(t: Toy, dt: number, platforms: readonly Platform[], bounds: WorldBounds, cats: readonly Threat[]): void {
    const m = t.mouse as MouseBody;
    if (t.held) holdMouse(m, t.x, t.y - 5, dt, platforms, bounds);
    else {
      stepMouse(m, dt, platforms, bounds, cats, this.rng);
      t.x = m.x;
      t.y = m.y;
      t.vx = m.vx;
      t.vy = m.vy;
      t.ground = m.ground;
    }
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
    if (t.controlled) {
      // A hand-held laser: a tiny tremor, otherwise exactly where the user points.
      t.age = 0;
      const k = 1 - Math.exp(-40 * dt);
      t.x += (t.tx - t.x) * k + (this.rng.next() - 0.5) * 0.8;
      t.y += (t.ty - t.y) * k + (this.rng.next() - 0.5) * 0.8;
      t.x = clamp(t.x, 2, bounds.width - 2);
      t.y = clamp(t.y, 2, bounds.height - 2);
      t.ground = platforms.find((p) => Math.abs(p.y - 2 - t.y) < 6 && t.x >= p.xMin && t.x <= p.xMax)?.id ?? null;
      return;
    }
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
      if (t.mouse) {
        drawMouse(ctx, t.mouse, !!t.held);
        for (const n of t.mouse.rope.nodes) {
          minX = Math.min(minX, n.x - 6);
          minY = Math.min(minY, n.y - 6);
          maxX = Math.max(maxX, n.x + 6);
          maxY = Math.max(maxY, n.y + 6);
        }
      } else if (t.kind === 'treat') {
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
