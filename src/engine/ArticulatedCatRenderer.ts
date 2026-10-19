/**
 * ArticulatedCatRenderer — "Mode A" procedural rig, painted for realism.
 *
 *  • Anatomy: a realistically small skull on a short neck, a deformable torso
 *    with deep chest, waist tuck, primordial pouch and rolling shoulder blades,
 *    tapered digitigrade legs (thigh → hock → long metatarsus behind, elbow →
 *    wrist → pastern in front) and a tapering Verlet tail.
 *  • Rendering: every furred part is texture-mapped from the UV atlas into an
 *    offscreen layer at device resolution. The union silhouette then gets one
 *    consistent volume-lighting pass (world-fixed key light, soft core shadow,
 *    sheen and ambient occlusion from blurred masks), soft contact shadows where
 *    parts overlap, and hair fringes instead of outlines, so the cat reads as a
 *    furry, rounded animal rather than a flat cut-out.
 *  • Face: modelled skull outline, whisker pads, layered irises with a gold
 *    halo, fibres, slit pupils, lid shadow and wet highlights, real nose leather
 *    with nostrils and philtrum, tapered whiskers and ears with furnishings.
 *
 * The skeleton / landmarks contract is unchanged, so physics, hitboxes and the
 * AI keep working on the same geometry.
 */
import { hexToRgb, mixHex, rgba, shadeHex } from '../shared/color';
import { catmullRom, clamp, clamp01, convexHull, lerp, matApply, matIdentity, matRotate, matScale, matTranslate, smoothstep, wrapAngle, type Mat2D, type Vec2 } from '../shared/math';
import type { CatProfile } from '../shared/types';
import { dataUrlToBitmap } from '../shared/zip';
import { createCanvas, ctx2d, type AnyCanvas, type AnyCtx } from './canvas';
import { buildCoatTexture, coatKey, type CoatTexture } from './CoatTexture';
import type { Pose } from './Pose';
import { HEAD_TEMPLATE, UV, type LegId, type UVRect } from './UVLayout';
import type { VerletTail } from './VerletTail';

export interface RenderTransform {
  x: number;
  y: number;
  /** Signed horizontal scale: ±1 for facing; passes through 0 while turning around. */
  flip: number;
  scale: number;
}

interface RibbonPt {
  x: number;
  y: number;
  nx: number;
  ny: number;
  top: number;
  bot: number;
  tc: number;
}

export interface LegGeom {
  a: Vec2;
  k: Vec2;
  p: Vec2;
  hidden: number;
  curl: number;
  wTop: number;
  wMid: number;
  wEnd: number;
  hind: boolean;
}

export interface Skeleton {
  M: Mat2D;
  facing: 1 | -1;
  /** |flip|: 1 in profile, → 0 mid-turn. */
  flipMag: number;
  torso: RibbonPt[];
  legs: Record<LegId, LegGeom>;
  head: { x: number; y: number; r: number; rot: number };
  neck: RibbonPt[];
  tailAnchor: Vec2;
  /** Local-space tail base direction. */
  tailAngle: number;
  dBody: Vec2;
  roll: number;
}

export interface Landmarks {
  head: { x: number; y: number; r: number };
  headUp: Vec2;
  paws: Vec2[];
  torsoPoly: Vec2[];
  spine: Vec2[];
  spineNormals: Vec2[];
  tail: Vec2[];
  hull: Vec2[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  roll: number;
  scale: number;
  backTop: Vec2;
  /** The nape / scruff (top of the neck behind the ears), where a hand picks the cat up. */
  scruff: Vec2;
}

export interface DrawOptions {
  time: number;
  grounded: boolean;
  groundY: number;
  alpha?: number;
  highlight?: number;
}

const TORSO_SAMPLES = 16;
const T_START = -0.2;
const T_END = 1.16;
/** Skull radius in local units (a real cat's head is ~0.3× its shoulder-to-hip length). */
const HEAD_R = 11.6;
/** Pulls the head toward the shoulders so the smaller skull keeps a short, thick neck. */
const HEAD_PULL = 0.86;
/**
 * Neck bone limits (local units): the skull centre never sits further than this
 * from the shoulders, and the head–torso joint bends only within this range
 * relative to the spine (−: chin up / forward, +: turned back toward the flank).
 * Poses that ask for more (a chin draped far over a partner) are clamped.
 */
export const NECK_MAX = 22.5;
export const NECK_ANGLE_MIN = -1.55;
export const NECK_ANGLE_MAX = 2.35;
/** Fastest the tail's base direction may swing (rad/s) — keeps state changes from flicking the tail. */
export const TAIL_BASE_MAX_RATE = 5;

/**
 * Head–torso joint constraint: returns the head centre with the shoulder→head
 * vector clamped to NECK_MAX and its angle to the spine direction `d` clamped to
 * [NECK_ANGLE_MIN, NECK_ANGLE_MAX] (short necks — the head tucked into the chest —
 * are left alone).
 */
export function clampNeck(shoulder: Vec2, head: Vec2, d: Vec2, maxLen = NECK_MAX): Vec2 {
  let vx = head.x - shoulder.x;
  let vy = head.y - shoulder.y;
  let len = Math.hypot(vx, vy);
  if (len > maxLen) {
    vx *= maxLen / len;
    vy *= maxLen / len;
    len = maxLen;
  }
  if (len > 8) {
    const spine = Math.atan2(d.y, d.x);
    const rel = wrapAngle(Math.atan2(vy, vx) - spine);
    const cl = clamp(rel, NECK_ANGLE_MIN, NECK_ANGLE_MAX);
    if (cl !== rel) {
      vx = Math.cos(spine + cl) * len;
      vy = Math.sin(spine + cl) * len;
    }
  }
  return { x: shoulder.x + vx, y: shoulder.y + vy };
}
/**
 * Global render quality, lowered automatically by the page loop when frames run
 * long (many cats on a slow machine): 1 = full, 0 = lighter lighting and fur.
 */
export const renderQuality = { level: 1 };

/** World-fixed key light (from the upper left). */
const LIGHT = { x: -0.38, y: -0.92 };

/* Face layout in head radii (eye line, nose, mouth, chin), matched to the head atlas. */
const FACE = { eyeX: 0.4, eyeY: -0.1, noseTop: 0.185, noseBot: 0.29, mouth: 0.36, chin: 0.64 };
const TEX_SX = FACE.eyeX / HEAD_TEMPLATE.eyeDX; // head radii per atlas px, horizontally
const TEX_SY = 0.35 / (HEAD_TEMPLATE.noseY - HEAD_TEMPLATE.eyeY); // vertically

function quadPoint(h: Vec2, c: Vec2, s: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return { x: mt * mt * h.x + 2 * mt * t * c.x + t * t * s.x, y: mt * mt * h.y + 2 * mt * t * c.y + t * t * s.y };
}

function quadTangent(h: Vec2, c: Vec2, s: Vec2, t: number): Vec2 {
  const x = 2 * (1 - t) * (c.x - h.x) + 2 * t * (s.x - c.x);
  const y = 2 * (1 - t) * (c.y - h.y) + 2 * t * (s.y - c.y);
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function gauss(t: number, c: number, w: number): number {
  const d = (t - c) / w;
  return Math.exp(-d * d);
}

/** Deterministic hash → 0..1 (stable hair placement frame to frame). */
function h01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function solveIK(a: Vec2, target: Vec2, l1: number, l2: number, back: Vec2): { k: Vec2; p: Vec2 } {
  let dx = target.x - a.x;
  let dy = target.y - a.y;
  let d = Math.hypot(dx, dy);
  const maxD = l1 + l2 - 0.01;
  const minD = Math.abs(l1 - l2) + 0.5;
  if (d < 1e-6) {
    dx = 0;
    dy = 1;
    d = 1e-6;
  }
  const ux = dx / d;
  const uy = dy / d;
  const dc = clamp(d, minD, maxD);
  const p = { x: a.x + ux * dc, y: a.y + uy * dc };
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const ang = Math.acos(cosA);
  const base = Math.atan2(uy, ux);
  const k1 = { x: a.x + Math.cos(base + ang) * l1, y: a.y + Math.sin(base + ang) * l1 };
  const k2 = { x: a.x + Math.cos(base - ang) * l1, y: a.y + Math.sin(base - ang) * l1 };
  const mx = (a.x + p.x) / 2;
  const my = (a.y + p.y) / 2;
  const s1 = (k1.x - mx) * back.x + (k1.y - my) * back.y;
  const s2 = (k2.x - mx) * back.x + (k2.y - my) * back.y;
  return { k: s1 > s2 ? k1 : k2, p };
}

/** Builds a smooth closed outline around a ribbon (rounded caps at either end). */
function ribbonPath(path: Path2D, pts: RibbonPt[], capStart = true, capEnd = true): void {
  const n = pts.length;
  const T = pts.map((p) => ({ x: p.x - p.nx * p.top, y: p.y - p.ny * p.top }));
  const B = pts.map((p) => ({ x: p.x + p.nx * p.bot, y: p.y + p.ny * p.bot }));
  path.moveTo(T[0].x, T[0].y);
  for (let i = 1; i < n - 1; i++) path.quadraticCurveTo(T[i].x, T[i].y, (T[i].x + T[i + 1].x) / 2, (T[i].y + T[i + 1].y) / 2);
  path.lineTo(T[n - 1].x, T[n - 1].y);
  const e = pts[n - 1];
  if (capEnd) {
    const r = (e.top + e.bot) / 2;
    const mx = (T[n - 1].x + B[n - 1].x) / 2;
    const my = (T[n - 1].y + B[n - 1].y) / 2;
    path.quadraticCurveTo(mx + e.ny * r * 1.9, my - e.nx * r * 1.9, B[n - 1].x, B[n - 1].y);
  } else path.lineTo(B[n - 1].x, B[n - 1].y);
  for (let i = n - 2; i > 0; i--) path.quadraticCurveTo(B[i].x, B[i].y, (B[i].x + B[i - 1].x) / 2, (B[i].y + B[i - 1].y) / 2);
  path.lineTo(B[0].x, B[0].y);
  const s = pts[0];
  if (capStart) {
    const r = (s.top + s.bot) / 2;
    const mx = (T[0].x + B[0].x) / 2;
    const my = (T[0].y + B[0].y) / 2;
    path.quadraticCurveTo(mx - s.ny * r * 1.9, my + s.nx * r * 1.9, T[0].x, T[0].y);
  }
  path.closePath();
}

/**
 * Draws one textured triangle: atlas triangle `s` mapped affinely onto screen
 * triangle `d`. The clip is grown slightly so neighbouring triangles never leave
 * hairline gaps; the part's own outline clip trims the excess.
 */
function texTri(ctx: AnyCtx, img: CanvasImageSource, s0: Vec2, s1: Vec2, s2: Vec2, d0: Vec2, d1: Vec2, d2: Vec2): void {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-6) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p: Vec2) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * 0.45, y: p.y + (dy / l) * 0.45 };
  };
  const g0 = grow(d0);
  const g1 = grow(d1);
  const g2 = grow(d2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0.x, g0.y);
  ctx.lineTo(g1.x, g1.y);
  ctx.lineTo(g2.x, g2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  const minX = Math.floor(Math.min(s0.x, s1.x, s2.x) - 1);
  const minY = Math.floor(Math.min(s0.y, s1.y, s2.y) - 1);
  const maxX = Math.ceil(Math.max(s0.x, s1.x, s2.x) + 1);
  const maxY = Math.ceil(Math.max(s0.y, s1.y, s2.y) + 1);
  const sx = clamp(minX, 0, 511);
  const sy = clamp(minY, 0, 511);
  const sw = clamp(maxX, 1, 512) - sx;
  const sh = clamp(maxY, 1, 512) - sy;
  if (sw > 0 && sh > 0) ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}

