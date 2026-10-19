import { describe, expect, it } from 'vitest';
import { PIEBALD_TABBY_PALETTE, createCat1, createCat2, defaultProfiles, normalizeProfile } from '../src/shared/presets';
import { hostnameMatches, isBlacklisted, normalizeSettings, withoutProfile } from '../src/shared/storage';

describe('factory presets (dual-cat addendum)', () => {
  it('ships two active cats out of the box', () => {
    const cats = defaultProfiles();
    expect(cats).toHaveLength(2);
    expect(cats.every((c) => c.enabled)).toBe(true);
    expect(cats.map((c) => c.id)).toEqual(['cat_slot_1', 'cat_slot_2']);
    expect(cats.map((c) => c.name)).toEqual(['Cat 1', 'Cat 2']);
  });

  it('uses the canonical piebald tabby palette', () => {
    expect(PIEBALD_TABBY_PALETTE.baseWhite).toBe('#F7F6F2');
    expect(PIEBALD_TABBY_PALETTE.undercoatWarm).toBe('#EFECE6');
    expect(PIEBALD_TABBY_PALETTE.tabbyBase).toBe('#7A6855');
    expect(PIEBALD_TABBY_PALETTE.tabbyStripe).toBe('#2A241E');
    expect(PIEBALD_TABBY_PALETTE.rufus).toBe('#B87A3D');
    expect(PIEBALD_TABBY_PALETTE.noseLeather).toBe('#E58B88');
    expect(PIEBALD_TABBY_PALETTE.pawPads).toBe('#E29592');
    expect(PIEBALD_TABBY_PALETTE.innerEar).toBe('#DF9B98');
  });

  it('models Cat 1: harlequin broken saddle, golden flank patch, sassy squint', () => {
    const c = createCat1();
    expect(c.pattern).toBe('PATCHED_TABBY_HARLEQUIN');
    expect(c.markings.shoulderBand).toBe(true);
    expect(c.markings.flankPatch).toBe(true);
    expect(c.palette.flankPatch).toBe('#C47D38');
    expect(c.markings.frontLegWhite).toBe(1);
    expect(c.personality).toEqual({ laziness: 0.78, huntDrive: 0.55, sociability: 0.95, sassiness: 0.65, clumsiness: 0.3, affection: 0.9 });
    expect(c.signature.chinPropSleep).toBe(true);
    expect(c.signature.airplaneSquint).toBe(true);
    expect(c.morphology.chonk).toBeGreaterThanOrEqual(1.15);
    expect(c.morphology.chonk).toBeLessThanOrEqual(1.22);
  });

  it('models Cat 2: continuous mantle, rump crest, melted loaf, pillow snuggler', () => {
    const c = createCat2();
    expect(c.pattern).toBe('MANTLED_BICOLOR_TABBY');
    expect(c.markings.rumpCrest).toBe(true);
    expect(c.markings.shoulderBand).toBe(false);
    expect(c.markings.blazeWidth).toBeGreaterThan(createCat1().markings.blazeWidth);
    expect(c.personality.laziness).toBe(0.72);
    expect(c.personality.sociability).toBe(0.95);
    expect(c.personality.sassiness).toBe(0.35);
    expect(c.personality.affection).toBe(0.92);
    expect(c.personality.huntDrive).toBe(0.68);
    expect(c.signature.meltedLoafSleep).toBe(true);
    expect(c.signature.pillowSnuggler).toBe(true);
  });

  it('normalises partial stored profiles without losing user data', () => {
    const p = normalizeProfile({ id: 'cat_slot_1', slot: 1, name: 'מיצי', markings: { blazeWidth: 0.1 } as never }, 1);
    expect(p.name).toBe('מיצי');
    expect(p.markings.blazeWidth).toBe(0.1);
    expect(p.markings.shoulderBand).toBe(true);
  });
});

describe('removing cats', () => {
  it('removes the chosen cat and keeps the others in order', () => {
    const cats = [createCat1(), createCat2(), { ...createCat2(), id: 'cat_x', slot: 3 }];
    expect(withoutProfile(cats, 'cat_slot_2').map((c) => c.id)).toEqual(['cat_slot_1', 'cat_x']);
  });

  it('never removes the last cat (it can only be switched off)', () => {
    const one = [createCat1()];
    expect(withoutProfile(one, 'cat_slot_1')).toHaveLength(1);
  });

  it('ignores unknown ids', () => {
    expect(withoutProfile(defaultProfiles(), 'nope')).toHaveLength(2);
  });
});

describe('settings & per-site pause', () => {
  it('matches hostnames including subdomains', () => {
    expect(hostnameMatches('www.youtube.com', 'youtube.com')).toBe(true);
    expect(hostnameMatches('music.youtube.com', 'youtube.com')).toBe(true);
    expect(hostnameMatches('notyoutube.com', 'youtube.com')).toBe(false);
  });

  it('blacklists paused domains', () => {
    const s = normalizeSettings({ blacklist: ['docs.google.com'] });
    expect(isBlacklisted(s, 'docs.google.com')).toBe(true);
    expect(isBlacklisted(s, 'mail.google.com')).toBe(false);
  });

  it('clamps out-of-range values', () => {
    const s = normalizeSettings({ volume: 5, catScale: 0.1 });
    expect(s.volume).toBe(1);
    expect(s.catScale).toBe(0.5);
  });
});
