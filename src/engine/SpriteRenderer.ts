/**
 * SpriteRenderer — "Mode B": draws a cat from an imported or baked sprite sheet.
 *
 * Compatible with:
 *  • ChroMeow HD sheets (one row per CatState, keys = state names, 192×208 cells)
 *  • OpenPets / Codex V1 sheets (8×9: idle, running-right, running-left, waving,
 *    jumping, failed, waiting, running, review)
 *  • OpenPets V2 sheets (8×11: V1 + sleeping, sitting)
 * Missing animations fall back through behaviour families so every one of the
 * simulation's states always has something sensible to show.
 */
import type { CatState } from '../shared/catStates';
import { convexHull, type Vec2 } from '../shared/math';
import type { SpriteAnimationDef, SpriteSheetData } from '../shared/types';
import { dataUrlToBitmap } from '../shared/zip';
import type { AnyCtx } from './canvas';
import type { Landmarks } from './ArticulatedCatRenderer';

export const OPENPETS_V1_ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'] as const;
export const OPENPETS_V2_ROWS = [...OPENPETS_V1_ROWS, 'sleeping', 'sitting'] as const;

const FAMILIES: Partial<Record<CatState, string[]>> = {
  CURLED_SLEEP: ['sleep', 'sleeping', 'waiting'],
  SPRAWLED_SLEEP: ['sleep', 'sleeping', 'waiting'],
  CHIN_PROP_SLEEP: ['sleep', 'sleeping', 'waiting'],
  MELTED_LOAF_SLEEP: ['sleep', 'sleeping', 'waiting'],
  TANDEM_BELLY_HOLD_SLEEP: ['sleep', 'sleeping', 'waiting'],
  PILLOW_STACK_CUDDLE: ['sleep', 'sleeping', 'waiting'],
  YIN_YANG_CUDDLE_SLEEP: ['sleep', 'sleeping', 'waiting'],
  WAKE_ARCH_STRETCH: ['stretch', 'waving', 'idle'],
  BIG_YAWN: ['yawn', 'waiting', 'idle'],
  IDLE_SIT: ['sit', 'sitting', 'idle'],
  IDLE_STAND: ['stand', 'idle'],
  CAT_LOAF: ['loaf', 'sitting', 'waiting', 'idle'],
  SPHINX_POSE: ['loaf', 'sitting', 'waiting', 'idle'],
  DANGLE_PAWS: ['loaf', 'sitting', 'review', 'idle'],
  LEDGE_CHIN_REST: ['loaf', 'waiting', 'idle'],
  WIDE_PAW_SPLAY: ['loaf', 'waiting', 'idle'],
  GROOM_LICK_PAW: ['groom', 'waving', 'idle'],
  GROOM_WASH_FACE: ['groom', 'waving', 'idle'],
  GROOM_BACK_LEG: ['groom', 'waving', 'idle'],
  SCRATCH_EAR_HIND_LEG: ['groom', 'waving', 'idle'],
  SAUNTER_WALK: ['walk', 'running', 'idle'],
  TROT: ['trot', 'running', 'idle'],
  ZOOMIES_SPRINT: ['run', 'running', 'idle'],
  PLAY_TAG_CHASE: ['run', 'running', 'idle'],
  JEALOUSY_INTERVENTION: ['walk', 'running', 'waving', 'idle'],
  STALK_CURSOR: ['stalk', 'walk', 'running', 'idle'],
  CROUCH_PREP_JUMP: ['crouch', 'waiting', 'idle'],
  JUMP_ASCEND: ['jump', 'jumping', 'idle'],
  FALL_DESCEND: ['fall', 'jump', 'jumping', 'idle'],
  STARTLED_AIRBORNE: ['fall', 'failed', 'jumping', 'idle'],
  LAND_RECOVERY: ['land', 'jumping', 'idle'],
  WALL_CLIMB: ['climb', 'running', 'idle'],
  EDGE_PEEK: ['peek', 'review', 'idle'],
  CURSOR_GAZE: ['look', 'review', 'idle'],
  KEYBOARD_WATCH: ['look', 'review', 'idle'],
  POUNCE_AND_PIN: ['pounce', 'jumping', 'idle'],
  PURRING: ['happy', 'waving', 'idle'],
  KNEADING_BISCUITS: ['knead', 'waving', 'idle'],
  BELLY_UP_ROLL: ['roll', 'waving', 'idle'],
  BUNNY_KICK_SWAT: ['roll', 'failed', 'idle'],
  TAIL_LASH: ['angry', 'failed', 'idle'],
  JUDGMENTAL_AIRPLANE_SQUINT: ['angry', 'failed', 'review', 'idle'],
  ELEVATOR_BUTT: ['happy', 'waving', 'idle'],
  PAW_TUCK: ['shy', 'waiting', 'idle'],
  EAT_TREAT: ['eat', 'review', 'idle'],
  NOSE_BOOP_GREETING: ['greet', 'waving', 'idle'],
  ALLOGROOMING: ['groom', 'waving', 'idle'],
  ALLOGROOM_RECEIVE: ['happy', 'waiting', 'idle'],
  PLAY_WRESTLE: ['play', 'jumping', 'idle'],
  SCRUFF_HELD: ['held', 'failed', 'waiting', 'idle'],
  SEEKING_FOOD: ['trot', 'running', 'idle'],
  SEEKING_WATER: ['trot', 'running', 'idle'],
  EATING: ['eat', 'review', 'idle'],
  DRINKING: ['drink', 'eat', 'review', 'idle'],
  EMPTY_BOWL_WAIT: ['beg', 'sit', 'waiting', 'idle'],
  CUDDLE_SLEEP: ['sleep', 'sleeping', 'waiting'],
};

