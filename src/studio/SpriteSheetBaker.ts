/**
 * SpriteSheetBaker — renders the procedural cat across every animation into a
 * sprite sheet (+ pet.json, zipped) and imports existing sheets.
 *
 * Layouts (all 8 columns, 192×208 px cells):
 *  • ChroMeow HD — one row per CatState (every behaviour the simulation has).
 *  • OpenPets / Codex V1 — 8×9: idle, running-right, running-left, waving,
 *    jumping, failed, waiting, running, review.
 * Import also accepts OpenPets V2 (8×11) and legacy 9×8 sheets.
 */
import { ALL_STATES, LEGACY_HD_STATE_COUNT, type CatState } from '../shared/catStates';
import type { CatProfile, SpriteSheetData, SpriteSheetSource } from '../shared/types';
import { bytesToDataUrl, createZip, readZip } from '../shared/zip';
import { ArticulatedCatRenderer } from '../engine/ArticulatedCatRenderer';
import { DEFAULT_POSE_CONTEXT, GAITS, computePose } from '../engine/PoseLibrary';
import { STATE_META } from '../ai/States';
import { VerletTail } from '../engine/VerletTail';
import { OPENPETS_V1_ROWS, OPENPETS_V2_ROWS, animationsForLayout } from '../engine/SpriteRenderer';
import { canvasToBlob } from '../engine/canvas';

export const CELL_W = 192;
export const CELL_H = 208;
export const COLUMNS = 8;
export const ANCHOR_Y = 0.9;

export type BakeLayout = 'chromeow-hd' | 'openpets-v1';

interface RowSpec {
  key: string;
  state: CatState;
  facing: 1 | -1;
  /** Optional per-frame state sequence (e.g. a whole jump). */
  sequence?: CatState[];
}

const OPENPETS_ROWS: RowSpec[] = [
  { key: 'idle', state: 'IDLE_SIT', facing: 1 },
  { key: 'running-right', state: 'TROT', facing: 1 },
  { key: 'running-left', state: 'TROT', facing: -1 },
  { key: 'waving', state: 'GROOM_WASH_FACE', facing: 1 },
  { key: 'jumping', state: 'JUMP_ASCEND', facing: 1, sequence: ['CROUCH_PREP_JUMP', 'CROUCH_PREP_JUMP', 'JUMP_ASCEND', 'JUMP_ASCEND', 'FALL_DESCEND', 'FALL_DESCEND', 'LAND_RECOVERY', 'IDLE_STAND'] },
  { key: 'failed', state: 'TAIL_LASH', facing: 1 },
  { key: 'waiting', state: 'CAT_LOAF', facing: 1 },
  { key: 'running', state: 'ZOOMIES_SPRINT', facing: 1 },
  { key: 'review', state: 'CURSOR_GAZE', facing: 1 },
];

function rowsFor(layout: BakeLayout): RowSpec[] {
  if (layout === 'openpets-v1') return OPENPETS_ROWS;
  return ALL_STATES.map((s) => ({ key: s, state: s, facing: 1 as const }));
}

function frameTiming(state: CatState, f: number): { t: number; progress: number; phase: number } {
  const g = GAITS[state];
  if (g) {
    const period = g.stride / (g.speed * g.stance);
    return { t: (f / COLUMNS) * period, progress: f / COLUMNS, phase: f / COLUMNS };
  }
  const meta = STATE_META[state];
  if (meta.duration) {
    const d = (meta.duration[0] + meta.duration[1]) / 2;
    const p = f / (COLUMNS - 1);
    return { t: p * d, progress: p, phase: p };
  }
  return { t: (f / COLUMNS) * 2.4, progress: f / COLUMNS, phase: f / COLUMNS };
}

export interface BakeResult {
  canvas: HTMLCanvasElement;
  sheet: Omit<SpriteSheetData, 'dataUrl'>;
  petJson: Record<string, unknown>;
}

