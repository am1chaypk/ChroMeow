import { describe, expect, it } from 'vitest';
import { applyWhiteBalance, averagePatch, contrastSpread, interpretSamples, kMeans, paletteFromSamples, samplePixels, suggestPalette, whiteBalanceFrom, type PixelSource } from '../src/studio/PhotoColorExtractor';
import { deltaE, hexToRgb, rgbToHsl } from '../src/shared/color';

/** Builds an RGBA image from vertical bands of colour with relative widths. */
function bands(width: number, height: number, cols: [string, number][]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  const total = cols.reduce((s, [, w]) => s + w, 0);
  const edges: number[] = [];
  let acc = 0;
  for (const [, w] of cols) {
    acc += w;
    edges.push((acc / total) * width);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = edges.findIndex((e) => x < e);
      const c = hexToRgb(cols[Math.max(0, idx)][0]);
      const i = (y * width + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('anatomical sampler', () => {
  it('averages a patch under a pin', () => {
    const img = bands(40, 40, [['#7A6855', 1]]);
    const c = averagePatch(img, 20, 20, 3);
    expect(c.r).toBeCloseTo(0x7a, 5);
    expect(c.g).toBeCloseTo(0x68, 5);
    expect(c.b).toBeCloseTo(0x55, 5);
  });

  it('blends across a boundary', () => {
    const img = bands(40, 10, [
      ['#000000', 1],
      ['#FFFFFF', 1],
    ]);
    const c = averagePatch(img, 20, 5, 2);
    expect(c.r).toBeGreaterThan(60);
    expect(c.r).toBeLessThan(200);
  });

  it('maps sampled body parts onto palette roles', () => {
    const p = paletteFromSamples({
      primaryFur: { r: 122, g: 104, b: 85 },
      bellyFur: { r: 247, g: 246, b: 242 },
      stripes: { r: 42, g: 36, b: 30 },
      leftEye: { r: 143, g: 168, b: 104 },
      nosePink: { r: 229, g: 139, b: 136 },
    });
    expect(p.tabbyBase).toBe('#7A6855');
    expect(p.baseWhite).toBe('#F7F6F2');
    expect(p.tabbyStripe).toBe('#2A241E');
    expect(p.eyeLeft).toBe('#8FA868');
    expect(p.eyeRight).toBe('#8FA868');
    expect(p.noseLeather).toBe('#E58B88');
    expect(p.innerEar).toBeDefined();
  });

  it('white-balances a lamp-lit photo from the white fur', () => {
    // A real indoor shot: white belly reads as beige, the tabby base as muddy brown.
    const lamp = { primaryFur: hexToRgb('#5A422B'), bellyFur: hexToRgb('#BCA891'), stripes: hexToRgb('#221813') };
    const raw = paletteFromSamples(lamp, { whiteBalance: false });
    const fixed = interpretSamples(lamp);
    expect(raw.baseWhite).toBe('#BCA891');
    expect(fixed.whiteBalanced).toBe(true);
    const white = hexToRgb(fixed.palette.baseWhite as string);
    expect(rgbToHsl(white).l).toBeGreaterThan(rgbToHsl(hexToRgb('#BCA891')).l + 0.15);
    expect(Math.max(white.r, white.g, white.b) - Math.min(white.r, white.g, white.b)).toBeLessThan(12);
    // The corrected agouti lands far closer to the canonical tabby base than the raw sample.
    const target = hexToRgb('#7A6855');
    expect(deltaE(hexToRgb(fixed.palette.tabbyBase as string), target)).toBeLessThan(deltaE(hexToRgb('#5A422B'), target) * 0.6);
  });

  it('leaves daylight samples and non-white "bellies" alone', () => {
    expect(whiteBalanceFrom(hexToRgb('#F7F6F2'))).not.toBeNull();
    const c = hexToRgb('#8FA868');
    const same = applyWhiteBalance(c, whiteBalanceFrom(hexToRgb('#F7F6F2')));
    expect(deltaE(same, c)).toBeLessThan(0.5);
    expect(whiteBalanceFrom(hexToRgb('#7A6855'))).toBeNull(); // too dark to be white fur
    expect(whiteBalanceFrom(hexToRgb('#E8A050'))).toBeNull(); // ginger, not white
  });

  it('ignores eye samples where a dilated pupil hides the iris', () => {
    const r = interpretSamples({ leftEye: { r: 38, g: 40, b: 42 }, rightEye: hexToRgb('#8FA868') }, { whiteBalance: false });
    expect(r.skippedEyes).toEqual(['leftEye']);
    expect(r.palette.eyeLeft).toBe('#8FA868');
    expect(r.palette.eyeRight).toBe('#8FA868');
    const none = interpretSamples({ leftEye: { r: 30, g: 30, b: 30 } });
    expect(none.palette.eyeLeft).toBeUndefined();
    expect(none.applied).toBe(0);
  });
});

describe('K-Means auto palette', () => {
  const coat = bands(120, 80, [
    ['#F7F6F2', 5],
    ['#7A6855', 3],
    ['#2A241E', 2],
  ]);

  it('finds the dominant colours and their share of the image', () => {
    const pts = samplePixels(coat, 3000, 1, 0);
    const clusters = kMeans(pts, 3, 7);
    expect(clusters).toHaveLength(3);
    const white = clusters.find((c) => deltaE(c.color, hexToRgb('#F7F6F2')) < 3);
    const brown = clusters.find((c) => deltaE(c.color, hexToRgb('#7A6855')) < 3);
    const dark = clusters.find((c) => deltaE(c.color, hexToRgb('#2A241E')) < 3);
    expect(white).toBeDefined();
    expect(brown).toBeDefined();
    expect(dark).toBeDefined();
    expect(white?.share ?? 0).toBeCloseTo(0.5, 1);
    expect(brown?.share ?? 0).toBeCloseTo(0.3, 1);
    expect(dark?.share ?? 0).toBeCloseTo(0.2, 1);
  });

  it('is deterministic for a seed', () => {
    const pts = samplePixels(coat, 2000, 3, 0);
    expect(kMeans(pts, 3, 11).map((c) => c.hex)).toEqual(kMeans(pts, 3, 11).map((c) => c.hex));
  });

  it('assigns coat roles: white fur, agouti base, stripe charcoal, nose pink, eye green', () => {
    const img = bands(200, 60, [
      ['#F7F6F2', 8],
      ['#7A6855', 6],
      ['#2A241E', 3],
      ['#E58B88', 1],
      ['#8FA868', 1],
      ['#B87A3D', 1],
    ]);
    const clusters = kMeans(samplePixels(img, 6000, 2, 0), 6, 4);
    const { palette } = suggestPalette(clusters);
    const near = (hex: string | undefined, target: string) => !!hex && deltaE(hexToRgb(hex), hexToRgb(target)) < 6;
    expect(near(palette.baseWhite, '#F7F6F2')).toBe(true);
    expect(near(palette.tabbyBase, '#7A6855')).toBe(true);
    expect(near(palette.tabbyStripe, '#2A241E')).toBe(true);
    expect(near(palette.noseLeather, '#E58B88')).toBe(true);
    expect(near(palette.eyeLeft, '#8FA868')).toBe(true);
    expect(near(palette.rufus, '#B87A3D')).toBe(true);
  });

  it('reports the light/dark contrast distribution', () => {
    const clusters = kMeans(samplePixels(coat, 2000, 1, 0), 3, 1);
    expect(contrastSpread(clusters)).toBeGreaterThan(0.7);
    const flat = kMeans(samplePixels(bands(50, 50, [['#808080', 1]]), 500, 1, 0), 2, 1);
    expect(contrastSpread(flat)).toBeLessThan(0.05);
  });

  it('centre-weighting favours the middle of the photo (where the cat usually is)', () => {
    // Background (#3366CC) frames a brown cat in the centre.
    const w = 100;
    const h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const centre = x > 30 && x < 70 && y > 30 && y < 70;
        const c = hexToRgb(centre ? '#7A6855' : '#3366CC');
        const i = (y * w + x) * 4;
        data.set([c.r, c.g, c.b, 255], i);
      }
    const src = { data, width: w, height: h };
    const share = (pts: { r: number }[]) => pts.filter((p) => p.r === 0x7a).length / pts.length;
    expect(share(samplePixels(src, 3000, 5, 0.9))).toBeGreaterThan(share(samplePixels(src, 3000, 5, 0)) + 0.1);
  });
});
