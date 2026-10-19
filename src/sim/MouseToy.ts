/**
 * The toy mouse (v3): a little grey felt mouse that runs about on its own like a
 * real one — scuttling in short bursts, pausing to "sniff", darting off, bolting
 * away when a cat creeps close — until a cat pins it. A twine string with a pom
 * at the end hangs from it: a multi-segment Verlet rope that drags along the
 * floor and the page's ledges, swings when the mouse is lifted or dangles over
 * an edge, and is exactly the thing cats can't resist batting at.
 *
 * DOM-free and deterministic for a given RNG, so the headless tests and Cat
 * Studio use it too.
 */
import { clamp, type Vec2 } from '../shared/math';
import type { Rng } from '../shared/rng';
import type { AnyCtx } from '../engine/canvas';
import { GRAVITY, platformBelow, type Platform, type WorldBounds } from '../engine/Physics';

/* ------------------------------------------------------------------ rope */

export interface RopeNode {
  x: number;
  y: number;
  px: number;
  py: number;
  /** Resting on a ledge / the floor this step. */
  grounded: boolean;
}

export const ROPE_SEGMENTS = 9;
export const ROPE_SEG_LEN = 7;
const ROPE_RADIUS = 1.5;

/**
 * A Verlet rope pinned at one end (node 0). Gravity, damping, distance
 * constraints, one-way collisions with ledges (it rests on top of them, slides
 * with friction and falls off their edges) and the viewport floor.
 */
export class StringRope {
  readonly nodes: RopeNode[] = [];
  segLen: number;

  /** Laid out from (x, y) in direction `angle` (default: hanging straight down). */
  constructor(x: number, y: number, count = ROPE_SEGMENTS, segLen = ROPE_SEG_LEN, angle = Math.PI / 2) {
    this.segLen = segLen;
    for (let i = 0; i < count; i++) {
      const nx = x + Math.cos(angle) * i * segLen;
      const ny = y + Math.sin(angle) * i * segLen;
      this.nodes.push({ x: nx, y: ny, px: nx, py: ny, grounded: false });
    }
  }

  reset(x: number, y: number): void {
    this.nodes.forEach((n, i) => {
      n.x = n.px = x;
      n.y = n.py = y + i * this.segLen;
      n.grounded = false;
    });
  }

  translate(dx: number, dy: number): void {
    for (const n of this.nodes) {
      n.x += dx;
      n.px += dx;
      n.y += dy;
      n.py += dy;
    }
  }