/** Renders the sheet. Yields to the event loop between rows so the UI stays responsive. */
export async function bakeSheet(profile: CatProfile, layout: BakeLayout, onProgress?: (f: number) => void): Promise<BakeResult> {
  const rows = rowsFor(layout);
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLUMNS;
  canvas.height = CELL_H * rows.length;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const renderer = new ArticulatedCatRenderer(profile);
  await renderer.ready;
  const scale = 1.22 * profile.morphology.size;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const tail = new VerletTail(6, 10.5 * scale * profile.morphology.tailLength, 0, 0, Math.PI);
    const ox = CELL_W / 2 + row.facing * -4;
    // Warm the tail up so it settles before the first frame.
    for (let w = -40; w < COLUMNS; w++) {
      const f = Math.max(0, w);
      const state = row.sequence ? row.sequence[f] : row.state;
      const tm = frameTiming(state, row.sequence ? 3 : f);
      const pose = computePose(state, { ...DEFAULT_POSE_CONTEXT, t: tm.t, progress: tm.progress, gaitPhase: tm.phase, vx: 60, vy: state === 'JUMP_ASCEND' ? -300 : state === 'FALL_DESCEND' ? 300 : 0, sitting: true, edgeAhead: Infinity });
      const lift = row.sequence && f >= 2 && f <= 5 ? Math.sin((Math.PI * (f - 1.5)) / 4.5) * 34 : 0;
      const cx = (w >= 0 ? f * CELL_W : 0) + ox;
      const cy = r * CELL_H + CELL_H * ANCHOR_Y - lift;
      const tr = { x: cx, y: cy, flip: row.facing, scale };
      const skel = renderer.skeleton(pose, tr, tm.t + 1);
      const a = renderer.tailAnchorWorld(skel, pose);
      if (w === 0) tail.translate(f * CELL_W, 0);
      const ground = r * CELL_H + CELL_H * ANCHOR_Y;
      for (let s = 0; s < 3; s++) {
        tail.step(1 / 60, a.x, a.y, { baseAngle: a.angle, curl: pose.tailCurl, waveAmp: pose.tailWave, waveFreq: pose.tailFreq, whip: pose.tailWhip, stiffness: pose.tailStiff, gravity: pose.tailGravity, damping: 0.94, maxBend: 1.15, handedness: row.facing }, () => ground, 2.6 * scale);
      }
      if (w < 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(f * CELL_W, r * CELL_H, CELL_W, CELL_H);
      ctx.clip();
      renderer.draw(ctx, skel, pose, tail, scale, { time: tm.t + 1, grounded: lift === 0 && !STATE_META[state].posture.startsWith('air'), groundY: ground });
      ctx.restore();
      // Next frame's tail starts from this cell's offset.
      if (f < COLUMNS - 1) tail.translate(CELL_W, 0);
    }
    onProgress?.((r + 1) / rows.length);
    await new Promise((res) => setTimeout(res, 0));
  }
  const source: SpriteSheetSource = layout === 'openpets-v1' ? 'openpets-v1' : 'chromeow-hd';
  const animations = animationsForLayout(source, COLUMNS, rows.map((r) => r.key), layout === 'openpets-v1' ? 8 : 9);
  const sheet: Omit<SpriteSheetData, 'dataUrl'> = { columns: COLUMNS, rows: rows.length, cellWidth: CELL_W, cellHeight: CELL_H, animations, source, anchorY: ANCHOR_Y, facesLeft: false };
  const slug = (profile.name || 'cat').toLowerCase().replace(/[^a-z0-9֐-׿]+/g, '-').replace(/^-|-$/g, '') || 'cat';
  const { photos: _photos, sprite: _sprite, paintMask: _paint, ...portable } = profile;
  void _photos;
  void _sprite;
  void _paint;
  const petJson = {
    id: slug,
    displayName: profile.name,
    description: (profile.bio || 'A ChroMeow cat').split(/[.!?]/)[0].slice(0, 120),
    spritesheetPath: 'spritesheet.webp',
    chromeow: { version: 1, layout, ...sheet, profile: portable },
  };
  return { canvas, sheet, petJson };
}

