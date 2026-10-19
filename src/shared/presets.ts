/**
 * Factory cat presets.
 *
 * The two built-in cats are Alex and Anna, the bonded brown-and-white mackerel
 * tabbies from the reference photographs:
 *
 *  • Alex (אלכס) — a patched brown-grey mackerel tabby with white, a little
 *    stockier than Anna. A warm rufous / amber patch sits low on his flank where
 *    the tabby coat meets the white belly, and a white band crosses his back just
 *    behind the shoulders ("broken saddle"), splitting the tabby shoulder patch
 *    from the rear saddle. Wide, slightly lopsided white blaze over the muzzle and
 *    cheeks, bubblegum-pink nose, white chest, belly and legs, ringed tail with a
 *    black tip. Relaxed and affectionate: sprawls, stretches his front paws out,
 *    eats a bit more, adores head, chin and back strokes, and is devoted to Anna.
 *  • Anna (אנה) — a classic cool brown / charcoal mackerel tabby with white: crisp
 *    near-black stripes over a cool taupe-grey ticked coat and one continuous
 *    tabby mantle from crown to tail base (no white band, no orange patch).
 *    Narrow symmetrical blaze, delicate pink nose, sharp eyeliner, a clear "M",
 *    white bib, belly and socks. An alert, agile cursor hunter with expressive
 *    "airplane ears" who is forever starting grooming sessions and cuddles.
 */
import type { CatProfile, CatTraits, CoatMarkings, CoatPalette, CoatPattern, Morphology, Personality, SignatureBehaviors } from './types';

/** 2 = v2.0 (Alex & Anna, traits). Stored profiles from v1 are migrated on load. */
export const PROFILE_VERSION = 2;
export const MAX_CATS = 6;

export const ALEX_ID = 'alex';
export const ANNA_ID = 'anna';

/** Shared base palette for the brown-and-white mackerel tabbies (used by templates). */
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

/** Alex: warmer golden-brown agouti, amber flank patch #D47A34 deepening into #B86528. */
export const ALEX_PALETTE: CoatPalette = {
  baseWhite: '#F8F7F4',
  undercoatWarm: '#F0ECE4',
  tabbyBase: '#7E6A53',
  tabbyStripe: '#28211B',
  rufus: '#B86528',
  flankPatch: '#D47A34',
  patchSecondary: '#C9873F',
  noseLeather: '#E88B9C',
  pawPads: '#E595A0',
  innerEar: '#E29BA3',
  eyeLeft: '#9DAA5E',
  eyeRight: '#8E9F55',
  eyeRim: '#1E1A16',
};

/** Anna: sharp #1E1D1B mackerel stripes over a cool #6A5D4D taupe-grey agouti. */
export const ANNA_PALETTE: CoatPalette = {
  baseWhite: '#F7F6F2',
  undercoatWarm: '#EDEAE5',
  tabbyBase: '#6A5D4D',
  tabbyStripe: '#1E1D1B',
  rufus: '#9C7A55',
  flankPatch: '#9C7A55',
  patchSecondary: '#B0865A',
  noseLeather: '#E7A1A4',
  pawPads: '#E39DA0',
  innerEar: '#DFA2A3',
  eyeLeft: '#9AAE62',
  eyeRight: '#8AA157',
  eyeRim: '#191715',
};

const NO_SIGNATURE: SignatureBehaviors = {
  chinPropSleep: false,
  meltedLoafSleep: false,
  airplaneSquint: false,
  pillowSnuggler: false,
  widePawSplay: false,
};

export const DEFAULT_TRAITS: CatTraits = {
  hungerRateMultiplier: 1,
  thirstRateMultiplier: 1,
  playfulness: 0.55,
  pettingAffinity: 1,
  earExpressiveness: 0.5,
  socialInitiative: 0.5,
  sprawlLover: 0.4,
  bondedWith: '',
};

