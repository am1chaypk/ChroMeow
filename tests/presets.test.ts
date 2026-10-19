import { describe, expect, it } from 'vitest';
import { ALEX_ID, ANNA_ID, PROFILE_VERSION, createAlex, createAnna, createFromBuiltin, defaultProfiles, migrateProfile, normalizeProfile } from '../src/shared/presets';
import { DEFAULT_STATION, hostnameMatches, isBlacklisted, normalizeProfiles, normalizeSettings, normalizeStation, withoutProfile } from '../src/shared/storage';
import { isWarmAmber, mergePalette } from '../src/studio/PhotoColorExtractor';
import type { CatProfile } from '../src/shared/types';

describe('built-in cats: Alex & Anna', () => {
  it('ships Alex and Anna as the two default cats', () => {
    const cats = defaultProfiles();
    expect(cats).toHaveLength(2);
    expect(cats.every((c) => c.enabled)).toBe(true);
    expect(cats.map((c) => c.id)).toEqual([ALEX_ID, ANNA_ID]);
    expect(cats.map((c) => c.id)).toEqual(['alex', 'anna']);
    expect(cats.map((c) => c.name)).toEqual(['Alex', 'Anna']);
    expect(cats.map((c) => c.version)).toEqual([PROFILE_VERSION, PROFILE_VERSION]);
  });

  it('models Alex: patched tabby with a white saddle band, amber flank patch and wide lopsided blaze', () => {
    const c = createAlex();
    expect(c.pattern).toBe('PATCHED_TABBY_HARLEQUIN');
    // Broken saddle: a white band crosses the back behind the shoulders.
    expect(c.markings.shoulderBand).toBe(true);
    // Warm rufous / amber flank patch, #D47A34 deepening into #B86528.
    expect(c.markings.flankPatch).toBe(true);
    expect(c.palette.flankPatch).toBe('#D47A34');
    expect(c.palette.rufus).toBe('#B86528');
    expect(isWarmAmber(c.palette.flankPatch)).toBe(true);
    expect(c.palette.noseLeather).toBe('#E88B9C');
    expect(c.palette.baseWhite).toBe('#F8F7F4');
    expect(c.markings.blazeWidth).toBeGreaterThan(0.6);
    expect(c.markings.blazeAsymmetry).toBeGreaterThan(0.3);
    expect(c.markings.frontLegWhite).toBe(1);
    expect(c.markings.hindLegWhite).toBeGreaterThan(0.85);
    expect(c.markings.tailTipDark).toBe(true);
    expect(c.markings.tailRings).toBeGreaterThanOrEqual(5);
    // Slightly stockier and bigger than Anna.
    expect(c.morphology.size).toBe(1.06);
    expect(c.morphology.chonk).toBeGreaterThan(createAnna().morphology.chonk);
  });

  it('models Anna: cool charcoal mackerel tabby with one unbroken mantle', () => {
    const c = createAnna();
    expect(c.pattern).toBe('MANTLED_BICOLOR_TABBY');
    expect(c.palette.tabbyStripe).toBe('#1E1D1B');
    expect(c.palette.tabbyBase).toBe('#6A5D4D');
    // No white band across the back and no orange patch.
    expect(c.markings.shoulderBand).toBe(false);
    expect(c.markings.flankPatch).toBe(false);
    expect(c.markings.rumpCrest).toBe(false);
    expect(c.markings.blazeWidth).toBeLessThan(createAlex().markings.blazeWidth);
    expect(c.markings.blazeAsymmetry).toBe(0);
    expect(c.markings.mMark).toBe(true);
    expect(c.markings.eyeliner).toBeGreaterThan(0.9);
    expect(c.morphology.size).toBe(0.98);
  });

  it('gives each cat its own personality and quirks', () => {
    const alex = createAlex();
    const anna = createAnna();
    // Alex: relaxed, affectionate, a sprawler with a slightly bigger appetite who adores head / chin / back rubs.
    expect(alex.traits.hungerRateMultiplier).toBe(1.15);
    expect(alex.personality.laziness).toBeGreaterThan(anna.personality.laziness);
    expect(alex.personality.affection).toBeGreaterThanOrEqual(0.9);
    expect(alex.traits.pettingAffinity).toBeGreaterThan(1.3);
    expect(alex.traits.sprawlLover).toBeGreaterThan(0.8);
    expect(alex.signature.widePawSplay).toBe(true);
    expect(alex.traits.bondedWith).toBe(ANNA_ID);
    // Anna: an agile hunter with expressive airplane ears who starts grooming and cuddles.
    expect(anna.personality.huntDrive).toBeGreaterThan(0.85);
    expect(anna.traits.playfulness).toBeGreaterThan(0.8);
    expect(anna.traits.earExpressiveness).toBeGreaterThan(0.85);
    expect(anna.signature.airplaneSquint).toBe(true);
    expect(anna.traits.socialInitiative).toBeGreaterThan(alex.traits.socialInitiative);
    expect(anna.traits.bondedWith).toBe(ALEX_ID);
  });

  it('loads Alex and Anna as Studio templates (a separate copy, not bonded to anyone)', () => {
    const copy = createFromBuiltin(ALEX_ID, 3, 'cat_new') as CatProfile;
    expect(copy.id).toBe('cat_new');
    expect(copy.slot).toBe(3);
    expect(copy.markings).toEqual(createAlex().markings);
    expect(copy.palette).toEqual(createAlex().palette);
    expect(copy.traits.bondedWith).toBe('');
    expect(createFromBuiltin('nope', 3, 'x')).toBeNull();
  });

  it('normalises partial stored profiles without losing user data', () => {
    const p = normalizeProfile({ id: 'alex', slot: 1, presetKey: 'alex', name: 'מיצי', markings: { blazeWidth: 0.1 } as never }, 1);
    expect(p.name).toBe('מיצי');
    expect(p.markings.blazeWidth).toBe(0.1);
    expect(p.markings.shoulderBand).toBe(true);
    expect(p.traits.hungerRateMultiplier).toBe(1.15);
  });
});

