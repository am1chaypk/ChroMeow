/**
 * Factory cat presets.
 *
 * cat_slot_1 and cat_slot_2 are modelled on the two bonded brown-and-white
 * piebald mackerel tabbies from the reference photographs:
 *
 *  • Cat 1 — "החתול עם צווארון/פס הכתף הלבן והכתם הזהוב": high-white harlequin
 *    with a white band cutting across the shoulders (broken saddle), a golden
 *    flank blotch, a narrow symmetrical blaze that climbs high up the forehead,
 *    full white front legs, high white hind stockings and sassy airplane ears.
 *  • Cat 2 — "החתול עם גלימת הגב המנומרת הרציפה": a continuous tabby mantle from
 *    crown to tail with only a small white crest near the rump, a broader
 *    soft-edged blaze, bold cheek stripes, white mittens and a melted-loaf habit.
 */
import type { CatProfile, CoatMarkings, CoatPalette, CoatPattern, Morphology, Personality, SignatureBehaviors } from './types';

export const PROFILE_VERSION = 1;
export const MAX_CATS = 6;

/** Canonical palette shared by both default cats (addendum §1). */
export const PIEBALD_TABBY_PALETTE: CoatPalette = {
  baseWhite: '#F7F6F2',
  undercoatWarm: '#EFECE6',
  tabbyBase: '#7A6855',
  tabbyStripe: '#2A241E',
  rufus: '#B87A3D',
  flankPatch: '#C47D38',
  patchSecondary: '#C9873F',
  noseLeather: '#E58B88',
  pawPads: '#E29592',
  innerEar: '#DF9B98',
  eyeLeft: '#8FA868',
  eyeRight: '#7E9A5C',
  eyeRim: '#1E1A16',
};

const NO_SIGNATURE: SignatureBehaviors = {
  chinPropSleep: false,
  meltedLoafSleep: false,
  airplaneSquint: false,
  pillowSnuggler: false,
  widePawSplay: false,
};

const BASE_MARKINGS: CoatMarkings = {
  whiteAmount: 0.5,
  blazeWidth: 0.5,
  blazeSoftness: 0.4,
  blazeHeight: 0.6,
  shoulderBand: false,
  flankPatch: false,
  rumpCrest: false,
  eyeliner: 0.7,
  mMark: true,
  cheekStripes: 0.6,
  eyeHalo: 0.3,
  frontLegWhite: 0.5,
  hindLegWhite: 0.5,
  tailRings: 5,
  tailTipDark: true,
  stripeDensity: 0.6,
};

const BASE_MORPH: Morphology = {
  chonk: 1.0,
  furLength: 'short',
  earSize: 1.0,
  tailLength: 1.0,
  heterochromia: false,
  size: 1.0,
};

const BASE_PERSONALITY: Personality = {
  laziness: 0.55,
  huntDrive: 0.55,
  sociability: 0.6,
  sassiness: 0.4,
  clumsiness: 0.25,
  affection: 0.6,
};

export function createCat1(): CatProfile {
  return {
    id: 'cat_slot_1',
    slot: 1,
    enabled: true,
    name: 'Cat 1',
    bio: 'החתול עם צווארון/פס הכתף הלבן והכתם הזהוב — white shoulder band, golden flank patch, sassy airplane ears, loves propping its chin on armrests.',
    pattern: 'PATCHED_TABBY_HARLEQUIN',
    palette: { ...PIEBALD_TABBY_PALETTE },
    markings: {
      whiteAmount: 0.64,
      blazeWidth: 0.34,
      blazeSoftness: 0.18,
      blazeHeight: 0.92,
      shoulderBand: true,
      flankPatch: true,
      rumpCrest: false,
      eyeliner: 0.85,
      mMark: true,
      cheekStripes: 0.55,
      eyeHalo: 0.7,
      frontLegWhite: 1.0,
      hindLegWhite: 0.85,
      tailRings: 5,
      tailTipDark: true,
      stripeDensity: 0.7,
    },
    morphology: { chonk: 1.2, furLength: 'short', earSize: 1.0, tailLength: 1.0, heterochromia: false, size: 1.0 },
    personality: { laziness: 0.78, huntDrive: 0.55, sociability: 0.95, sassiness: 0.65, clumsiness: 0.3, affection: 0.9 },
    signature: { chinPropSleep: true, meltedLoafSleep: false, airplaneSquint: true, pillowSnuggler: false, widePawSplay: true },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: 'cat1-harlequin',
    version: PROFILE_VERSION,
  };
}

