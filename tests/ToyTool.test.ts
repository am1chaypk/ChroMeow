import { describe, expect, it } from 'vitest';
import { releaseVelocity } from '../src/sim/ToyTool';
import { ToyManager } from '../src/content/ToyManager';

describe('hand-held toys', () => {
  it('measures the throw from the last ~90 ms of the drag', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 5, y: 0, t: 0.2 }, // slow wind-up
      { x: 10, y: -2, t: 0.3 },
      { x: 40, y: -12, t: 0.35 },
      { x: 70, y: -22, t: 0.4 }, // fast flick at the end
    ];
    const { vx, vy } = releaseVelocity(samples);
    expect(vx).toBeGreaterThan(500);
    expect(vy).toBeLessThan(-150);
  });

  it('returns no velocity for a still click', () => {
    expect(releaseVelocity([{ x: 3, y: 3, t: 1 }])).toEqual({ vx: 0, vy: 0 });
  });

  it('drops treats exactly where you click, capped so spam replaces the oldest', () => {
    const toys = new ToyManager();
    for (let i = 0; i < 15; i++) toys.spawnTreatAt(100 + i, 50);
    const treats = toys.toys.filter((t) => t.kind === 'treat');
    expect(treats).toHaveLength(12);
    expect(treats[treats.length - 1].x).toBe(114);
  });

  it('holds the ball under the cursor, then throws it (speed-capped)', () => {
    const toys = new ToyManager();
    toys.holdBall(200, 100);
    toys.holdBall(220, 90);
    const held = toys.toys.find((t) => t.kind === 'ball');
    expect(held?.held).toBe(true);
    expect(held?.x).toBe(220);
    // Cats never chase a ball that is still in your hand.
    expect(toys.nearest(220, 90, ['ball'])).toBeNull();
    const thrown = toys.throwBall(9000, 0);
    expect(thrown?.held).toBe(false);
    expect(Math.hypot(thrown?.vx ?? 0, thrown?.vy ?? 0)).toBeLessThanOrEqual(1700.0001);
    expect(toys.nearest(220, 90, ['ball'])).not.toBeNull();
  });

  it('the laser follows the hand while held and fades once released', () => {
    const toys = new ToyManager();
    const bounds = { width: 800, height: 600 };
    toys.controlLaser(300, 200, true);
    for (let i = 0; i < 30; i++) toys.update(1 / 60, [], bounds);
    const dot = toys.toys.find((t) => t.kind === 'laser');
    expect(dot?.controlled).toBe(true);
    expect(Math.abs((dot?.x ?? 0) - 300)).toBeLessThan(3);
    toys.controlLaser(300, 200, false);
    for (let i = 0; i < 40; i++) toys.update(1 / 60, [], bounds);
    expect(toys.toys.find((t) => t.kind === 'laser')).toBeUndefined();
  });
});