  step(dt: number, ax: number, ay: number, platforms: readonly Platform[], bounds: WorldBounds): void {
    const h = clamp(dt, 0, 1 / 20);
    if (h <= 0) return;
    const sub = 3;
    const sh = h / sub;
    const nodes = this.nodes;
    for (let s = 0; s < sub; s++) {
      const root = nodes[0];
      root.px = root.x;
      root.py = root.y;
      root.x = ax;
      root.y = ay;
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        const damp = n.grounded ? 0.82 : 0.992;
        const vx = (n.x - n.px) * damp;
        const vy = (n.y - n.py) * damp;
        n.px = n.x;
        n.py = n.y;
        n.x += vx;
        n.y += vy + GRAVITY * sh * sh;
      }
      for (let iter = 0; iter < 8; iter++) {
        for (let i = 1; i < nodes.length; i++) {
          const a = nodes[i - 1];
          const b = nodes[i];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-6;
          // A string only resists stretching, never compression (it can bunch up on the floor).
          if (d <= this.segLen) continue;
          const diff = (d - this.segLen) / d;
          if (i === 1) {
            b.x -= dx * diff;
            b.y -= dy * diff;
          } else {
            a.x += dx * diff * 0.5;
            a.y += dy * diff * 0.5;
            b.x -= dx * diff * 0.5;
            b.y -= dy * diff * 0.5;
          }
        }
        this.collide(platforms, bounds, iter === 7);
      }
    }
  }

  /** Keeps nodes on top of the ledge / floor below them; on the last pass also applies friction and sets `grounded`. */
  private collide(platforms: readonly Platform[], bounds: WorldBounds, last: boolean): void {
    for (let i = 1; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.x = clamp(n.x, 1, bounds.width - 1);
      // Only ledges the node was above a moment ago stop it (one-way, like the cats' ledges).
      const support = platformBelow(n.x, Math.min(n.py, n.y) - 2, platforms, 1);
      const gy = (support ? support.y : bounds.height - 2) - ROPE_RADIUS;
      if (n.y > gy) n.y = gy;
      if (!last) continue;
      n.grounded = n.y >= gy - 0.05;
      if (n.grounded) {
        // Friction: a dragged string slides, it doesn't skate; resting contact kills the bounce.
        n.px = n.x - (n.x - n.px) * 0.55;
        n.py = n.y;
      }
    }
  }

  tip(): Vec2 {
    const t = this.nodes[this.nodes.length - 1];
    return { x: t.x, y: t.y };
  }

  /** The lowest-hanging free point (what a cat paws at when the string dangles). */
  lowestFree(): Vec2 | null {
    let best: RopeNode | null = null;
    for (const n of this.nodes) if (!n.grounded && (!best || n.y > best.y)) best = n;
    return best ? { x: best.x, y: best.y } : null;
  }

  /** How far the string hangs freely below its anchor (0 when it all lies on the ground). */
  hangDepth(): number {
    const a = this.nodes[0];
    let d = 0;
    for (const n of this.nodes) if (!n.grounded) d = Math.max(d, n.y - a.y);
    return d;
  }

  /** Mean speed of the nodes (px/s at the given dt) — a swinging or wriggling string is irresistible. */
  speed(dt: number): number {
    if (dt <= 0) return 0;
    let s = 0;
    for (const n of this.nodes) s += Math.hypot(n.x - n.px, n.y - n.py);
    return s / this.nodes.length / (dt / 3);
  }

  /** Nearest node index to a point within `r` px, or −1. */
  nearest(x: number, y: number, r: number): number {
    let best = -1;
    let bd = r;
    this.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** A paw swat: kicks the nodes around index `i` with velocity (vx, vy) px/s. */
  bat(i: number, vx: number, vy: number, dt = 1 / 60): void {
    const sub = dt / 3;
    this.nodes.forEach((n, k) => {
      if (k === 0) return;
      const w = Math.max(0, 1 - Math.abs(k - i) / 3);
      if (w <= 0) return;
      n.px = n.x - vx * sub * w;
      n.py = n.y - vy * sub * w;
      n.grounded = false;
    });
  }

  /** Total length of the rope as simulated (for tests). */
  length(): number {
    let l = 0;
    for (let i = 1; i < this.nodes.length; i++) l += Math.hypot(this.nodes[i].x - this.nodes[i - 1].x, this.nodes[i].y - this.nodes[i - 1].y);
    return l;
  }
}

/* ----------------------------------------------------------------- mouse */

export type MouseMode = 'pause' | 'scuttle' | 'dart' | 'flee' | 'caught' | 'limp';

export interface MouseBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Platform the mouse runs on, or null while falling / thrown. */
  ground: string | null;
  /** Direction it faces / runs (+1 right). */
  dir: 1 | -1;
  mode: MouseMode;
  /** Seconds left in the current mode. */
  modeT: number;
  speed: number;
  /** Times a cat has pinned it; after MOUSE_LIVES it gives up and lies there (toy debris). */
  catches: number;
  /** Animation clock (legs, whiskers). */
  anim: number;
  /** Seconds before it can be startled into bolting again (a fleeing mouse runs out of puff). */
  calm: number;
  rope: StringRope;
}

/** A cat this close (px, horizontally, about the same height) makes the mouse bolt… */
export const MOUSE_ALERT = 150;
/** …unless it is stalking (creeping slower than STALK_SPEED): then the mouse only notices it this close. */
export const MOUSE_ALERT_STALKED = 62;
export const STALK_SPEED = 70;

