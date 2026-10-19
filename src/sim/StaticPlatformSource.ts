/** A fixed set of ledges — used by the Cat Studio sandbox, the popup avatars and tests. */
import { makeFloor, type Platform, type PlatformSource, type WorldBounds } from '../engine/Physics';

export interface StaticLedge {
  id: string;
  xMin: number;
  xMax: number;
  y: number;
  warm?: number;
  narrow?: boolean;
  tag?: string;
}

export class StaticPlatformSource implements PlatformSource {
  private ledges: Platform[] = [];
  private floorP: Platform;

  constructor(
    private size: WorldBounds,
    ledges: StaticLedge[] = [],
    private floorInset = 2,
  ) {
    this.floorP = makeFloor(size, floorInset);
    this.setLedges(ledges);
  }

  setLedges(ledges: StaticLedge[]): void {
    this.ledges = ledges.map((l) => ({
      id: l.id,
      kind: 'dom' as const,
      xMin: l.xMin,
      xMax: l.xMax,
      y: l.y,
      warm: l.warm ?? 0.1,
      narrow: l.narrow ?? l.xMax - l.xMin < 300,
      tag: l.tag ?? 'div',
      elementRef: null,
    }));
  }

  resize(size: WorldBounds): void {
    this.size = size;
    this.floorP = makeFloor(size, this.floorInset);
  }

  platforms(): readonly Platform[] {
    return this.ledges;
  }

  get(id: string): Platform | null {
    if (id === 'floor') return this.floorP;
    return this.ledges.find((l) => l.id === id) ?? null;
  }

  floor(): Platform {
    return this.floorP;
  }

  bounds(): WorldBounds {
    return this.size;
  }
}