const BASE_MARKINGS: CoatMarkings = {
  whiteAmount: 0.5,
  blazeWidth: 0.5,
  blazeSoftness: 0.4,
  blazeAsymmetry: 0,
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

export function createAlex(): CatProfile {
  return {
    id: ALEX_ID,
    slot: 1,
    enabled: true,
    name: 'Alex',
    bio: 'Alex (אלכס) — patched brown-grey mackerel tabby with white: amber flank patch, white band across the back behind the shoulders, wide white blaze. Relaxed, affectionate, sprawls and stretches, loves chin and back scratches, and is devoted to Anna.',
    pattern: 'PATCHED_TABBY_HARLEQUIN',
    palette: { ...ALEX_PALETTE },
    markings: {
      whiteAmount: 0.66,
      blazeWidth: 0.78,
      blazeSoftness: 0.32,
      blazeAsymmetry: 0.55,
      blazeHeight: 0.62,
      shoulderBand: true,
      flankPatch: true,
      rumpCrest: false,
      eyeliner: 0.8,
      mMark: true,
      cheekStripes: 0.5,
      eyeHalo: 0.65,
      frontLegWhite: 1.0,
      hindLegWhite: 0.92,
      tailRings: 6,
      tailTipDark: true,
      stripeDensity: 0.72,
    },
    morphology: { chonk: 1.26, furLength: 'short', earSize: 1.0, tailLength: 1.0, heterochromia: false, size: 1.06 },
    personality: { laziness: 0.8, huntDrive: 0.45, sociability: 0.95, sassiness: 0.3, clumsiness: 0.3, affection: 0.95 },
    signature: { chinPropSleep: true, meltedLoafSleep: false, airplaneSquint: false, pillowSnuggler: false, widePawSplay: true },
    traits: {
      hungerRateMultiplier: 1.15,
      thirstRateMultiplier: 1.0,
      playfulness: 0.42,
      pettingAffinity: 1.45,
      earExpressiveness: 0.3,
      socialInitiative: 0.45,
      sprawlLover: 0.9,
      bondedWith: ANNA_ID,
    },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: ALEX_ID,
    version: PROFILE_VERSION,
  };
}

export function createAnna(): CatProfile {
  return {
    id: ANNA_ID,
    slot: 2,
    enabled: true,
    name: 'Anna',
    bio: 'Anna (אנה) — classic cool brown / charcoal mackerel tabby with white: one continuous tabby mantle from crown to tail, narrow blaze, crisp eyeliner and "M". An alert cursor hunter with expressive airplane ears who loves grooming and cuddling Alex.',
    pattern: 'MANTLED_BICOLOR_TABBY',
    palette: { ...ANNA_PALETTE },
    markings: {
      whiteAmount: 0.4,
      blazeWidth: 0.3,
      blazeSoftness: 0.22,
      blazeAsymmetry: 0,
      blazeHeight: 0.78,
      shoulderBand: false,
      flankPatch: false,
      rumpCrest: false,
      eyeliner: 0.95,
      mMark: true,
      cheekStripes: 0.9,
      eyeHalo: 0.35,
      frontLegWhite: 0.55,
      hindLegWhite: 0.6,
      tailRings: 6,
      tailTipDark: true,
      stripeDensity: 0.85,
    },
    morphology: { chonk: 1.08, furLength: 'short', earSize: 1.03, tailLength: 1.02, heterochromia: false, size: 0.98 },
    personality: { laziness: 0.5, huntDrive: 0.9, sociability: 0.95, sassiness: 0.5, clumsiness: 0.15, affection: 0.88 },
    signature: { chinPropSleep: false, meltedLoafSleep: true, airplaneSquint: true, pillowSnuggler: true, widePawSplay: false },
    traits: {
      hungerRateMultiplier: 0.95,
      thirstRateMultiplier: 1.05,
      playfulness: 0.88,
      pettingAffinity: 1.1,
      earExpressiveness: 0.92,
      socialInitiative: 0.92,
      sprawlLover: 0.35,
      bondedWith: ALEX_ID,
    },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: ANNA_ID,
    version: PROFILE_VERSION,
  };
}

/** Built-in templates the Studio can start a new cat from. */
export const BUILTIN_TEMPLATES = [
  { key: ALEX_ID, create: createAlex },
  { key: ANNA_ID, create: createAnna },
] as const;

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
    traits: { ...DEFAULT_TRAITS, playfulness: clamp01(0.3 + 0.6 * (1 - (t.personality?.laziness ?? BASE_PERSONALITY.laziness))) },
    paintMask: null,
    renderMode: 'procedural',
    sprite: null,
    photos: [],
    presetKey: t.key,
    version: PROFILE_VERSION,
  };
}

/** A fresh copy of a built-in cat (Alex / Anna) as a new, separate cat in `slot`. */
export function createFromBuiltin(key: string, slot: number, id: string): CatProfile | null {
  const t = BUILTIN_TEMPLATES.find((b) => b.key === key);
  if (!t) return null;
  const base = t.create();
  return { ...base, id, slot, traits: { ...base.traits, bondedWith: '' } };
}

