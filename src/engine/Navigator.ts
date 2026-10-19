/**
 * Navigator — plans multi-hop routes across DOM ledges (Dijkstra over a jump
 * graph built on the fly). Each hop is a walk to a takeoff point followed by a
 * planned parabolic jump; cats never "teleport" between ledges.
 */
import { clamp } from '../shared/math';
import { MAX_GAP, MAX_JUMP_DX, MAX_JUMP_UP, platformWidth, type Platform, type WorldBounds } from './Physics';

export interface NavJump {
  from: string;
  to: string;
  takeoffX: number;
  landX: number;
  /** True when the arc passes through the ledge it starts from / lands on (rare fallback). */
  through: boolean;
}

export interface NavPlan {
  hops: NavJump[];
  finalX: number;
  targetPlatform: string;
}

const EDGE_MARGIN = 22;
const JUMP_COST = 140;

function overlap(a: Platform, b: Platform): number {
  return Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin);
}

/** Computes the best takeoff/landing pair for hopping from P to Q, or null if impossible. */
export function planHop(p: Platform, q: Platform, fromX: number, bounds: WorldBounds, margin = EDGE_MARGIN): NavJump | null {
  const rise = p.y - q.y;
  if (rise > MAX_JUMP_UP) return null;
  const pLo = p.xMin + margin;
  const pHi = p.xMax - margin;
  const qLo = q.xMin + margin;
  const qHi = q.xMax - margin;
  if (pHi < pLo || qHi < qLo) return null;
  const ov = overlap(p, q);

  if (rise >= 0) {
    // Upward (or level) jump.
    if (ov <= 0) {
      const gap = q.xMin > p.xMax ? q.xMin - p.xMax : p.xMin - q.xMax;
      if (gap > MAX_GAP) return null;
      const right = q.xMin > p.xMax;
      const takeoffX = right ? pHi : pLo;
      const landX = right ? qLo : qHi;
      if (Math.abs(landX - takeoffX) > MAX_JUMP_DX) return null;
      return { from: p.id, to: q.id, takeoffX, landX, through: false };
    }
    // Overlapping: prefer leaping onto Q from beside it, otherwise straight up through.
    if (p.xMin < q.xMin - 40) return { from: p.id, to: q.id, takeoffX: clamp(q.xMin - 34, pLo, pHi), landX: qLo, through: false };
    if (p.xMax > q.xMax + 40) return { from: p.id, to: q.id, takeoffX: clamp(q.xMax + 34, pLo, pHi), landX: qHi, through: false };
    const x = clamp(fromX, Math.max(pLo, qLo), Math.min(pHi, qHi));
    return { from: p.id, to: q.id, takeoffX: x, landX: clamp(x + 10, qLo, qHi), through: true };
  }

  // Downward: step off the nearest edge of P that has open air over Q.
  const options: NavJump[] = [];
  const width = bounds.width;
  if (q.xMin < p.xMin - 12) {
    const landX = clamp(p.xMin - 30, qLo, qHi);
    if (landX < p.xMin && landX >= 4) options.push({ from: p.id, to: q.id, takeoffX: pLo, landX, through: false });
  }
  if (q.xMax > p.xMax + 12) {
    const landX = clamp(p.xMax + 30, qLo, qHi);
    if (landX > p.xMax && landX <= width - 4) options.push({ from: p.id, to: q.id, takeoffX: pHi, landX, through: false });
  }
  if (ov <= 0) {
    const gap = q.xMin > p.xMax ? q.xMin - p.xMax : p.xMin - q.xMax;
    if (gap <= MAX_GAP * 1.6) {
      const right = q.xMin > p.xMax;
      options.push({ from: p.id, to: q.id, takeoffX: right ? pHi : pLo, landX: right ? qLo : qHi, through: false });
    }
  }
  if (options.length === 0) {
    if (q.kind !== 'floor' && ov <= 0) return null;
    // Fallback: hop down through the ledge (cat passes in front of it).
    const x = clamp(fromX, Math.max(pLo, qLo), Math.min(pHi, qHi));
    return { from: p.id, to: q.id, takeoffX: x, landX: clamp(x + 16, qLo, qHi), through: true };
  }
  options.sort((a, b) => Math.abs(a.takeoffX - fromX) - Math.abs(b.takeoffX - fromX));
  return options[0];
}

/**
 * Dijkstra across ledges from (startId, startX) to (targetId, targetX).
 * Cost = walking distance + a fixed penalty per jump (+ extra for drop-through hops).
 */
export function planRoute(platforms: readonly Platform[], startId: string, startX: number, targetId: string, targetX: number, bounds: WorldBounds, maxHops = 6): NavPlan | null {
  const byId = new Map(platforms.map((p) => [p.id, p] as const));
  const start = byId.get(startId);
  const target = byId.get(targetId);
  if (!start || !target) return null;
  const clampOn = (p: Platform, x: number) => clamp(x, p.xMin + EDGE_MARGIN, Math.max(p.xMin + EDGE_MARGIN, p.xMax - EDGE_MARGIN));
  if (startId === targetId) return { hops: [], finalX: clampOn(target, targetX), targetPlatform: targetId };

  interface Node {
    id: string;
    x: number;
    cost: number;
    hops: NavJump[];
  }
  const best = new Map<string, number>([[startId, 0]]);
  const open: Node[] = [{ id: startId, x: startX, cost: 0, hops: [] }];
  while (open.length) {
    open.sort((a, b) => a.cost - b.cost);
    const cur = open.shift() as Node;
    if (cur.id === targetId) {
      return { hops: cur.hops, finalX: clampOn(target, targetX), targetPlatform: targetId };
    }
    if (cur.hops.length >= maxHops) continue;
    const p = byId.get(cur.id);
    if (!p) continue;
    for (const q of platforms) {
      if (q.id === p.id) continue;
      const hop = planHop(p, q, cur.x, bounds);
      if (!hop) continue;
      const walk = Math.abs(hop.takeoffX - cur.x);
      const finish = q.id === targetId ? Math.abs(clampOn(q, targetX) - hop.landX) : 0;
      const cost = cur.cost + walk + JUMP_COST + (hop.through ? 260 : 0) + finish * 0.5 + (platformWidth(q) < 120 ? 40 : 0);
      if (cost < (best.get(q.id) ?? Infinity)) {
        best.set(q.id, cost);
        open.push({ id: q.id, x: hop.landX, cost, hops: [...cur.hops, hop] });
      }
    }
  }
  return null;
}
