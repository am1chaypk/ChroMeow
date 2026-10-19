/**
 * Cat export / import. A `.chromeow.json` file carries one or more complete
 * cats (coat, markings, body, personality, painted mask, reference photos and
 * baked sprite sheet), so a custom cat can be backed up or moved to another
 * browser. Files are plain JSON and never leave the machine unless the user
 * moves them.
 *
 * Everything read from a file is treated as untrusted: each field is rebuilt
 * from the known schema with type checks and clamps, unknown keys are dropped,
 * and embedded images must be base64 image data URLs.
 */
import { isValidHex } from './color';
import { clamp, clamp01 } from './math';
import { DEFAULT_TRAITS, MAX_CATS, normalizeProfile } from './presets';
import { uid } from './rng';
import { COAT_PATTERNS, type CatProfile, type CatTraits, type CoatPattern, type SpriteAnimationDef, type SpriteSheetData } from './types';

export const CAT_FILE_FORMAT = 'chromeow-cats';
export const CAT_FILE_VERSION = 1;
/** Generous cap: three photos, a paint mask and an HD sprite sheet fit comfortably. */
export const MAX_CAT_FILE_BYTES = 40 * 1024 * 1024;

export interface CatFile {
  format: typeof CAT_FILE_FORMAT;
  version: number;
  exportedAt: string;
  cats: CatProfile[];
}

export function serializeCats(cats: CatProfile[], now = new Date()): string {
  const file: CatFile = {
    format: CAT_FILE_FORMAT,
    version: CAT_FILE_VERSION,
    exportedAt: now.toISOString(),
    cats: cats.map((c) => ({ ...c })),
  };
  return JSON.stringify(file, null, 2);
}