describe('v1 → v2 migration', () => {
  const v1Cat1 = {
    id: 'cat_slot_1',
    slot: 1,
    enabled: false,
    name: 'Cat 1',
    pattern: 'PATCHED_TABBY_HARLEQUIN',
    palette: { baseWhite: '#F7F6F2', undercoatWarm: '#EFECE6', tabbyBase: '#7A6855', tabbyStripe: '#2A241E', rufus: '#B87A3D', flankPatch: '#C47D38', patchSecondary: '#C9873F', noseLeather: '#E58B88', pawPads: '#E29592', innerEar: '#DF9B98', eyeLeft: '#8FA868', eyeRight: '#7E9A5C', eyeRim: '#1E1A16' },
    markings: { whiteAmount: 0.64, blazeWidth: 0.34, blazeSoftness: 0.18, blazeHeight: 0.92, shoulderBand: true, flankPatch: true, rumpCrest: false, eyeliner: 0.85, mMark: true, cheekStripes: 0.55, eyeHalo: 0.7, frontLegWhite: 1.0, hindLegWhite: 0.85, tailRings: 5, tailTipDark: true, stripeDensity: 0.7 },
    presetKey: 'cat1-harlequin',
    version: 1,
    photos: ['data:image/jpeg;base64,AAAA'],
  } as unknown as Partial<CatProfile>;

  it('turns an untouched factory "Cat 1" into Alex, keeping the user’s switch and photos', () => {
    const [alex] = normalizeProfiles([v1Cat1]);
    expect(alex.id).toBe('alex');
    expect(alex.name).toBe('Alex');
    expect(alex.presetKey).toBe('alex');
    expect(alex.palette.flankPatch).toBe('#D47A34');
    expect(alex.enabled).toBe(false);
    expect(alex.photos).toHaveLength(1);
    expect(alex.version).toBe(PROFILE_VERSION);
  });

  it('keeps a renamed, recoloured cat exactly as the user made it', () => {
    const custom = { ...v1Cat1, name: 'Mitzi', palette: { ...(v1Cat1.palette as object), tabbyBase: '#333333' } } as Partial<CatProfile>;
    const out = migrateProfile(custom, new Set(['cat_slot_1']));
    expect(out.name).toBe('Mitzi');
    expect(out.palette?.tabbyBase).toBe('#333333');
    expect(out.traits?.hungerRateMultiplier).toBe(1.15);
  });

  it('is a no-op for v2 profiles and non-factory cats', () => {
    const alex = createAlex();
    expect(migrateProfile(alex, new Set())).toBe(alex);
    const ginger = { presetKey: 'ginger-mackerel', version: 1 } as Partial<CatProfile>;
    expect(migrateProfile(ginger, new Set())).toBe(ginger);
  });
});

describe('Studio colour tools preserve Alex’s markings', () => {
  it('never drops the amber patch or the saddle band when photo colours are applied', () => {
    const alex = createAlex();
    // A dull beige "rufous" cluster from a dim photo must not replace the amber patch…
    const merged = mergePalette(alex, { tabbyBase: '#6F6151', flankPatch: '#9C8B76', rufus: '#8E826F' });
    expect(merged.tabbyBase).toBe('#6F6151');
    expect(merged.flankPatch).toBe('#D47A34');
    expect(merged.rufus).toBe('#B86528');
    // …but a genuinely amber sample is taken.
    expect(mergePalette(alex, { flankPatch: '#D9803A' }).flankPatch).toBe('#D9803A');
    // Markings are not part of a palette merge at all.
    expect(alex.markings.shoulderBand).toBe(true);
    expect(alex.markings.flankPatch).toBe(true);
  });
});

describe('removing cats', () => {
  it('removes the chosen cat and keeps the others in order', () => {
    const cats = [createAlex(), createAnna(), { ...createAnna(), id: 'cat_x', slot: 3 }];
    expect(withoutProfile(cats, 'anna').map((c) => c.id)).toEqual(['alex', 'cat_x']);
  });

  it('never removes the last cat (it can only be switched off)', () => {
    const one = [createAlex()];
    expect(withoutProfile(one, 'alex')).toHaveLength(1);
  });

  it('ignores unknown ids', () => {
    expect(withoutProfile(defaultProfiles(), 'nope')).toHaveLength(2);
  });
});

describe('settings, station & per-site pause', () => {
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
    const s = normalizeSettings({ volume: 5, catScale: 0.1, idleThreshold: 2 });
    expect(s.volume).toBe(1);
    expect(s.catScale).toBe(0.5);
    expect(s.idleThreshold).toBe(30);
    expect(normalizeSettings({}).idleThreshold).toBe(120);
  });

  it('defaults the food & water station and clamps stored levels', () => {
    expect(DEFAULT_STATION).toEqual({ enabled: true, xNormalized: 0.9, foodLevel: 80, waterLevel: 80 });
    expect(normalizeStation(undefined)).toEqual(DEFAULT_STATION);
    expect(normalizeStation({ foodLevel: 140, waterLevel: -3, xNormalized: 2, enabled: false })).toEqual({ enabled: false, xNormalized: 1, foodLevel: 100, waterLevel: 0 });
  });
});