/** A cat as the mouse sees it: where its feet are and how fast it moves. */
export interface Threat {
  x: number;
  y: number;
  vx?: number;
}
/** Pins before the mouse is worn out and lies still. */
export const MOUSE_LIVES = 3;
const BODY_H = 5.5;

export function createMouse(x: number, y: number, dir: 1 | -1 = 1): MouseBody {
  return { x, y, vx: 0, vy: 0, ground: null, dir, mode: 'pause', modeT: 0.6, speed: 0, catches: 0, anim: 0, calm: 0, rope: new StringRope(x - dir * 8, y) };
}

/** Where the string is tied on: under the mouse's rump. */
export function ropeAnchor(m: MouseBody): Vec2 {
  return { x: m.x - m.dir * 8, y: m.y - 1.5 };
}

function setMode(m: MouseBody, mode: MouseMode, rng: Rng): void {
  m.mode = mode;
  switch (mode) {
    case 'pause':
      m.modeT = rng.range(0.35, 1.5);
      m.speed = 0;
      break;
    case 'scuttle':
      m.modeT = rng.range(0.5, 1.5);
      m.speed = rng.range(70, 125);
      break;
    case 'dart':
      m.modeT = rng.range(0.25, 0.6);
      m.speed = rng.range(260, 370);
      break;
    case 'flee':
      m.modeT = rng.range(0.55, 0.95);
      m.speed = rng.range(300, 380);
      break;
    case 'caught':
      m.modeT = 1.1;
      m.speed = 0;
      break;
    case 'limp':
      m.modeT = Infinity;
      m.speed = 0;
      break;
  }
}

/**
 * One step of the mouse's little life. `threats` are the cats' positions
 * (feet); the nearest one within MOUSE_ALERT on the same level makes it flee.
 */
