/**
 * ArticulatedCatRenderer — "Mode A" procedural HD painterly rig.
 *
 *  • Torso: deformable spline ribbon (quadratic spine with arch, breathing,
 *    loaf compression, haunch bulge) texture-mapped strip by strip from the UV
 *    atlas, with a roll axis so bellies genuinely flip into view (belly-up,
 *    tandem side-sleeping).
 *  • Four legs: 2-bone inverse kinematics, texture-mapped, with paws, toe lines
 *    and pink toe beans.
 *  • Head: 3/4 face with rotating ears (0° alert … −40° airplane), eyelids,
 *    dilating pupils, nose leather, mouth/tongue, whiskers.
 *  • Tail: drawn along the world-space Verlet chain (see VerletTail).
 */
import { mixHex, rgba, shadeHex } from '../shared/color';
import { catmullRom, clamp, clamp01, convexHull, lerp, matApply, matIdentity, matRotate, matScale, matTranslate, type Mat2D, type Vec2 } from '../shared/math';
import type { CatProfile } from '../shared/types';
import { dataUrlToBitmap } from '../shared/zip';
import type { AnyCtx } from './canvas';
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
}

export interface Skeleton {
  M: Mat2D;
  facing: 1 | -1;
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
}

export interface DrawOptions {
  time: number;
  grounded: boolean;
  groundY: number;
  alpha?: number;
  highlight?: number;
}

const TORSO_SAMPLES = 18;
const T_START = -0.2;
const T_END = 1.16;

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
    // tangent = (ny, −nx)
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

/** Texture-maps an atlas strip along a ribbon, segment by segment (affine parallelograms). */
function drawRibbonTexture(ctx: AnyCtx, img: CanvasImageSource, rect: UVRect, pts: RibbonPt[], along: 'x' | 'y', v0 = 0, v1 = 1): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const A = { x: p.x - p.nx * p.top, y: p.y - p.ny * p.top };
    const B = { x: q.x - q.nx * q.top, y: q.y - q.ny * q.top };
    const D = { x: p.x + p.nx * p.bot, y: p.y + p.ny * p.bot };
    ctx.save();
    if (along === 'x') {
      ctx.transform(B.x - A.x, B.y - A.y, D.x - A.x, D.y - A.y, A.x, A.y);
      const sx = rect.x + p.tc * rect.w;
      const sw = Math.max(0.6, (q.tc - p.tc) * rect.w);
      const sy = rect.y + v0 * rect.h;
      const sh = Math.max(0.6, (v1 - v0) * rect.h);
      ctx.drawImage(img, sx, sy, sw, sh, -0.04, -0.02, 1.12, 1.04);
    } else {
      ctx.transform(D.x - A.x, D.y - A.y, B.x - A.x, B.y - A.y, A.x, A.y);
      const sy = rect.y + p.tc * rect.h;
      const sh = Math.max(0.6, (q.tc - p.tc) * rect.h);
      const sx = rect.x + v0 * rect.w;
      const sw = Math.max(0.6, (v1 - v0) * rect.w);
      ctx.drawImage(img, sx, sy, sw, sh, -0.02, -0.04, 1.04, 1.12);
    }
    ctx.restore();
  }
}

export class ArticulatedCatRenderer {
  profile: CatProfile;
  private tex: CoatTexture;
  private paintKey = '';
  private chonkK = 1;
  private furF = 1;
  /** Resolves once the painted mask (if any) has been decoded into the texture. */
  ready: Promise<void>;

  constructor(profile: CatProfile) {
    this.profile = profile;
    this.tex = buildCoatTexture(profile, null);
    this.applyMorph();
    this.ready = this.loadPaint();
  }

  get texture(): CoatTexture {
    return this.tex;
  }