export async function bakeZip(profile: CatProfile, layout: BakeLayout, onProgress?: (f: number) => void): Promise<{ zip: Blob; webp: Blob; sheet: SpriteSheetData; fileBase: string }> {
  const res = await bakeSheet(profile, layout, onProgress);
  const webp = await canvasToBlob(res.canvas, 'image/webp', 0.92);
  const webpBytes = new Uint8Array(await webp.arrayBuffer());
  const json = new TextEncoder().encode(JSON.stringify(res.petJson, null, 2));
  const zipBytes = createZip([
    { name: 'pet.json', data: json },
    { name: 'spritesheet.webp', data: webpBytes },
  ]);
  const fileBase = `${String(res.petJson.id)}-${layout}`;
  return {
    zip: new Blob([zipBytes as BlobPart], { type: 'application/zip' }),
    webp,
    sheet: { ...res.sheet, dataUrl: bytesToDataUrl(webpBytes, 'image/webp') },
    fileBase,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------- importing */

export type ImportLayout = 'auto' | 'openpets-v1' | 'openpets-v2' | 'chromeow-hd' | 'legacy-9x8';

const LEGACY_ROWS = ['idle', 'waving', 'running', 'failed', 'review', 'jumping', 'extra1', 'extra2'];

export interface ImportResult {
  sheet: SpriteSheetData;
  displayName?: string;
}

function mimeFor(name: string): string {
  return /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/webp';
}

export async function importSpriteFile(file: File, hint: ImportLayout = 'auto'): Promise<ImportResult> {
  let imageBytes: Uint8Array;
  let imageName = file.name;
  let pet: Record<string, unknown> | null = null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    const entries = await readZip(bytes);
    const petEntry = entries.find((e) => /(^|\/)pet\.json$/i.test(e.name));
    if (petEntry) pet = JSON.parse(new TextDecoder().decode(petEntry.data)) as Record<string, unknown>;
    const wanted = typeof pet?.spritesheetPath === 'string' ? (pet.spritesheetPath as string) : '';
    const img = entries.find((e) => wanted && e.name.endsWith(wanted)) ?? entries.find((e) => /\.(webp|png)$/i.test(e.name));
    if (!img) throw new Error('No sprite sheet image found in the archive');
    imageBytes = img.data;
    imageName = img.name;
  } else {
    imageBytes = bytes;
  }
  const mime = mimeFor(imageName);
  const bmp = await createImageBitmap(new Blob([imageBytes as BlobPart], { type: mime }));
  const W = bmp.width;
  const H = bmp.height;
  bmp.close();
  const dataUrl = bytesToDataUrl(imageBytes, mime);
  const cm = pet?.chromeow as (Partial<SpriteSheetData> & { layout?: string }) | undefined;
  if (cm && cm.animations && cm.columns && cm.rows) {
    return {
      sheet: { dataUrl, columns: cm.columns, rows: cm.rows, cellWidth: cm.cellWidth ?? W / cm.columns, cellHeight: cm.cellHeight ?? H / cm.rows, animations: cm.animations, source: (cm.source as SpriteSheetSource) ?? 'chromeow-hd', anchorY: cm.anchorY ?? ANCHOR_Y, facesLeft: !!cm.facesLeft },
      displayName: typeof pet?.displayName === 'string' ? (pet.displayName as string) : undefined,
    };
  }
  let layout = hint;
  /** Rows an HD sheet of this size would have (one per state; v1 sheets have 49). */
  const hdRows = H / (W / 8 / (CELL_W / CELL_H));
  if (layout === 'auto') {
    const ratio = H / W;
    const near = (v: number) => Math.abs(ratio - v) < 0.04;
    if (near(1664 / 1728)) layout = 'legacy-9x8';
    else if (near((9 * CELL_H) / (8 * CELL_W))) layout = 'openpets-v1';
    else if (near((11 * CELL_H) / (8 * CELL_W))) layout = 'openpets-v2';
    else if (Math.abs(hdRows - ALL_STATES.length) < 0.6 || Math.abs(hdRows - LEGACY_HD_STATE_COUNT) < 0.6) layout = 'chromeow-hd';
    else layout = 'openpets-v1';
  }
  let columns = 8;
  let keys: readonly string[];
  let source: SpriteSheetSource = 'custom';
  if (layout === 'legacy-9x8') {
    columns = 9;
    keys = LEGACY_ROWS;
  } else if (layout === 'openpets-v2') {
    keys = OPENPETS_V2_ROWS;
    source = 'openpets-v2';
  } else if (layout === 'chromeow-hd') {
    // Sheets baked before v2 have the first 49 states only (new states were appended).
    keys = Math.abs(hdRows - LEGACY_HD_STATE_COUNT) < 0.6 ? ALL_STATES.slice(0, LEGACY_HD_STATE_COUNT) : ALL_STATES;
    source = 'chromeow-hd';
  } else {
    keys = OPENPETS_V1_ROWS;
    source = 'openpets-v1';
  }
  const rows = keys.length;
  return {
    sheet: { dataUrl, columns, rows, cellWidth: W / columns, cellHeight: H / rows, animations: animationsForLayout(source, columns, keys, 8), source, anchorY: 0.93, facesLeft: false },
    displayName: typeof pet?.displayName === 'string' ? (pet.displayName as string) : undefined,
  };
}
