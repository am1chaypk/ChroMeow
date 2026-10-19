/**
 * The complete ChroMeow behavioural state vocabulary.
 *
 * The first 28 entries are the core ethogram from the master spec; the rest are
 * the extended reaction, social and signature states (including the six
 * photo-derived signature postures of Alex and Anna), followed by the v2 states
 * for being picked up, the food & water station and the idle cuddle.
 *
 * New states are only ever appended, so sprite sheets baked with the 49-state
 * ChroMeow HD layout keep their row order.
 */
export const CORE_STATES = [
  // Rest & wake chain
  'CURLED_SLEEP',
  'SPRAWLED_SLEEP',
  'WAKE_ARCH_STRETCH',
  'BIG_YAWN',
  // Posture & idle
  'IDLE_SIT',
  'CAT_LOAF',
  'SPHINX_POSE',
  'DANGLE_PAWS',
  // Self-care
  'GROOM_LICK_PAW',
  'GROOM_WASH_FACE',
  'GROOM_BACK_LEG',
  'SCRATCH_EAR_HIND_LEG',
  // Locomotion
  'SAUNTER_WALK',
  'TROT',
  'ZOOMIES_SPRINT',
  'CROUCH_PREP_JUMP',
  'JUMP_ASCEND',
  'FALL_DESCEND',
  'LAND_RECOVERY',
  'WALL_CLIMB',
  // Cursor & page interaction
  'CURSOR_GAZE',
  'STALK_CURSOR',
  'POUNCE_AND_PIN',
  'KEYBOARD_WATCH',
  // Tactile responses
  'PURRING',
  'KNEADING_BISCUITS',
  'BELLY_UP_ROLL',
  'BUNNY_KICK_SWAT',
] as const;

export const EXTENDED_STATES = [
  'IDLE_STAND',
  'TAIL_LASH',
  'STARTLED_AIRBORNE',
  'EDGE_PEEK',
  'EAT_TREAT',
  'ELEVATOR_BUTT',
  'PAW_TUCK',
  // Social (Cat ↔ Cat)
  'NOSE_BOOP_GREETING',
  'ALLOGROOMING',
  'ALLOGROOM_RECEIVE',
  'YIN_YANG_CUDDLE_SLEEP',
  'PLAY_TAG_CHASE',
  'PLAY_WRESTLE',
  'JEALOUSY_INTERVENTION',
  // Signature states modelled on the reference photographs
  'CHIN_PROP_SLEEP',
  'MELTED_LOAF_SLEEP',
  'TANDEM_BELLY_HOLD_SLEEP',
  'PILLOW_STACK_CUDDLE',
  'LEDGE_CHIN_REST',
  'WIDE_PAW_SPLAY',
  'JUDGMENTAL_AIRPLANE_SQUINT',
  // v2: held by the scruff, the food & water station and the idle cuddle
  'SCRUFF_HELD',
  'SEEKING_FOOD',
  'EATING',
  'SEEKING_WATER',
  'DRINKING',
  'EMPTY_BOWL_WAIT',
  'CUDDLE_SLEEP',
] as const;

/** Number of states in the original ChroMeow HD sprite layout (one row each). */
export const LEGACY_HD_STATE_COUNT = 49;

export const ALL_STATES = [...CORE_STATES, ...EXTENDED_STATES] as const;

export type CatState = (typeof ALL_STATES)[number];

export function isCatState(value: unknown): value is CatState {
  return typeof value === 'string' && (ALL_STATES as readonly string[]).includes(value);
}

export const SLEEP_STATES: ReadonlySet<CatState> = new Set<CatState>([
  'CURLED_SLEEP',
  'SPRAWLED_SLEEP',
  'CHIN_PROP_SLEEP',
  'MELTED_LOAF_SLEEP',
  'TANDEM_BELLY_HOLD_SLEEP',
  'PILLOW_STACK_CUDDLE',
  'YIN_YANG_CUDDLE_SLEEP',
  'CUDDLE_SLEEP',
]);

export const AIRBORNE_STATES: ReadonlySet<CatState> = new Set<CatState>([
  'JUMP_ASCEND',
  'FALL_DESCEND',
  'STARTLED_AIRBORNE',
]);