  setProfile(profile: CatProfile): void {
    const changed = coatKey(profile) !== this.tex.key;
    this.profile = profile;
    this.applyMorph();
    if (changed) {
      this.tex = buildCoatTexture(profile, null);
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
    const breathe = 1 + 0.035 * pose.breath * Math.sin(time * Math.PI * 2 * pose.breathRate);
    const roll = clamp01(pose.roll);
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
      const pouch = 1 + 0.36 * Math.exp(-(((t - 0.4) / 0.28) ** 2)) * Math.max(0, chonk - 0.7);
      const haunchBot = 1 + 0.42 * pose.haunch * Math.exp(-(((t - 0.04) / 0.17) ** 2));
      const haunchTop = 1 + 0.22 * pose.haunch * Math.exp(-(((t + 0.0) / 0.16) ** 2));
      const top = pose.thickTop * k * cap * haunchTop * breathe;
      const bot = pose.thickBot * k * cap * pouch * haunchBot * breathe;
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

    // Head & neck
    const r = 15.5 * (0.93 + 0.09 * chonk);
    const head = { x: pose.headX, y: pose.headY, r, rot: pose.headRot };
    const neckBase = torso[TORSO_SAMPLES - 4];
    const ndx = head.x - neckBase.x;
    const ndy = head.y + r * 0.35 - neckBase.y;
    const nl = Math.hypot(ndx, ndy) || 1;
    const nnx = -ndy / nl;
    const nny = ndx / nl;
    const neckW = Math.max(neckBase.top, neckBase.bot) * 0.92;
    const neck: RibbonPt[] = [];
    for (let i = 0; i <= 3; i++) {
      const f = i / 3;
      neck.push({
        x: neckBase.x + ndx * f,
        y: neckBase.y + ndy * f,
        nx: nnx,
        ny: nny,
        top: lerp(neckW, r * 0.72, f),
        bot: lerp(neckW, r * 0.78, f),
        tc: lerp(0.86, 1, f),
      });
    }

    // Legs — anchors sit on the ventral side; they migrate to the top as the cat rolls over.
    const anchorSide = Math.cos(roll * Math.PI);
    const back = { x: -d.x, y: -d.y };
    const front = torso[Math.round(TORSO_SAMPLES * 0.78)];
    const rear = torso[Math.round(TORSO_SAMPLES * 0.2)];
    const aF = { x: front.x + front.nx * front.bot * 0.42 * anchorSide - d.x * 1.5, y: front.y + front.ny * front.bot * 0.42 * anchorSide - d.y * 1.5 };
    const aH = { x: rear.x + rear.nx * rear.bot * 0.36 * anchorSide + d.x * 2.5, y: rear.y + rear.ny * rear.bot * 0.36 * anchorSide + d.y * 2.5 };
    const mk = (anchor: Vec2, tx: number, ty: number, l1: number, l2: number, hidden: number, curl: number, wTop: number): LegGeom => {
      const sol = solveIK(anchor, { x: tx, y: ty }, l1, l2, back);
      return { a: anchor, k: sol.k, p: sol.p, hidden, curl, wTop: wTop * k, wMid: 8.2 * k, wEnd: 7.2 * k };
    };
    const legs: Record<LegId, LegGeom> = {
      frontNear: mk(aF, pose.fnX, pose.fnY, 17, 17, pose.frontHidden, pose.fnCurl, 12),
      frontFar: mk({ x: aF.x - 4, y: aF.y }, pose.ffX, pose.ffY, 17, 17, pose.frontHidden, pose.ffCurl, 11.5),
      hindNear: mk(aH, pose.hnX, pose.hnY, 18.5, 17.5, pose.hindHidden, pose.hnCurl, 17),
      hindFar: mk({ x: aH.x - 4, y: aH.y }, pose.hfX, pose.hfY, 18.5, 17.5, pose.hindHidden, pose.hfCurl, 15),
    };

    const tailBase = torso[1];
    const tailAnchor = { x: tailBase.x - tailBase.nx * tailBase.top * 0.35 * (1 - 2 * roll) + d.x * 2, y: tailBase.y - tailBase.ny * tailBase.top * 0.35 * (1 - 2 * roll) + d.y * 2 };
    return {
      M,
      facing: tr.flip >= 0 ? 1 : -1,
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

  /** World-space anchor + base angle for the Verlet tail. */
  tailAnchorWorld(skel: Skeleton, pose: Pose): { x: number; y: number; angle: number } {
    const p = matApply(skel.M, skel.tailAnchor.x, skel.tailAnchor.y);
    const a = pose.tailAngle + pose.rot;
    const angle = skel.facing > 0 ? a : Math.PI - a;
    return { x: p.x, y: p.y, angle };
  }

  /* ------------------------------------------------------------ drawing */

  draw(ctx: AnyCtx, skel: Skeleton, pose: Pose, tail: VerletTail, scale: number, opts: DrawOptions): Landmarks {
    const tex = this.tex;
    const img = tex.canvas as CanvasImageSource;
    const M = skel.M;
    ctx.save();
    ctx.globalAlpha = opts.alpha ?? 1;
    ctx.imageSmoothingEnabled = true;

    // Soft contact shadow.
    if (opts.grounded) {
      const c = matApply(M, (pose.hipX + pose.shX) / 2, 0);
      const w = Math.abs(pose.shX - pose.hipX) * scale * 0.85 + 18 * scale;
      ctx.save();
      const g = ctx.createRadialGradient(c.x, opts.groundY, 1, c.x, opts.groundY, w);
      g.addColorStop(0, 'rgba(20,14,10,0.22)');
      g.addColorStop(1, 'rgba(20,14,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(c.x, opts.groundY - 1, w, 5 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const tailFront = pose.tailFront > 0.5;
    if (!tailFront) this.drawTail(ctx, tail, scale, pose);

    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);

    // Far legs (shaded) behind the body.
    this.drawLeg(ctx, img, skel.legs.hindFar, UV.legs.hindFar, true);
    this.drawLeg(ctx, img, skel.legs.frontFar, UV.legs.frontFar, true);
    if (pose.hindNearFront <= 0.5) this.drawLeg(ctx, img, skel.legs.hindNear, UV.legs.hindNear, false);

    this.drawTorso(ctx, img, skel);
    if (pose.tuck > 0.05) this.drawMittens(ctx, skel, pose);
    this.drawNeck(ctx, img, skel);
    this.drawLeg(ctx, img, skel.legs.frontNear, UV.legs.frontNear, false);
    if (pose.hindNearFront > 0.5 && pose.hindNearFront < 0.95) this.drawLeg(ctx, img, skel.legs.hindNear, UV.legs.hindNear, false);
    this.drawPads(ctx, skel, pose);
    ctx.restore();

    if (tailFront) this.drawTail(ctx, tail, scale, pose);

    ctx.save();
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    this.drawHead(ctx, img, skel, pose, opts.time);
    if (pose.hindNearFront >= 0.95) this.drawLeg(ctx, img, skel.legs.hindNear, UV.legs.hindNear, false);
    ctx.restore();

    ctx.restore();
    return this.landmarks(skel, tail, scale);
  }

  private drawTorso(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton): void {
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
      // The upper band (outline → split) shows v ∈ [roll, 1]; past the ventral
      // midline (v = 1) the far side appears mirrored, v ∈ [1 − roll, 1].
      const f = clamp(1 - roll, 0, 1);
      if (f > 0.01) {
        const upper = pts.map((p) => ({ x: p.x - p.nx * p.top, y: p.y - p.ny * p.top, nx: p.nx, ny: p.ny, top: 0, bot: (p.top + p.bot) * f, tc: p.tc }));
        drawRibbonTexture(ctx, img, UV.torso, upper, 'x', roll, 1);
      }
      if (f < 0.99) {
        const lower = pts.map((p) => ({ x: p.x + p.nx * p.bot, y: p.y + p.ny * p.bot, nx: -p.nx, ny: -p.ny, top: 0, bot: (p.top + p.bot) * (1 - f), tc: p.tc }));
        drawRibbonTexture(ctx, img, UV.torso, lower, 'x', 1 - roll, 1);
      }
    }
    // Volume shading.
    const mid = pts[Math.floor(pts.length / 2)];
    const thick = mid.top + mid.bot;
    const g = ctx.createLinearGradient(mid.x - mid.nx * mid.top, mid.y - mid.ny * mid.top, mid.x + mid.nx * mid.bot, mid.y + mid.ny * mid.bot);
    g.addColorStop(0, 'rgba(255,250,240,0.16)');
    g.addColorStop(0.35, 'rgba(255,255,255,0)');
    g.addColorStop(0.78, 'rgba(30,20,12,0.08)');
    g.addColorStop(1, 'rgba(30,20,12,0.26)');
    ctx.fillStyle = g;
    ctx.fillRect(mid.x - thick * 6, mid.y - thick * 6, thick * 12, thick * 12);
    ctx.restore();

    // Fur tufts along the silhouette.
    this.drawTufts(ctx, pts, roll);
    ctx.lineWidth = 0.55;
    ctx.strokeStyle = this.tex.outline;
    ctx.stroke(outline);
  }

  private drawTufts(ctx: AnyCtx, pts: RibbonPt[], roll: number): void {
    const tex = this.tex;
    const f = this.furF;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.8;
    ctx.globalAlpha *= 0.55;
    for (let i = 2; i < pts.length - 2; i++) {
      const p = pts[i];
      for (const side of [-1, 1] as const) {
        const off = side < 0 ? p.top : p.bot;
        // Visible outline texture rows: top edge shows v = roll, bottom edge v = 1 − roll.
        const vTex = side < 0 ? roll : 1 - roll;
        const [r, g, b] = tex.sample(UV.torso.x + p.tc * UV.torso.w, UV.torso.y + clamp(vTex, 0.04, 0.96) * UV.torso.h);
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        const n = side > 0 ? (f > 1.2 ? 3 : 2) : f > 1.2 ? 2 : 1;
        for (let j = 0; j < n; j++) {
          const jt = (j + 0.5) / n;
          const bx = p.x + side * p.nx * off * 0.94 + p.ny * (jt - 0.5) * 3.4;
          const by = p.y + side * p.ny * off * 0.94 - p.nx * (jt - 0.5) * 3.4;
          const len = (0.9 + ((i * 7 + j * 3) % 5) * 0.18) * f;
          // fur lies back toward the rump (−tangent) and slightly outward
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + side * p.nx * len * 0.55 - p.ny * len * 1.3, by + side * p.ny * len * 0.55 + p.nx * len * 1.3);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  private drawNeck(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton): void {
    const pts = skel.neck;
    const path = new Path2D();
    ribbonPath(path, pts, false, true);
    ctx.save();
    ctx.clip(path);
    drawRibbonTexture(ctx, img, UV.torso, pts, 'x', 0, skel.roll > 0.5 ? 0.6 : 1);
    ctx.restore();
  }

  private drawLeg(ctx: AnyCtx, img: CanvasImageSource, leg: LegGeom, rect: UVRect, far: boolean): void {
    const alpha = 1 - clamp01(leg.hidden);
    if (alpha <= 0.02) return;
    const seg = (a: Vec2, b: Vec2) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { nx: -(b.y - a.y) / l, ny: (b.x - a.x) / l };
    };
    const n1 = seg(leg.a, leg.k);
    const n2 = seg(leg.k, leg.p);
    const nk = { nx: (n1.nx + n2.nx) / 2, ny: (n1.ny + n2.ny) / 2 };
    const nkl = Math.hypot(nk.nx, nk.ny) || 1;
    const pts: RibbonPt[] = [
      { x: leg.a.x, y: leg.a.y, nx: n1.nx, ny: n1.ny, top: leg.wTop / 2, bot: leg.wTop / 2, tc: 0 },
      { x: leg.k.x, y: leg.k.y, nx: nk.nx / nkl, ny: nk.ny / nkl, top: leg.wMid / 2, bot: leg.wMid / 2, tc: 0.5 },
      { x: leg.p.x, y: leg.p.y, nx: n2.nx, ny: n2.ny, top: leg.wEnd / 2, bot: leg.wEnd / 2, tc: 0.9 },
    ];
    ctx.save();
    ctx.globalAlpha *= alpha;
    const path = new Path2D();
    ribbonPath(path, pts, true, true);
    ctx.save();
    ctx.clip(path);
    drawRibbonTexture(ctx, img, rect, pts, 'y', 0, 1);
    if (far) {
      ctx.fillStyle = 'rgba(25,18,12,0.13)';
      ctx.fillRect(-200, -200, 400, 400);
    }
    ctx.restore();
    ctx.strokeStyle = this.tex.legOutline;
    ctx.lineWidth = 0.5;
    ctx.stroke(path);

    // Paw
    const [pr, pg, pb] = this.tex.sample(rect.x + rect.w / 2, rect.y + rect.h * 0.96);
    const dir = Math.atan2(leg.p.y - leg.k.y, leg.p.x - leg.k.x);
    const pawAng = (dir - Math.PI / 2) * (0.25 + 0.75 * clamp01(leg.curl));
    ctx.save();
    ctx.translate(leg.p.x, leg.p.y - 1.2);
    ctx.rotate(pawAng);
    ctx.fillStyle = far ? `rgb(${Math.round(pr * 0.82)},${Math.round(pg * 0.8)},${Math.round(pb * 0.78)})` : `rgb(${pr},${pg},${pb})`;
    ctx.beginPath();
    ctx.ellipse(1.6, 0, 5.2 * this.chonkK, 3.4 * this.chonkK, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = this.tex.legOutline;
    ctx.lineWidth = 0.45;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,45,35,0.45)';
    ctx.lineWidth = 0.45;
    for (const tx of [3.4, 5.2]) {
      ctx.beginPath();
      ctx.moveTo(tx, -1.9);
      ctx.lineTo(tx - 0.4, 0.2);
      ctx.stroke();
    }
    ctx.restore();
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
      ctx.fillStyle = pal.pawPads;
      ctx.beginPath();
      ctx.ellipse(leg.p.x + 0.8, leg.p.y - 0.2, 1.9, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const [ox, oy] of [
        [-1.4, -2.1],
        [0.6, -2.7],
        [2.6, -2.2],
      ]) {
        ctx.beginPath();
        ctx.ellipse(leg.p.x + ox + 0.8, leg.p.y + oy, 0.8, 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawMittens(ctx: AnyCtx, skel: Skeleton, pose: Pose): void {
    const pts = skel.torso;
    const chest = pts[Math.round(pts.length * 0.8)];
    const bx = chest.x + chest.nx * chest.bot * 0.8;
    const by = Math.min(-2, chest.y + chest.ny * chest.bot * 0.85);
    const [r, g, b] = this.tex.sample(UV.legs.frontNear.x + 32, UV.legs.frontNear.y + 246);
    ctx.save();
    ctx.globalAlpha *= clamp01(pose.tuck);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.strokeStyle = this.tex.outline;
    ctx.lineWidth = 0.5;
    for (const ox of [-1.5, 4.5]) {
      ctx.beginPath();
      ctx.ellipse(bx + ox, by + 1.2, 4.2 * this.chonkK, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTail(ctx: AnyCtx, tail: VerletTail, scale: number, pose: Pose): void {
    const nodes = tail.nodes.map((n) => ({ x: n.x, y: n.y }));
    const pts = catmullRom(nodes, 4);
    if (pts.length < 2) return;
    const puff = 1 + 0.9 * clamp01(pose.tailPuff);
    const base = 4.6 * scale * this.chonkK * (0.85 + 0.15 * this.furF) * puff;
    const tip = 2.2 * scale * (0.8 + 0.3 * this.furF) * puff;
    const rib: RibbonPt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const f = i / (pts.length - 1);
      const w = lerp(base, tip, Math.pow(f, 0.9)) * (this.furF > 1.6 ? 1 + 0.35 * Math.sin(f * Math.PI) : 1);
      rib.push({ x: pts[i].x, y: pts[i].y, nx: -(b.y - a.y) / l, ny: (b.x - a.x) / l, top: w, bot: w, tc: f * 0.98 });
    }
    const path = new Path2D();
    ribbonPath(path, rib, false, true);
    ctx.save();
    ctx.clip(path);
    drawRibbonTexture(ctx, this.tex.canvas as CanvasImageSource, UV.tail, rib, 'x', 0, 1);
    ctx.restore();
    ctx.strokeStyle = this.tex.outline;
    ctx.lineWidth = 0.7 * scale;
    ctx.stroke(path);
    if (this.furF > 1.2 || pose.tailPuff > 0.55) {
      ctx.save();
      ctx.globalAlpha *= 0.6;
      ctx.lineWidth = 0.7 * scale;
      for (let i = 2; i < rib.length; i += 2) {
        const p = rib[i];
        const [r, g, b] = this.tex.sample(UV.tail.x + p.tc * UV.tail.w, UV.tail.y + 32);
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(p.x + s * p.nx * p.top, p.y + s * p.ny * p.top);
          const fl = 1.4 * scale * this.furF * (0.6 + 0.4 * clamp01(pose.tailPuff));
          ctx.lineTo(p.x + s * p.nx * (p.top + fl) - p.ny * fl, p.y + s * p.ny * (p.top + fl) + p.nx * fl);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  private drawEar(ctx: AnyCtx, side: 1 | -1, r: number, deg: number, ft: number): void {
    const pal = this.profile.palette;
    const es = 9.6 * this.profile.morphology.earSize * (side < 0 ? 1 - 0.12 * ft : 1);
    const bx = side * 0.5 * r + ft * 0.13 * r;
    const by = -0.62 * r;
    const flat = deg < 0 ? 1 + deg / 150 : 1 + deg / 300;
    const ang = side * (0.36 + Math.max(0, -deg) * (Math.PI / 180) * 1.25 - Math.max(0, deg) * 0.004);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang);
    ctx.scale(1, flat);
    const bw = es * 0.62;
    const h = es * 1.38;
    const outer = new Path2D();
    outer.moveTo(-bw, 2);
    outer.quadraticCurveTo(-bw * 0.85, -h * 0.55, -bw * 0.12, -h);
    outer.quadraticCurveTo(0, -h * 1.05, bw * 0.15, -h * 0.98);
    outer.quadraticCurveTo(bw * 0.9, -h * 0.5, bw, 2);
    outer.closePath();
    ctx.fillStyle = side < 0 ? shadeHex(this.tex.earOuter, -0.06) : this.tex.earOuter;
    ctx.fill(outer);
    ctx.strokeStyle = this.tex.outline;
    ctx.lineWidth = 0.7;
    ctx.stroke(outer);
    // inner pinna
    const inner = new Path2D();
    const s = 0.64;
    inner.moveTo(-bw * s, 1);
    inner.quadraticCurveTo(-bw * s * 0.8, -h * 0.5, -bw * 0.08, -h * 0.82);
    inner.quadraticCurveTo(bw * s * 0.85, -h * 0.45, bw * s, 1);
    inner.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, -h);
    g.addColorStop(0, mixHex(pal.innerEar, '#FFFFFF', 0.25));
    g.addColorStop(0.7, pal.innerEar);
    g.addColorStop(1, shadeHex(pal.innerEar, -0.1));
    ctx.fillStyle = g;
    ctx.fill(inner);
    // white ear furnishings
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 4; i++) {
      const x = -bw * 0.4 + i * bw * 0.27;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + bw * 0.1, -h * 0.25, x + bw * 0.05 * (i - 1.5), -h * 0.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawHead(ctx: AnyCtx, img: CanvasImageSource, skel: Skeleton, pose: Pose, time: number): void {
    const { r } = skel.head;
    const chonk = this.profile.morphology.chonk;
    const pal = this.profile.palette;
    const ft = clamp01(pose.faceTurn);
    const shift = ft * 0.2 * r;
    ctx.save();
    ctx.translate(skel.head.x, skel.head.y);
    ctx.rotate(skel.head.rot);

    this.drawEar(ctx, -1, r, pose.earL, ft);
    this.drawEar(ctx, 1, r, pose.earR, ft);

    const rx = r * (1.0 + 0.09 * (chonk - 1)) * (1 + 0.05 * (this.furF - 1));
    const ry = r * 0.9;
    const headPath = new Path2D();
    headPath.ellipse(shift * 0.3, 0.02 * r, rx, ry, 0, 0, Math.PI * 2);
    headPath.ellipse(shift * 0.3 - 0.6 * r, 0.3 * r, 0.44 * r, 0.36 * r, 0.2, 0, Math.PI * 2);
    headPath.ellipse(shift * 0.3 + 0.6 * r, 0.3 * r, 0.44 * r, 0.36 * r, -0.2, 0, Math.PI * 2);
    // Stroke first at double width; the fill below hides the inner half, so only the
    // outer silhouette of the union (head + cheek bulges) remains outlined.
    ctx.strokeStyle = this.tex.outline;
    ctx.lineWidth = 1.3;
    ctx.stroke(headPath);
    ctx.save();
    ctx.clip(headPath);
    ctx.save();
    ctx.translate(shift, 0);
    if (skel.facing < 0) ctx.scale(-1, 1);
    const sc = r / HEAD_TEMPLATE.radius;
    ctx.scale(sc * 0.98, sc);
    ctx.drawImage(img, UV.head.x, UV.head.y, UV.head.w, UV.head.h, -HEAD_TEMPLATE.cx, -HEAD_TEMPLATE.cy, UV.head.w, UV.head.h);
    ctx.restore();
    const g = ctx.createRadialGradient(r * 0.25, -r * 0.4, r * 0.1, 0, 0, r * 1.4);
    g.addColorStop(0, 'rgba(255,250,240,0.14)');
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(30,20,12,0.24)');
    ctx.fillStyle = g;
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
    ctx.restore();

    // cheek ruff for long fur
    if (this.furF > 1.3) {
      const [cr, cg, cb] = this.tex.sample(UV.head.x + 30, UV.head.y + 120);
      ctx.strokeStyle = `rgb(${cr},${cg},${cb})`;
      ctx.lineWidth = 0.9;
      for (let i = 0; i < 14; i++) {
        const a = Math.PI * (0.15 + (i / 13) * 0.7);
        const x0 = Math.cos(a) * rx * 0.98 + shift * 0.3;
        const y0 = Math.sin(a) * ry * 0.98 + 0.05 * r;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + Math.cos(a) * 2.6 * this.furF, y0 + Math.sin(a) * 2.6 * this.furF);
        ctx.stroke();
      }
    }

    // Eyes
    const het = this.profile.morphology.heterochromia;
    const nearEye = skel.facing > 0 ? pal.eyeLeft : het ? pal.eyeRight : pal.eyeLeft;
    const farEye = skel.facing > 0 ? (het ? pal.eyeRight : pal.eyeLeft) : pal.eyeLeft;
    const open = clamp01(pose.eyeOpen * (1 - pose.squint * 0.5));
    for (const s of [-1, 1] as const) {
      const ex = shift + s * 0.45 * r * (s > 0 ? 1 : 1 - 0.32 * ft) + ft * 0.05 * r;
      const ey = -0.1 * r;
      const ew = 0.27 * r * (s > 0 ? 1 : 1 - 0.18 * ft);
      const eh = 0.205 * r;
      this.drawEye(ctx, ex, ey, ew, eh, s, open, pose, s > 0 ? nearEye : farEye, r);
    }

    // Nose
    const nx = shift + ft * 0.07 * r;
    ctx.save();
    ctx.translate(nx, 0);
    const nose = new Path2D();
    nose.moveTo(-0.14 * r, 0.25 * r);
    nose.quadraticCurveTo(0, 0.21 * r, 0.14 * r, 0.25 * r);
    nose.quadraticCurveTo(0.06 * r, 0.35 * r, 0, 0.39 * r);
    nose.quadraticCurveTo(-0.06 * r, 0.35 * r, -0.14 * r, 0.25 * r);
    nose.closePath();
    ctx.fillStyle = pal.noseLeather;
    ctx.fill(nose);
    ctx.strokeStyle = shadeHex(pal.noseLeather, -0.25);
    ctx.lineWidth = 0.45;
    ctx.stroke(nose);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.ellipse(-0.03 * r, 0.255 * r, 0.05 * r, 0.025 * r, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mouth
    const mo = clamp01(pose.mouth);
    ctx.strokeStyle = 'rgba(70,45,40,0.75)';
    ctx.lineWidth = 0.55;
    ctx.lineCap = 'round';
    if (mo > 0.06) {
      ctx.fillStyle = '#5A1E24';
      ctx.beginPath();
      ctx.ellipse(0, 0.6 * r, 0.17 * r * (0.5 + mo * 0.5), 0.23 * r * mo, 0, 0, Math.PI * 2);
      ctx.fill();
      if (pose.tongue > 0.05) {
        ctx.fillStyle = '#E8838F';
        ctx.beginPath();
        ctx.ellipse(0, 0.66 * r + 0.06 * r * mo, 0.12 * r * (0.5 + mo * 0.5), 0.12 * r * mo * pose.tongue + 0.02 * r, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#FFFFFF';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.11 * r, 0.42 * r);
        ctx.lineTo(s * 0.07 * r, 0.42 * r);
        ctx.lineTo(s * 0.09 * r, 0.42 * r + 0.08 * r * mo);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(0, 0.39 * r);
      ctx.lineTo(0, 0.46 * r);
      ctx.quadraticCurveTo(-0.06 * r, 0.53 * r, -0.14 * r, 0.48 * r);
      ctx.moveTo(0, 0.46 * r);
      ctx.quadraticCurveTo(0.06 * r, 0.53 * r, 0.14 * r, 0.48 * r);
      ctx.stroke();
      if (pose.tongue > 0.2) {
        ctx.fillStyle = '#E8838F';
        ctx.beginPath();
        ctx.ellipse(0.02 * r, 0.52 * r, 0.06 * r, 0.06 * r * pose.tongue, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Whiskers
    ctx.save();
    ctx.lineCap = 'round';
    const tw = Math.sin(time * 1.7) * 0.02;
    for (const s of [-1, 1] as const) {
      const ox = nx + s * 0.2 * r;
      for (let i = 0; i < 3; i++) {
        const len = (0.78 + 0.1 * (1 - i)) * r * (s < 0 ? 1 - 0.25 * ft : 1);
        const y0 = 0.44 * r + i * 0.06 * r;
        ctx.strokeStyle = 'rgba(80,70,60,0.22)';
        ctx.lineWidth = 0.5;
        const ex = ox + s * len;
        const ey = y0 + (i - 1) * 0.16 * r + 0.06 * r + tw * r;
        ctx.beginPath();
        ctx.moveTo(ox, y0 + 0.02 * r);
        ctx.quadraticCurveTo(ox + s * len * 0.5, y0 - 0.06 * r + (i - 1) * 0.06 * r, ex, ey + 0.02 * r);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 0.38;
        ctx.beginPath();
        ctx.moveTo(ox, y0);
        ctx.quadraticCurveTo(ox + s * len * 0.5, y0 - 0.08 * r + (i - 1) * 0.06 * r, ex, ey);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.restore();
  }

  private drawEye(ctx: AnyCtx, ex: number, ey: number, ew: number, eh: number, s: 1 | -1, open: number, pose: Pose, iris: string, r: number): void {
    const pal = this.profile.palette;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(s * -0.13);
    const almond = new Path2D();
    almond.moveTo(-ew, 0);
    almond.quadraticCurveTo(0, -eh * 1.3, ew, 0);
    almond.quadraticCurveTo(0, eh * 1.25, -ew, 0);
    almond.closePath();
    if (open < 0.12) {
      ctx.strokeStyle = pal.eyeRim;
      ctx.lineWidth = 0.1 * r;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-ew * 1.02, -eh * 0.05);
      ctx.quadraticCurveTo(0, eh * 0.62, ew * 1.08, -eh * 0.12);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.clip(almond);
    const lx = pose.lookX * ew * 0.3;
    const ly = pose.lookY * eh * 0.28;
    const g = ctx.createRadialGradient(lx * 0.5, ly * 0.5, eh * 0.1, 0, 0, ew * 1.05);
    g.addColorStop(0, mixHex(iris, '#E9D86A', 0.55));
    g.addColorStop(0.5, mixHex(iris, '#C9C25A', 0.2));
    g.addColorStop(1, shadeHex(iris, -0.2));
    ctx.fillStyle = g;
    ctx.fillRect(-ew * 1.2, -eh * 1.5, ew * 2.4, eh * 3);
    const pw = ew * lerp(0.13, 0.66, clamp01(pose.pupil));
    ctx.fillStyle = '#0B0A09';
    ctx.beginPath();
    ctx.ellipse(lx, ly, pw, eh * 1.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(lx - ew * 0.28, ly - eh * 0.38, eh * 0.2, eh * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    // eyelids
    const lidY = -eh * 1.15 + (1 - open) * eh * 2.0;
    const lidColor = this.tex.capColor;
    ctx.fillStyle = lidColor;
    ctx.beginPath();
    ctx.moveTo(-ew * 1.3, -eh * 2);
    ctx.lineTo(ew * 1.3, -eh * 2);
    ctx.lineTo(ew * 1.3, lidY - eh * 0.1);
    ctx.quadraticCurveTo(0, lidY + eh * 0.35, -ew * 1.3, lidY - eh * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = pal.eyeRim;
    ctx.lineWidth = 0.05 * r;
    ctx.beginPath();
    ctx.moveTo(-ew * 1.3, lidY - eh * 0.1);
    ctx.quadraticCurveTo(0, lidY + eh * 0.35, ew * 1.3, lidY - eh * 0.1);
    ctx.stroke();
    if (pose.squint > 0.05) {
      const bl = eh * 1.15 - pose.squint * eh * 0.7;
      ctx.fillStyle = lidColor;
      ctx.fillRect(-ew * 1.3, bl, ew * 2.6, eh * 2);
    }
    ctx.restore();
    ctx.strokeStyle = pal.eyeRim;
    ctx.lineWidth = 0.06 * r;
    ctx.stroke(almond);
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
    const hr = skel.head.r * scale * 1.15;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      hullPts.push({ x: hc.x + Math.cos(a) * hr, y: hc.y + Math.sin(a) * hr });
    }
    hullPts.push({ x: hc.x + headUp.x * hr * 1.6, y: hc.y + headUp.y * hr * 1.6 });
    for (const id of ['frontNear', 'frontFar', 'hindNear', 'hindFar'] as LegId[]) {
      const lg = skel.legs[id];
      if (lg.hidden > 0.6) continue;
      hullPts.push(w(lg.p.x, lg.p.y + 2), w(lg.k.x, lg.k.y));
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
    return { head: { x: hc.x, y: hc.y, r: skel.head.r * scale }, headUp, paws, torsoPoly, spine, spineNormals, tail: tailPts, hull, bounds: { minX, minY, maxX, maxY }, roll: skel.roll, scale, backTop };
  }
}

export function rgbaFromSample(s: [number, number, number], a: number): string {
  return rgba(`#${s.map((v) => v.toString(16).padStart(2, '0')).join('')}`, a);
}