export function defaultProfiles(): CatProfile[] {
  return [createAlex(), createAnna()];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Fills in any missing fields on a stored profile (forward compatibility). */
export function normalizeProfile(p: Partial<CatProfile>, slot: number): CatProfile {
  const base =
    p.presetKey === ANNA_ID ? createAnna() : p.presetKey === ALEX_ID ? createAlex() : slot === 1 ? createAlex() : slot === 2 ? createAnna() : createFromTemplate(EXTRA_PRESETS[0].key, slot);
  return {
    ...base,
    ...p,
    palette: { ...base.palette, ...(p.palette ?? {}) },
    markings: { ...base.markings, ...(p.markings ?? {}) },
    morphology: { ...base.morphology, ...(p.morphology ?? {}) },
    personality: { ...base.personality, ...(p.personality ?? {}) },
    signature: { ...base.signature, ...(p.signature ?? {}) },
    traits: { ...(p.presetKey && p.presetKey !== base.presetKey ? DEFAULT_TRAITS : base.traits), ...(p.traits ?? {}) },
    photos: Array.isArray(p.photos) ? p.photos : [],
    version: PROFILE_VERSION,
  } as CatProfile;
}

/* ------------------------------------------------------------ v1 → v2 migration */

/** The v1 factory coats, used to tell an untouched factory cat from a customised one. */
const V1_PALETTE: CoatPalette = { ...PIEBALD_TABBY_PALETTE };
const V1_CAT2_PALETTE: CoatPalette = { ...PIEBALD_TABBY_PALETTE, eyeLeft: '#86A160', eyeRight: '#6E8C52' };
const V1_CAT1_MARKINGS: Omit<CoatMarkings, 'blazeAsymmetry'> = { whiteAmount: 0.64, blazeWidth: 0.34, blazeSoftness: 0.18, blazeHeight: 0.92, shoulderBand: true, flankPatch: true, rumpCrest: false, eyeliner: 0.85, mMark: true, cheekStripes: 0.55, eyeHalo: 0.7, frontLegWhite: 1.0, hindLegWhite: 0.85, tailRings: 5, tailTipDark: true, stripeDensity: 0.7 };
const V1_CAT2_MARKINGS: Omit<CoatMarkings, 'blazeAsymmetry'> = { whiteAmount: 0.4, blazeWidth: 0.62, blazeSoftness: 0.62, blazeHeight: 0.55, shoulderBand: false, flankPatch: false, rumpCrest: true, eyeliner: 0.92, mMark: true, cheekStripes: 0.9, eyeHalo: 0.5, frontLegWhite: 0.86, hindLegWhite: 0.78, tailRings: 5, tailTipDark: true, stripeDensity: 0.8 };

function sameValues(a: object | undefined, b: object): boolean {
  if (!a) return false;
  const ra = a as Record<string, unknown>;
  return Object.entries(b).every(([k, v]) => ra[k] === v);
}

/**
 * Turns the v1 factory cats ("Cat 1" / "Cat 2") into Alex and Anna. Whatever the
 * user made their own is kept: a custom name, an edited coat, paint, photos,
 * sprite sheets and the on/off switch. Untouched factory parts get the v2 look.
 */
export function migrateProfile(p: Partial<CatProfile>, takenIds: ReadonlySet<string>): Partial<CatProfile> {
  if ((p.version ?? 1) >= 2) return p;
  const key = p.presetKey;
  if (key !== 'cat1-harlequin' && key !== 'cat2-mantled') return p;
  const alex = key === 'cat1-harlequin';
  const fresh = alex ? createAlex() : createAnna();
  const out: Partial<CatProfile> = { ...p, presetKey: fresh.presetKey, traits: { ...fresh.traits } };
  const defaultName = alex ? /^(cat 1|חתול 1)$/i : /^(cat 2|חתול 2)$/i;
  if (!p.name || defaultName.test(p.name.trim())) out.name = fresh.name;
  if (p.id === (alex ? 'cat_slot_1' : 'cat_slot_2') && !takenIds.has(fresh.id)) out.id = fresh.id;
  const coatUntouched = sameValues(p.palette, alex ? V1_PALETTE : V1_CAT2_PALETTE) && sameValues(p.markings, alex ? V1_CAT1_MARKINGS : V1_CAT2_MARKINGS) && p.pattern === fresh.pattern;
  if (coatUntouched) {
    out.palette = { ...fresh.palette };
    out.markings = { ...fresh.markings };
    out.morphology = { ...fresh.morphology };
    out.personality = { ...fresh.personality };
    out.signature = { ...fresh.signature };
    out.bio = fresh.bio;
  }
  return out;
}
