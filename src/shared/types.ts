import type { CatState } from './catStates';

export type HexColor = string;

/** Every colour the procedural coat renderer can use. */
export interface CoatPalette {
  /** Snowy white of chest, belly, paws and muzzle. */
  baseWhite: HexColor;
  /** Cream-white transition on the fluffy belly pouch. */
  undercoatWarm: HexColor;
  /** Primary coat colour (ticked agouti for tabbies, solid colour otherwise). */
  tabbyBase: HexColor;
  /** Stripes, "M" marking, eyeliner, tail rings. */
  tabbyStripe: HexColor;
  /** Warm rufism highlights (nose bridge, eye halo, thighs). */
  rufus: HexColor;
  /** Distinct flank blotch colour (Cat 1's golden patch). */
  flankPatch: HexColor;
  /** Secondary patch colour for calico / tortoiseshell. */
  patchSecondary: HexColor;
  noseLeather: HexColor;
  pawPads: HexColor;
  innerEar: HexColor;
  eyeLeft: HexColor;
  eyeRight: HexColor;
  /** Dark eye rim / eyeliner. */
  eyeRim: HexColor;
}

export const COAT_PATTERNS = [
  'SOLID',
  'TUXEDO',
  'CLASSIC_TABBY',
  'MACKEREL_TABBY',
  'SPOTTED',
  'CALICO',
  'TORTOISESHELL',
  'COLORPOINT',
  'BICOLOR_VAN',
  'PATCHED_TABBY_HARLEQUIN',
  'MANTLED_BICOLOR_TABBY',
  'CUSTOM_MASK',
] as const;
export type CoatPattern = (typeof COAT_PATTERNS)[number];

/** Fine-grained marking topology. All numbers are 0..1 unless noted. */
export interface CoatMarkings {
  /** How far white climbs up the flanks (bicolour patterns). */
  whiteAmount: number;
  /** Width of the inverted-V facial blaze. */
  blazeWidth: number;
  /** Edge softness of the blaze. */
  blazeSoftness: number;
  /** 0 = mirror-symmetrical blaze, 1 = one side reaches much further across the cheek (Alex). */
  blazeAsymmetry: number;
  /** How high the blaze climbs up the forehead. */
  blazeHeight: number;
  /** White band crossing the back behind the shoulders — a "broken saddle" (Alex). */
  shoulderBand: boolean;
  /** Warm rufous / amber blotch on the lower flank where tabby meets white (Alex). */
  flankPatch: boolean;
  /** Small white crest dipping up from the belly near the rump. */
  rumpCrest: boolean;
  /** Cleopatra eyeliner intensity. */
  eyeliner: number;
  /** Forehead "M". */
  mMark: boolean;
  /** Bold cheek stripes. */
  cheekStripes: number;
  /** Rufous glow around the eyes / nose bridge. */
  eyeHalo: number;
  /** Fraction of the front legs that is white, from the paw upward. */
  frontLegWhite: number;
  /** Fraction of the hind legs that is white, from the paw upward. */
  hindLegWhite: number;
  /** Number of dark tail rings (0..8). */
  tailRings: number;
  /** Solid dark tail tip. */
  tailTipDark: boolean;
  /** Stripe density for tabby patterns. */
  stripeDensity: number;
}

export type FurLength = 'short' | 'medium' | 'long';

export interface Morphology {
  /** Body chonkiness, 0.7 (sleek) .. 1.4 (chonky). */
  chonk: number;
  furLength: FurLength;
  /** 0.7 .. 1.4 */
  earSize: number;
  /** 0.6 .. 1.4 */
  tailLength: number;
  heterochromia: boolean;
  /** Overall size multiplier, 0.7 .. 1.4 */
  size: number;
}

/** Immutable personality weights w_i ∈ [0, 1]. */
export interface Personality {
  laziness: number;
  huntDrive: number;
  sociability: number;
  sassiness: number;
  clumsiness: number;
  /** Baseline affection / cuddliness (from the dual-cat addendum). */
  affection: number;
}

export const PERSONALITY_KEYS: readonly (keyof Personality)[] = [
  'laziness',
  'huntDrive',
  'sociability',
  'sassiness',
  'clumsiness',
  'affection',
];

/** Signature habits taken from the reference photographs. */
export interface SignatureBehaviors {
  chinPropSleep: boolean;
  meltedLoafSleep: boolean;
  airplaneSquint: boolean;
  pillowSnuggler: boolean;
  widePawSplay: boolean;
}

/**
 * Individual quirks that go beyond the 0..1 personality weights: appetite,
 * favourite petting spots, how expressive the ears are and who the cat is
 * bonded with.
 */