export function createCat2(): CatProfile {
  return {
    id: 'cat_slot_2',
    slot: 2,
    enabled: true,
    name: 'Cat 2',
    bio: 'החתול עם גלימת הגב המנומרת הרציפה — continuous tabby mantle, white rump crest, white mittens, sleeps melted flat along ledges and uses Cat 1 as a pillow.',
    pattern: 'MANTLED_BICOLOR_TABBY',
    palette: { ...PIEBALD_TABBY_PALETTE, eyeLeft: '#86A160', eyeRight: '#6E8C52' },
    markings: {
      whiteAmount: 0.4,
      blazeWidth: 0.62,
      blazeSoftness: 0.62,
      blazeHeight: 0.55,
      shoulderBand: false,
      flankPatch: false,
      rumpCrest: true,
      eyeliner: 0.92,
      mMark: true,
      cheekStripes: 0.9,
      eyeHalo: 0.5,
      frontLegWhite: 0.86,
      hindLegWhite: 0.78,
      tailRings: 5,
      tailTipDark: true,
      stripeDensity: 0.8,
    },
    morphology: { chonk: 1.17, furLength: 'short', earSize: 1.0, tailLength: 1.0, heterochromia: false, size: 1.0 },
    personality: { laziness: 0.72, huntDrive: 0.68, sociability: 0.95, sassiness: 0.35, clumsiness: 0.25, affection: 0.92 },
    signature: { chinPropSleep: false, meltedLoafSleep: true, airplaneSquint: false, pillowSnuggler: true, widePawSplay: false },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: 'cat2-mantled',
    version: PROFILE_VERSION,
  };
}

interface PresetTemplate {
  key: string;
  label: string;
  labelHe: string;
  pattern: CoatPattern;
  palette: Partial<CoatPalette>;
  markings?: Partial<CoatMarkings>;
  morphology?: Partial<Morphology>;
  personality?: Partial<Personality>;
}