/** File name for an export: the cat's name (Hebrew kept), or a generic name for several. */
export function exportFileName(cats: CatProfile[]): string {
  if (cats.length !== 1) return 'chromeow-cats.chromeow.json';
  const slug = cats[0].name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return `${slug || 'cat'}.chromeow.json`;
}

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function imageUrl(v: unknown): string | null {
  return typeof v === 'string' && v.length < MAX_CAT_FILE_BYTES && IMAGE_DATA_URL.test(v) ? v : null;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function num(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Copies only keys the template knows, coerced to the template's types. */
function pick<T extends object>(template: T, raw: unknown, numRange: (key: string, base: number) => [number, number]): Partial<T> {
  const src = obj(raw);
  const out: Record<string, unknown> = {};
  for (const [key, base] of Object.entries(template)) {
    const v = src[key];
    if (typeof base === 'number') {
      const [lo, hi] = numRange(key, base);
      const n = num(v, lo, hi);
      if (n !== undefined) out[key] = n;
    } else if (typeof base === 'boolean') {
      const b = bool(v);
      if (b !== undefined) out[key] = b;
    } else if (typeof base === 'string') {
      if (typeof v === 'string' && (!/^#/.test(base) || (/^#/.test(v) && isValidHex(v)))) out[key] = v.slice(0, 32);
    }
  }
  return out as Partial<T>;
}

function sprite(raw: unknown): SpriteSheetData | null {
  const s = obj(raw);
  const dataUrl = imageUrl(s.dataUrl);
  if (!dataUrl) return null;
  const columns = num(s.columns, 1, 64);
  const rows = num(s.rows, 1, 128);
  const cellWidth = num(s.cellWidth, 4, 1024);
  const cellHeight = num(s.cellHeight, 4, 1024);
  if (!columns || !rows || !cellWidth || !cellHeight) return null;
  const animations: Record<string, SpriteAnimationDef> = {};
  for (const [key, a] of Object.entries(obj(s.animations)).slice(0, 128)) {
    const o = obj(a);
    const row = num(o.row, 0, rows - 1);
    const frames = num(o.frames, 1, columns);
    const fps = num(o.fps, 0.5, 60);
    if (row === undefined || !frames || !fps || !/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue;
    animations[key] = { row: Math.round(row), frames: Math.round(frames), fps, loop: o.loop !== false };
  }
  const source = s.source === 'chromeow-hd' || s.source === 'openpets-v1' || s.source === 'openpets-v2' ? s.source : 'custom';
  return {
    dataUrl,
    columns: Math.round(columns),
    rows: Math.round(rows),
    cellWidth,
    cellHeight,
    animations,
    source,
    anchorY: num(s.anchorY, 0, 1) ?? 0.95,
    facesLeft: s.facesLeft === true,
  };
}

const TRAIT_RANGES: Record<string, [number, number]> = { hungerRateMultiplier: [0.5, 2], thirstRateMultiplier: [0.5, 2], pettingAffinity: [0.5, 2] };

function traits(raw: unknown): Partial<CatTraits> {
  const out = pick(DEFAULT_TRAITS, raw, (key) => TRAIT_RANGES[key] ?? [0, 1]) as Partial<CatTraits>;
  const bond = obj(raw).bondedWith;
  out.bondedWith = typeof bond === 'string' && /^[\w-]{1,48}$/.test(bond) ? bond : '';
  return out;
}

/** Rebuilds one cat from untrusted data on top of a factory template for `slot`. */
export function sanitizeCat(raw: unknown, slot: number): CatProfile {
  const r = obj(raw);
  const base = normalizeProfile({}, slot);
  const pattern = COAT_PATTERNS.includes(r.pattern as CoatPattern) ? (r.pattern as CoatPattern) : base.pattern;
  const markings = pick(base.markings, r.markings, (key) => (key === 'tailRings' ? [0, 8] : [0, 1]));
  const morph = obj(r.morphology);
  const morphology = pick(base.morphology, morph, (key) => (key === 'tailLength' ? [0.6, 1.4] : [0.7, 1.4]));
  delete morphology.furLength;
  if (morph.furLength === 'short' || morph.furLength === 'medium' || morph.furLength === 'long') morphology.furLength = morph.furLength;
  return normalizeProfile(
    {
      id: uid('cat'),
      slot,
      enabled: bool(r.enabled) ?? true,
      name: (str(r.name, 28) ?? '').trim() || base.name,
      bio: str(r.bio, 500) ?? '',
      pattern,
      palette: { ...base.palette, ...pick(base.palette, r.palette, () => [0, 0]) },
      markings: { ...base.markings, ...markings },
      morphology: { ...base.morphology, ...morphology },
      personality: { ...base.personality, ...pick(base.personality, r.personality, () => [0, 1]) },
      signature: { ...base.signature, ...pick(base.signature, r.signature, () => [0, 1]) },
      traits: { ...DEFAULT_TRAITS, ...traits(r.traits) },
      paintMask: imageUrl(r.paintMask),
      renderMode: r.renderMode === 'sprite' ? 'sprite' : 'procedural',
      sprite: sprite(r.sprite),
      photos: (Array.isArray(r.photos) ? r.photos : []).map(imageUrl).filter((u): u is string => !!u).slice(0, 3),
      presetKey: str(r.presetKey, 40) ?? base.presetKey,
    },
    slot,
  );
}

export class CatFileError extends Error {}

/** Parses a cat file (or a single bare cat object) into sanitized cats. */
export function parseCatFile(text: string, firstSlot = 1): CatProfile[] {
  if (text.length > MAX_CAT_FILE_BYTES) throw new CatFileError('too-large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CatFileError('not-json');
  }
  const d = obj(data);
  let list: unknown[];
  if (d.format === CAT_FILE_FORMAT && Array.isArray(d.cats)) list = d.cats;
  else if (typeof d.pattern === 'string' && d.palette) list = [d];
  else throw new CatFileError('not-a-cat-file');
  if (list.length === 0) throw new CatFileError('empty');
  return list.slice(0, MAX_CATS).map((c, i) => sanitizeCat(c, firstSlot + i));
}

/**
 * Adds imported cats into free slots (up to MAX_CATS). Returns the merged list,
 * the cats that were added and how many did not fit.
 */
export function mergeImported(existing: CatProfile[], imported: CatProfile[]): { profiles: CatProfile[]; added: CatProfile[]; skipped: number } {
  const used = new Set(existing.map((p) => p.slot));
  const ids = new Set(existing.map((p) => p.id));
  const out = [...existing];
  const added: CatProfile[] = [];
  for (const cat of imported) {
    if (out.length >= MAX_CATS) break;
    let slot = 1;
    while (used.has(slot)) slot++;
    used.add(slot);
    let id = cat.id;
    while (ids.has(id)) id = uid('cat');
    ids.add(id);
    const placed = { ...cat, id, slot, personality: { ...cat.personality }, palette: { ...cat.palette } };
    // Keep the personality numbers inside 0..1 even if a template ever changes.
    for (const k of Object.keys(placed.personality) as (keyof typeof placed.personality)[]) placed.personality[k] = clamp01(placed.personality[k]);
    out.push(placed);
    added.push(placed);
  }
  out.sort((a, b) => a.slot - b.slot);
  return { profiles: out, added, skipped: imported.length - added.length };
}