interface ResolvedAnim {
  key: string;
  def: SpriteAnimationDef;
  /** Explicit direction baked into this row (OpenPets running-left / -right). */
  direction: 1 | -1 | 0;
}

export class SpriteRenderer {
  private bitmap: ImageBitmap | null = null;
  private loadedUrl = '';
  private frameCounts = new Map<string, number>();

  constructor(public sheet: SpriteSheetData) {
    void this.load();
  }

  get ready(): boolean {
    return !!this.bitmap;
  }

  setSheet(sheet: SpriteSheetData): void {
    this.sheet = sheet;
    if (sheet.dataUrl !== this.loadedUrl) void this.load();
  }

  private async load(): Promise<void> {
    const url = this.sheet.dataUrl;
    try {
      const bmp = await dataUrlToBitmap(url);
      if (url !== this.sheet.dataUrl) return;
      this.bitmap?.close();
      this.bitmap = bmp;
      this.loadedUrl = url;
      this.measureFrames();
    } catch {
      this.bitmap = null;
    }
  }

  /** Trims trailing fully transparent cells so short rows don't flash blank frames. */
  private measureFrames(): void {
    this.frameCounts.clear();
    const bmp = this.bitmap;
    if (!bmp || typeof OffscreenCanvas === 'undefined') return;
    const { cellWidth: cw, cellHeight: ch } = this.sheet;
    const probe = new OffscreenCanvas(cw, ch);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    if (!pctx) return;
    for (const [key, def] of Object.entries(this.sheet.animations)) {
      let count = def.frames;
      while (count > 1) {
        pctx.clearRect(0, 0, cw, ch);
        pctx.drawImage(bmp, (count - 1) * cw, def.row * ch, cw, ch, 0, 0, cw, ch);
        const data = pctx.getImageData(0, 0, cw, ch).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4 * 7) if (data[i] > 16) opaque++;
        if (opaque > 4) break;
        count--;
      }
      this.frameCounts.set(key, count);
    }
  }

  resolve(state: CatState, movingDir: 1 | -1 | 0): ResolvedAnim | null {
    const anims = this.sheet.animations;
    if (anims[state]) return { key: state, def: anims[state], direction: 0 };
    const fam = FAMILIES[state] ?? ['idle'];
    for (const key of fam) {
      if (key === 'running' && movingDir !== 0) {
        const dirKey = movingDir > 0 ? 'running-right' : 'running-left';
        if (anims[dirKey]) return { key: dirKey, def: anims[dirKey], direction: movingDir };
      }
      if (anims[key]) return { key, def: anims[key], direction: 0 };
    }
    const first = Object.keys(anims)[0];
    return first ? { key: first, def: anims[first], direction: 0 } : null;
  }

  /** Draws the current frame; returns approximate landmarks for hit-testing. */
  draw(ctx: AnyCtx, state: CatState, t: number, x: number, y: number, facing: 1 | -1, scale: number, movingDir: 1 | -1 | 0, alpha = 1): Landmarks | null {
    const bmp = this.bitmap;
    const anim = this.resolve(state, movingDir);
    const { cellWidth: cw, cellHeight: ch, anchorY } = this.sheet;
    const k = (scale * 92) / ch;
    const w = cw * k;
    const h = ch * k;
    if (bmp && anim) {
      const frames = Math.max(1, this.frameCounts.get(anim.key) ?? anim.def.frames);
      const idx = anim.def.loop ? Math.floor(t * anim.def.fps) % frames : Math.min(frames - 1, Math.floor(t * anim.def.fps));
      const sheetFacesLeft = this.sheet.facesLeft;
      const flip = anim.direction !== 0 ? false : (facing < 0) !== sheetFacesLeft;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.translate(x, y);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(bmp, idx * cw, anim.def.row * ch, cw, ch, -w / 2, -h * anchorY, w, h);
      ctx.restore();
    }
    return spriteLandmarks(x, y, w, h, anchorY, facing, scale);
  }
}