/**
 * Texture-maps an atlas strip along a ribbon as a triangle strip, so strongly
 * curved bodies (sitting, curling, rolling) stay seamlessly covered.
 */
function drawRibbonTexture(ctx: AnyCtx, img: CanvasImageSource, rect: UVRect, pts: RibbonPt[], along: 'x' | 'y', v0 = 0, v1 = 1): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const A = { x: p.x - p.nx * p.top, y: p.y - p.ny * p.top };
    const B = { x: q.x - q.nx * q.top, y: q.y - q.ny * q.top };
    const C = { x: q.x + q.nx * q.bot, y: q.y + q.ny * q.bot };
    const D = { x: p.x + p.nx * p.bot, y: p.y + p.ny * p.bot };
    let sA: Vec2, sB: Vec2, sC: Vec2, sD: Vec2;
    // Stay 1.5 atlas px inside the region so bilinear filtering never bleeds a neighbour in.
    const inset = 1.5;
    if (along === 'x') {
      const up = clamp(rect.x + p.tc * rect.w, rect.x + inset, rect.x + rect.w - inset);
      const uq = clamp(rect.x + q.tc * rect.w, rect.x + inset, rect.x + rect.w - inset);
      const vt = clamp(rect.y + v0 * rect.h, rect.y + inset, rect.y + rect.h - inset);
      const vb = clamp(rect.y + v1 * rect.h, rect.y + inset, rect.y + rect.h - inset);
      sA = { x: up, y: vt };
      sB = { x: uq, y: vt };
      sC = { x: uq, y: vb };
      sD = { x: up, y: vb };
    } else {
      const vp = clamp(rect.y + p.tc * rect.h, rect.y + inset, rect.y + rect.h - inset);
      const vq = clamp(rect.y + q.tc * rect.h, rect.y + inset, rect.y + rect.h - inset);
      const ul = clamp(rect.x + v0 * rect.w, rect.x + inset, rect.x + rect.w - inset);
      const ur = clamp(rect.x + v1 * rect.w, rect.x + inset, rect.x + rect.w - inset);
      sA = { x: ul, y: vp };
      sB = { x: ul, y: vq };
      sC = { x: ur, y: vq };
      sD = { x: ur, y: vp };
    }
    texTri(ctx, img, sA, sB, sD, A, B, D);
    texTri(ctx, img, sB, sC, sD, B, C, D);
  }
}

/**
 * Maps a vertical slice of an atlas strip onto one straight bone as a single
 * rectangle (no per-segment seams); the caller's clip path supplies the taper.
 */
function drawBoneTexture(ctx: AnyCtx, img: CanvasImageSource, rect: UVRect, p0: Vec2, p1: Vec2, w: number, tc0: number, tc1: number, ext: number): void {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const nx = -uy;
  const ny = ux;
  const ox = p0.x - nx * w * 0.5 - ux * ext;
  const oy = p0.y - ny * w * 0.5 - uy * ext;
  ctx.save();
  ctx.transform(nx * w, ny * w, ux * (l + ext * 2), uy * (l + ext * 2), ox, oy);
  const s0 = clamp(tc0 - (ext / l) * (tc1 - tc0), 0.006, 0.994);
  const s1 = clamp(tc1 + (ext / l) * (tc1 - tc0), 0.006, 0.994);
  ctx.drawImage(img, rect.x + 1.5, rect.y + s0 * rect.h, rect.w - 3, Math.max(0.6, (s1 - s0) * rect.h), 0, 0, 1, 1);
  ctx.restore();
}

interface EdgeHair {
  x: number;
  y: number;
  /** Outward normal. */
  nx: number;
  ny: number;
  /** Fur flow direction (unit). */
  fx: number;
  fy: number;
  color: string;
  len: number;
}

