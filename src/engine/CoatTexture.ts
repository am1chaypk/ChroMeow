/**
 * Procedural coat generator. Paints a cat's fur onto the 512×512 UV atlas:
 * pattern topology (harlequin broken saddle, continuous mantle, tuxedo, classic /
 * mackerel tabby, spots, calico, tortie, colourpoint, van), agouti ticking,
 * mackerel stripes, rufous warmth, facial blaze / "M" / eyeliner, leg stockings,
 * tail rings — and finally the user's painted mask from Cat Studio on top.
 */
import { hexToRgb, mixHex, rgba, shadeHex } from '../shared/color';
import { clamp, clamp01, lerp } from '../shared/math';
import { Rng, hashString } from '../shared/rng';
import type { CatProfile, CoatMarkings, CoatPalette, CoatPattern } from '../shared/types';
import { createCanvas, ctx2d, type AnyCanvas, type AnyCtx } from './canvas';
import { ATLAS_SIZE, HEAD_TEMPLATE, UV, type LegId, type UVRect } from './UVLayout';

export interface CoatTexture {
  canvas: AnyCanvas;
  pixels: Uint8ClampedArray;
  key: string;
  /** Representative colours used for procedurally drawn parts (ears, outlines). */
  capColor: string;
  earOuter: string;
  outline: string;
  /** Softer outline for (usually white) legs and paws. */
  legOutline: string;
  /** RGB at atlas pixel (clamped). */
  sample(x: number, y: number): [number, number, number];
}

type Pt = [number, number];

const TW = UV.torso.w;
const TH = UV.torso.h;

function profileKey(p: CatProfile): string {
  return String(
    hashString(
      JSON.stringify([p.pattern, p.palette, p.markings, p.morphology.furLength, p.paintMask ? p.paintMask.length + p.paintMask.slice(-64) : 0]),
    ),
  );
}

/** Densifies a polygon (u,v in 0..1) and jitters vertices for an organic fur edge. */
function organic(poly: Pt[], rng: Rng, jitter: number, w: number, h: number, steps = 7): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = lerp(a[0], b[0], t) * w;
      const y = lerp(a[1], b[1], t) * h;
      const edge = a[0] < -0.01 || a[0] > 1.01 || a[1] < -0.01 ? 0.15 : 1;
      out.push([x + rng.gauss() * jitter * edge, y + rng.gauss() * jitter * edge]);
    }
  }
  return out;
}

function fillPoly(ctx: AnyCtx, pts: Pt[], ox = 0, oy = 0): void {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(ox + pts[0][0], oy + pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    ctx.quadraticCurveTo(ox + p[0], oy + p[1], ox + (p[0] + q[0]) / 2, oy + (p[1] + q[1]) / 2);
  }
  ctx.closePath();
  ctx.fill();
}

function isTabbyFamily(p: CoatPattern): boolean {
  return p === 'PATCHED_TABBY_HARLEQUIN' || p === 'MANTLED_BICOLOR_TABBY' || p === 'MACKEREL_TABBY' || p === 'CLASSIC_TABBY' || p === 'SPOTTED' || p === 'BICOLOR_VAN';
}

function stripeStyle(p: CoatPattern): 'mackerel' | 'classic' | 'spots' | 'ghost' | 'none' {
  switch (p) {
    case 'PATCHED_TABBY_HARLEQUIN':
    case 'MANTLED_BICOLOR_TABBY':
    case 'MACKEREL_TABBY':
    case 'BICOLOR_VAN':
      return 'mackerel';
    case 'CLASSIC_TABBY':
      return 'classic';
    case 'SPOTTED':
      return 'spots';
    case 'SOLID':
    case 'TUXEDO':
      return 'ghost';
    default:
      return 'none';
  }
}

