/**
 * 6-zone anatomical petting map. Zones are resolved against the *rendered*
 * geometry of the current frame (head circle, paw positions, tail chain, torso
 * outline and spine normals), so they follow the cat through every pose — even
 * belly-up, where back and belly swap sides.
 */
import { distToSegment, pointInPolygon, type Vec2 } from '../shared/math';
import type { Landmarks } from '../engine/ArticulatedCatRenderer';

export const PET_ZONES = ['CHIN_CHEEKS', 'CROWN_EARS', 'BACK_BASE_OF_TAIL', 'FRONT_PAWS', 'BELLY', 'TAIL'] as const;
export type PetZone = (typeof PET_ZONES)[number];

export interface ZoneResponse {
  /** Affection change per second of petting. */
  affection: number;
  /** Irritation change per second (scaled by sassiness). */
  irritation: number;
}

export const ZONE_EFFECTS: Record<PetZone, ZoneResponse> = {
  CHIN_CHEEKS: { affection: 5.5, irritation: -2 },
  CROWN_EARS: { affection: 4, irritation: -1 },
  BACK_BASE_OF_TAIL: { affection: 5, irritation: -0.5 },
  FRONT_PAWS: { affection: 0.4, irritation: 1.2 },
  BELLY: { affection: 1.5, irritation: 3.5 },
  TAIL: { affection: -1, irritation: 14 },
};

export function classifyZone(px: number, py: number, lm: Landmarks): PetZone | null {
  const s = lm.scale;
  // Head (incl. ears above it).
  const hx = px - lm.head.x;
  const hy = py - lm.head.y;
  const hd = Math.hypot(hx, hy);
  const along = (hx * lm.headUp.x + hy * lm.headUp.y) / Math.max(1, lm.head.r);
  if (hd < lm.head.r * 1.12 || (along > 0.6 && along < 1.9 && hd < lm.head.r * 1.9)) {
    return along > 0.2 ? 'CROWN_EARS' : 'CHIN_CHEEKS';
  }
  // Front paws.
  for (const paw of lm.paws) {
    if (Math.hypot(px - paw.x, py - paw.y) < 7.5 * s) return 'FRONT_PAWS';
  }
  // Tail (skip the root node which is buried in the rump).
  const tail = lm.tail;
  for (let i = 1; i < tail.length - 1; i++) {
    if (distToSegment(px, py, tail[i].x, tail[i].y, tail[i + 1].x, tail[i + 1].y) < 6.5 * s) return 'TAIL';
  }
  // Torso: dorsal vs ventral by the signed distance along the spine normal.
  if (pointInPolygon(px, py, lm.torsoPoly)) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < lm.spine.length; i++) {
      const d = Math.hypot(px - lm.spine[i].x, py - lm.spine[i].y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const sp = lm.spine[best];
    const n = lm.spineNormals[best];
    const side = (px - sp.x) * n.x + (py - sp.y) * n.y;
    const ventral = lm.roll > 0.5 ? side < 0 : side >= 0;
    return ventral ? 'BELLY' : 'BACK_BASE_OF_TAIL';
  }
  return null;
}

/** Hull test used to decide whether the pointer is "on" a cat at all. */
export function onCat(px: number, py: number, lm: Landmarks): boolean {
  return pointInPolygon(px, py, lm.hull as Vec2[]);
}
