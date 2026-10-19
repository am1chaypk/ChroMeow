/**
 * Dev tool: renders the extension icons from Cat 1's procedural face.
 * Bundle this file for the browser and open it with scripts/render-icons.py,
 * which saves public/icons/icon{16,32,48,128}.png.
 */
import { createCat1 } from '../src/shared/presets';
import { ArticulatedCatRenderer } from '../src/engine/ArticulatedCatRenderer';
import { DEFAULT_POSE_CONTEXT, computePose } from '../src/engine/PoseLibrary';
import { VerletTail } from '../src/engine/VerletTail';

declare global {
  interface Window {
    __icons?: Record<string, string>;
  }
}

function render(): void {
  const S = 512;
  const big = document.createElement('canvas');
  big.width = big.height = S;
  const ctx = big.getContext('2d') as CanvasRenderingContext2D;
  // Rounded tile in the duvet blue-grey of the reference photos.
  ctx.fillStyle = '#E3E9ED';
  ctx.beginPath();
  ctx.roundRect(8, 8, S - 16, S - 16, 112);
  ctx.fill();
  const cat = createCat1();
  const r = new ArticulatedCatRenderer(cat);
  const pose = computePose('CAT_LOAF', { ...DEFAULT_POSE_CONTEXT });
  pose.eyeOpen = 0.82;
  pose.faceTurn = 0.08;
  pose.headRot = 0;
  const scale = 10.5;
  // Frame the head: head centre (local) → tile centre.
  const tr = { x: S / 2 - pose.headX * scale, y: S * 0.56 - pose.headY * scale, flip: 1, scale };
  const tail = new VerletTail(6, 10.5 * scale, 0, 0, Math.PI);
  const skel = r.skeleton(pose, tr, 0);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(8, 8, S - 16, S - 16, 112);
  ctx.clip();
  r.draw(ctx, skel, pose, tail, scale, { time: 0, grounded: false, groundY: 0 });
  ctx.restore();
  const out: Record<string, string> = {};
  for (const size of [128, 48, 32, 16]) {
    // Progressive halving for crisp small icons.
    let src: HTMLCanvasElement = big;
    let cur = S;
    while (cur / 2 >= size) {
      const c = document.createElement('canvas');
      c.width = c.height = cur / 2;
      const cc = c.getContext('2d') as CanvasRenderingContext2D;
      cc.imageSmoothingQuality = 'high';
      cc.drawImage(src, 0, 0, cur / 2, cur / 2);
      src = c;
      cur /= 2;
    }
    const fin = document.createElement('canvas');
    fin.width = fin.height = size;
    const fc = fin.getContext('2d') as CanvasRenderingContext2D;
    fc.imageSmoothingQuality = 'high';
    fc.drawImage(src, 0, 0, size, size);
    out[String(size)] = fin.toDataURL('image/png');
  }
  out.preview = big.toDataURL('image/png');
  window.__icons = out;
}

render();
