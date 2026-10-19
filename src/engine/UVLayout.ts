/**
 * The 512×512 UV atlas every procedural cat is painted onto. The same layout is
 * used by the coat generator, the renderer (which texture-maps body parts as
 * deformable ribbons) and the Cat Studio paint brush, so a smudge painted on the
 * template appears exactly there on the animated cat.
 *
 *  ┌──────────────────────────── TORSO (u: rump→neck, v: spine→belly) ─┐ 0
 *  │                                                                   │
 *  ├──────────┬──────┬──────┬──────┬──────┬────────────────────────────┤ 192
 *  │   HEAD   │ LEG  │ LEG  │ LEG  │ LEG  │                            │
 *  │ (frontal)│ FN   │ FF   │ HN   │ HF   │                            │
 *  ├──────────┤(top→ │      │      │      │                            │ 384
 *  │   EARS   │ paw) │      │      │      │                            │
 *  ├──────────┴──────┴──────┴──────┴──────┴────────────────────────────┤ 448
 *  │                    TAIL (u: base → tip)                           │
 *  └───────────────────────────────────────────────────────────────────┘ 512
 */
export const ATLAS_SIZE = 512;

export interface UVRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LegId = 'frontNear' | 'frontFar' | 'hindNear' | 'hindFar';

export const UV = {
  torso: { x: 0, y: 0, w: 512, h: 192 } as UVRect,
  head: { x: 0, y: 192, w: 192, h: 192 } as UVRect,
  ears: { x: 0, y: 384, w: 192, h: 64 } as UVRect,
  legs: {
    frontNear: { x: 192, y: 192, w: 64, h: 256 } as UVRect,
    frontFar: { x: 256, y: 192, w: 64, h: 256 } as UVRect,
    hindNear: { x: 320, y: 192, w: 64, h: 256 } as UVRect,
    hindFar: { x: 384, y: 192, w: 64, h: 256 } as UVRect,
  } as Record<LegId, UVRect>,
  tail: { x: 0, y: 448, w: 512, h: 64 } as UVRect,
} as const;

/** Head template landmarks, in HEAD-region-local pixels (0..192). */
export const HEAD_TEMPLATE = {
  cx: 96,
  cy: 100,
  /** Template units that correspond to one head radius on screen. */
  radius: 70,
  eyeDX: 33,
  eyeY: 92,
  noseY: 124,
  muzzleY: 138,
  chinY: 162,
} as const;

export interface UVRegionLabel {
  rect: UVRect;
  label: string;
  labelHe: string;
}

export const UV_LABELS: readonly UVRegionLabel[] = [
  { rect: UV.torso, label: 'Body (rump ← → chest · spine at top, belly at bottom)', labelHe: 'גוף (עכוז ← → חזה · עמוד שדרה למעלה, בטן למטה)' },
  { rect: UV.head, label: 'Face', labelHe: 'פנים' },
  { rect: UV.legs.frontNear, label: 'Front leg (near)', labelHe: 'רגל קדמית (קרובה)' },
  { rect: UV.legs.frontFar, label: 'Front leg (far)', labelHe: 'רגל קדמית (רחוקה)' },
  { rect: UV.legs.hindNear, label: 'Hind leg (near)', labelHe: 'רגל אחורית (קרובה)' },
  { rect: UV.legs.hindFar, label: 'Hind leg (far)', labelHe: 'רגל אחורית (רחוקה)' },
  { rect: UV.tail, label: 'Tail (base → tip)', labelHe: 'זנב (בסיס ← קצה)' },
];