export function stepMouse(m: MouseBody, dt: number, platforms: readonly Platform[], bounds: WorldBounds, threats: readonly Threat[], rng: Rng): void {
  m.anim += dt * (0.4 + m.speed / 40);
  m.calm = Math.max(0, m.calm - dt);
  if (!m.ground) {
    // Falling (dropped in, thrown, or ran off a ledge).
    const prevY = m.y;
    m.vy = Math.min(m.vy + GRAVITY * dt, 1300);
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.x < 6 || m.x > bounds.width - 6) {
      m.x = clamp(m.x, 6, bounds.width - 6);
      m.vx = -m.vx * 0.5;
    }
    if (m.vy > 0) {
      let land: Platform | null = null;
      for (const p of platforms) if (m.x >= p.xMin && m.x <= p.xMax && p.y >= prevY - 0.5 && p.y <= m.y + 0.5 && (!land || p.y < land.y)) land = p;
      const floorY = bounds.height - 2;
      if (!land && m.y >= floorY) land = platforms.find((p) => p.kind === 'floor') ?? null;
      if (land || m.y >= floorY) {
        m.y = land ? land.y : floorY;
        m.vy = 0;
        m.vx = 0;
        m.ground = land ? land.id : 'floor';
        if (m.mode !== 'limp') setMode(m, 'pause', rng);
      }
    }
    m.rope.step(dt, ropeAnchor(m).x, ropeAnchor(m).y, platforms, bounds);
    return;
  }
  const p = platforms.find((q) => q.id === m.ground) ?? (m.ground === 'floor' ? platforms.find((q) => q.kind === 'floor') ?? null : null);
  if (!p) {
    m.ground = null;
    m.vx = m.dir * m.speed * 0.5;
    return;
  }
  if (p.y !== m.y) m.rope.translate(0, p.y - m.y); // the ledge moved (page scroll): the string comes along
  m.y = p.y;
  if (m.mode !== 'caught' && m.mode !== 'limp' && m.mode !== 'flee' && m.calm <= 0) {
    // Danger check: the nearest cat on this level. A stalking cat gets much closer unnoticed.
    let near: Threat | null = null;
    let nd = Infinity;
    for (const c of threats) {
      if (Math.abs(c.y - m.y) > 60) continue;
      const d = Math.abs(c.x - m.x);
      const alert = Math.abs(c.vx ?? 0) < STALK_SPEED ? MOUSE_ALERT_STALKED : MOUSE_ALERT;
      if (d < alert && d < nd) {
        nd = d;
        near = c;
      }
    }
    if (near) {
      // Surprised at close quarters (a pounce out of a stalk), a mouse usually freezes for a heartbeat.
      if (rng.chance(nd < 95 ? 0.6 : 0.3)) {
        // Some mice freeze instead of running — for a heartbeat.
        setMode(m, 'pause', rng);
        m.modeT = rng.range(0.5, 1.1);
        m.calm = m.modeT + 0.4;
      } else {
        setMode(m, 'flee', rng);
        m.dir = near.x > m.x ? -1 : 1;
        // Cornered against the edge: dart past the cat instead.
        const room = m.dir > 0 ? p.xMax - m.x : m.x - p.xMin;
        if (room < 26 && p.kind === 'floor') m.dir = m.dir > 0 ? -1 : 1;
        m.calm = m.modeT + rng.range(1, 2.2);
      }
    }
  }
  m.modeT -= dt;
  if (m.modeT <= 0) {
    if (m.mode === 'caught') {
      if (m.catches >= MOUSE_LIVES) setMode(m, 'limp', rng);
      else {
        setMode(m, 'flee', rng);
        if (threats.length) {
          const c = threats.reduce((a, b) => (Math.abs(b.x - m.x) < Math.abs(a.x - m.x) ? b : a));
          m.dir = c.x > m.x ? -1 : 1;
        }
      }
    } else if (m.mode === 'pause') {
      const r = rng.next();
      if (r < 0.15) m.dir = m.dir > 0 ? -1 : 1;
      setMode(m, r < 0.62 ? 'scuttle' : 'dart', rng);
    } else if (m.mode !== 'limp') setMode(m, 'pause', rng);
  }
  // Scuttling is stop-and-go: little bursts several times a second.
  const burst = m.mode === 'scuttle' ? 0.35 + 0.65 * Math.max(0, Math.sin(m.anim * 2.1)) : 1;
  m.vx = m.dir * m.speed * burst;
  let nx = m.x + m.vx * dt;
  const lo = p.xMin + 5;
  const hi = p.xMax - 5;
  if (nx < lo || nx > hi) {
    const dropOff = p.kind !== 'floor' && (m.mode === 'flee' || m.mode === 'dart' || rng.chance(0.3));
    if (dropOff) {
      // Off the edge of a ledge it goes.
      m.ground = null;
      m.vy = -40;
      m.vx = m.dir * Math.max(60, m.speed * 0.4);
    } else {
      nx = clamp(nx, lo, hi);
      m.dir = m.dir > 0 ? -1 : 1;
      if (m.mode === 'scuttle') setMode(m, 'pause', rng);
    }
  }
  m.x = nx;
  const a = ropeAnchor(m);
  m.rope.step(dt, a.x, a.y, platforms, bounds);
}

/** A cat pinned the mouse. */
export function catchMouse(m: MouseBody, rng: Rng): void {
  if (m.mode === 'caught' || m.mode === 'limp') return;
  m.catches++;
  setMode(m, 'caught', rng);
}

/** The user picked the mouse up: it dangles, string hanging below. */
export function holdMouse(m: MouseBody, x: number, y: number, dt: number, platforms: readonly Platform[], bounds: WorldBounds): void {
  m.x = x;
  m.y = y + BODY_H;
  m.vx = 0;
  m.vy = 0;
  m.ground = null;
  m.anim += dt * 6;
  const a = ropeAnchor(m);
  m.rope.step(dt, a.x, a.y, platforms, bounds);
}

/* ---------------------------------------------------------------- drawing */

