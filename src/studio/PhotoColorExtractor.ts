/**
 * PhotoColorExtractor — local computer vision on an HTML5 canvas.
 *
 *  • Interactive anatomical sampler: averages a small patch under each pin.
 *  • Auto palette: centre-weighted pixel sampling + K-Means (k-means++ seeding,
 *    CIE-Lab distance) → dominant colours with their share of the cat
 *    ("contrast distribution"), then heuristic role assignment (white fur,
 *    agouti base, stripe charcoal, rufous, nose pink, eye green).
 *
 * The pure functions operate on RGBA byte arrays so they are unit-testable
 * without a DOM. Nothing ever leaves the machine.
 */
import { clamp, clamp01 } from '../shared/math';
import { hexToRgb, mixHex, rgbToHex, rgbToHsl, rgbToLab, shadeHex, type RGB } from '../shared/color';
import { Rng } from '../shared/rng';
import type { CoatPalette } from '../shared/types';

export interface PixelSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ColorCluster {
  color: RGB;
  hex: string;
  /** Fraction of sampled pixels in this cluster (0..1). */
  share: number;
  lum: number;
  sat: number;
  hue: number;
  /** Absolute chroma (max−min)/255 — robust for near-whites under warm indoor light. */
  chroma: number;
}

export type SampleRole = 'primaryFur' | 'bellyFur' | 'stripes' | 'leftEye' | 'rightEye' | 'nosePink' | 'pawSocks';

export const SAMPLE_ROLES: readonly SampleRole[] = ['primaryFur', 'bellyFur', 'stripes', 'leftEye', 'rightEye', 'nosePink', 'pawSocks'];

/** Mean colour of a (2r+1)² patch, ignoring fully transparent pixels. */
export function averagePatch(src: PixelSource, x: number, y: number, radius = 3): RGB {
  const { data, width, height } = src;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let yy = Math.max(0, cy - radius); yy <= Math.min(height - 1, cy + radius); yy++) {
    for (let xx = Math.max(0, cx - radius); xx <= Math.min(width - 1, cx + radius); xx++) {
      const i = (yy * width + xx) * 4;
      if (data[i + 3] < 8) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 128, g: 128, b: 128 };
}

/**
 * Samples up to `max` pixels. With centreWeight > 0, pixels near the image centre
 * (where the cat usually is) are proportionally more likely to be kept.
 */
export function samplePixels(src: PixelSource, max = 5000, seed = 1, centreWeight = 0.75): RGB[] {
  const { data, width, height } = src;
  const rng = new Rng(seed);
  const out: RGB[] = [];
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / (max * 2)));
  for (let p = 0; p < total && out.length < max; p += stride) {
    const i = p * 4;
    if (data[i + 3] < 8) continue;
    const x = (p % width) / width - 0.5;
    const y = Math.floor(p / width) / height - 0.5;
    const d = Math.sqrt((x * x) / 0.16 + (y * y) / 0.16);
    const keep = 1 - centreWeight * clamp01(d - 0.35);
    if (rng.next() > keep) continue;
    out.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  return out;
}