/** Draws a fringe of fine hairs along an edge (deterministic per index, so it never shimmers). */
function drawFringe(ctx: AnyCtx, edge: EdgeHair[], width: number, perPoint: number, seed: number, alpha = 0.7): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.globalAlpha *= alpha;
  for (let i = 0; i < edge.length; i++) {
    const e = edge[i];
    ctx.strokeStyle = e.color;
    ctx.beginPath();
    const next = edge[Math.min(edge.length - 1, i + 1)];
    for (let k = 0; k < perPoint; k++) {
      const t = (k + h01(seed + i * 13.7 + k * 3.1)) / perPoint;
      const bx = lerp(e.x, next.x, t);
      const by = lerp(e.y, next.y, t);
      const l = e.len * (0.55 + 0.7 * h01(seed + i * 7.3 + k * 11.9));
      const out = 0.55 + 0.35 * h01(seed + i * 5.1 + k);
      const dx = e.nx * out + e.fx * (1 - out) * 1.6;
      const dy = e.ny * out + e.fy * (1 - out) * 1.6;
      const dl = Math.hypot(dx, dy) || 1;
      const sx = bx - e.nx * l * 0.35;
      const sy = by - e.ny * l * 0.35;
      const ex = bx + (dx / dl) * l * 0.75;
      const ey = by + (dy / dl) * l * 0.75;
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(lerp(sx, ex, 0.5) + e.fx * l * 0.15, lerp(sy, ey, 0.5) + e.fy * l * 0.15, ex, ey);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function rgbStr(c: [number, number, number], k = 1): string {
  return `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
}

export class ArticulatedCatRenderer {
  profile: CatProfile;
  /** Built lazily on first use, so the rig (skeleton, landmarks) also works without a canvas (tests). */
  private texCache: CoatTexture | null = null;
  private texKey = '';
  private paintKey = '';
  private chonkK = 1;
  private furF = 1;
  private layerA: AnyCanvas | null = null;
  private layerB: AnyCanvas | null = null;
  private maskC: AnyCanvas | null = null;
  private tmpC: AnyCanvas | null = null;
  private blurC: AnyCanvas | null = null;
  private frame = { W: 1, H: 1, ds: 1, bx: 0, by: 0 };
  /** Hair fringes fade at small on-screen sizes, where single hairs would read as noise. */
  private fringeK = 1;
  /** Resolves once the painted mask (if any) has been decoded into the texture. */
  ready: Promise<void>;

  constructor(profile: CatProfile) {
    this.profile = profile;
    this.texKey = coatKey(profile);
    this.applyMorph();
    this.ready = this.loadPaint();
  }

  private get tex(): CoatTexture {
    if (!this.texCache) this.texCache = buildCoatTexture(this.profile, null);
    return this.texCache;
  }

  private set tex(t: CoatTexture) {
    this.texCache = t;
  }

  get texture(): CoatTexture {
    return this.tex;
  }

  setProfile(profile: CatProfile): void {
    const changed = coatKey(profile) !== this.texKey;
    this.profile = profile;
    this.applyMorph();
    if (changed) {
      this.texKey = coatKey(profile);
      this.texCache = null;
      this.ready = this.loadPaint();
    }
  }

  private applyMorph(): void {
    const m = this.profile.morphology;
    this.chonkK = 0.62 + 0.38 * clamp(m.chonk, 0.7, 1.4);
    this.furF = m.furLength === 'long' ? 1.9 : m.furLength === 'medium' ? 1.35 : 1;
  }

  private async loadPaint(): Promise<void> {
    const mask = this.profile.paintMask;
    const key = coatKey(this.profile);
    if (!mask) {
      this.paintKey = '';
      return;
    }
    if (this.paintKey === key) return;
    try {
      const bmp = await dataUrlToBitmap(mask);
      if (coatKey(this.profile) !== key) return;
      this.tex = buildCoatTexture(this.profile, bmp);
      this.paintKey = key;
      bmp.close();
    } catch {
      /* corrupt mask: keep the procedural coat */
    }
  }

  /** Cat-local → world matrix. */
  matrix(tr: RenderTransform, pose: Pose): Mat2D {
    let M = matTranslate(matIdentity(), tr.x, tr.y);
    M = matScale(M, tr.flip * tr.scale, tr.scale);
    M = matRotate(M, pose.rot);
    M = matTranslate(M, pose.rootX, pose.rootY);
    return M;
  }

  skeleton(pose: Pose, tr: RenderTransform, time: number): Skeleton {
    const k = this.chonkK;
    const chonk = this.profile.morphology.chonk;
    const M = this.matrix(tr, pose);
    const shiver = pose.shiver > 0 ? Math.sin(time * 160) * 0.25 * pose.shiver : 0;
    const H = { x: pose.hipX, y: pose.hipY + shiver };
    const S = { x: pose.shX, y: pose.shY - shiver };
    const dx = S.x - H.x;
    const dy = S.y - H.y;
    const L = Math.hypot(dx, dy) || 1;
    const d = { x: dx / L, y: dy / L };
    const n = { x: -d.y, y: d.x };
    const C = { x: (H.x + S.x) / 2 + n.x * pose.arch, y: (H.y + S.y) / 2 + n.y * pose.arch };
    const breathe = 1 + 0.03 * pose.breath * Math.sin(time * Math.PI * 2 * pose.breathRate);
    const roll = clamp01(pose.roll);
    // Shoulder blades ride up as the near foreleg pushes back (a cat's rolling shoulder walk).
    const scapLift = clamp((S.x - pose.fnX) / 14, -1, 1) * (1 - pose.frontHidden);
    const waist = clamp(1.25 - chonk, 0, 0.6);
    const torso: RibbonPt[] = [];
    for (let i = 0; i < TORSO_SAMPLES; i++) {
      const t = lerp(T_START, T_END, i / (TORSO_SAMPLES - 1));
      let P: Vec2;
      let tan: Vec2;
      if (t < 0) {
        tan = quadTangent(H, C, S, 0);
        P = { x: H.x + tan.x * t * L, y: H.y + tan.y * t * L };
      } else if (t > 1) {
        tan = quadTangent(H, C, S, 1);
        P = { x: S.x + tan.x * (t - 1) * L, y: S.y + tan.y * (t - 1) * L };
      } else {
        P = quadPoint(H, C, S, t);
        tan = quadTangent(H, C, S, t);
      }
      const s = (t - 0.48) / ((T_END - T_START) / 2);
      const cap = Math.sqrt(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(s)), 2.6)));
      // Dorsal line: rump, slight dip behind the withers, shoulder blades.
      const dorsal = 1 + 0.05 * gauss(t, 0.08, 0.13) - 0.035 * gauss(t, 0.58, 0.16) + (0.05 + 0.045 * scapLift) * gauss(t, 0.86, 0.09);
      // Ventral line: deep chest, waist tuck (athletic cats), primordial pouch (chonky cats).
      const ventral = 1 + 0.09 * gauss(t, 0.8, 0.13) - 0.16 * waist * gauss(t, 0.3, 0.13) + 0.38 * Math.max(0, chonk - 0.85) * gauss(t, 0.36, 0.22);
      const haunchBot = 1 + 0.42 * pose.haunch * gauss(t, 0.04, 0.17);
      const haunchTop = 1 + 0.22 * pose.haunch * gauss(t, 0, 0.16);
      const top = pose.thickTop * k * cap * haunchTop * dorsal * breathe;
      const bot = pose.thickBot * k * cap * ventral * haunchBot * breathe;
      torso.push({
        x: P.x,
        y: P.y,
        nx: -tan.y,
        ny: tan.x,
        top: lerp(top, bot, roll),
        bot: lerp(bot, top, roll),
        tc: (t - T_START) / (T_END - T_START),
      });
    }

    // Head & neck — realistic skull on a short, thick neck.
    const r = HEAD_R * (0.94 + 0.08 * chonk);
    const hc = clampNeck(S, { x: S.x + (pose.headX - S.x) * HEAD_PULL, y: S.y + (pose.headY - S.y) * HEAD_PULL }, d);
    const head = { x: hc.x, y: hc.y, r, rot: pose.headRot };
    const neckBase = torso[Math.round(TORSO_SAMPLES * 0.75)];
    const ndx = head.x - neckBase.x;
    const ndy = head.y + r * 0.3 - neckBase.y;
    const nl = Math.hypot(ndx, ndy) || 1;
    const nnx = -ndy / nl;
    const nny = ndx / nl;
    const neck: RibbonPt[] = [];
    for (let i = 0; i <= 5; i++) {
      const f = i / 5;
      // Start well inside the chest (so the join never shows), swell into the ruff, then meet the jaw.
      const ruff = 1 + 0.08 * Math.sin(f * Math.PI);
      neck.push({
        x: neckBase.x + ndx * f,
        y: neckBase.y + ndy * f,
        nx: nnx,
        ny: nny,
        top: lerp(neckBase.top * 0.78, r * 0.74, f) * ruff,
        bot: lerp(neckBase.bot * 0.82, r * 0.84, f) * ruff,
        tc: lerp(0.84, 1, f),
      });
    }

    // Legs — anchors sit on the ventral side; they migrate to the top as the cat rolls over.
    const anchorSide = Math.cos(roll * Math.PI);
    // Elbows and hocks point backward; hocks also lift so they never dip through the floor.
    const backFront = { x: -0.97, y: 0.24 };
    // Standing, the hock rides up behind; sitting, it rests on the ground behind the haunch.
    const sitK = smoothstep(0.7, 1.3, pose.haunch);
    const bhx = lerp(-0.94, -0.72, sitK);
    const bhy = lerp(-0.34, 0.69, sitK);
    const bhl = Math.hypot(bhx, bhy) || 1;
    const backHind = { x: bhx / bhl, y: bhy / bhl };
    const front = torso[Math.round(TORSO_SAMPLES * 0.78)];
    const rear = torso[Math.round(TORSO_SAMPLES * 0.2)];
    const aF = { x: front.x + front.nx * front.bot * 0.42 * anchorSide - d.x * 1.5, y: front.y + front.ny * front.bot * 0.42 * anchorSide - d.y * 1.5 };
    const aH = { x: rear.x + rear.nx * rear.bot * 0.3 * anchorSide + d.x * 2.5, y: rear.y + rear.ny * rear.bot * 0.3 * anchorSide + d.y * 2.5 };
    const mk = (anchor: Vec2, tx: number, ty: number, l1: number, l2: number, hidden: number, curl: number, hind: boolean, wTop: number, wMid: number, wEnd: number): LegGeom => {
      const sol = solveIK(anchor, { x: tx, y: ty }, l1, l2, hind ? backHind : backFront);
      if (sol.k.y > -1.2 && ty > -2) {
        // A joint never sinks through the floor: rest it on the ground instead.
        sol.k = { x: sol.k.x, y: -1.2 };
      }
      return { a: anchor, k: sol.k, p: sol.p, hidden, curl, wTop: wTop * k, wMid: wMid * (0.8 + 0.2 * k), wEnd: wEnd * (0.85 + 0.15 * k), hind };
    };
    // Hind: long thigh+shin to the hock, then the long metatarsus; front: upper arm+forearm.
    // When sitting, the thigh *is* the haunch, so the leg's upper part slims to stay inside it.
    const thigh = 1 - 0.55 * smoothstep(0.7, 1.3, pose.haunch);
    const legs: Record<LegId, LegGeom> = {
      frontNear: mk(aF, pose.fnX, pose.fnY, 17, 17, pose.frontHidden, pose.fnCurl, false, 11.5, 6.6, 5.1),
      frontFar: mk({ x: aF.x - 4, y: aF.y }, pose.ffX, pose.ffY, 17, 17, pose.frontHidden, pose.ffCurl, false, 10.5, 6.2, 4.9),
      hindNear: mk(aH, pose.hnX, pose.hnY, 21, 15, pose.hindHidden, pose.hnCurl, true, 17.5 * thigh, 5.6, 4.9),
      hindFar: mk({ x: aH.x - 4, y: aH.y }, pose.hfX, pose.hfY, 21, 15, pose.hindHidden, pose.hfCurl, true, 15 * thigh, 5.3, 4.7),
    };

    const tailBase = torso[1];
    const tailAnchor = { x: tailBase.x - tailBase.nx * tailBase.top * 0.35 * (1 - 2 * roll) + d.x * 2, y: tailBase.y - tailBase.ny * tailBase.top * 0.35 * (1 - 2 * roll) + d.y * 2 };
    return {
      M,
      facing: tr.flip >= 0 ? 1 : -1,
      flipMag: Math.abs(tr.flip),
      torso,
      legs,
      head,
      neck,
      tailAnchor,
      tailAngle: pose.tailAngle,
      dBody: d,
      roll,
    };
  }

  /**
   * Local-space scruff (dorsal side of the neck base) and the point that hangs
   * straight below it when the cat is held up by it: the hips, so the spine
   * hangs (nearly) vertical, as a scruffed cat's does.
   */
  scruffLocal(skel: Skeleton): { scruff: Vec2; com: Vec2 } {
    const nb = skel.neck[1];
    const scruff = { x: nb.x - nb.nx * nb.top * 0.92, y: nb.y - nb.ny * nb.top * 0.92 };
    const hip = skel.torso[Math.floor(skel.torso.length * 0.18)];
    const mid = skel.torso[Math.floor(skel.torso.length * 0.45)];
    return { scruff, com: { x: (hip.x * 2 + mid.x) / 3, y: (hip.y * 2 + mid.y) / 3 } };
  }

  /** Last (rate-limited) local tail base angle, for TAIL_BASE_MAX_RATE. */
  private tailBase = NaN;

  /**
   * World-space anchor + base angle for the Verlet tail. With `dt` > 0 the base
   * direction is rate-limited (TAIL_BASE_MAX_RATE) so a state change can't flick it.
   */
  tailAnchorWorld(skel: Skeleton, pose: Pose, dt = 0): { x: number; y: number; angle: number } {
    const p = matApply(skel.M, skel.tailAnchor.x, skel.tailAnchor.y);
    let a = pose.tailAngle + pose.rot;
    if (dt > 0) {
      if (Number.isFinite(this.tailBase)) a = this.tailBase + clamp(wrapAngle(a - this.tailBase), -TAIL_BASE_MAX_RATE * dt, TAIL_BASE_MAX_RATE * dt);
      this.tailBase = a;
    }
    const angle = skel.facing > 0 ? a : Math.PI - a;
    return { x: p.x, y: p.y, angle };
  }

  /* ------------------------------------------------------------ drawing */

  private canvas(slot: 'layerA' | 'layerB' | 'maskC' | 'tmpC' | 'blurC', w: number, h: number): AnyCanvas {
    let c = this[slot];
    if (!c || c.width < w || c.height < h) {
      const nw = Math.max(w, c ? c.width : 0, 64);
      const nh = Math.max(h, c ? c.height : 0, 64);
      c = createCanvas(Math.ceil(nw * 1.15), Math.ceil(nh * 1.15));
      this[slot] = c;
    }
    return c;
  }

  draw(ctx: AnyCtx, skel: Skeleton, pose: Pose, tail: VerletTail, scale: number, opts: DrawOptions): Landmarks {
    const lm = this.landmarks(skel, tail, scale);
    const T = ctx.getTransform();
    const ds = clamp(Math.hypot(T.a, T.b), 0.25, 4);
    const pad = 12 * scale;
    const bx = Math.floor(lm.bounds.minX - pad);
    const by = Math.floor(lm.bounds.minY - pad);
    const bw = Math.ceil(lm.bounds.maxX - lm.bounds.minX + pad * 2);
    const bh = Math.ceil(lm.bounds.maxY - lm.bounds.minY + pad * 2);
    const W = Math.max(1, Math.ceil(bw * ds));
    const Hh = Math.max(1, Math.ceil(bh * ds));
    if (W > 4096 || Hh > 4096) return lm;
    const unit = ds * scale; // device px per local unit

    if (opts.grounded) this.drawGroundShadow(ctx, skel, pose, scale, opts.groundY);

    this.frame = { W, H: Hh, ds, bx, by };
    this.fringeK = clamp((unit - 1) / 2, 0.4, 1) * (renderQuality.level >= 1 ? 1 : 0.6);
    const overlayLeg = pose.hindNearFront >= 0.95 && skel.legs.hindNear.hidden < 0.98;
    const A = this.canvas('layerA', W, Hh);
    const actx = ctx2d(A);
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.globalAlpha = 1;
    actx.globalCompositeOperation = 'source-over';
    actx.clearRect(0, 0, A.width, A.height);
    actx.setTransform(ds, 0, 0, ds, -bx * ds, -by * ds);
    actx.imageSmoothingEnabled = true;
    this.paintBody(actx, skel, pose, tail, scale, unit, overlayLeg);
    this.shade(A, W, Hh, unit);
    actx.setTransform(ds, 0, 0, ds, -bx * ds, -by * ds);
    this.withHead(actx, skel, () => this.drawFace(actx, skel, pose, opts.time, unit));

    let B: AnyCanvas | null = null;
    if (overlayLeg) {
      B = this.canvas('layerB', W, Hh);
      const bctx = ctx2d(B);
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, B.width, B.height);
      bctx.setTransform(ds, 0, 0, ds, -bx * ds, -by * ds);
      bctx.save();
      bctx.transform(skel.M.a, skel.M.b, skel.M.c, skel.M.d, skel.M.e, skel.M.f);
      this.drawLeg(bctx, skel.legs.hindNear, UV.legs.hindNear, false, 'hindNear', unit, true);
      bctx.restore();
      this.shade(B, W, Hh, unit);
    }

    ctx.save();
    ctx.globalAlpha = opts.alpha ?? 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(A as CanvasImageSource, 0, 0, W, Hh, bx, by, W / ds, Hh / ds);
    if (B) ctx.drawImage(B as CanvasImageSource, 0, 0, W, Hh, bx, by, W / ds, Hh / ds);
    ctx.restore();
    return lm;
  }

  /** Paints every furred part into the layer (no face details, no lighting yet). */
  private paintBody(ctx: AnyCtx, skel: Skeleton, pose: Pose, tail: VerletTail, scale: number, unit: number, overlayLeg: boolean): void {
    const img = this.tex.canvas as CanvasImageSource;
    const M = skel.M;
    const tailFront = pose.tailFront > 0.5;

    // Far legs first, then darken them (they sit in the body's shadow).
    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    this.drawLeg(ctx, skel.legs.hindFar, UV.legs.hindFar, true, 'hindFar', unit, false);
    this.drawLeg(ctx, skel.legs.frontFar, UV.legs.frontFar, true, 'frontFar', unit, false);
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(28,18,10,0.14)';
    ctx.fillRect(0, 0, 4096, 4096);
    ctx.restore();

    if (!tailFront) this.drawTail(ctx, tail, scale, pose, unit, false);

    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    if (pose.hindNearFront <= 0.5) this.drawLeg(ctx, skel.legs.hindNear, UV.legs.hindNear, false, 'hindNear', unit, false);
    this.drawTorso(ctx, img, skel, pose, unit);
    if (pose.tuck > 0.05) this.drawMittens(ctx, skel, pose, unit);
    this.drawNeck(ctx, img, skel);
    ctx.restore();
    this.drawLegFaded(ctx, skel, 'frontNear', unit);
    if (pose.hindNearFront > 0.5 && !overlayLeg) this.drawLegFaded(ctx, skel, 'hindNear', unit);
    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    this.drawPads(ctx, skel, pose);
    ctx.restore();

    if (tailFront) this.drawTail(ctx, tail, scale, pose, unit, true);

    this.withHead(ctx, skel, () => this.drawHeadFur(ctx, img, skel, pose, unit));
  }

  /** Runs `fn` in head-local space (+x toward the face), undoing the turn-around squash. */
  private withHead(ctx: AnyCtx, skel: Skeleton, fn: () => void): void {
    const M = skel.M;
    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    ctx.translate(skel.head.x, skel.head.y);
    ctx.rotate(skel.head.rot);
    // Mid-turn the body foreshortens, but a skull never flattens into a card.
    const fm = Math.max(0.001, skel.flipMag);
    if (fm < 0.82) ctx.scale(0.82 / fm, 1);
    fn();
    ctx.restore();
  }

  /** Effective 3/4 turn of the face (frontal while the body turns around). */
  private faceTurn(skel: Skeleton, pose: Pose): number {
    return clamp01(pose.faceTurn) * smoothstep(0.25, 0.9, skel.flipMag);
  }

  /* --------------------------------------------------------- lighting */

  /**
   * One lighting pass over the union silhouette: core shadow away from the key
   * light, a soft sheen toward it and ambient occlusion around the rim — all from
   * blurred copies of the alpha mask, so overlapping parts shade as one body.
   */
  private shade(layer: AnyCanvas, W: number, H: number, unit: number): void {
    // Lighting is low-frequency, so it is computed at reduced resolution and
    // upsampled: a fraction of the blur cost with no visible difference.
    const q = renderQuality.level >= 1 ? 0.34 : 0.25;
    const mw = Math.max(1, Math.ceil(W * q));
    const mh = Math.max(1, Math.ceil(H * q));
    const u = unit * q;
    const mask = this.canvas('maskC', mw, mh);
    const tmp = this.canvas('tmpC', Math.max(mw, W), Math.max(mh, H));
    const m = ctx2d(mask);
    const t = ctx2d(tmp);
    const l = ctx2d(layer);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.imageSmoothingEnabled = true;
    m.clearRect(0, 0, mask.width, mask.height);
    m.drawImage(layer as CanvasImageSource, 0, 0, W, H, 0, 0, mw, mh);
    m.globalCompositeOperation = 'source-in';
    m.fillStyle = '#000';
    m.fillRect(0, 0, mw, mh);
    m.globalCompositeOperation = 'source-over';

    // One blur of the silhouette, reused at different offsets for every band.
    const blurred = this.canvas('blurC', mw + 2, mh + 2);
    const b = ctx2d(blurred);
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, blurred.width, blurred.height);
    b.filter = `blur(${(3.8 * u).toFixed(2)}px)`;
    b.drawImage(mask as CanvasImageSource, 0, 0, mw, mh, 0, 0, mw, mh);
    b.filter = 'none';

    const pass = (dx: number, dy: number, color: string, alpha: number) => {
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, mw + 2, mh + 2);
      t.drawImage(mask as CanvasImageSource, 0, 0, mw, mh, 0, 0, mw, mh);
      t.globalCompositeOperation = 'destination-out';
      t.drawImage(blurred as CanvasImageSource, 0, 0, mw, mh, dx, dy, mw, mh);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = color;
      t.fillRect(0, 0, mw, mh);
      t.globalCompositeOperation = 'source-over';
      l.save();
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.globalCompositeOperation = 'source-atop';
      l.globalAlpha = alpha;
      l.imageSmoothingEnabled = true;
      l.drawImage(tmp as CanvasImageSource, 0, 0, mw, mh, 0, 0, W, H);
      l.restore();
    };
    const d = 4.2 * u;
    // Core shadow on the side away from the light (warm, like fur in shade).
    pass(LIGHT.x * d, LIGHT.y * d, 'rgb(46,28,16)', 0.44);
    if (renderQuality.level < 1) return;
    // Sheen on the lit side.
    pass(-LIGHT.x * d * 0.7, -LIGHT.y * d * 0.7, 'rgb(255,246,228)', 0.22);
    // Ambient occlusion: everything darkens slightly as it turns away at the rim.
    pass(0, 0, 'rgb(30,20,12)', 0.2);
  }

  /** Soft contact shadow of a part onto whatever is already painted beneath it. */
  private castShadow(ctx: AnyCtx, path: Path2D, unit: number, alpha: number, blurUnits = 1.8): void {
    const far = 4000;
    ctx.save();
    // Draw the shape far away and let only its blurred shadow land in place
    // (shadow blur/offset are in device pixels, independent of the transform).
    const T = ctx.getTransform();
    ctx.setTransform(T.a, T.b, T.c, T.d, T.e + far, T.f);
    ctx.shadowColor = `rgba(24,14,8,${alpha})`;
    ctx.shadowBlur = blurUnits * unit;
    ctx.shadowOffsetX = -far + 0.6 * unit;
    ctx.shadowOffsetY = 0.9 * unit;
    ctx.fillStyle = '#000';
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fill(path);
    ctx.restore();
  }

  private drawGroundShadow(ctx: AnyCtx, skel: Skeleton, pose: Pose, scale: number, groundY: number): void {
    const M = skel.M;
    const c = matApply(M, (pose.hipX + pose.shX) / 2, 0);
    const len = Math.abs(pose.shX - pose.hipX) * scale;
    const lying = clamp01((-Math.min(pose.hipY, pose.shY) - 10) / 20);
    const w = len * 0.75 + 20 * scale;
    ctx.save();
    // Broad ambient shadow.
    const g = ctx.createRadialGradient(c.x, groundY, 1, c.x, groundY, w);
    g.addColorStop(0, `rgba(22,15,10,${0.2 + 0.08 * (1 - lying)})`);
    g.addColorStop(0.6, 'rgba(22,15,10,0.07)');
    g.addColorStop(1, 'rgba(22,15,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, groundY - 0.5, w, (4 + 3 * (1 - lying)) * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tight occlusion right under the body / paws.
    const legs = skel.legs;
    for (const id of ['frontNear', 'frontFar', 'hindNear', 'hindFar'] as LegId[]) {
      const lg = legs[id];
      if (lg.hidden > 0.6) continue;
      const p = matApply(M, lg.p.x, lg.p.y);
      if (Math.abs(p.y - groundY) > 3 * scale) continue;
      const rg = ctx.createRadialGradient(p.x, groundY, 0, p.x, groundY, 6 * scale);
      rg.addColorStop(0, 'rgba(18,12,8,0.3)');
      rg.addColorStop(1, 'rgba(18,12,8,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(p.x, groundY, 6 * scale, 2 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ torso */

  private drawTorso(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton, pose: Pose, unit: number): void {
    const pts = skel.torso;
    const roll = skel.roll;
    const outline = new Path2D();
    ribbonPath(outline, pts);
    ctx.save();
    ctx.clip(outline);
    if (roll < 0.02) {
      drawRibbonTexture(ctx, img, UV.torso, pts, 'x', 0, 1);
    } else {
      // Rolling over: the visible band of the coat cylinder is v ∈ [roll, 1 + roll].
      const f = clamp(1 - roll, 0, 1);
      if (f < 0.99) {
        const lower = pts.map((p) => ({ x: p.x + p.nx * p.bot, y: p.y + p.ny * p.bot, nx: -p.nx, ny: -p.ny, top: 0, bot: (p.top + p.bot) * (1 - f), tc: p.tc }));
        drawRibbonTexture(ctx, img, UV.torso, lower, 'x', 1 - roll, 1);
      }
      if (f > 0.01) {
        // Slightly overlap the lower band so the ventral midline never shows a seam.
        const over = 0.05;
        const upper = pts.map((p) => ({ x: p.x - p.nx * p.top, y: p.y - p.ny * p.top, nx: p.nx, ny: p.ny, top: 0, bot: (p.top + p.bot) * Math.min(1, f + over), tc: p.tc }));
        drawRibbonTexture(ctx, img, UV.torso, upper, 'x', roll, 0.995);
      }
    }
    // Haunch / thigh roundness: the hind quarter catches light as its own mass.
    const hq = pts[Math.round(pts.length * 0.16)];
    const hr = (hq.top + hq.bot) * (0.55 + 0.15 * pose.haunch);
    const hx = hq.x + hq.nx * (hq.bot - hq.top) * 0.25;
    const hy = hq.y + hq.ny * (hq.bot - hq.top) * 0.25;
    const g = ctx.createRadialGradient(hx - hr * 0.3, hy - hr * 0.35, hr * 0.1, hx, hy, hr);
    g.addColorStop(0, 'rgba(255,248,232,0.12)');
    g.addColorStop(0.6, 'rgba(255,255,255,0)');
    g.addColorStop(0.85, 'rgba(40,26,14,0.1)');
    g.addColorStop(1, 'rgba(40,26,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    // Shoulder mass.
    const sq = pts[Math.round(pts.length * 0.8)];
    const sr = (sq.top + sq.bot) * 0.5;
    const sg = ctx.createRadialGradient(sq.x - sr * 0.2, sq.y - sr * 0.4, sr * 0.1, sq.x, sq.y, sr * 1.1);
    sg.addColorStop(0, 'rgba(255,248,232,0.1)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(sq.x - sr * 1.2, sq.y - sr * 1.2, sr * 2.4, sr * 2.4);
    ctx.restore();

    this.torsoFringe(ctx, pts, roll, unit);
  }

  private torsoFringe(ctx: AnyCtx, pts: RibbonPt[], roll: number, unit: number): void {
    const tex = this.tex;
    const f = this.furF;
    const top: EdgeHair[] = [];
    const bot: EdgeHair[] = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      // Fur lies back toward the rump (−tangent): tangent = (ny, −nx).
      const fx = -p.ny;
      const fy = p.nx;
      const tcol = tex.sample(UV.torso.x + p.tc * UV.torso.w, UV.torso.y + clamp(roll + 0.03, 0.03, 0.97) * UV.torso.h);
      const bcol = tex.sample(UV.torso.x + p.tc * UV.torso.w, UV.torso.y + clamp(1 - roll - 0.04, 0.03, 0.97) * UV.torso.h);
      const belly = gauss(p.tc, 0.5, 0.25);
      const chest = gauss(p.tc, 0.88, 0.07);
      top.push({ x: p.x - p.nx * p.top * 0.97, y: p.y - p.ny * p.top * 0.97, nx: -p.nx, ny: -p.ny, fx, fy, color: rgbStr(tcol, 1.08), len: 0.9 * f });
      bot.push({
        x: p.x + p.nx * p.bot * 0.96,
        y: p.y + p.ny * p.bot * 0.96,
        nx: p.nx,
        ny: p.ny,
        fx: fx * (1 - chest) + p.nx * chest,
        fy: fy * (1 - chest) + p.ny * chest,
        color: rgbStr(bcol),
        len: (1.2 + 0.7 * belly + 0.9 * chest) * f,
      });
    }
    const w = Math.max(0.22, 0.55 / unit);
    drawFringe(ctx, top, w, f > 1.2 ? 4 : 3, 11, 0.4 * this.fringeK);
    drawFringe(ctx, bot, w, f > 1.2 ? 6 : 4, 23, 0.5 * this.fringeK);
  }

  private drawNeck(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton): void {
    const pts = skel.neck;
    const path = new Path2D();
    ribbonPath(path, pts, true, true);
    ctx.save();
    ctx.clip(path);
    drawRibbonTexture(ctx, img, UV.torso, pts, 'x', 0, skel.roll > 0.5 ? 0.6 : 1);
    ctx.restore();
    // Throat ruff: soft, longer hairs under the jaw.
    const tex = this.tex;
    const edge: EdgeHair[] = [];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const c = tex.sample(UV.torso.x + p.tc * UV.torso.w - 4, UV.torso.y + UV.torso.h * 0.9);
      edge.push({ x: p.x + p.nx * p.bot * 0.95, y: p.y + p.ny * p.bot * 0.95, nx: p.nx, ny: p.ny, fx: p.nx * 0.6 - p.ny * 0.4, fy: p.ny * 0.6 + p.nx * 0.4, color: rgbStr(c), len: 2.2 * this.furF });
    }
    drawFringe(ctx, edge, 0.4, 5, 41, 0.6 * this.fringeK);
  }

  /* ------------------------------------------------------------- legs */

  /** Samples an anatomically tapered ribbon along two straight bones (anchor → joint → paw). */
  private legRibbon(leg: LegGeom): RibbonPt[] {
    const { a, k, p } = leg;
    const n1 = (() => {
      const l = Math.hypot(k.x - a.x, k.y - a.y) || 1;
      return { x: -(k.y - a.y) / l, y: (k.x - a.x) / l };
    })();
    const n2 = (() => {
      const l = Math.hypot(p.x - k.x, p.y - k.y) || 1;
      return { x: -(p.y - k.y) / l, y: (p.x - k.x) / l };
    })();
    let nk = { x: n1.x + n2.x, y: n1.y + n2.y };
    const nkl = Math.hypot(nk.x, nk.y) || 1;
    nk = { x: nk.x / nkl, y: nk.y / nkl };
    const width = (f: number): number => {
      let w: number;
      if (leg.hind) {
        // Muscular thigh that stays full, then a slim shank and metatarsus.
        w = f < 0.5 ? lerp(leg.wTop, leg.wMid, Math.pow(smoothstep(0, 0.5, f), 0.75)) : lerp(leg.wMid, leg.wEnd, (f - 0.5) / 0.5);
        w *= 1 + 0.14 * gauss(f, 0.5, 0.05); // hock
      } else {
        w = f < 0.5 ? lerp(leg.wTop, leg.wMid, smoothstep(0, 0.5, f)) : lerp(leg.wMid, leg.wEnd, (f - 0.5) / 0.5);
        w *= 1 - 0.1 * gauss(f, 0.84, 0.06); // wrist
        w *= 1 + 0.08 * gauss(f, 0.47, 0.06); // elbow
      }
      return w;
    };
    const pts: RibbonPt[] = [];
    const push = (x: number, y: number, n: Vec2, f: number) => {
      const w = width(f);
      pts.push({ x, y, nx: n.x, ny: n.y, top: w / 2, bot: w / 2, tc: f * 0.92 });
    };
    for (const f of [0, 0.14, 0.28, 0.4]) push(lerp(a.x, k.x, f / 0.5), lerp(a.y, k.y, f / 0.5), n1, f);
    push(k.x, k.y, nk, 0.5);
    for (const f of [0.6, 0.72, 0.84, 1]) push(lerp(k.x, p.x, (f - 0.5) / 0.5), lerp(k.y, p.y, (f - 0.5) / 0.5), n2, f);
    return pts;
  }

  private drawLeg(ctx: AnyCtx, leg: LegGeom, rect: UVRect, far: boolean, id: LegId, unit: number, castOnBody: boolean): void {
    const alpha = 1 - clamp01(leg.hidden);
    if (alpha <= 0.02) return;
    const pts = this.legRibbon(leg);
    const path = new Path2D();
    ribbonPath(path, pts, true, false);
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (castOnBody) this.castShadow(ctx, path, unit, 0.32);
    ctx.save();
    ctx.clip(path);
    const img = this.tex.canvas as CanvasImageSource;
    const wMax = Math.max(leg.wTop, leg.wMid, leg.wEnd) * 1.25;
    drawBoneTexture(ctx, img, rect, leg.k, leg.p, wMax, 0.46, 0.92, 4);
    drawBoneTexture(ctx, img, rect, leg.a, leg.k, wMax, 0, 0.46, 4);
    ctx.restore();

    // Hair fringe on both sides; leg fur flows down toward the paw.
    for (const s of [-1, 1]) {
      const edge: EdgeHair[] = [];
      for (let i = 2; i < pts.length - 1; i++) {
        const p = pts[i];
        const c = this.tex.sample(rect.x + rect.w / 2, rect.y + p.tc * rect.h);
        edge.push({ x: p.x + s * p.nx * p.top * 0.96, y: p.y + s * p.ny * p.top * 0.96, nx: s * p.nx, ny: s * p.ny, fx: p.ny, fy: -p.nx, color: rgbStr(c), len: (leg.hind && i < 5 ? 1.1 : 0.7) * this.furF });
      }
      drawFringe(ctx, edge, Math.max(0.22, 0.5 / unit), 2, id.length * 7 + (far ? 3 : 0) + s * 17, 0.45 * this.fringeK);
    }
    this.drawPaw(ctx, leg, rect, far, pts);
    ctx.restore();
  }

  /**
   * Near legs sit on top of the body, but a real upper arm / thigh melts into the
   * chest and haunch under the fur. Paint the leg on a scratch layer, fade its top
   * out along the bone, then composite it over the body.
   */
  private drawLegFaded(ctx: AnyCtx, skel: Skeleton, id: LegId, unit: number): void {
    const leg = skel.legs[id];
    if (leg.hidden > 0.98) return;
    const { W, H, ds, bx, by } = this.frame;
    const M = skel.M;
    const tmp = this.canvas('tmpC', W, H);
    const t = ctx2d(tmp);
    // Device-space box around the leg (plus paw and fur) so clears and copies stay small.
    const pad = Math.max(leg.wTop, 8) * 1.4;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const pt of [leg.a, leg.k, leg.p]) {
      for (const [ox, oy] of [
        [-pad, -pad],
        [pad, pad],
        [-pad, pad],
        [pad, -pad],
      ]) {
        const w = matApply(M, pt.x + ox, pt.y + oy);
        x0 = Math.min(x0, w.x);
        y0 = Math.min(y0, w.y);
        x1 = Math.max(x1, w.x);
        y1 = Math.max(y1, w.y);
      }
    }
    const rx = clamp(Math.floor((x0 - bx) * ds), 0, W);
    const ry = clamp(Math.floor((y0 - by) * ds), 0, H);
    const rw = clamp(Math.ceil((x1 - bx) * ds), 0, W) - rx;
    const rh = clamp(Math.ceil((y1 - by) * ds), 0, H) - ry;
    if (rw <= 0 || rh <= 0) return;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    t.clearRect(rx, ry, rw, rh);
    t.save();
    t.beginPath();
    t.rect(rx, ry, rw, rh);
    t.clip();
    t.setTransform(ds, 0, 0, ds, -bx * ds, -by * ds);
    t.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    t.imageSmoothingEnabled = true;
    this.drawLeg(t, leg, UV.legs[id], false, id, unit, false);
    // Fade the top of the leg into the body.
    const fadeEnd = { x: lerp(leg.a.x, leg.k.x, leg.hind ? 0.7 : 0.66), y: lerp(leg.a.y, leg.k.y, leg.hind ? 0.7 : 0.66) };
    const g = t.createLinearGradient(leg.a.x, leg.a.y, fadeEnd.x, fadeEnd.y);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3, 'rgba(0,0,0,0.12)');
    g.addColorStop(0.65, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    t.globalCompositeOperation = 'destination-in';
    t.fillStyle = g;
    t.fillRect(-400, -400, 800, 800);
    t.globalCompositeOperation = 'source-over';
    t.restore();
    // Soft contact shadow of the visible part onto the body, then the leg itself.
    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    const lower = this.legRibbon(leg).slice(4);
    const path = new Path2D();
    ribbonPath(path, lower, true, false);
    this.castShadow(ctx, path, unit, 0.36, 2.2);
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp as CanvasImageSource, rx, ry, rw, rh, rx, ry, rw, rh);
    ctx.restore();
  }

  private drawPaw(ctx: AnyCtx, leg: LegGeom, rect: UVRect, far: boolean, pts: RibbonPt[]): void {
    const c = this.tex.sample(rect.x + rect.w / 2, rect.y + rect.h * 0.97);
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 3];
    const dir = Math.atan2(end.y - prev.y, end.x - prev.x);
    // Planted paws lie flat; lifted paws hang and flex with the curl.
    const curl = clamp01(leg.curl);
    const flat = leg.p.y > -1.2 ? 1 : 0;
    const ang = lerp((dir - Math.PI / 2) * 0.35, (dir - Math.PI / 2) * 0.9 + 0.25, curl) * (1 - 0.6 * flat);
    const L = (leg.hind ? 6.4 : 5.8) * this.chonkK;
    const Hh = (leg.hind ? 3.4 : 3.6) * this.chonkK;
    ctx.save();
    ctx.translate(leg.p.x, leg.p.y - Hh * 0.45);
    ctx.rotate(ang);
    const paw = new Path2D();
    // Rounded, slightly wedge-shaped paw with a fuller toe end (pointing +x).
    paw.moveTo(-L * 0.45, -Hh * 0.55);
    paw.bezierCurveTo(L * 0.1, -Hh * 0.75, L * 0.7, -Hh * 0.6, L * 0.82, Hh * 0.05);
    paw.bezierCurveTo(L * 0.86, Hh * 0.55, L * 0.5, Hh * 0.62, 0, Hh * 0.6);
    paw.bezierCurveTo(-L * 0.42, Hh * 0.58, -L * 0.6, Hh * 0.1, -L * 0.45, -Hh * 0.55);
    paw.closePath();
    const g = ctx.createLinearGradient(0, -Hh * 0.7, 0, Hh * 0.7);
    g.addColorStop(0, rgbStr(c, far ? 0.9 : 1.02));
    g.addColorStop(1, rgbStr(c, far ? 0.8 : 0.93));
    ctx.fillStyle = g;
    ctx.fill(paw);
    // Toe separations: soft creases on the front of the paw.
    ctx.strokeStyle = 'rgba(70,52,40,0.28)';
    ctx.lineWidth = 0.32;
    ctx.lineCap = 'round';
    for (const tx of [0.42, 0.62]) {
      ctx.beginPath();
      ctx.moveTo(L * tx, -Hh * 0.42);
      ctx.quadraticCurveTo(L * (tx + 0.04), -Hh * 0.05, L * (tx + 0.02), Hh * 0.28);
      ctx.stroke();
    }
    // Tiny hairs over the toes.
    ctx.strokeStyle = rgbStr(c, 1.04);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const x = L * (0.1 + i * 0.13);
      ctx.moveTo(x, -Hh * 0.55);
      ctx.lineTo(x + 0.5, -Hh * 0.8);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPads(ctx: AnyCtx, skel: Skeleton, pose: Pose): void {
    if (pose.pads < 0.05) return;
    const pal = this.profile.palette;
    ctx.save();
    ctx.globalAlpha *= clamp01(pose.pads);
    for (const id of ['frontNear', 'frontFar', 'hindNear'] as LegId[]) {
      const leg = skel.legs[id];
      if (leg.hidden > 0.6) continue;
      const curl = id === 'hindNear' ? pose.hnCurl : id === 'frontNear' ? pose.fnCurl : pose.ffCurl;
      if (curl < 0.25 && skel.roll < 0.6) continue;
      const cx = leg.p.x + 0.8;
      const cy = leg.p.y - 0.4;
      const g = ctx.createRadialGradient(cx - 0.4, cy - 0.4, 0.2, cx, cy, 2.2);
      g.addColorStop(0, mixHex(pal.pawPads, '#FFFFFF', 0.25));
      g.addColorStop(1, shadeHex(pal.pawPads, -0.12));
      ctx.fillStyle = g;
      // Heart-ish metacarpal pad.
      ctx.beginPath();
      ctx.moveTo(cx - 1.9, cy - 0.2);
      ctx.bezierCurveTo(cx - 1.8, cy + 1.5, cx + 1.8, cy + 1.5, cx + 1.9, cy - 0.2);
      ctx.bezierCurveTo(cx + 1.4, cy - 1.3, cx - 1.4, cy - 1.3, cx - 1.9, cy - 0.2);
      ctx.fill();
      for (const [ox, oy] of [
        [-1.6, -2.2],
        [-0.1, -2.9],
        [1.5, -2.8],
        [2.8, -1.9],
      ]) {
        ctx.beginPath();
        ctx.ellipse(cx + ox, cy + oy, 0.75, 0.66, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawMittens(ctx: AnyCtx, skel: Skeleton, pose: Pose, unit: number): void {
    const pts = skel.torso;
    const chest = pts[Math.round(pts.length * 0.8)];
    const bx = chest.x + chest.nx * chest.bot * 0.8;
    const by = Math.min(-2, chest.y + chest.ny * chest.bot * 0.85);
    const c = this.tex.sample(UV.legs.frontNear.x + 32, UV.legs.frontNear.y + 246);
    ctx.save();
    ctx.globalAlpha *= clamp01(pose.tuck);
    for (const ox of [-1.5, 4.5]) {
      const path = new Path2D();
      path.ellipse(bx + ox, by + 1.2, 3.8 * this.chonkK, 2.3, 0, 0, Math.PI * 2);
      this.castShadow(ctx, path, unit, 0.25, 1.2);
      const g = ctx.createLinearGradient(0, by - 1, 0, by + 3.5);
      g.addColorStop(0, rgbStr(c, 1.02));
      g.addColorStop(1, rgbStr(c, 0.85));
      ctx.fillStyle = g;
      ctx.fill(path);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- tail */

  private drawTail(ctx: AnyCtx, tail: VerletTail, scale: number, pose: Pose, unit: number, inFront: boolean): void {
    const nodes = tail.nodes.map((n) => ({ x: n.x, y: n.y }));
    const pts = catmullRom(nodes, renderQuality.level >= 1 ? 4 : 3);
    if (pts.length < 2) return;
    const puff = 1 + 0.9 * clamp01(pose.tailPuff);
    const base = 3.9 * scale * this.chonkK * (0.85 + 0.15 * this.furF) * puff;
    const tip = 1.5 * scale * (0.8 + 0.35 * this.furF) * (1 + 0.5 * clamp01(pose.tailPuff));
    const rib: RibbonPt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const f = i / (pts.length - 1);
      const w = lerp(base, tip, Math.pow(f, 1.15)) * (1 + 0.08 * gauss(f, 0.05, 0.08)) * (this.furF > 1.6 ? 1 + 0.35 * Math.sin(f * Math.PI) : 1);
      rib.push({ x: pts[i].x, y: pts[i].y, nx: -(b.y - a.y) / l, ny: (b.x - a.x) / l, top: w, bot: w, tc: f * 0.98 });
    }
    const path = new Path2D();
    ribbonPath(path, rib, true, true);
    if (inFront) this.castShadow(ctx, path, ctx.getTransform().a, 0.3, 1.6 * scale);
    ctx.save();
    ctx.clip(path);
    // The outline uses every sample; the texture only needs every other one.
    const texRib = rib.filter((_, i) => i % 2 === 0 || i === rib.length - 1);
    drawRibbonTexture(ctx, this.tex.canvas as CanvasImageSource, UV.tail, texRib, 'x', 0, 1);
    ctx.restore();
    // Hair fringe; fur flows toward the tip and fluffs out with fur length / puff.
    const len = (0.8 + 1.2 * clamp01(pose.tailPuff) + (this.furF - 1) * 1.6) * scale;
    for (const s of [-1, 1]) {
      const edge: EdgeHair[] = [];
      for (let i = 1; i < rib.length; i += 2) {
        const p = rib[i];
        const c = this.tex.sample(UV.tail.x + p.tc * UV.tail.w, UV.tail.y + UV.tail.h * (s < 0 ? 0.3 : 0.7));
        edge.push({ x: p.x + s * p.nx * p.top * 0.95, y: p.y + s * p.ny * p.top * 0.95, nx: s * p.nx, ny: s * p.ny, fx: p.ny, fy: -p.nx, color: rgbStr(c), len });
      }
      drawFringe(ctx, edge, Math.max(0.3 * scale, 0.5 / ctx.getTransform().a), 3, 61 + s * 7, 0.55 * this.fringeK);
    }
    void unit;
  }

  /* ------------------------------------------------------------- head */

  /** Skull outline in head radii for a given 3/4 turn. */
  private headOutline(r: number, ft: number): Vec2[] {
    const chonk = this.profile.morphology.chonk;
    const jowl = 1 + 0.12 * clamp(chonk - 1, -0.3, 0.4) + 0.05 * (this.furF - 1);
    const base: [number, number][] = [
      [0, -0.86],
      [0.46, -0.79],
      [0.8, -0.46],
      [0.98, -0.04],
      [0.9 * jowl, 0.3],
      [0.55 * jowl, 0.56],
      [0.18, FACE.chin],
      [-0.18, FACE.chin],
      [-0.55 * jowl, 0.56],
      [-0.9 * jowl, 0.3],
      [-0.98, -0.04],
      [-0.8, -0.46],
      [-0.46, -0.79],
    ];
    return base.map(([x, y]) => {
      let X = x;
      if (x > 0) X += ft * 0.12 * (y > 0.05 ? 1.2 : 0.4); // muzzle and cheek come forward in 3/4
      else X *= 1 - 0.24 * ft;
      return { x: (X + ft * 0.16) * r, y: y * r };
    });
  }

  private drawHeadFur(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton, pose: Pose, unit: number): void {
    const { r } = skel.head;
    const ft = this.faceTurn(skel, pose);
    const shift = ft * 0.16 * r;

    this.drawEar(ctx, -1, r, pose.earL, ft, unit);
    this.drawEar(ctx, 1, r, pose.earR, ft, unit);

    const outline = this.headOutline(r, ft);
    const smooth = catmullRom([...outline, outline[0], outline[1], outline[2]], 4).slice(4 * 1, 4 * (outline.length + 1) + 1);
    const headPath = new Path2D();
    smooth.forEach((p, i) => (i === 0 ? headPath.moveTo(p.x, p.y) : headPath.lineTo(p.x, p.y)));
    headPath.closePath();
    // Head casts a soft shadow onto neck / shoulders.
    this.castShadow(ctx, headPath, unit, 0.3, 2);
    ctx.save();
    ctx.clip(headPath);
    ctx.save();
    ctx.translate(shift, FACE.eyeY * r);
    if (skel.facing < 0) ctx.scale(-1, 1);
    ctx.scale(TEX_SX * r * (1 - 0.1 * ft), TEX_SY * r);
    ctx.drawImage(img, UV.head.x, UV.head.y, UV.head.w, UV.head.h, -HEAD_TEMPLATE.cx, -HEAD_TEMPLATE.eyeY, UV.head.w, UV.head.h);
    ctx.restore();
    // Brow ridge & cheekbones catch light; eye sockets and muzzle sides sit in shade.
    const pal = this.profile.palette;
    for (const s of [-1, 1]) {
      const ex = shift + s * FACE.eyeX * r * (s > 0 ? 1 : 1 - 0.3 * ft);
      const sock = ctx.createRadialGradient(ex, FACE.eyeY * r, 0.05 * r, ex, FACE.eyeY * r, 0.34 * r);
      sock.addColorStop(0, 'rgba(30,18,10,0.22)');
      sock.addColorStop(1, 'rgba(30,18,10,0)');
      ctx.fillStyle = sock;
      ctx.fillRect(ex - 0.4 * r, (FACE.eyeY - 0.4) * r, 0.8 * r, 0.8 * r);
    }
    // Whisker pads: two soft swellings either side of the philtrum.
    for (const s of [-1, 1]) {
      const px = shift + ft * 0.06 * r + s * 0.15 * r * (s > 0 ? 1 : 1 - 0.3 * ft);
      const py = 0.36 * r;
      const wp = ctx.createRadialGradient(px - 0.03 * r, py - 0.05 * r, 0.01 * r, px, py, 0.17 * r);
      wp.addColorStop(0, 'rgba(255,252,246,0.2)');
      wp.addColorStop(0.6, 'rgba(255,255,255,0)');
      wp.addColorStop(0.85, 'rgba(40,26,16,0.1)');
      wp.addColorStop(1, 'rgba(40,26,16,0)');
      ctx.fillStyle = wp;
      ctx.fillRect(px - 0.2 * r, py - 0.2 * r, 0.4 * r, 0.4 * r);
    }
    // Chin shadow under the lower lip.
    const cg = ctx.createRadialGradient(shift + ft * 0.06 * r, 0.6 * r, 0.02 * r, shift, 0.62 * r, 0.3 * r);
    cg.addColorStop(0, 'rgba(30,20,12,0.18)');
    cg.addColorStop(1, 'rgba(30,20,12,0)');
    ctx.fillStyle = cg;
    ctx.fillRect(-r, 0.3 * r, 2 * r, 0.6 * r);
    void pal;
    ctx.restore();

    // Fur fringe around the skull; cheek ruff is fuller and flows back.
    const edge: EdgeHair[] = [];
    const n = smooth.length;
    for (let i = 0; i < n; i += 2) {
      const p = smooth[i];
      const q = smooth[(i + 1) % n];
      const o = smooth[(i - 1 + n) % n];
      let nx = q.y - o.y;
      let ny = -(q.x - o.x);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      if (nx * (p.x - shift) + ny * p.y < 0) {
        nx = -nx;
        ny = -ny;
      }
      const tx = HEAD_TEMPLATE.cx + (p.x - shift) / (TEX_SX * r) * (skel.facing < 0 ? -1 : 1) * 0.92;
      const ty = HEAD_TEMPLATE.eyeY + (p.y - FACE.eyeY * r) / (TEX_SY * r) * 0.92;
      const c = this.tex.sample(UV.head.x + clamp(tx, 2, 190), UV.head.y + clamp(ty, 2, 190));
      const cheek = p.y > -0.1 * r && p.y < 0.5 * r ? 1 : 0;
      edge.push({ x: p.x - nx * 0.04 * r, y: p.y - ny * 0.04 * r, nx, ny, fx: Math.sign(p.x - shift) * 0.8, fy: 0.45, color: rgbStr(c), len: (0.08 + 0.08 * cheek) * r * this.furF });
    }
    drawFringe(ctx, edge, Math.max(0.25, 0.5 / unit), 3, 77, 0.6 * Math.max(0.6, this.fringeK));
  }

  private drawEar(ctx: AnyCtx, side: 1 | -1, r: number, deg: number, ft: number, unit: number): void {
    const pal = this.profile.palette;
    const es = 0.8 * r * this.profile.morphology.earSize * (side < 0 ? 1 - 0.1 * ft : 1);
    const bw = es * 0.98 * (side < 0 ? 1 - 0.28 * ft : 1);
    const bx = (side * 0.5 + ft * 0.18 - (side < 0 ? ft * 0.05 : 0)) * r;
    const by = -0.58 * r;
    const flat = deg < 0 ? 1 + deg / 140 : 1 + deg / 300;
    const ang = side * (0.3 + Math.max(0, -deg) * (Math.PI / 180) * 1.2 - Math.max(0, deg) * 0.004);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang);
    ctx.scale(1, flat);
    const outer = new Path2D();
    outer.moveTo(-bw * 0.5, es * 0.12);
    outer.bezierCurveTo(-bw * 0.55, -es * 0.42, -bw * 0.2, -es * 0.86, -bw * 0.02, -es);
    outer.quadraticCurveTo(bw * 0.06, -es * 1.02, bw * 0.1, -es * 0.96);
    outer.bezierCurveTo(bw * 0.3, -es * 0.82, bw * 0.55, -es * 0.42, bw * 0.52, es * 0.1);
    outer.closePath();
    const cap = this.tex.earOuter;
    const og = ctx.createLinearGradient(0, es * 0.1, 0, -es);
    og.addColorStop(0, shadeHex(cap, side < 0 ? -0.06 : 0.02));
    og.addColorStop(1, shadeHex(cap, side < 0 ? -0.14 : -0.06));
    ctx.fillStyle = og;
    ctx.fill(outer);
    // Inner pinna: thin pink skin, darkest deep in the cup, translucent at the rim.
    const inner = new Path2D();
    inner.moveTo(-bw * 0.42, es * 0.08);
    inner.bezierCurveTo(-bw * 0.44, -es * 0.42, -bw * 0.16, -es * 0.8, -bw * 0.01, -es * 0.9);
    inner.bezierCurveTo(bw * 0.18, -es * 0.76, bw * 0.45, -es * 0.4, bw * 0.43, es * 0.08);
    inner.closePath();
    const ig = ctx.createRadialGradient(bw * 0.02, -es * 0.25, es * 0.04, 0, -es * 0.4, es * 0.62);
    ig.addColorStop(0, shadeHex(pal.innerEar, -0.32));
    ig.addColorStop(0.55, pal.innerEar);
    ig.addColorStop(1, mixHex(pal.innerEar, '#FFFFFF', 0.3));
    ctx.fillStyle = ig;
    ctx.globalAlpha *= side < 0 ? 1 - 0.55 * ft : 1;
    ctx.fill(inner);
    // Ear furnishings: pale hairs sweeping up from the inner edge.
    ctx.strokeStyle = mixHex(pal.baseWhite, '#FFFFFF', 0.4);
    ctx.lineWidth = Math.max(0.22, 0.45 / unit);
    ctx.lineCap = 'round';
    ctx.globalAlpha *= 0.85;
    ctx.beginPath();
    for (let i = 0; i < 9; i++) {
      const f = i / 8;
      const x0 = lerp(-bw * 0.36, bw * 0.34, f);
      const y0 = es * 0.04 - Math.abs(f - 0.5) * es * 0.2;
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 * 0.6, y0 - es * 0.22, x0 * 0.25 + bw * 0.02 * (f - 0.5), y0 - es * (0.36 + 0.12 * h01(i + side * 9)));
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------- face */

  private drawFace(ctx: AnyCtx, skel: Skeleton, pose: Pose, time: number, unit: number): void {
    const { r } = skel.head;
    const pal = this.profile.palette;
    const ft = this.faceTurn(skel, pose);
    const shift = ft * 0.16 * r;

    // Eyes
    const het = this.profile.morphology.heterochromia;
    const nearEye = skel.facing > 0 ? pal.eyeLeft : het ? pal.eyeRight : pal.eyeLeft;
    const farEye = skel.facing > 0 ? (het ? pal.eyeRight : pal.eyeLeft) : pal.eyeLeft;
    const open = clamp01(pose.eyeOpen * (1 - pose.squint * 0.5));
    for (const s of [-1, 1] as const) {
      const ex = shift + s * FACE.eyeX * r * (s > 0 ? 1 : 1 - 0.3 * ft) + ft * 0.04 * r;
      const ey = FACE.eyeY * r;
      const ew = 0.205 * r * (s > 0 ? 1 : 1 - 0.22 * ft);
      const eh = 0.15 * r;
      this.drawEye(ctx, ex, ey, ew, eh, s, open, pose, s > 0 ? nearEye : farEye, r, unit);
    }

    // Nose leather
    const nx = shift + ft * 0.07 * r;
    ctx.save();
    ctx.translate(nx, 0);
    const nw = 0.11 * r;
    const nose = new Path2D();
    nose.moveTo(-nw, FACE.noseTop * r + 0.012 * r);
    nose.quadraticCurveTo(0, FACE.noseTop * r - 0.03 * r, nw, FACE.noseTop * r + 0.012 * r);
    nose.quadraticCurveTo(nw * 0.75, FACE.noseTop * r + 0.07 * r, 0.014 * r, FACE.noseBot * r);
    nose.quadraticCurveTo(0, FACE.noseBot * r + 0.008 * r, -0.014 * r, FACE.noseBot * r);
    nose.quadraticCurveTo(-nw * 0.75, FACE.noseTop * r + 0.07 * r, -nw, FACE.noseTop * r + 0.012 * r);
    nose.closePath();
    const ng = ctx.createLinearGradient(0, FACE.noseTop * r - 0.03 * r, 0, FACE.noseBot * r);
    ng.addColorStop(0, mixHex(pal.noseLeather, '#FFFFFF', 0.18));
    ng.addColorStop(0.55, pal.noseLeather);
    ng.addColorStop(1, shadeHex(pal.noseLeather, -0.22));
    ctx.fillStyle = ng;
    ctx.fill(nose);
    // Nostrils
    ctx.fillStyle = rgba(shadeHex(pal.noseLeather, -0.6), 0.75);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.052 * r, FACE.noseTop * r + 0.055 * r, 0.024 * r, 0.011 * r, s * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    // Leather sheen
    const hl = ctx.createRadialGradient(-0.03 * r, FACE.noseTop * r + 0.01 * r, 0, -0.03 * r, FACE.noseTop * r + 0.01 * r, 0.05 * r);
    hl.addColorStop(0, 'rgba(255,255,255,0.45)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(-0.1 * r, FACE.noseTop * r - 0.05 * r, 0.2 * r, 0.12 * r);

    // Philtrum and mouth
    const mo = clamp01(pose.mouth);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(58,36,30,0.7)';
    ctx.lineWidth = Math.max(0.3, 0.022 * r);
    if (mo > 0.06) {
      const my = FACE.mouth * r + 0.06 * r;
      ctx.fillStyle = '#4E1A20';
      ctx.beginPath();
      ctx.moveTo(-0.16 * r * (0.55 + 0.45 * mo), my - 0.02 * r);
      ctx.quadraticCurveTo(0, my - 0.06 * r, 0.16 * r * (0.55 + 0.45 * mo), my - 0.02 * r);
      ctx.quadraticCurveTo(0.1 * r, my + 0.3 * r * mo, 0, my + 0.32 * r * mo);
      ctx.quadraticCurveTo(-0.1 * r, my + 0.3 * r * mo, -0.16 * r * (0.55 + 0.45 * mo), my - 0.02 * r);
      ctx.fill();
      if (pose.tongue > 0.05) {
        const tg = ctx.createLinearGradient(0, my, 0, my + 0.3 * r * mo);
        tg.addColorStop(0, '#C9606E');
        tg.addColorStop(1, '#EE97A2');
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.ellipse(0, my + 0.2 * r * mo, 0.1 * r * (0.5 + mo * 0.5), 0.1 * r * mo * pose.tongue + 0.02 * r, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#F6F1E8';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.1 * r, my - 0.03 * r);
        ctx.lineTo(s * 0.065 * r, my - 0.03 * r);
        ctx.lineTo(s * 0.085 * r, my + 0.07 * r * mo);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(0, FACE.noseBot * r);
      ctx.lineTo(0, FACE.mouth * r);
      ctx.moveTo(0, FACE.mouth * r);
      ctx.quadraticCurveTo(-0.05 * r, FACE.mouth * r + 0.04 * r, -0.12 * r, FACE.mouth * r + 0.015 * r);
      ctx.moveTo(0, FACE.mouth * r);
      ctx.quadraticCurveTo(0.05 * r, FACE.mouth * r + 0.04 * r, 0.12 * r, FACE.mouth * r + 0.015 * r);
      ctx.stroke();
      if (pose.tongue > 0.2) {
        ctx.fillStyle = '#E38593';
        ctx.beginPath();
        ctx.ellipse(0.015 * r, FACE.mouth * r + 0.05 * r, 0.05 * r, 0.05 * r * pose.tongue, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Whisker follicle dots on the pads.
    ctx.fillStyle = 'rgba(70,50,40,0.28)';
    for (const s of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.arc(s * (0.09 + k * 0.035) * r * (s > 0 ? 1 : 1 - 0.3 * ft), (0.3 + row * 0.04) * r, 0.007 * r + 0.08, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    this.drawWhiskers(ctx, r, nx, ft, time, unit, pose);
  }

  private drawWhiskers(ctx: AnyCtx, r: number, nx: number, ft: number, time: number, unit: number, pose: Pose): void {
    ctx.save();
    const tw = Math.sin(time * 1.7) * 0.015 + Math.sin(time * 4.3) * 0.006;
    // Alert / annoyed cats push whiskers forward; relaxed whiskers droop.
    const fwd = clamp01(-(pose.earL + pose.earR) / 60) * 0.12;
    const base = Math.max(0.006 * r, 0.32 / unit);
    for (const s of [-1, 1] as const) {
      for (let i = 0; i < 5; i++) {
        const len = (1.05 + 0.14 * (2 - Math.abs(i - 1.5))) * r * (s < 0 ? 1 - 0.3 * ft : 1);
        const ox = nx + s * (0.12 + 0.02 * i) * r * (s > 0 ? 1 : 1 - 0.3 * ft);
        const oy = (0.3 + i * 0.022) * r;
        const ang = s > 0 ? -0.08 + i * 0.1 - fwd + tw : Math.PI + 0.08 - i * 0.1 + fwd - tw;
        const ex = ox + Math.cos(ang) * len;
        const ey = oy + Math.sin(ang) * len + 0.12 * r * (i / 4) + 0.06 * r;
        const cx = ox + Math.cos(ang) * len * 0.5;
        const cy = oy + Math.sin(ang) * len * 0.5 - 0.02 * r;
        // Tapered whisker: a thin filled sliver, root to tip.
        const dx = ex - ox;
        const dy = ey - oy;
        const dl = Math.hypot(dx, dy) || 1;
        const px = (-dy / dl) * base;
        const py = (dx / dl) * base;
        ctx.fillStyle = 'rgba(40,30,22,0.16)';
        ctx.beginPath();
        ctx.moveTo(ox + px, oy + py + 0.012 * r);
        ctx.quadraticCurveTo(cx, cy + 0.012 * r, ex, ey + 0.012 * r);
        ctx.quadraticCurveTo(cx, cy + 0.012 * r, ox - px, oy - py + 0.012 * r);
        ctx.fill();
        ctx.fillStyle = 'rgba(252,250,245,0.88)';
        ctx.beginPath();
        ctx.moveTo(ox + px, oy + py);
        ctx.quadraticCurveTo(cx + px * 0.4, cy + py * 0.4, ex, ey);
        ctx.quadraticCurveTo(cx - px * 0.4, cy - py * 0.4, ox - px, oy - py);
        ctx.fill();
      }
      // Eyebrow whiskers above each eye.
      const bx = nx + s * 0.3 * r * (s > 0 ? 1 : 1 - 0.3 * ft);
      ctx.strokeStyle = 'rgba(250,246,238,0.7)';
      ctx.lineWidth = base * 0.9;
      ctx.lineCap = 'round';
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(bx, (FACE.eyeY - 0.2) * r);
        ctx.quadraticCurveTo(bx + s * 0.18 * r, (FACE.eyeY - 0.42 - i * 0.05) * r, bx + s * (0.38 + i * 0.08) * r, (FACE.eyeY - 0.5 - i * 0.06) * r);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawEye(ctx: AnyCtx, ex: number, ey: number, ew: number, eh: number, s: 1 | -1, open: number, pose: Pose, iris: string, r: number, unit: number): void {
    const pal = this.profile.palette;
    ctx.save();
    ctx.translate(ex, ey);
    // Outer corner sits a little higher than the inner one.
    ctx.rotate(s * -0.16);
    const X = (x: number) => x * s; // +x = toward the temple
    const almond = new Path2D();
    almond.moveTo(X(-ew), eh * 0.12);
    almond.bezierCurveTo(X(-ew * 0.5), -eh * 1.28, X(ew * 0.55), -eh * 1.2, X(ew), -eh * 0.08);
    almond.bezierCurveTo(X(ew * 0.52), eh * 1.04, X(-ew * 0.45), eh * 1.06, X(-ew), eh * 0.12);
    almond.closePath();
    const rimW = Math.max(0.035 * r, 0.5 / unit);
    if (open < 0.1) {
      // Closed: the lid line with dark margin, gently curved like a smile.
      ctx.strokeStyle = pal.eyeRim;
      ctx.lineWidth = rimW * 1.25;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(X(-ew * 1.02), eh * 0.0);
      ctx.bezierCurveTo(X(-ew * 0.4), eh * 0.55, X(ew * 0.45), eh * 0.5, X(ew * 1.05), -eh * 0.12);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.clip(almond);
    const lx = pose.lookX * ew * 0.28;
    const ly = pose.lookY * eh * 0.25;
    // Iris: gold halo around the pupil, the eye colour, a darker limbal ring.
    const g = ctx.createRadialGradient(lx, ly, eh * 0.08, lx, ly, ew * 1.05);
    g.addColorStop(0, mixHex(iris, '#E7CF63', 0.6));
    g.addColorStop(0.32, mixHex(iris, '#D9C65C', 0.3));
    g.addColorStop(0.7, iris);
    g.addColorStop(0.92, shadeHex(iris, -0.35));
    g.addColorStop(1, shadeHex(iris, -0.55));
    ctx.fillStyle = g;
    ctx.fillRect(-ew * 1.3, -eh * 1.5, ew * 2.6, eh * 3);
    // Iris fibres.
    ctx.lineWidth = Math.max(0.15, 0.25 / unit);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + h01(i) * 0.1;
      ctx.strokeStyle = i % 2 ? 'rgba(255,245,200,0.14)' : 'rgba(30,40,20,0.16)';
      ctx.beginPath();
      ctx.moveTo(lx + Math.cos(a) * eh * 0.3, ly + Math.sin(a) * eh * 0.3);
      ctx.lineTo(lx + Math.cos(a) * ew * (0.85 + 0.12 * h01(i * 3)), ly + Math.sin(a) * ew * (0.85 + 0.12 * h01(i * 3)));
      ctx.stroke();
    }
    // Pupil: a vertical slit that rounds out as it dilates.
    const dil = clamp01(pose.pupil);
    const pw = ew * lerp(0.07, 0.6, dil);
    const ph = eh * lerp(1.18, 0.98, dil);
    const bulge = lerp(1.25, 1.02, dil);
    ctx.fillStyle = '#080706';
    ctx.beginPath();
    ctx.moveTo(lx, ly - ph);
    ctx.bezierCurveTo(lx + pw * bulge, ly - ph * 0.55, lx + pw * bulge, ly + ph * 0.55, lx, ly + ph);
    ctx.bezierCurveTo(lx - pw * bulge, ly + ph * 0.55, lx - pw * bulge, ly - ph * 0.55, lx, ly - ph);
    ctx.fill();
    // Upper-lid shadow falling on the eyeball.
    const ls = ctx.createLinearGradient(0, -eh * 1.2, 0, eh * 0.2);
    ls.addColorStop(0, 'rgba(0,0,0,0.5)');
    ls.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ls;
    ctx.fillRect(-ew * 1.3, -eh * 1.5, ew * 2.6, eh * 1.7);
    // Wet highlights: a soft window reflection up-left, a faint bounce low-right (world-fixed).
    const hx = -ew * 0.3 + lx * 0.3;
    const hy = -eh * 0.42;
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, eh * 0.3);
    hg.addColorStop(0, 'rgba(255,255,255,0.95)');
    hg.addColorStop(0.45, 'rgba(255,255,255,0.75)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(hx - eh * 0.4, hy - eh * 0.4, eh * 0.8, eh * 0.8);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.ellipse(ew * 0.32, eh * 0.45, eh * 0.18, eh * 0.08, -0.3, 0, Math.PI * 2);
    ctx.fill();
    // Eyelids (blinks, sleepy and squinting eyes) in the surrounding fur colour.
    const lidY = -eh * 1.2 + (1 - open) * eh * 2.1;
    const lidColor = this.tex.capColor;
    if (open < 0.98) {
      ctx.fillStyle = lidColor;
      ctx.beginPath();
      ctx.moveTo(-ew * 1.3, -eh * 2);
      ctx.lineTo(ew * 1.3, -eh * 2);
      ctx.lineTo(ew * 1.3, lidY - eh * 0.1);
      ctx.quadraticCurveTo(0, lidY + eh * 0.35, -ew * 1.3, lidY - eh * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pal.eyeRim;
      ctx.lineWidth = rimW;
      ctx.beginPath();
      ctx.moveTo(-ew * 1.3, lidY - eh * 0.1);
      ctx.quadraticCurveTo(0, lidY + eh * 0.35, ew * 1.3, lidY - eh * 0.1);
      ctx.stroke();
    }
    if (pose.squint > 0.05) {
      const bl = eh * 1.15 - pose.squint * eh * 0.75;
      ctx.fillStyle = lidColor;
      ctx.beginPath();
      ctx.moveTo(-ew * 1.3, bl + eh * 0.15);
      ctx.quadraticCurveTo(0, bl - eh * 0.2, ew * 1.3, bl + eh * 0.15);
      ctx.lineTo(ew * 1.3, eh * 2);
      ctx.lineTo(-ew * 1.3, eh * 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // Dark lid margin, heavier at the inner corner where it runs into the tear line.
    ctx.strokeStyle = pal.eyeRim;
    ctx.lineWidth = rimW;
    ctx.stroke(almond);
    ctx.fillStyle = pal.eyeRim;
    ctx.beginPath();
    ctx.moveTo(X(-ew * 1.02), eh * 0.02);
    ctx.quadraticCurveTo(X(-ew * 1.12), eh * 0.45, X(-ew * 1.18), eh * 0.85);
    ctx.quadraticCurveTo(X(-ew * 0.98), eh * 0.4, X(-ew * 0.86), eh * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------- landmarks */

  landmarks(skel: Skeleton, tail: VerletTail, scale: number): Landmarks {
    const M = skel.M;
    const w = (x: number, y: number) => matApply(M, x, y);
    const torsoPoly: Vec2[] = [];
    for (const p of skel.torso) torsoPoly.push(w(p.x - p.nx * p.top, p.y - p.ny * p.top));
    for (let i = skel.torso.length - 1; i >= 0; i--) {
      const p = skel.torso[i];
      torsoPoly.push(w(p.x + p.nx * p.bot, p.y + p.ny * p.bot));
    }
    const spine = skel.torso.map((p) => w(p.x, p.y));
    const spineNormals = skel.torso.map((p) => {
      const a = w(p.x, p.y);
      const b = w(p.x + p.nx, p.y + p.ny);
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    });
    const hc = w(skel.head.x, skel.head.y);
    const up = w(skel.head.x + Math.sin(skel.head.rot) * skel.head.r, skel.head.y - Math.cos(skel.head.rot) * skel.head.r);
    const headUp = { x: (up.x - hc.x) / (skel.head.r * scale), y: (up.y - hc.y) / (skel.head.r * scale) };
    const paws = [w(skel.legs.frontNear.p.x, skel.legs.frontNear.p.y), w(skel.legs.frontFar.p.x, skel.legs.frontFar.p.y)];
    const tailPts = tail.nodes.map((n) => ({ x: n.x, y: n.y }));
    const hullPts: Vec2[] = [];
    for (let i = 0; i < torsoPoly.length; i += 2) hullPts.push(torsoPoly[i]);
    const hr = skel.head.r * scale * 1.2;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      hullPts.push({ x: hc.x + Math.cos(a) * hr, y: hc.y + Math.sin(a) * hr });
    }
    hullPts.push({ x: hc.x + headUp.x * hr * 1.55, y: hc.y + headUp.y * hr * 1.55 });
    for (const id of ['frontNear', 'frontFar', 'hindNear', 'hindFar'] as LegId[]) {
      const lg = skel.legs[id];
      if (lg.hidden > 0.6) continue;
      hullPts.push(w(lg.p.x + 4, lg.p.y + 1), w(lg.p.x - 3, lg.p.y + 1), w(lg.k.x, lg.k.y));
    }
    for (const t of tailPts) hullPts.push(t);
    const hull = convexHull(hullPts);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const mid = skel.torso[Math.floor(skel.torso.length / 2)];
    const backTop = w(mid.x - mid.nx * mid.top, mid.y - mid.ny * mid.top);
    const sl = this.scruffLocal(skel).scruff;
    const scruff = w(sl.x, sl.y);
    return { head: { x: hc.x, y: hc.y, r: skel.head.r * scale }, headUp, paws, torsoPoly, spine, spineNormals, tail: tailPts, hull, bounds: { minX, minY, maxX, maxY }, roll: skel.roll, scale, backTop, scruff };
  }
}

export function rgbaFromSample(s: [number, number, number], a: number): string {
  return rgba(`#${s.map((v) => v.toString(16).padStart(2, '0')).join('')}`, a);
}

/** Exposed for tests / tooling: the colour a fur sample renders as. */
export function sampleToHex(s: [number, number, number]): string {
  const c = hexToRgb(`#${s.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