export function drawMouse(ctx: AnyCtx, m: MouseBody, held: boolean): void {
  // The string first (behind the mouse): a smooth twine curve with a pom at the end.
  const nodes = m.rope.nodes;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#CDB98F';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length - 1; i++) {
    const mx = (nodes[i].x + nodes[i + 1].x) / 2;
    const my = (nodes[i].y + nodes[i + 1].y) / 2;
    ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, mx, my);
  }
  const tip = nodes[nodes.length - 1];
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,96,60,0.35)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // Pom.
  const pg = ctx.createRadialGradient(tip.x - 1, tip.y - 1, 0.5, tip.x, tip.y, 3.6);
  pg.addColorStop(0, '#FF9AA8');
  pg.addColorStop(1, '#D9435E');
  ctx.fillStyle = pg;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 3.4, 0, Math.PI * 2);
  ctx.fill();

  // The mouse.
  const limp = m.mode === 'limp';
  const squish = m.mode === 'caught' ? 0.72 + 0.08 * Math.sin(m.anim * 20) : 1;
  ctx.translate(m.x, m.y);
  ctx.scale(m.dir, 1);
  if (limp) ctx.rotate(0.12);
  if (held) ctx.rotate(Math.sin(m.anim * 1.7) * 0.18 - 0.1);
  ctx.scale(1, squish);
  // Shadow.
  if (!held) {
    ctx.fillStyle = 'rgba(30,22,16,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, -0.5, 11, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Feet (a blur of little legs when it runs).
  const run = m.speed > 1 && !held;
  ctx.fillStyle = '#E9A7A7';
  for (let i = 0; i < 2; i++) {
    const ph = m.anim * 9 + i * Math.PI;
    const fx = (i === 0 ? 5 : -5) + (run ? Math.sin(ph) * 2.2 : 0);
    ctx.beginPath();
    ctx.ellipse(fx, -0.8, 1.8, 1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Body: felt teardrop, nose to the right.
  const bg = ctx.createLinearGradient(0, -BODY_H * 2.2, 0, 0);
  bg.addColorStop(0, '#A9A6A3');
  bg.addColorStop(1, '#7F7B78');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(12, -3.2);
  ctx.bezierCurveTo(8, -11.5, -6, -12.5, -10, -5.5);
  ctx.bezierCurveTo(-11.5, -2.5, -10, -1, -7, -1);
  ctx.lineTo(8, -1);
  ctx.bezierCurveTo(10.5, -1, 12, -2, 12, -3.2);
  ctx.closePath();
  ctx.fill();
  // Felt texture: a couple of soft stitch lines.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-6, -8.5);
  ctx.quadraticCurveTo(0, -11, 6, -8);
  ctx.stroke();
  // Ear.
  const twitch = m.mode === 'pause' ? Math.sin(m.anim * 13) * 0.25 : 0;
  ctx.save();
  ctx.translate(4.5, -9.5);
  ctx.rotate(-0.35 + twitch);
  ctx.fillStyle = '#8E8A87';
  ctx.beginPath();
  ctx.ellipse(0, -2.6, 3.4, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#F1B6B9';
  ctx.beginPath();
  ctx.ellipse(0.2, -2.6, 2.1, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Eye (an x when worn out), nose and whiskers.
  ctx.fillStyle = '#1E1A18';
  if (limp) {
    ctx.strokeStyle = '#1E1A18';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(6.2, -7.6);
    ctx.lineTo(8.2, -5.6);
    ctx.moveTo(8.2, -7.6);
    ctx.lineTo(6.2, -5.6);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(7.3, -6.6, 1.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#E58B98';
  ctx.beginPath();
  ctx.arc(12, -3.3, 1.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,55,50,0.55)';
  ctx.lineWidth = 0.5;
  const wig = m.mode === 'pause' ? Math.sin(m.anim * 17) * 0.8 : 0;
  ctx.beginPath();
  ctx.moveTo(11, -3.5);
  ctx.lineTo(16, -5.2 + wig);
  ctx.moveTo(11, -3);
  ctx.lineTo(16.3, -2.6 + wig);
  ctx.stroke();
  ctx.restore();
}