/** Fur ticking: thousands of short directional strokes. */
function tick(ctx: AnyCtx, rect: UVRect, rng: Rng, count: number, colors: string[], alpha: number, len: [number, number], angle: number, spread: number, width = 1.1): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  for (let i = 0; i < count; i++) {
    const x = rect.x + rng.next() * rect.w;
    const y = rect.y + rng.next() * rect.h;
    const l = rng.range(len[0], len[1]);
    const a = angle + rng.gauss() * spread;
    ctx.globalAlpha = alpha * rng.range(0.5, 1);
    ctx.strokeStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + rng.gauss(), y + Math.sin(a) * l * 0.5 + rng.gauss(), x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws a marking as a band of short directional hairs along a polyline instead of a
 * blurred brush line, so stripe edges break up into fur the way real tabby markings do.
 * `width(f)` gives the band width at fraction f of the length; `flow` is the fur direction.
 */
function furStripe(
  ctx: AnyCtx,
  pts: Pt[],
  width: (f: number) => number,
  color: string,
  rng: Rng,
  opts: { alpha?: number; flow?: number; len?: [number, number]; density?: number; breaks?: number; core?: number } = {},
): void {
  if (pts.length < 2) return;
  const alpha = opts.alpha ?? 0.85;
  const flow = opts.flow ?? Math.PI * 0.94;
  const len = opts.len ?? [3, 7];
  const density = opts.density ?? 1;
  const breaks = opts.breaks ?? 0.12;
  const core = opts.core ?? 0.55;
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = seg[seg.length - 1];
  if (total < 1) return;
  const at = (d: number): [number, number, number] => {
    let i = 1;
    while (i < seg.length - 1 && seg[i] < d) i++;
    const t = (d - seg[i - 1]) / Math.max(1e-6, seg[i] - seg[i - 1]);
    const a = pts[i - 1];
    const b = pts[i];
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), Math.atan2(b[1] - a[1], b[0] - a[0])];
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  let gap = 0;
  for (let d = 0; d <= total; d += 1.5) {
    const f = d / total;
    if (gap > 0) {
      gap -= 1.5;
      continue;
    }
    // Ends of stripes break into dashes.
    if (rng.chance(breaks * (0.15 + f * f) * 0.12)) {
      gap = rng.range(3, 9);
      continue;
    }
    const [x, y, dir] = at(d);
    const w = Math.max(0.6, width(f));
    const nx = -Math.sin(dir);
    const ny = Math.cos(dir);
    // Solid-ish core so narrow stripes read as continuous.
    ctx.globalAlpha = alpha * core;
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.32, w * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    const n = Math.max(2, Math.round(w * 0.9 * density));
    for (let k = 0; k < n; k++) {
      const off = (rng.next() - 0.5) * w;
      const edge = Math.abs(off) / (w / 2);
      const l = rng.range(len[0], len[1]) * (1 - 0.35 * edge);
      const a = flow + rng.gauss() * 0.22;
      const sx = x + nx * off - Math.cos(a) * l * 0.35;
      const sy = y + ny * off - Math.sin(a) * l * 0.35;
      ctx.globalAlpha = alpha * (1 - 0.55 * edge) * rng.range(0.6, 1);
      ctx.lineWidth = rng.range(0.8, 1.4);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx + Math.cos(a) * l * 0.5 + rng.gauss() * 0.4, sy + Math.sin(a) * l * 0.5 + rng.gauss() * 0.4, sx + Math.cos(a) * l, sy + Math.sin(a) * l);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Low-frequency mottling so large colour areas are never flat. */
function mottle(ctx: AnyCtx, rect: UVRect, rng: Rng, light: string, dark: string, count: number, alpha: number): void {
  ctx.save();
  ctx.filter = 'blur(6px)';
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha * rng.range(0.4, 1);
    ctx.fillStyle = rng.chance(0.5) ? light : dark;
    ctx.beginPath();
    ctx.ellipse(rect.x + rng.next() * rect.w, rect.y + rng.next() * rect.h, rng.range(8, 22), rng.range(5, 14), rng.gauss() * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ torso */

function torsoMaskPolys(pattern: CoatPattern, m: CoatMarkings): Pt[][] {
  const w = (0.5 - m.whiteAmount) * 0.42; // positive => more colour
  switch (pattern) {
    case 'PATCHED_TABBY_HARLEQUIN': {
      const rear: Pt[] = [
        [-0.04, -0.06],
        [0.505, -0.06],
        [0.505, 0.06],
        [0.49, 0.22],
        [0.46, 0.38],
        [0.42, 0.47 + w * 0.5],
        [0.35, 0.55 + w],
        [0.27, 0.6 + w],
        [0.19, 0.62 + w],
        [0.12, 0.69 + w],
        [0.05, 0.8 + w * 0.5],
        [-0.04, 0.86],
      ];
      const front: Pt[] = [
        [0.6, -0.06],
        [1.04, -0.06],
        [1.04, 0.37 + w * 0.4],
        [0.96, 0.39 + w * 0.5],
        [0.87, 0.43 + w * 0.6],
        [0.78, 0.5 + w * 0.7],
        [0.7, 0.46 + w * 0.6],
        [0.64, 0.33],
        [0.605, 0.14],
      ];
      const polys = [rear, front];
      if (!m.shoulderBand) {
        polys.push([
          [0.44, -0.06],
          [0.66, -0.06],
          [0.68, 0.42 + w * 0.5],
          [0.44, 0.44 + w * 0.5],
        ]);
      }
      return polys;
    }
    case 'MANTLED_BICOLOR_TABBY': {
      const mantle: Pt[] = [
        [-0.04, -0.06],
        [1.04, -0.06],
        [1.04, 0.43 + w * 0.4],
        [0.95, 0.47 + w * 0.5],
        [0.87, 0.6 + w * 0.6],
        [0.78, 0.7 + w * 0.6],
        [0.69, 0.67 + w * 0.6],
        [0.58, 0.6 + w],
        [0.45, 0.6 + w],
        [0.33, 0.62 + w],
        [0.25, 0.64 + w],
      ];
      if (m.rumpCrest) {
        mantle.push([0.225, 0.6 + w], [0.2, 0.4], [0.18, 0.3], [0.165, 0.27], [0.15, 0.31], [0.135, 0.42], [0.12, 0.66 + w]);
      }
      mantle.push([0.07, 0.8 + w * 0.5], [0.02, 0.86], [-0.04, 0.9]);
      return [mantle];
    }
    case 'TUXEDO': {
      return [
        [
          [-0.04, -0.06],
          [1.04, -0.06],
          [1.04, 0.36 + w * 0.5],
          [0.9, 0.42 + w * 0.5],
          [0.8, 0.62 + w * 0.6],
          [0.6, 0.66 + w * 0.7],
          [0.35, 0.68 + w * 0.7],
          [0.15, 0.74 + w * 0.6],
          [-0.04, 0.84],
        ],
      ];
    }
    case 'BICOLOR_VAN': {
      if (m.whiteAmount >= 0.85) {
        return [
          [
            [-0.04, -0.06],
            [0.14, -0.06],
            [0.13, 0.18],
            [0.05, 0.3],
            [-0.04, 0.34],
          ],
          [
            [0.42, 0.05],
            [0.5, 0.04],
            [0.52, 0.12],
            [0.45, 0.16],
          ],
        ];
      }
      const b = clamp((1 - m.whiteAmount) * 0.95, 0.15, 0.9);
      return [
        [
          [-0.04, -0.06],
          [1.04, -0.06],
          [1.04, b * 0.8],
          [0.8, b],
          [0.5, b + 0.04],
          [0.2, b + 0.02],
          [-0.04, b + 0.1],
        ],
      ];
    }
    default: {
      // Generic: full colour, optional white belly/chest locket from whiteAmount.
      if (m.whiteAmount < 0.06) {
        return [
          [
            [-0.06, -0.06],
            [1.06, -0.06],
            [1.06, 1.06],
            [-0.06, 1.06],
          ],
        ];
      }
      const b = clamp(1 - m.whiteAmount * 0.85, 0.2, 0.98);
      return [
        [
          [-0.04, -0.06],
          [1.04, -0.06],
          [1.04, b - 0.08],
          [0.86, b - 0.04],
          [0.6, b + 0.02],
          [0.3, b + 0.03],
          [-0.04, Math.min(1.04, b + 0.12)],
        ],
      ];
    }
  }
}

function drawMackerelStripes(ctx: AnyCtx, rect: UVRect, rng: Rng, color: string, density: number, scaleY = 1): void {
  const count = Math.round(lerp(8, 14, density));
  // Dorsal line: a dark, hairy band down the spine that the stripes hang from.
  const dorsal: Pt[] = [];
  for (let s = 0; s <= 24; s++) dorsal.push([rect.x + (s / 24) * rect.w, rect.y + rect.h * (0.035 + Math.sin(s * 0.9) * 0.006)]);
  furStripe(ctx, dorsal, () => rect.h * 0.075, color, rng, { alpha: 0.78, flow: Math.PI, len: [4, 8], density: 1.2, breaks: 0 });
  for (let k = 0; k < count; k++) {
    const u0 = (k + 0.5 + rng.gauss() * 0.16) / count;
    // Mackerel stripes run down the flank, bowing gently toward the rump.
    const slant = rng.range(-0.05, -0.012);
    const depth = rng.range(0.52, 0.86) * scaleY;
    const phase = rng.next() * 6;
    const wobble = rng.range(0.004, 0.01);
    const pts: Pt[] = [];
    for (let s = 0; s <= 14; s++) {
      const v = 0.04 + (s / 14) * depth;
      pts.push([(u0 + slant * v * 2.2 + Math.sin(v * 8 + phase) * wobble) * rect.w + rect.x, v * rect.h + rect.y]);
    }
    const wBase = rng.range(10, 15);
    furStripe(ctx, pts, (f) => lerp(wBase, 4, f) * (1 - 0.3 * Math.sin(f * 9 + phase) ** 2), color, rng, {
      alpha: 0.8,
      flow: Math.PI * 0.93,
      len: [4, 9],
      breaks: 0.8,
      core: 0.45,
    });
    // Occasional forked or broken spur, as on real mackerel coats.
    if (rng.chance(0.3)) {
      const i0 = 3 + Math.floor(rng.next() * 6);
      const [bx, by] = pts[i0];
      const spur: Pt[] = [
        [bx, by],
        [bx + rng.range(-9, -3), by + rng.range(8, 14)],
        [bx + rng.range(-14, -6), by + rng.range(16, 26)],
      ];
      furStripe(ctx, spur, (f) => lerp(6, 2.5, f), color, rng, { alpha: 0.7, breaks: 1.2 });
    }
  }
}

function drawClassicSwirl(ctx: AnyCtx, rect: UVRect, rng: Rng, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const cx = rect.x + rect.w * 0.38;
  const cy = rect.y + rect.h * 0.5;
  for (let r = 0; r < 4; r++) {
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 9 - r * 1.2;
    ctx.beginPath();
    ctx.ellipse(cx + rng.gauss() * 2, cy + rng.gauss() * 2, 22 + r * 26, 14 + r * 15, rng.gauss() * 0.05, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 14, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // butterfly lines along the spine + shoulder bars
  ctx.lineWidth = 5;
  for (let l = 0; l < 3; l++) {
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + 4 + l * 9);
    ctx.lineTo(rect.x + rect.w * 0.7, rect.y + 4 + l * 9 + rng.gauss());
    ctx.stroke();
  }
  drawMackerelStripes(ctx, { x: rect.x + rect.w * 0.68, y: rect.y, w: rect.w * 0.32, h: rect.h }, rng, color, 0.4, 0.8);
  ctx.restore();
}

function drawSpots(ctx: AnyCtx, rect: UVRect, rng: Rng, color: string, density: number): void {
  ctx.save();
  ctx.fillStyle = color;
  const rows = 5;
  const cols = Math.round(lerp(10, 18, density));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = rect.x + ((c + (r % 2) * 0.5 + rng.gauss() * 0.2) / cols) * rect.w;
      const y = rect.y + ((r + 0.6 + rng.gauss() * 0.15) / (rows + 0.6)) * rect.h * 0.85;
      ctx.globalAlpha = rng.range(0.7, 0.95);
      ctx.beginPath();
      ctx.ellipse(x, y, rng.range(5, 9), rng.range(4, 7), rng.gauss() * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 0.9;
  ctx.fillRect(rect.x, rect.y, rect.w, 6);
  ctx.restore();
}

function paintTorso(ctx: AnyCtx, p: CatProfile, rng: Rng): void {
  const { palette: pal, markings: m, pattern } = p;
  const R = UV.torso;
  const whiteBase = pattern !== 'SOLID' && pattern !== 'TORTOISESHELL' && pattern !== 'CUSTOM_MASK';

  // 1. Base layer: white (bicolour) or primary.
  if (pattern === 'COLORPOINT') {
    const g = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
    g.addColorStop(0, mixHex(pal.baseWhite, pal.tabbyBase, 0.18));
    g.addColorStop(1, pal.undercoatWarm);
    ctx.fillStyle = g;
  } else if (pattern === 'CUSTOM_MASK' || pattern === 'SOLID' || pattern === 'TORTOISESHELL') {
    ctx.fillStyle = pal.tabbyBase;
  } else {
    ctx.fillStyle = pal.baseWhite;
  }
  ctx.fillRect(R.x, R.y, R.w, R.h);

  if (whiteBase && pattern !== 'COLORPOINT') {
    // Cream belly pouch + soft fur texture on white.
    const g = ctx.createLinearGradient(0, R.y + R.h * 0.55, 0, R.y + R.h);
    g.addColorStop(0, rgba(pal.undercoatWarm, 0));
    g.addColorStop(1, rgba(pal.undercoatWarm, 0.95));
    ctx.fillStyle = g;
    ctx.fillRect(R.x, R.y + R.h * 0.55, R.w, R.h * 0.45);
    tick(ctx, R, rng, 1400, [shadeHex(pal.baseWhite, -0.07), shadeHex(pal.undercoatWarm, -0.05), '#FFFFFF'], 0.45, [4, 9], Math.PI * 0.97, 0.25, 1);
  }

  if (pattern === 'CALICO') {
    paintCalicoPatches(ctx, R, rng, pal, m.whiteAmount);
    return;
  }
  if (pattern === 'COLORPOINT') {
    ctx.save();
    const gl = ctx.createLinearGradient(R.x, 0, R.x + R.w * 0.35, 0);
    gl.addColorStop(0, rgba(pal.tabbyBase, 0.55));
    gl.addColorStop(1, rgba(pal.tabbyBase, 0));
    ctx.fillStyle = gl;
    ctx.fillRect(R.x, R.y, R.w * 0.35, R.h);
    const gr = ctx.createLinearGradient(R.x + R.w, 0, R.x + R.w * 0.8, 0);
    gr.addColorStop(0, rgba(pal.tabbyBase, 0.35));
    gr.addColorStop(1, rgba(pal.tabbyBase, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(R.x + R.w * 0.8, R.y, R.w * 0.2, R.h);
    const gd = ctx.createLinearGradient(0, R.y, 0, R.y + R.h * 0.4);
    gd.addColorStop(0, rgba(pal.tabbyBase, 0.22));
    gd.addColorStop(1, rgba(pal.tabbyBase, 0));
    ctx.fillStyle = gd;
    ctx.fillRect(R.x, R.y, R.w, R.h * 0.4);
    ctx.restore();
    tick(ctx, R, rng, 1200, [shadeHex(pal.baseWhite, -0.08), pal.undercoatWarm], 0.4, [4, 9], Math.PI, 0.25);
    return;
  }

  // 2. Colour layer (tabby / primary) on its own canvas, then masked.
  const layer = createCanvas(R.w, R.h);
  const lc = ctx2d(layer);
  const local: UVRect = { x: 0, y: 0, w: R.w, h: R.h };
  lc.fillStyle = pal.tabbyBase;
  lc.fillRect(0, 0, R.w, R.h);
  const tabby = isTabbyFamily(pattern);
  if (pattern === 'TORTOISESHELL') {
    paintTortie(lc, local, rng, pal);
  } else {
    // agouti ticking: light tips & dark bands
    tick(lc, local, rng, tabby ? 3600 : 1800, [shadeHex(pal.tabbyBase, 0.16), shadeHex(pal.tabbyBase, -0.14), mixHex(pal.tabbyBase, pal.rufus, 0.45), pal.tabbyStripe], tabby ? 0.55 : 0.3, [4, 10], Math.PI * 0.96, 0.22, 1.2);
    mottle(lc, local, rng, shadeHex(pal.tabbyBase, 0.12), shadeHex(pal.tabbyBase, -0.12), 26, 0.35);
    // rufous warmth low on the flanks
    if (tabby) {
      const g = lc.createLinearGradient(0, R.h * 0.35, 0, R.h * 0.85);
      g.addColorStop(0, rgba(pal.rufus, 0));
      g.addColorStop(1, rgba(pal.rufus, 0.32));
      lc.fillStyle = g;
      lc.fillRect(0, 0, R.w, R.h);
    }
    const style = stripeStyle(pattern);
    if (style === 'mackerel') drawMackerelStripes(lc, local, rng, pal.tabbyStripe, m.stripeDensity);
    else if (style === 'classic') drawClassicSwirl(lc, local, rng, pal.tabbyStripe);
    else if (style === 'spots') drawSpots(lc, local, rng, pal.tabbyStripe, m.stripeDensity);
    else if (style === 'ghost' && m.stripeDensity > 0.3) {
      lc.globalAlpha = 0.18 * m.stripeDensity;
      drawMackerelStripes(lc, local, rng, pal.tabbyStripe, m.stripeDensity);
      lc.globalAlpha = 1;
    }
    // second, finer ticking pass on top of stripes for a furry break-up
    tick(lc, local, rng, 1600, [shadeHex(pal.tabbyBase, 0.22), mixHex(pal.tabbyBase, pal.baseWhite, 0.3)], 0.35, [3, 7], Math.PI * 0.95, 0.3, 0.9);
  }

  // Mask
  const mask = createCanvas(R.w, R.h);
  const mc = ctx2d(mask);
  mc.fillStyle = '#000';
  const soft = pattern === 'MANTLED_BICOLOR_TABBY' ? 2.2 : 1.6;
  mc.filter = `blur(${soft}px)`;
  for (const poly of torsoMaskPolys(pattern, m)) fillPoly(mc, organic(poly, rng, 2.4, R.w, R.h));
  mc.filter = 'none';
  lc.globalCompositeOperation = 'destination-in';
  lc.drawImage(mask as CanvasImageSource, 0, 0);
  lc.globalCompositeOperation = 'source-over';
  ctx.drawImage(layer as CanvasImageSource, R.x, R.y);

  // Fur-edge feathering where colour meets white: short strokes crossing the border.
  if (whiteBase) featherEdges(ctx, mask, R, rng, pal);

  // 3. Golden flank blotch (Cat 1).
  if (m.flankPatch) {
    const polys = torsoMaskPolys(pattern, m);
    const rear = polys[0];
    const bottomAt = (u: number) => {
      let best = 0.6;
      let bd = Infinity;
      for (const pt of rear) {
        if (pt[1] > 0.3 && Math.abs(pt[0] - u) < bd) {
          bd = Math.abs(pt[0] - u);
          best = pt[1];
        }
      }
      return best;
    };
    const u = 0.25;
    const v = bottomAt(u) - 0.07;
    const cx = R.x + u * R.w;
    const cy = R.y + v * R.h;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 46);
    g.addColorStop(0, rgba(pal.flankPatch, 0.95));
    g.addColorStop(0.55, rgba(pal.flankPatch, 0.7));
    g.addColorStop(1, rgba(pal.flankPatch, 0));
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 52, 26, -0.08, 0, Math.PI * 2);
    ctx.fill();
    tick(ctx, { x: cx - 40, y: cy - 16, w: 80, h: 32 }, rng, 260, [shadeHex(pal.flankPatch, 0.12), shadeHex(pal.flankPatch, -0.1)], 0.6, [4, 9], Math.PI, 0.2);
    ctx.restore();
  }
}

function featherEdges(ctx: AnyCtx, mask: AnyCanvas, R: UVRect, rng: Rng, pal: CoatPalette): void {
  const mctx = ctx2d(mask);
  const data = mctx.getImageData(0, 0, R.w, R.h).data;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 1600; i++) {
    const x = Math.floor(rng.next() * R.w);
    const y = Math.floor(rng.next() * R.h);
    const a = data[(y * R.w + x) * 4 + 3];
    if (a < 40 || a > 215) continue;
    const toColour = rng.chance(0.5);
    ctx.strokeStyle = toColour ? shadeHex(pal.tabbyBase, rng.range(-0.05, 0.12)) : pal.baseWhite;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.1;
    const ang = Math.PI * 0.95 + rng.gauss() * 0.5;
    const l = rng.range(4, 9);
    ctx.beginPath();
    ctx.moveTo(R.x + x, R.y + y);
    ctx.lineTo(R.x + x + Math.cos(ang) * l, R.y + y + Math.sin(ang) * l + (toColour ? 3 : -3));
    ctx.stroke();
  }
  ctx.restore();
}

function blob(ctx: AnyCtx, cx: number, cy: number, rx: number, ry: number, rng: Rng): void {
  const pts: Pt[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.75 + rng.next() * 0.45;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  fillPoly(ctx, pts);
}

function paintCalicoPatches(ctx: AnyCtx, R: UVRect, rng: Rng, pal: CoatPalette, white: number): void {
  ctx.save();
  ctx.filter = 'blur(1.5px)';
  const n = Math.round(lerp(8, 4, white));
  for (let i = 0; i < n; i++) {
    const orange = i % 2 === 0;
    ctx.fillStyle = orange ? pal.patchSecondary : pal.tabbyBase;
    const cx = R.x + rng.range(0.05, 0.95) * R.w;
    const cy = R.y + rng.range(0.05, 0.45) * R.h;
    blob(ctx, cx, cy, rng.range(30, 70), rng.range(22, 44), rng);
  }
  ctx.filter = 'none';
  ctx.restore();
  tick(ctx, R, rng, 900, [shadeHex(pal.patchSecondary, 0.1), shadeHex(pal.tabbyBase, 0.15)], 0.25, [4, 8], Math.PI, 0.25);
}

function paintTortie(ctx: AnyCtx, R: UVRect, rng: Rng, pal: CoatPalette): void {
  ctx.save();
  ctx.filter = 'blur(2px)';
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = rng.chance(0.6) ? pal.patchSecondary : shadeHex(pal.patchSecondary, -0.15);
    ctx.globalAlpha = rng.range(0.55, 0.95);
    blob(ctx, R.x + rng.next() * R.w, R.y + rng.next() * R.h, rng.range(10, 34), rng.range(8, 22), rng);
  }
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.restore();
  tick(ctx, R, rng, 2600, [pal.patchSecondary, pal.tabbyStripe, shadeHex(pal.tabbyBase, 0.12)], 0.45, [4, 10], Math.PI * 0.96, 0.25, 1.2);
}

/* ------------------------------------------------------------------- head */

function paintHead(ctx: AnyCtx, p: CatProfile, rng: Rng): void {
  const { palette: pal, markings: m, pattern } = p;
  const R = UV.head;
  const T = HEAD_TEMPLATE;
  const cx = R.x + T.cx;
  const ey = R.y + T.eyeY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(R.x, R.y, R.w, R.h);
  ctx.clip();

  const tabby = isTabbyFamily(pattern) || pattern === 'TUXEDO' || pattern === 'SOLID' || pattern === 'CUSTOM_MASK';
  const capColor = pattern === 'COLORPOINT' ? mixHex(pal.baseWhite, pal.tabbyBase, 0.25) : pal.tabbyBase;
  ctx.fillStyle = capColor;
  ctx.fillRect(R.x, R.y, R.w, R.h);

  if (pattern === 'TORTOISESHELL' || pattern === 'CALICO') {
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = pal.patchSecondary;
    blob(ctx, R.x + 52, R.y + 70, 40, 46, rng);
    if (pattern === 'TORTOISESHELL') blob(ctx, R.x + 140, R.y + 130, 30, 30, rng);
    ctx.restore();
  }
  // ticking
  if (pattern !== 'COLORPOINT') {
    tick(ctx, R, rng, 900, [shadeHex(capColor, 0.15), shadeHex(capColor, -0.14), mixHex(capColor, pal.rufus, 0.5)], 0.55, [3, 6], -Math.PI / 2, 0.5, 1);
  }

  // rufous eye halo & nose bridge warmth
  if (m.eyeHalo > 0.01) {
    for (const sx of [-1, 1]) {
      const g = ctx.createRadialGradient(cx + sx * T.eyeDX, ey, 6, cx + sx * T.eyeDX, ey + 4, 34);
      g.addColorStop(0, rgba(pal.rufus, 0.85 * m.eyeHalo));
      g.addColorStop(1, rgba(pal.rufus, 0));
      ctx.fillStyle = g;
      ctx.fillRect(R.x, R.y, R.w, R.h);
    }
  }

  const stripe = pal.tabbyStripe;
  if (tabby && stripeStyle(pattern) !== 'none') {
    const ghost = stripeStyle(pattern) === 'ghost' ? 0.25 : 1;
    const quad = (x0: number, y0: number, cx1: number, cy1: number, x1: number, y1: number, n = 10): Pt[] => {
      const out: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        out.push([mt * mt * x0 + 2 * mt * t * cx1 + t * t * x1, mt * mt * y0 + 2 * mt * t * cy1 + t * t * y1]);
      }
      return out;
    };
    // forehead stripes running up over the crown (fur flows up and back)
    for (let i = -3; i <= 3; i++) {
      const x0 = cx + i * 7.5;
      const w0 = i === 0 ? 3.4 : 2.8;
      furStripe(ctx, quad(x0, R.y + 62 - Math.abs(i) * 2, x0 + i * 2.5, R.y + 36, x0 + i * 5, R.y + 4), (f) => lerp(w0, w0 * 1.25, f), stripe, rng, {
        alpha: 0.8 * ghost,
        flow: -Math.PI / 2 + i * 0.08,
        len: [2.5, 5],
        breaks: 0.5,
      });
    }
    // the "M"
    if (m.mMark) {
      const M: Pt[] = [
        [cx - 26, R.y + 74],
        [cx - 16, R.y + 54],
        [cx - 6, R.y + 70],
        [cx, R.y + 58],
        [cx + 6, R.y + 70],
        [cx + 16, R.y + 54],
        [cx + 26, R.y + 74],
      ];
      furStripe(ctx, M, () => 3.4, stripe, rng, { alpha: 0.92 * ghost, flow: -Math.PI / 2, len: [2.5, 4.5], breaks: 0, core: 0.75 });
    }
    // cheek stripes sweeping back from the eyes (fur flows outward)
    if (m.cheekStripes > 0.02) {
      for (const sx of [-1, 1]) {
        const flow = sx > 0 ? 0.15 : Math.PI - 0.15;
        furStripe(ctx, quad(cx + sx * (T.eyeDX + 14), ey + 14, cx + sx * (T.eyeDX + 30), ey + 18, cx + sx * (T.eyeDX + 46), ey + 8), (f) => lerp(4, 2.6, f), stripe, rng, {
          alpha: 0.88 * m.cheekStripes * ghost,
          flow,
          len: [2.5, 5],
          breaks: 0.4,
        });
        furStripe(ctx, quad(cx + sx * (T.eyeDX + 10), ey + 30, cx + sx * (T.eyeDX + 28), ey + 34, cx + sx * (T.eyeDX + 44), ey + 26), (f) => lerp(3.2, 2, f), stripe, rng, {
          alpha: 0.8 * m.cheekStripes * ghost,
          flow,
          len: [2.5, 5],
          breaks: 0.6,
        });
      }
    }
  }
  // Cleopatra eyeliner sweeping toward the temples
  if (m.eyeliner > 0.02 && pattern !== 'COLORPOINT') {
    for (const sx of [-1, 1]) {
      const pts: Pt[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const mt = 1 - t;
        const x0 = cx + sx * (T.eyeDX + 11);
        const x1 = cx + sx * (T.eyeDX + 24);
        const x2 = cx + sx * (T.eyeDX + 37);
        pts.push([mt * mt * x0 + 2 * mt * t * x1 + t * t * x2, mt * mt * (ey + 1) + 2 * mt * t * (ey + 2) + t * t * (ey - 8)]);
      }
      furStripe(ctx, pts, (f) => lerp(3.6, 1.2, f), stripe, rng, { alpha: 0.95 * m.eyeliner, flow: sx > 0 ? -0.2 : Math.PI + 0.2, len: [2, 4], breaks: 0, core: 0.9 });
    }
  }
  ctx.globalAlpha = 1;

  if (pattern === 'COLORPOINT') {
    const g = ctx.createRadialGradient(cx, R.y + 128, 8, cx, R.y + 118, 70);
    g.addColorStop(0, rgba(pal.tabbyBase, 0.95));
    g.addColorStop(0.6, rgba(pal.tabbyBase, 0.6));
    g.addColorStop(1, rgba(pal.tabbyBase, 0));
    ctx.fillStyle = g;
    ctx.fillRect(R.x, R.y, R.w, R.h);
  }

  // White blaze (inverted V) + whisker pads + chin + throat bib.
  const blazeW = m.blazeWidth;
  if (blazeW > 0.02 && pattern !== 'COLORPOINT') {
    const topY = R.y + T.eyeY - 14 - m.blazeHeight * 64;
    const hwEye = 2.5 + blazeW * 17;
    const hwNose = 9 + blazeW * 26;
    ctx.save();
    ctx.fillStyle = pal.baseWhite;
    ctx.filter = `blur(${(0.6 + m.blazeSoftness * 3.4).toFixed(2)}px)`;
    ctx.beginPath();
    ctx.moveTo(cx, topY);
    ctx.quadraticCurveTo(cx + hwEye * 0.6, (topY + ey) / 2, cx + hwEye, ey);
    ctx.quadraticCurveTo(cx + hwNose * 0.8, R.y + T.noseY - 10, cx + hwNose, R.y + T.noseY + 2);
    ctx.lineTo(cx + 46, R.y + 150);
    ctx.lineTo(cx + 60, R.y + 200);
    ctx.lineTo(cx - 60, R.y + 200);
    ctx.lineTo(cx - 46, R.y + 150);
    ctx.lineTo(cx - hwNose, R.y + T.noseY + 2);
    ctx.quadraticCurveTo(cx - hwNose * 0.8, R.y + T.noseY - 10, cx - hwEye, ey);
    ctx.quadraticCurveTo(cx - hwEye * 0.6, (topY + ey) / 2, cx, topY);
    ctx.closePath();
    ctx.fill();
    // whisker pads
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + sx * 18, R.y + T.muzzleY, 20 + blazeW * 5, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(cx, R.y + T.chinY, 24 + blazeW * 8, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    tick(ctx, { x: cx - 40, y: R.y + T.noseY, w: 80, h: 60 }, rng, 160, [shadeHex(pal.baseWhite, -0.06), '#FFFFFF'], 0.4, [3, 6], Math.PI / 2, 0.8, 0.9);
    // warm rufous wash on the sides of the nose bridge (seen in both reference cats)
    if (m.eyeHalo > 0.2) {
      for (const sx of [-1, 1]) {
        const g = ctx.createRadialGradient(cx + sx * (hwEye + 6), ey + 12, 1, cx + sx * (hwEye + 6), ey + 12, 12);
        g.addColorStop(0, rgba(pal.rufus, 0.5 * m.eyeHalo));
        g.addColorStop(1, rgba(pal.rufus, 0));
        ctx.fillStyle = g;
        ctx.fillRect(R.x, R.y, R.w, R.h);
      }
    }
  } else if (pattern !== 'COLORPOINT') {
    // muzzle slightly paler even without a blaze
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = mixHex(capColor, pal.baseWhite, 0.5);
    ctx.filter = 'blur(4px)';
    ctx.beginPath();
    ctx.ellipse(cx, R.y + T.muzzleY + 6, 34, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/* ------------------------------------------------------------- legs, tail */

function legWhiteFraction(id: LegId, m: CoatMarkings): number {
  return id === 'frontNear' || id === 'frontFar' ? m.frontLegWhite : m.hindLegWhite;
}

function paintLegs(ctx: AnyCtx, p: CatProfile, rng: Rng): void {
  const { palette: pal, markings: m, pattern } = p;
  for (const id of ['frontNear', 'frontFar', 'hindNear', 'hindFar'] as LegId[]) {
    const R = UV.legs[id];
    const top = pattern === 'COLORPOINT' ? mixHex(pal.baseWhite, pal.tabbyBase, 0.35) : pattern === 'CALICO' ? pal.baseWhite : pal.tabbyBase;
    ctx.fillStyle = top;
    ctx.fillRect(R.x, R.y, R.w, R.h);
    if (pattern === 'COLORPOINT') {
      const g = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
      g.addColorStop(0, rgba(pal.tabbyBase, 0.15));
      g.addColorStop(1, rgba(pal.tabbyBase, 0.95));
      ctx.fillStyle = g;
      ctx.fillRect(R.x, R.y, R.w, R.h);
      continue;
    }
    if (pattern !== 'CALICO') {
      tick(ctx, R, rng, 260, [shadeHex(top, 0.14), shadeHex(top, -0.12)], 0.5, [3, 7], Math.PI / 2, 0.3, 1);
      if (stripeStyle(pattern) === 'mackerel' || stripeStyle(pattern) === 'classic' || stripeStyle(pattern) === 'spots') {
        for (let k = 0; k < 4; k++) {
          const y = R.y + 30 + k * 44 + rng.gauss() * 4;
          const bar: Pt[] = [];
          for (let s = 0; s <= 8; s++) bar.push([R.x + (s / 8) * R.w, y + Math.sin((s / 8) * Math.PI) * 6 + rng.gauss() * 0.6]);
          furStripe(ctx, bar, (f) => lerp(5.5, 3.5, Math.abs(f - 0.5) * 2), pal.tabbyStripe, rng, { alpha: 0.72, flow: Math.PI / 2, len: [3, 6], breaks: 0.6 });
        }
      }
      if (pattern === 'TORTOISESHELL') paintTortie(ctx, R, rng, pal);
    }
    const wf = pattern === 'CALICO' ? 1 : legWhiteFraction(id, m);
    if (wf > 0.01) {
      const startY = R.y + R.h * (1 - clamp01(wf));
      const g = ctx.createLinearGradient(0, startY - 10, 0, startY + 10);
      g.addColorStop(0, rgba(pal.baseWhite, 0));
      g.addColorStop(1, rgba(pal.baseWhite, 1));
      ctx.fillStyle = g;
      ctx.fillRect(R.x, startY - 10, R.w, 20);
      ctx.fillStyle = pal.baseWhite;
      ctx.fillRect(R.x, startY + 10, R.w, R.y + R.h - startY);
      tick(ctx, { x: R.x, y: startY, w: R.w, h: R.y + R.h - startY }, rng, 120, [shadeHex(pal.baseWhite, -0.07)], 0.5, [3, 6], Math.PI / 2, 0.3, 1);
    }
  }
}

function paintTail(ctx: AnyCtx, p: CatProfile, rng: Rng): void {
  const { palette: pal, markings: m, pattern } = p;
  const R = UV.tail;
  const base = pattern === 'COLORPOINT' ? pal.tabbyBase : pal.tabbyBase;
  ctx.fillStyle = base;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  if (pattern === 'CALICO') {
    ctx.fillStyle = pal.patchSecondary;
    ctx.fillRect(R.x + R.w * 0.3, R.y, R.w * 0.35, R.h);
  }
  tick(ctx, R, rng, 900, [shadeHex(base, 0.14), shadeHex(base, -0.14), mixHex(base, pal.rufus, 0.4)], 0.5, [4, 9], Math.PI, 0.2, 1.1);
  if (pattern === 'TORTOISESHELL') paintTortie(ctx, R, rng, pal);
  const rings = Math.round(clamp(m.tailRings, 0, 8));
  if (rings > 0 && pattern !== 'COLORPOINT' && pattern !== 'SOLID') {
    for (let k = 0; k < rings; k++) {
      const u = lerp(0.22, 0.86, rings === 1 ? 0.5 : k / (rings - 1));
      const w = lerp(15, 24, k / Math.max(1, rings - 1));
      const ring: Pt[] = [];
      for (let s = 0; s <= 8; s++) ring.push([R.x + u * R.w + Math.sin((s / 8) * Math.PI) * 5, R.y - 2 + (s / 8) * (R.h + 4)]);
      furStripe(ctx, ring, (f) => w * (0.82 + 0.18 * Math.sin(f * Math.PI)), pal.tabbyStripe, rng, { alpha: 0.9, flow: 0, len: [4, 8], density: 1.1, breaks: 0, core: 0.8 });
    }
  }
  if (m.tailTipDark || pattern === 'COLORPOINT') {
    const g = ctx.createLinearGradient(R.x + R.w * 0.86, 0, R.x + R.w * 0.93, 0);
    g.addColorStop(0, rgba(pal.tabbyStripe, 0));
    g.addColorStop(1, rgba(pal.tabbyStripe, 0.96));
    ctx.fillStyle = g;
    ctx.fillRect(R.x + R.w * 0.86, R.y, R.w * 0.14, R.h);
  }
  // dorsal stripe along the tail
  if (isTabbyFamily(pattern)) {
    ctx.fillStyle = rgba(pal.tabbyStripe, 0.35);
    ctx.fillRect(R.x, R.y, R.w, R.h * 0.18);
  }
}

function paintEars(ctx: AnyCtx, p: CatProfile, rng: Rng): void {
  const R = UV.ears;
  const outer = p.pattern === 'COLORPOINT' ? p.palette.tabbyBase : p.palette.tabbyBase;
  ctx.fillStyle = outer;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  tick(ctx, R, rng, 200, [shadeHex(outer, 0.15), shadeHex(outer, -0.15)], 0.5, [3, 6], -Math.PI / 2, 0.3, 1);
}

/* ------------------------------------------------------------------- main */

export function buildCoatTexture(profile: CatProfile, paint: CanvasImageSource | null = null): CoatTexture {
  const canvas = createCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = ctx2d(canvas, { willReadFrequently: true });
  const rng = new Rng(hashString(profile.id + profile.pattern));
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  paintTorso(ctx, profile, rng);
  paintHead(ctx, profile, rng);
  paintLegs(ctx, profile, rng);
  paintTail(ctx, profile, rng);
  paintEars(ctx, profile, rng);
  if (paint) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(paint, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.restore();
  }
  const pixels = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const sample = (x: number, y: number): [number, number, number] => {
    const xi = Math.max(0, Math.min(ATLAS_SIZE - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(ATLAS_SIZE - 1, Math.round(y)));
    const i = (yi * ATLAS_SIZE + xi) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };
  const pal = profile.palette;
  const capColor = profile.pattern === 'COLORPOINT' ? mixHex(pal.baseWhite, pal.tabbyBase, 0.3) : pal.tabbyBase;
  const rgbCap = hexToRgb(capColor);
  const outline = `rgba(${Math.round(rgbCap.r * 0.35)},${Math.round(rgbCap.g * 0.32)},${Math.round(rgbCap.b * 0.3)},0.55)`;
  return {
    canvas,
    pixels,
    key: profileKey(profile),
    capColor,
    earOuter: profile.pattern === 'COLORPOINT' ? pal.tabbyBase : shadeHex(capColor, -0.04),
    outline,
    legOutline: `rgba(${Math.round(rgbCap.r * 0.6)},${Math.round(rgbCap.g * 0.56)},${Math.round(rgbCap.b * 0.52)},0.42)`,
    sample,
  };
}

export function coatKey(profile: CatProfile): string {
  return profileKey(profile);
}