function labDist2(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

/** K-Means clustering in CIE-Lab with k-means++ initialisation. Deterministic for a given seed. */
export function kMeans(points: RGB[], k: number, seed = 7, iterations = 14): ColorCluster[] {
  if (points.length === 0) return [];
  const kk = Math.max(1, Math.min(k, points.length));
  const rng = new Rng(seed);
  const labs = points.map(rgbToLab);
  const centers: [number, number, number][] = [labs[Math.floor(rng.next() * labs.length)]];
  while (centers.length < kk) {
    const d2 = labs.map((l) => Math.min(...centers.map((c) => labDist2(l, c))));
    const sum = d2.reduce((a, b) => a + b, 0);
    if (sum === 0) break;
    let r = rng.next() * sum;
    let idx = 0;
    for (; idx < d2.length - 1; idx++) {
      r -= d2[idx];
      if (r <= 0) break;
    }
    centers.push(labs[idx]);
  }
  const assign = new Int32Array(labs.length);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < labs.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = labDist2(labs[i], centers[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < labs.length; i++) {
      const s = sums[assign[i]];
      s[0] += labs[i][0];
      s[1] += labs[i][1];
      s[2] += labs[i][2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (!moved && it > 0) break;
  }
  // Report mean RGB per cluster (more faithful than converting Lab back).
  const rgbSums = centers.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < points.length; i++) {
    const s = rgbSums[assign[i]];
    s[0] += points[i].r;
    s[1] += points[i].g;
    s[2] += points[i].b;
    s[3]++;
  }
  const clusters: ColorCluster[] = [];
  for (const s of rgbSums) {
    if (s[3] === 0) continue;
    const color = { r: s[0] / s[3], g: s[1] / s[3], b: s[2] / s[3] };
    const hsl = rgbToHsl(color);
    const chroma = (Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)) / 255;
    clusters.push({ color, hex: rgbToHex(color), share: s[3] / points.length, lum: hsl.l, sat: hsl.s, hue: hsl.h, chroma });
  }
  return clusters.sort((a, b) => b.share - a.share);
}

export interface PaletteSuggestion {
  palette: Partial<CoatPalette>;
  /** Which cluster hex was chosen for which role (for the UI legend). */
  roles: Partial<Record<keyof CoatPalette, string>>;
}

function inHue(h: number, lo: number, hi: number): boolean {
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
}

/** Maps clusters to coat palette roles using simple, explainable colour heuristics. */
export function suggestPalette(clusters: ColorCluster[]): PaletteSuggestion {
  const palette: Partial<CoatPalette> = {};
  const roles: Partial<Record<keyof CoatPalette, string>> = {};
  const used = new Set<ColorCluster>();
  const pick = (key: keyof CoatPalette, c: ColorCluster | undefined, hex?: string) => {
    if (!c) return;
    used.add(c);
    palette[key] = hex ?? c.hex;
    roles[key] = c.hex;
  };
  const sig = clusters.filter((c) => c.share > 0.01);
  // White fur often photographs as cream under warm lamps, so judge by absolute chroma, not HSL saturation.
  const white = sig.filter((c) => c.lum > 0.6 && c.chroma < 0.22).sort((a, b) => b.lum * (0.5 + b.share) - a.lum * (0.5 + a.share))[0];
  pick('baseWhite', white);
  if (white) {
    palette.undercoatWarm = shadeHex(mixHex(white.hex, '#C9A27A', 0.08), -0.03);
    roles.undercoatWarm = white.hex;
  }
  const dark = sig.filter((c) => !used.has(c) && c.lum < 0.3).sort((a, b) => a.lum - b.lum)[0];
  pick('tabbyStripe', dark);
  const base = sig.filter((c) => !used.has(c) && c.lum >= 0.18 && c.lum <= 0.62 && c.chroma < 0.32).sort((a, b) => b.share - a.share)[0];
  pick('tabbyBase', base);
  const rufus = sig.filter((c) => !used.has(c) && inHue(c.hue, 15, 48) && c.sat > 0.28 && c.lum > 0.25 && c.lum < 0.7).sort((a, b) => b.sat - a.sat)[0];
  if (rufus) {
    pick('rufus', rufus);
    palette.flankPatch = shadeHex(rufus.hex, 0.03);
    roles.flankPatch = rufus.hex;
  }
  const pink = clusters.filter((c) => inHue(c.hue, 330, 22) && c.sat > 0.25 && c.lum > 0.45 && c.lum < 0.85).sort((a, b) => b.sat - a.sat)[0];
  if (pink) {
    palette.noseLeather = pink.hex;
    palette.innerEar = shadeHex(pink.hex, 0.02);
    palette.pawPads = shadeHex(pink.hex, 0.01);
    roles.noseLeather = pink.hex;
  }
  const eye = clusters.filter((c) => inHue(c.hue, 50, 150) && c.sat > 0.22 && c.lum > 0.25 && c.lum < 0.75).sort((a, b) => b.sat - a.sat)[0];
  if (eye) {
    palette.eyeLeft = eye.hex;
    palette.eyeRight = shadeHex(eye.hex, -0.03);
    roles.eyeLeft = eye.hex;
  }
  return { palette, roles };
}

/** Converts pin samples into palette updates. */
/** The clean warm white that white fur is corrected towards (the factory `baseWhite`). */
export const WHITE_REFERENCE: RGB = { r: 247, g: 246, b: 242 };

const lumaOf = (c: RGB) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const chromaOf = (c: RGB) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;

export interface WhiteBalance {
  /** Luminance-neutral per-channel gains that remove the lamp's colour cast. */
  cast: [number, number, number];
  /** Exposure gain (kept modest so bright noses and eyes don't blow out). */
  exposure: number;
}

/**
 * Von Kries white balance from a patch of white fur: indoor lamps make white
 * cats look beige and under-exposed. Returns null when the sample is too dark
 * or too coloured to be white fur (e.g. a solid-coloured cat's "belly").
 */
export function whiteBalanceFrom(white: RGB, target: RGB = WHITE_REFERENCE): WhiteBalance | null {
  const l = (Math.max(white.r, white.g, white.b) + Math.min(white.r, white.g, white.b)) / 510;
  if (l < 0.45 || chromaOf(white) > 0.3) return null;
  const gains = [target.r / Math.max(1, white.r), target.g / Math.max(1, white.g), target.b / Math.max(1, white.b)];
  const e = lumaOf(target) / Math.max(1, lumaOf(white));
  const cast = gains.map((g) => clamp(g / e, 0.75, 1.35)) as [number, number, number];
  return { cast, exposure: clamp(e, 0.9, 1.35) };
}

export function applyWhiteBalance(c: RGB, wb: WhiteBalance | null): RGB {
  if (!wb) return c;
  return {
    r: clamp(c.r * wb.cast[0] * wb.exposure, 0, 255),
    g: clamp(c.g * wb.cast[1] * wb.exposure, 0, 255),
    b: clamp(c.b * wb.cast[2] * wb.exposure, 0, 255),
  };
}

/** True when a sampled "eye" is really a dilated pupil (no iris colour to read). */
export function isPupilDominated(c: RGB): boolean {
  return Math.max(c.r, c.g, c.b) < 64;
}

export interface SampleInterpretation {
  palette: Partial<CoatPalette>;
  whiteBalanced: boolean;
  /** Eye samples ignored because the pupil filled the iris. */
  skippedEyes: SampleRole[];
  applied: number;
}

export function interpretSamples(samples: Partial<Record<SampleRole, RGB>>, opts: { whiteBalance?: boolean } = {}): SampleInterpretation {
  const white = samples.bellyFur ?? samples.pawSocks;
  const wb = opts.whiteBalance !== false && white ? whiteBalanceFrom(white) : null;
  const fix = (c: RGB) => applyWhiteBalance(c, wb);
  const hex = (c: RGB) => rgbToHex(fix(c));
  const out: Partial<CoatPalette> = {};
  const skippedEyes: SampleRole[] = [];
  if (samples.primaryFur) out.tabbyBase = hex(samples.primaryFur);
  const whiteHex = samples.bellyFur ? hex(samples.bellyFur) : samples.pawSocks ? hex(samples.pawSocks) : null;
  if (whiteHex) {
    out.baseWhite = whiteHex;
    out.undercoatWarm = shadeHex(mixHex(whiteHex, '#C9A27A', 0.08), -0.03);
  }
  if (samples.stripes) out.tabbyStripe = hex(samples.stripes);
  const eye = (role: 'leftEye' | 'rightEye'): string | null => {
    const c = samples[role];
    if (!c) return null;
    if (isPupilDominated(c)) {
      skippedEyes.push(role);
      return null;
    }
    return hex(c);
  };
  const left = eye('leftEye');
  const right = eye('rightEye');
  // One readable eye colours both; two readable eyes keep any heterochromia.
  const eyeL = left ?? right;
  const eyeR = right ?? left;
  if (eyeL) out.eyeLeft = eyeL;
  if (eyeR) out.eyeRight = eyeR;
  if (samples.nosePink) {
    const nose = hex(samples.nosePink);
    out.noseLeather = nose;
    out.innerEar = shadeHex(nose, 0.02);
    out.pawPads = shadeHex(nose, 0.01);
  }
  return { palette: out, whiteBalanced: !!wb, skippedEyes, applied: Object.keys(samples).length - skippedEyes.length };
}

export function paletteFromSamples(samples: Partial<Record<SampleRole, RGB>>, opts: { whiteBalance?: boolean } = {}): Partial<CoatPalette> {
  return interpretSamples(samples, opts).palette;
}

/** Contrast between the lightest and darkest significant clusters (0..1). */
export function contrastSpread(clusters: ColorCluster[]): number {
  const sig = clusters.filter((c) => c.share > 0.03);
  if (sig.length < 2) return 0;
  return clamp(Math.max(...sig.map((c) => c.lum)) - Math.min(...sig.map((c) => c.lum)), 0, 1);
}

/* ------------------------------------------------------------ DOM helpers */

/** Decodes an image File locally and returns a downscaled canvas + pixels. */
export async function loadPhoto(file: Blob, maxSide = 900): Promise<{ canvas: HTMLCanvasElement; pixels: PixelSource }> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, pixels: { data: img.data, width: img.width, height: img.height } };
}