export function spriteLandmarks(x: number, y: number, w: number, h: number, anchorY: number, facing: 1 | -1, scale: number): Landmarks {
  const top = y - h * anchorY + h * 0.18;
  const left = x - w * 0.36;
  const right = x + w * 0.36;
  const bottom = y;
  const headX = x + facing * w * 0.2;
  const headY = top + h * 0.18;
  const r = h * 0.17;
  const torsoPoly: Vec2[] = [
    { x: x - facing * w * 0.3, y: top + h * 0.3 },
    { x: x + facing * w * 0.15, y: top + h * 0.3 },
    { x: x + facing * w * 0.15, y: bottom - h * 0.12 },
    { x: x - facing * w * 0.3, y: bottom - h * 0.12 },
  ];
  const spine = [torsoPoly[0], torsoPoly[1]].map((p) => ({ x: p.x, y: p.y + h * 0.1 }));
  const tail = [
    { x: x - facing * w * 0.3, y: top + h * 0.35 },
    { x: x - facing * w * 0.42, y: top + h * 0.15 },
  ];
  const hull = convexHull([
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ]);
  return {
    head: { x: headX, y: headY, r },
    headUp: { x: 0, y: -1 },
    paws: [
      { x: x + facing * w * 0.18, y: bottom - 4 },
      { x: x + facing * w * 0.1, y: bottom - 4 },
    ],
    torsoPoly,
    spine,
    spineNormals: spine.map(() => ({ x: 0, y: 1 })),
    tail,
    hull,
    bounds: { minX: left, minY: top, maxX: right, maxY: bottom },
    roll: 0,
    scale,
    backTop: { x, y: top + h * 0.3 },
    scruff: { x: headX - facing * r * 1.1, y: headY + r * 0.2 },
  };
}

/** Builds an animations map for a sheet of the given layout. */
export function animationsForLayout(source: SpriteSheetData['source'], columns: number, rowKeys: readonly string[], fps = 8): Record<string, SpriteAnimationDef> {
  const out: Record<string, SpriteAnimationDef> = {};
  rowKeys.forEach((key, row) => {
    if (!key) return;
    out[key] = { row, frames: columns, fps, loop: !/jump|pounce|land|stretch|yawn/i.test(key) || source === 'chromeow-hd' };
  });
  return out;
}