export interface CatTraits {
  /** Multiplies how fast hunger builds (1 = average cat). */
  hungerRateMultiplier: number;
  /** Multiplies how fast thirst builds. */
  thirstRateMultiplier: number;
  /** 0..1 baseline urge to play and hunt the cursor. */
  playfulness: number;
  /** Multiplies the affection gained from head, chin and back strokes. */
  pettingAffinity: number;
  /** 0..1 how quickly ears flatten into "airplane ears" when annoyed or overstimulated. */
  earExpressiveness: number;
  /** 0..1 how often this cat starts grooming / cuddling its partner. */
  socialInitiative: number;
  /** 0..1 love of sprawling out and long front-paw stretches. */
  sprawlLover: number;
  /** Profile id of the cat this one is bonded with (prefers it for cuddles), or ''. */
  bondedWith: string;
}

export interface SpriteAnimationDef {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export type SpriteSheetSource = 'chromeow-hd' | 'openpets-v1' | 'openpets-v2' | 'custom';

export interface SpriteSheetData {
  /** PNG / WebP as a data: URL (decoded locally with createImageBitmap). */
  dataUrl: string;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** Keyed by CatState or by an animation family name (see SpriteRenderer). */
  animations: Record<string, SpriteAnimationDef>;
  source: SpriteSheetSource;
  /** Fraction of the cell height where the feet touch the ground. */
  anchorY: number;
  /** True when the sheet's cats face left by default. */
  facesLeft: boolean;
}

export type RenderMode = 'procedural' | 'sprite';

export interface CatProfile {
  id: string;
  slot: number;
  enabled: boolean;
  name: string;
  bio: string;
  pattern: CoatPattern;
  palette: CoatPalette;
  markings: CoatMarkings;
  morphology: Morphology;
  personality: Personality;
  signature: SignatureBehaviors;
  traits: CatTraits;
  /** Painted overlay on the 512×512 UV atlas (PNG data URL) or null. */
  paintMask: string | null;
  renderMode: RenderMode;
  sprite: SpriteSheetData | null;
  /** Small JPEG thumbnails of the reference photos (kept local only). */
  photos: string[];
  presetKey: string;
  version: number;
}

export type Language = 'auto' | 'en' | 'he';

export interface Settings {
  clickThroughLock: boolean;
  blacklist: string[];
  catScale: number;
  globalPause: boolean;
  language: Language;
  showNameTags: boolean;
  /** Lowers activity (fewer zoomies, slower frame rate) — also auto-on with prefers-reduced-motion. */
  calmMode: boolean;
  /** Seconds without mouse / keyboard input before the cats curl up together (30..1800). */
  idleThreshold: number;
}

export interface Drives {
  energy: number;
  playfulness: number;
  affection: number;
  curiosity: number;
  irritation: number;
  socialNeed: number;
  /** 0..100, rises over time (faster when active); eating brings it down. */
  hunger: number;
  /** 0..100, rises over time (faster when active); drinking brings it down. */
  thirst: number;
}

export const DRIVE_KEYS: readonly (keyof Drives)[] = [
  'energy',
  'playfulness',
  'affection',
  'curiosity',
  'irritation',
  'socialNeed',
  'hunger',
  'thirst',
];

/** The food & water station on the viewport floor (shared by all tabs). */
export interface FeedingStation {
  enabled: boolean;
  /** Horizontal position of the station's centre along the viewport floor, 0..1. */
  xNormalized: number;
  /** 0..100 */
  foodLevel: number;
  /** 0..100 */
  waterLevel: number;
}

export type BowlKind = 'food' | 'water';

/** The canonical, tab-independent state of one cat (kept by the service worker). */
export interface CatRuntimeSnapshot {
  id: string;
  name: string;
  state: CatState;
  drives: Drives;
  /** Horizontal position as a fraction of the viewport width. */
  relX: number;
  /** Vertical position as a fraction of the viewport height. */
  relY: number;
  facing: 1 | -1;
  onFloor: boolean;
}

export interface WorldSnapshot {
  cats: CatRuntimeSnapshot[];
  updatedAt: number;
  href: string;
}

export type ToyKind = 'treat' | 'laser' | 'ball';

export type PopupAction = 'treat' | 'laser' | 'ball' | 'call';

export interface PageInfo {
  hostname: string;
  blacklisted: boolean;
  running: boolean;
  catCount: number;
  /** Toy currently in hand on that page (left-click play mode), if any. */
  playTool?: ToyKind | null;
}