/** Small JPEG thumbnail for persisting the reference photo in the profile. */
export function thumbnail(canvas: HTMLCanvasElement, maxSide = 360): string {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  (c.getContext('2d') as CanvasRenderingContext2D).drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

/** Runs the whole auto-palette pipeline on a photo. */
export function analyzePhoto(pixels: PixelSource, k = 7): { clusters: ColorCluster[]; suggestion: PaletteSuggestion; contrast: number } {
  const pts = samplePixels(pixels, 4500, 11, 0.8);
  const clusters = kMeans(pts, k, 5, 16);
  return { clusters, suggestion: suggestPalette(clusters), contrast: contrastSpread(clusters) };
}

/** True for a warm, clearly amber / rufous colour (a real orange patch, not beige or brown). */
export function isWarmAmber(hex: string): boolean {
  const { h, s, l } = rgbToHsl(hexToRgb(hex));
  return h >= 12 && h <= 42 && s >= 0.42 && l >= 0.3 && l <= 0.72;
}

/**
 * Merges photo-derived colours into a cat's palette without losing its signature
 * markings: markings (Alex's white saddle band, flank patch, blaze…) are never
 * touched, and while the flank patch is switched on its amber and the rufous
 * undertone only change to another genuinely warm amber.
 */
export function mergePalette(current: { palette: CoatPalette; markings: { flankPatch: boolean } }, patch: Partial<CoatPalette>): CoatPalette {
  const next: CoatPalette = { ...current.palette, ...patch };
  if (current.markings.flankPatch) {
    if (patch.flankPatch && !isWarmAmber(patch.flankPatch)) next.flankPatch = current.palette.flankPatch;
    if (patch.rufus && !isWarmAmber(patch.rufus)) next.rufus = current.palette.rufus;
  }
  return next;
}
