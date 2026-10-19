/** Canvas helpers that work in content scripts, extension pages and workers. */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export function ctx2d(c: AnyCanvas, opts?: CanvasRenderingContext2DSettings): AnyCtx {
  const ctx = (c as HTMLCanvasElement).getContext('2d', opts) as AnyCtx | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Converts any canvas to a PNG/WebP data URL. */
export async function canvasToDataUrl(c: AnyCanvas, type = 'image/png', quality = 0.92): Promise<string> {
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) {
    const blob = await c.convertToBlob({ type, quality });
    return await blobToDataUrl(blob);
  }
  return (c as HTMLCanvasElement).toDataURL(type, quality);
}

export async function canvasToBlob(c: AnyCanvas, type = 'image/png', quality = 0.92): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) return c.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
}
