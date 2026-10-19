import { describe, expect, it } from 'vitest';
import { bytesToDataUrl, crc32, createZip, dataUrlToBytes, readZip } from '../src/shared/zip';

describe('zip', () => {
  it('computes the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips a pet.json + sprite sheet bundle', async () => {
    const json = new TextEncoder().encode(JSON.stringify({ id: 'cat-1', displayName: 'חתול 1', spritesheetPath: 'spritesheet.webp' }));
    const image = new Uint8Array(4096).map((_, i) => (i * 31) & 255);
    const zip = createZip([
      { name: 'pet.json', data: json },
      { name: 'spritesheet.webp', data: image },
    ]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['pet.json', 'spritesheet.webp']);
    expect(JSON.parse(new TextDecoder().decode(entries[0].data)).displayName).toBe('חתול 1');
    expect(Array.from(entries[1].data)).toEqual(Array.from(image));
  });

  it('rejects non-zip input', async () => {
    let failed = false;
    try {
      await readZip(new Uint8Array([1, 2, 3, 4, 5]));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('converts between bytes and data URLs', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const url = bytesToDataUrl(bytes, 'image/webp');
    expect(url.startsWith('data:image/webp;base64,')).toBe(true);
    const back = dataUrlToBytes(url);
    expect(back.mime).toBe('image/webp');
    expect(Array.from(back.bytes)).toEqual(Array.from(bytes));
  });
});