/** Extra presets offered when adding cats 3–6 in Cat Studio. */
export const EXTRA_PRESETS: readonly PresetTemplate[] = [
  {
    key: 'ginger-mackerel',
    label: 'Ginger Mackerel Tabby',
    labelHe: 'ג׳ינג׳י טאבי מקרל',
    pattern: 'MACKEREL_TABBY',
    palette: { tabbyBase: '#D98A3D', tabbyStripe: '#9A4E1C', rufus: '#E8A25A', baseWhite: '#FBEBD5', undercoatWarm: '#F5DDBC', eyeLeft: '#D8A13A', eyeRight: '#D8A13A' },
    markings: { whiteAmount: 0.12, blazeWidth: 0.2, frontLegWhite: 0.1, hindLegWhite: 0.1, eyeHalo: 0.2 },
    personality: { huntDrive: 0.8, laziness: 0.4, sassiness: 0.3 },
  },
  {
    key: 'tuxedo',
    label: 'Tuxedo',
    labelHe: 'טוקסידו',
    pattern: 'TUXEDO',
    palette: { tabbyBase: '#1E1C1B', tabbyStripe: '#0E0D0C', rufus: '#2E2A27', eyeLeft: '#C9B23C', eyeRight: '#C9B23C' },
    markings: { whiteAmount: 0.45, blazeWidth: 0.45, blazeHeight: 0.4, frontLegWhite: 0.35, hindLegWhite: 0.3, eyeliner: 0.2, mMark: false, cheekStripes: 0, eyeHalo: 0, tailRings: 0 },
    personality: { sassiness: 0.55, huntDrive: 0.7 },
  },
  {
    key: 'siamese',
    label: 'Seal-point Siamese',
    labelHe: 'סיאמי סיל־פוינט',
    pattern: 'COLORPOINT',
    palette: { baseWhite: '#F3E9DA', undercoatWarm: '#EADBC5', tabbyBase: '#3E2C22', tabbyStripe: '#2A1D16', rufus: '#C9A882', eyeLeft: '#4F8FD6', eyeRight: '#4F8FD6', noseLeather: '#5A4038', pawPads: '#5A4038' },
    markings: { whiteAmount: 0, blazeWidth: 0, eyeliner: 0.2, mMark: false, cheekStripes: 0, eyeHalo: 0, tailRings: 0, tailTipDark: true, frontLegWhite: 0, hindLegWhite: 0 },
    morphology: { chonk: 0.85, earSize: 1.25, tailLength: 1.2 },
    personality: { sociability: 0.9, sassiness: 0.5, laziness: 0.4 },
  },
  {
    key: 'calico',
    label: 'Calico',
    labelHe: 'קליקו',
    pattern: 'CALICO',
    palette: { tabbyBase: '#2B2622', tabbyStripe: '#151210', patchSecondary: '#D8893C', eyeLeft: '#C8A040', eyeRight: '#C8A040' },
    markings: { whiteAmount: 0.6, blazeWidth: 0.5, eyeliner: 0.3, mMark: false, cheekStripes: 0.1, tailRings: 0, frontLegWhite: 0.7, hindLegWhite: 0.7 },
    personality: { sassiness: 0.7, laziness: 0.5 },
  },
  {
    key: 'tortie',
    label: 'Tortoiseshell',
    labelHe: 'צב (טורטי)',
    pattern: 'TORTOISESHELL',
    palette: { tabbyBase: '#2A2420', tabbyStripe: '#120F0D', patchSecondary: '#B8662C', eyeLeft: '#D29A36', eyeRight: '#D29A36' },
    markings: { whiteAmount: 0, blazeWidth: 0.1, eyeliner: 0.3, mMark: false, cheekStripes: 0.1, tailRings: 0, frontLegWhite: 0, hindLegWhite: 0 },
    personality: { sassiness: 0.8 },
  },
  {
    key: 'grey-solid',
    label: 'Fluffy Grey',
    labelHe: 'אפור פרוותי',
    pattern: 'SOLID',
    palette: { tabbyBase: '#7D8590', tabbyStripe: '#5C636C', rufus: '#8A919B', baseWhite: '#C9CED4', undercoatWarm: '#B5BCC4', eyeLeft: '#D9A33B', eyeRight: '#D9A33B', noseLeather: '#5F6670' },
    markings: { whiteAmount: 0, blazeWidth: 0, eyeliner: 0.1, mMark: false, cheekStripes: 0, eyeHalo: 0, tailRings: 0, tailTipDark: false, frontLegWhite: 0, hindLegWhite: 0 },
    morphology: { furLength: 'long', chonk: 1.25 },
    personality: { laziness: 0.85, sociability: 0.7 },
  },
  {
    key: 'van',
    label: 'Turkish Van',
    labelHe: 'ואן טורקי',
    pattern: 'BICOLOR_VAN',
    palette: { tabbyBase: '#C77A3A', tabbyStripe: '#8C4B1E', rufus: '#D8954E', eyeLeft: '#5C8FD0', eyeRight: '#D9A33B' },
    markings: { whiteAmount: 0.95, blazeWidth: 0.7, blazeHeight: 0.7, frontLegWhite: 1, hindLegWhite: 1, tailRings: 4, eyeliner: 0.2, cheekStripes: 0 },
    morphology: { heterochromia: true, furLength: 'medium' },
    personality: { huntDrive: 0.75, laziness: 0.35 },
  },
];

export function createFromTemplate(key: string, slot: number): CatProfile {
  const t = EXTRA_PRESETS.find((p) => p.key === key) ?? EXTRA_PRESETS[0];
  return {
    id: `cat_slot_${slot}_${Date.now().toString(36)}`,
    slot,
    enabled: true,
    name: `Cat ${slot}`,
    bio: t.label,
    pattern: t.pattern,
    palette: { ...PIEBALD_TABBY_PALETTE, ...t.palette },
    markings: { ...BASE_MARKINGS, ...t.markings },
    morphology: { ...BASE_MORPH, ...t.morphology },
    personality: { ...BASE_PERSONALITY, ...t.personality },
    signature: { ...NO_SIGNATURE },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: t.key,
    version: PROFILE_VERSION,
  };
}

export function defaultProfiles(): CatProfile[] {
  return [createCat1(), createCat2()];
}

/** Fills in any missing fields on a stored profile (forward compatibility). */
export function normalizeProfile(p: Partial<CatProfile>, slot: number): CatProfile {
  const base = slot === 1 ? createCat1() : slot === 2 ? createCat2() : createFromTemplate(EXTRA_PRESETS[0].key, slot);
  return {
    ...base,
    ...p,
    palette: { ...base.palette, ...(p.palette ?? {}) },
    markings: { ...base.markings, ...(p.markings ?? {}) },
    morphology: { ...base.morphology, ...(p.morphology ?? {}) },
    personality: { ...base.personality, ...(p.personality ?? {}) },
    signature: { ...base.signature, ...(p.signature ?? {}) },
    photos: Array.isArray(p.photos) ? p.photos : [],
    version: PROFILE_VERSION,
  } as CatProfile;
}
