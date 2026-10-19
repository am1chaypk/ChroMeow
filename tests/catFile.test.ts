import { describe, expect, it } from 'vitest';
import { CatFileError, MAX_CAT_FILE_BYTES, exportFileName, mergeImported, parseCatFile, sanitizeCat, serializeCats } from '../src/shared/catFile';
import { MAX_CATS, createAlex, createAnna, defaultProfiles } from '../src/shared/presets';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('cat export / import', () => {
  it('round-trips a custom cat with photos, paint and sprite sheet', () => {
    const cat = { ...createAlex(), name: 'מיצי', bio: 'Loves boxes', photos: [PNG], paintMask: PNG };
    cat.sprite = { dataUrl: PNG, columns: 8, rows: 9, cellWidth: 192, cellHeight: 208, animations: { idle: { row: 0, frames: 8, fps: 6, loop: true } }, source: 'openpets-v1', anchorY: 0.95, facesLeft: false };
    cat.renderMode = 'sprite';
    const [back] = parseCatFile(serializeCats([cat]), 3);
    expect(back.name).toBe('מיצי');
    expect(back.bio).toBe('Loves boxes');
    expect(back.pattern).toBe(cat.pattern);
    expect(back.palette).toEqual(cat.palette);
    expect(back.markings).toEqual(cat.markings);
    expect(back.morphology).toEqual(cat.morphology);
    expect(back.personality).toEqual(cat.personality);
    expect(back.photos).toEqual([PNG]);
    expect(back.paintMask).toBe(PNG);
    expect(back.renderMode).toBe('sprite');
    expect(back.sprite?.animations.idle.frames).toBe(8);
    expect(back.slot).toBe(3);
    expect(back.id).not.toBe(cat.id);
  });

  it('accepts a bare cat object as well as a full file', () => {
    const cats = parseCatFile(JSON.stringify(createAnna()));
    expect(cats).toHaveLength(1);
    expect(cats[0].pattern).toBe('MANTLED_BICOLOR_TABBY');
  });

  it('sanitises untrusted fields', () => {
    const evil = {
      ...createAlex(),
      name: 'x'.repeat(200),
      pattern: 'NOT_A_PATTERN',
      palette: { ...createAlex().palette, baseWhite: 'url(javascript:alert(1))', eyeLeft: '#123456' },
      markings: { ...createAlex().markings, tailRings: 99, whiteAmount: -4 },
      morphology: { ...createAlex().morphology, chonk: 50, furLength: '<img>' },
      personality: { ...createAlex().personality, sassiness: 7 },
      photos: ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', PNG, PNG, PNG, PNG],
      paintMask: 'https://example.com/x.png',
      sprite: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', columns: 8, rows: 9, cellWidth: 10, cellHeight: 10, animations: {} },
      __proto__hack: { polluted: true },
      extra: 'dropped',
    };
    const c = sanitizeCat(evil, 1) as unknown as Record<string, unknown> & ReturnType<typeof sanitizeCat>;
    expect(c.name.length).toBeLessThanOrEqual(28);
    expect(c.pattern).toBe(createAlex().pattern);
    expect(c.palette.baseWhite).toBe(createAlex().palette.baseWhite);
    expect(c.palette.eyeLeft).toBe('#123456');
    expect(c.markings.tailRings).toBe(8);
    expect(c.markings.whiteAmount).toBe(0);
    expect(c.morphology.chonk).toBe(1.4);
    expect(c.morphology.furLength).toBe(createAlex().morphology.furLength);
    expect(c.personality.sassiness).toBe(1);
    expect(c.photos).toEqual([PNG, PNG, PNG]);
    expect(c.paintMask).toBeNull();
    expect(c.sprite).toBeNull();
    expect(c.extra).toBeUndefined();
    expect(c.__proto__hack).toBeUndefined();
  });

  it('rejects files that are not cats', () => {
    const fails = (text: string) => {
      try {
        parseCatFile(text);
        return false;
      } catch (e) {
        return e instanceof CatFileError;
      }
    };
    expect(fails('not json')).toBe(true);
    expect(fails('{"hello": 1}')).toBe(true);
    expect(fails('{"format": "chromeow-cats", "version": 1, "cats": []}')).toBe(true);
    expect(fails(' '.repeat(MAX_CAT_FILE_BYTES + 1))).toBe(true);
  });

  it('places imported cats in free slots and stops at the cat limit', () => {
    const existing = defaultProfiles();
    const imported = parseCatFile(serializeCats([createAlex(), createAnna(), createAlex(), createAnna(), createAlex(), createAnna()]));
    const { profiles, added, skipped } = mergeImported(existing, imported);
    expect(profiles).toHaveLength(MAX_CATS);
    expect(added).toHaveLength(MAX_CATS - 2);
    expect(skipped).toBe(2);
    expect(new Set(profiles.map((p) => p.slot)).size).toBe(MAX_CATS);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(MAX_CATS);
  });

  it('names export files after the cat', () => {
    expect(exportFileName([{ ...createAlex(), name: 'Miso / the cat' }])).toBe('Miso-the-cat.chromeow.json');
    expect(exportFileName([{ ...createAlex(), name: 'מיצי' }])).toBe('מיצי.chromeow.json');
    expect(exportFileName(defaultProfiles())).toBe('chromeow-cats.chromeow.json');
  });
});
