/**
 * State metadata and the biological transition graph.
 *
 * Cats never teleport between unrelated states: the brain asks for a *target*
 * state and `findPath` returns the natural chain through intermediate postures
 * (e.g. CURLED_SLEEP → SPRAWLED_SLEEP → WAKE_ARCH_STRETCH → BIG_YAWN → IDLE_SIT →
 * IDLE_STAND → SAUNTER_WALK). Physics may additionally *interrupt* into airborne
 * states (a startle or a fall), which is modelled as a separate edge set that
 * the planner never uses voluntarily. Being picked up by the scruff is such an
 * interrupt too: any state can be grabbed into SCRUFF_HELD, and releasing it
 * always drops the cat into FALL_DESCEND (or straight into LAND_RECOVERY).
 */
import { ALL_STATES, AIRBORNE_STATES, SLEEP_STATES, type CatState } from '../shared/catStates';

export type Posture = 'stand' | 'sit' | 'lie' | 'sleep' | 'air' | 'wall' | 'react' | 'held';

export interface StateMeta {
  posture: Posture;
  /** Moves horizontally under its own power. */
  locomotion: boolean;
  /** Timed states auto-advance after a duration in [min, max] seconds. */
  duration: [number, number] | null;
  /** Minimum dwell when traversed as an intermediate step of a path. */
  passThrough: number;
  /** Whether a new brain request may cut this state short. */
  interruptible: boolean;
  /** Default follow-up when a timed state ends without anything queued. */
  next: CatState | 'RETURN' | null;
}

function m(posture: Posture, opts: Partial<StateMeta> = {}): StateMeta {
  return { posture, locomotion: false, duration: null, passThrough: 0.4, interruptible: true, next: null, ...opts };
}

export const STATE_META: Record<CatState, StateMeta> = {
  CURLED_SLEEP: m('sleep', { passThrough: 1.2 }),
  SPRAWLED_SLEEP: m('sleep', { passThrough: 1.0 }),
  WAKE_ARCH_STRETCH: m('stand', { duration: [2.0, 2.6], interruptible: false, next: 'BIG_YAWN' }),
  BIG_YAWN: m('sit', { duration: [1.3, 1.7], interruptible: false, next: 'IDLE_SIT' }),
  IDLE_SIT: m('sit', { passThrough: 0.45 }),
  CAT_LOAF: m('lie', { passThrough: 0.6 }),
  SPHINX_POSE: m('lie', { passThrough: 0.5 }),
  DANGLE_PAWS: m('lie'),
  GROOM_LICK_PAW: m('sit', { duration: [2.5, 4.5], next: 'IDLE_SIT' }),
  GROOM_WASH_FACE: m('sit', { duration: [2.5, 4.5], next: 'IDLE_SIT' }),
  GROOM_BACK_LEG: m('sit', { duration: [3, 5.5], next: 'IDLE_SIT' }),
  SCRATCH_EAR_HIND_LEG: m('sit', { duration: [1.2, 2.2], next: 'IDLE_SIT' }),
  SAUNTER_WALK: m('stand', { locomotion: true, passThrough: 0.2 }),
  TROT: m('stand', { locomotion: true, passThrough: 0.2 }),
  ZOOMIES_SPRINT: m('stand', { locomotion: true, passThrough: 0.2 }),
  CROUCH_PREP_JUMP: m('stand', { duration: [0.4, 0.6], interruptible: false, next: 'IDLE_STAND', passThrough: 0.35 }),
  JUMP_ASCEND: m('air', { interruptible: false }),
  FALL_DESCEND: m('air', { interruptible: false }),
  LAND_RECOVERY: m('stand', { duration: [0.3, 0.42], interruptible: false, next: 'IDLE_STAND' }),
  WALL_CLIMB: m('wall', { locomotion: true, interruptible: false }),
  CURSOR_GAZE: m('sit'),
  STALK_CURSOR: m('stand', { locomotion: true }),
  POUNCE_AND_PIN: m('stand', { duration: [1.2, 1.6], interruptible: false, next: 'IDLE_STAND' }),
  KEYBOARD_WATCH: m('sit'),
  PURRING: m('sit'),
  KNEADING_BISCUITS: m('sit'),
  BELLY_UP_ROLL: m('lie'),
  BUNNY_KICK_SWAT: m('lie', { duration: [1.2, 2.0], next: 'BELLY_UP_ROLL' }),
  IDLE_STAND: m('stand', { passThrough: 0.25 }),
  TAIL_LASH: m('stand', { duration: [1.4, 2.2], interruptible: false, next: 'IDLE_STAND' }),
  STARTLED_AIRBORNE: m('air', { interruptible: false }),
  EDGE_PEEK: m('stand'),
  EAT_TREAT: m('stand', { duration: [2.4, 3.2], interruptible: false, next: 'IDLE_SIT' }),
  ELEVATOR_BUTT: m('stand'),
  PAW_TUCK: m('sit', { duration: [0.9, 1.2], next: 'RETURN' }),
  NOSE_BOOP_GREETING: m('stand', { duration: [1.5, 1.9], interruptible: false, next: 'IDLE_STAND' }),
  ALLOGROOMING: m('sit'),
  ALLOGROOM_RECEIVE: m('lie'),
  YIN_YANG_CUDDLE_SLEEP: m('sleep', { passThrough: 1.0 }),
  PLAY_TAG_CHASE: m('stand', { locomotion: true }),
  PLAY_WRESTLE: m('lie'),
  JEALOUSY_INTERVENTION: m('stand', { locomotion: true }),
  CHIN_PROP_SLEEP: m('sleep', { passThrough: 1.0 }),
  MELTED_LOAF_SLEEP: m('sleep', { passThrough: 1.0 }),
  TANDEM_BELLY_HOLD_SLEEP: m('sleep', { passThrough: 1.0 }),
  PILLOW_STACK_CUDDLE: m('sleep', { passThrough: 1.0 }),
  LEDGE_CHIN_REST: m('lie'),
  WIDE_PAW_SPLAY: m('lie'),
  JUDGMENTAL_AIRPLANE_SQUINT: m('react', { duration: [2.4, 3.2], interruptible: false, next: 'RETURN' }),
  SCRUFF_HELD: m('held', { interruptible: false }),
  SEEKING_FOOD: m('stand', { locomotion: true, passThrough: 0.2 }),
  EATING: m('stand', { passThrough: 0.5 }),
  SEEKING_WATER: m('stand', { locomotion: true, passThrough: 0.2 }),
  DRINKING: m('stand', { passThrough: 0.5 }),
  EMPTY_BOWL_WAIT: m('sit', { passThrough: 0.5 }),
  CUDDLE_SLEEP: m('sleep', { passThrough: 1.0 }),
  // Rears up against the post and drags its claws down the sisal for 3–5 s.
  SCRATCH_POST: m('stand', { duration: [3, 5], next: 'IDLE_STAND', passThrough: 0.3 }),
};

const SLEEPS: CatState[] = [...SLEEP_STATES];

/** Voluntary, biologically plausible transitions. */
export const TRANSITIONS: Record<CatState, readonly CatState[]> = {
  CURLED_SLEEP: ['SPRAWLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT', 'YIN_YANG_CUDDLE_SLEEP', 'PILLOW_STACK_CUDDLE', 'CUDDLE_SLEEP'],
  SPRAWLED_SLEEP: ['WAKE_ARCH_STRETCH', 'CURLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT', 'TANDEM_BELLY_HOLD_SLEEP'],
  CHIN_PROP_SLEEP: ['WAKE_ARCH_STRETCH', 'SPRAWLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  MELTED_LOAF_SLEEP: ['WAKE_ARCH_STRETCH', 'CURLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  TANDEM_BELLY_HOLD_SLEEP: ['WAKE_ARCH_STRETCH', 'SPRAWLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  PILLOW_STACK_CUDDLE: ['WAKE_ARCH_STRETCH', 'CURLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  YIN_YANG_CUDDLE_SLEEP: ['CURLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  // Wakes straight into the stretch → yawn chain (the idle wake-up greeting).
  CUDDLE_SLEEP: ['WAKE_ARCH_STRETCH', 'CURLED_SLEEP', 'JUDGMENTAL_AIRPLANE_SQUINT'],
  // The squint only leads back to sleep (or into the normal wake-up stretch). Returning to an
  // awake resting state it came from is handled by FelineFSM's RETURN mechanism, so the planner
  // can never use the squint as a shortcut that skips the stretch-and-yawn wake chain.
  JUDGMENTAL_AIRPLANE_SQUINT: [...SLEEPS, 'WAKE_ARCH_STRETCH'],
  WAKE_ARCH_STRETCH: ['BIG_YAWN'],
  BIG_YAWN: ['IDLE_SIT'],
  IDLE_SIT: [
    'IDLE_STAND',
    'CAT_LOAF',
    'SPHINX_POSE',
    'BIG_YAWN',
    'GROOM_LICK_PAW',
    'GROOM_WASH_FACE',
    'GROOM_BACK_LEG',
    'SCRATCH_EAR_HIND_LEG',
    'CURSOR_GAZE',
    'KEYBOARD_WATCH',
    'PURRING',
    'KNEADING_BISCUITS',
    'TAIL_LASH',
    'PAW_TUCK',
    'ALLOGROOMING',
    'ALLOGROOM_RECEIVE',
    'JUDGMENTAL_AIRPLANE_SQUINT',
    'EMPTY_BOWL_WAIT',
  ],
  IDLE_STAND: [
    'IDLE_SIT',
    // A good long stretch is welcome any time a cat is up and about (Alex's favourite).
    'WAKE_ARCH_STRETCH',
    'SAUNTER_WALK',
    'TROT',
    'ZOOMIES_SPRINT',
    'STALK_CURSOR',
    'CROUCH_PREP_JUMP',
    'TAIL_LASH',
    'ELEVATOR_BUTT',
    'NOSE_BOOP_GREETING',
    'EAT_TREAT',
    'JEALOUSY_INTERVENTION',
    'PLAY_TAG_CHASE',
    'PLAY_WRESTLE',
    'EDGE_PEEK',
    'WALL_CLIMB',
    'CAT_LOAF',
    'SPHINX_POSE',
    'KNEADING_BISCUITS',
    'SEEKING_FOOD',
    'SEEKING_WATER',
    'EATING',
    'DRINKING',
    'SCRATCH_POST',
  ],
  CAT_LOAF: [
    'IDLE_SIT',
    'IDLE_STAND',
    'SPHINX_POSE',
    'CURLED_SLEEP',
    'MELTED_LOAF_SLEEP',
    'PURRING',
    'KNEADING_BISCUITS',
    'PAW_TUCK',
    'ALLOGROOM_RECEIVE',
    'YIN_YANG_CUDDLE_SLEEP',
    'PILLOW_STACK_CUDDLE',
    'CUDDLE_SLEEP',
    'DANGLE_PAWS',
    'LEDGE_CHIN_REST',
    'TAIL_LASH',
    'JUDGMENTAL_AIRPLANE_SQUINT',
  ],
  SPHINX_POSE: [
    'IDLE_SIT',
    'IDLE_STAND',
    'CAT_LOAF',
    'DANGLE_PAWS',
    'LEDGE_CHIN_REST',
    'WIDE_PAW_SPLAY',
    'BELLY_UP_ROLL',
    'SPRAWLED_SLEEP',
    'CHIN_PROP_SLEEP',
    'PAW_TUCK',
    'TANDEM_BELLY_HOLD_SLEEP',
    'PILLOW_STACK_CUDDLE',
    'JUDGMENTAL_AIRPLANE_SQUINT',
  ],
  DANGLE_PAWS: ['SPHINX_POSE', 'CAT_LOAF', 'LEDGE_CHIN_REST', 'WIDE_PAW_SPLAY'],
  LEDGE_CHIN_REST: ['SPHINX_POSE', 'CHIN_PROP_SLEEP', 'DANGLE_PAWS', 'WIDE_PAW_SPLAY', 'CAT_LOAF'],
  WIDE_PAW_SPLAY: ['SPHINX_POSE', 'CHIN_PROP_SLEEP', 'SPRAWLED_SLEEP', 'LEDGE_CHIN_REST'],
  GROOM_LICK_PAW: ['IDLE_SIT', 'GROOM_WASH_FACE'],
  GROOM_WASH_FACE: ['IDLE_SIT', 'GROOM_LICK_PAW'],
  GROOM_BACK_LEG: ['IDLE_SIT'],
  SCRATCH_EAR_HIND_LEG: ['IDLE_SIT'],
  SAUNTER_WALK: ['IDLE_STAND', 'TROT', 'CROUCH_PREP_JUMP', 'STALK_CURSOR', 'NOSE_BOOP_GREETING', 'JEALOUSY_INTERVENTION'],
  TROT: ['IDLE_STAND', 'SAUNTER_WALK', 'ZOOMIES_SPRINT', 'CROUCH_PREP_JUMP', 'PLAY_TAG_CHASE'],
  ZOOMIES_SPRINT: ['TROT', 'IDLE_STAND', 'CROUCH_PREP_JUMP'],
  CROUCH_PREP_JUMP: ['JUMP_ASCEND', 'POUNCE_AND_PIN', 'IDLE_STAND'],
  JUMP_ASCEND: ['FALL_DESCEND', 'LAND_RECOVERY'],
  FALL_DESCEND: ['LAND_RECOVERY'],
  STARTLED_AIRBORNE: ['FALL_DESCEND', 'LAND_RECOVERY'],
  LAND_RECOVERY: ['IDLE_STAND', 'SAUNTER_WALK', 'TROT', 'ZOOMIES_SPRINT', 'CROUCH_PREP_JUMP', 'PLAY_TAG_CHASE', 'STALK_CURSOR'],
  WALL_CLIMB: ['EDGE_PEEK', 'JUMP_ASCEND', 'FALL_DESCEND'],
  EDGE_PEEK: ['IDLE_STAND', 'WALL_CLIMB', 'FALL_DESCEND'],
  CURSOR_GAZE: ['IDLE_SIT', 'KEYBOARD_WATCH'],
  STALK_CURSOR: ['CROUCH_PREP_JUMP', 'IDLE_STAND', 'SAUNTER_WALK'],
  POUNCE_AND_PIN: ['IDLE_STAND'],
  KEYBOARD_WATCH: ['IDLE_SIT', 'CURSOR_GAZE'],
  PURRING: ['IDLE_SIT', 'CAT_LOAF', 'KNEADING_BISCUITS', 'BELLY_UP_ROLL'],
  KNEADING_BISCUITS: ['PURRING', 'IDLE_SIT', 'CAT_LOAF', 'IDLE_STAND'],
  BELLY_UP_ROLL: ['BUNNY_KICK_SWAT', 'SPHINX_POSE', 'CAT_LOAF', 'SPRAWLED_SLEEP', 'PURRING'],
  BUNNY_KICK_SWAT: ['BELLY_UP_ROLL', 'IDLE_STAND', 'SPHINX_POSE'],
  TAIL_LASH: ['IDLE_STAND', 'IDLE_SIT', 'CAT_LOAF'],
  ELEVATOR_BUTT: ['IDLE_STAND'],
  PAW_TUCK: ['IDLE_SIT', 'CAT_LOAF', 'SPHINX_POSE'],
  EAT_TREAT: ['IDLE_STAND', 'IDLE_SIT'],
  NOSE_BOOP_GREETING: ['IDLE_STAND', 'IDLE_SIT', 'PLAY_TAG_CHASE', 'SAUNTER_WALK'],
  ALLOGROOMING: ['IDLE_SIT', 'CAT_LOAF'],
  ALLOGROOM_RECEIVE: ['IDLE_SIT', 'CAT_LOAF', 'PURRING'],
  PLAY_TAG_CHASE: ['IDLE_STAND', 'TROT', 'CROUCH_PREP_JUMP', 'PLAY_WRESTLE', 'ZOOMIES_SPRINT'],
  PLAY_WRESTLE: ['IDLE_STAND', 'BELLY_UP_ROLL', 'PLAY_TAG_CHASE'],
  JEALOUSY_INTERVENTION: ['IDLE_STAND', 'IDLE_SIT'],
  // Never entered voluntarily (see isPhysicsInterrupt).
  SCRUFF_HELD: [],
  SEEKING_FOOD: ['IDLE_STAND', 'SAUNTER_WALK', 'TROT', 'CROUCH_PREP_JUMP', 'EATING'],
  SEEKING_WATER: ['IDLE_STAND', 'SAUNTER_WALK', 'TROT', 'CROUCH_PREP_JUMP', 'DRINKING'],
  EATING: ['IDLE_STAND', 'IDLE_SIT'],
  DRINKING: ['IDLE_STAND', 'IDLE_SIT'],
  EMPTY_BOWL_WAIT: ['IDLE_SIT', 'IDLE_STAND', 'CURSOR_GAZE'],
  SCRATCH_POST: ['IDLE_STAND', 'IDLE_SIT', 'WAKE_ARCH_STRETCH'],
};

/** Involuntary, physics-driven edges (startles, falls, landings). */
export function isPhysicsInterrupt(from: CatState, to: CatState): boolean {
  const posture = STATE_META[from].posture;
  // A hand can scoop a cat out of anything; letting go means falling (or landing at once).
  if (to === 'SCRUFF_HELD') return from !== 'SCRUFF_HELD';
  if (from === 'SCRUFF_HELD') return to === 'FALL_DESCEND' || to === 'LAND_RECOVERY' || to === 'STARTLED_AIRBORNE';
  if (to === 'STARTLED_AIRBORNE') return posture !== 'air' || from === 'JUMP_ASCEND';
  // Awake cats (standing, sitting or lying) can step / hop off a ledge; sleepers startle instead.
  if (to === 'FALL_DESCEND') return posture === 'stand' || posture === 'sit' || posture === 'lie' || posture === 'wall' || from === 'JUMP_ASCEND' || from === 'STARTLED_AIRBORNE' || from === 'EDGE_PEEK';
  if (to === 'LAND_RECOVERY') return AIRBORNE_STATES.has(from);
  if (to === 'JUMP_ASCEND') return from === 'CROUCH_PREP_JUMP' || from === 'WALL_CLIMB';
  return false;
}

export function canTransition(from: CatState, to: CatState): boolean {
  return from === to || TRANSITIONS[from].includes(to) || isPhysicsInterrupt(from, to);
}

/** next-hop table: NEXT[from][to] = first step on a shortest voluntary path. */
const NEXT: Map<CatState, Map<CatState, CatState>> = (() => {
  const table = new Map<CatState, Map<CatState, CatState>>();
  for (const src of ALL_STATES) {
    const firstStep = new Map<CatState, CatState>();
    const seen = new Set<CatState>([src]);
    const queue: Array<[CatState, CatState]> = [];
    for (const n of TRANSITIONS[src]) {
      if (!seen.has(n)) {
        seen.add(n);
        firstStep.set(n, n);
        queue.push([n, n]);
      }
    }
    while (queue.length) {
      const [node, first] = queue.shift() as [CatState, CatState];
      for (const n of TRANSITIONS[node]) {
        if (seen.has(n)) continue;
        seen.add(n);
        firstStep.set(n, first);
        queue.push([n, first]);
      }
    }
    table.set(src, firstStep);
  }
  return table;
})();

/** Shortest natural chain from → to (inclusive), or null if unreachable. */
export function findPath(from: CatState, to: CatState): CatState[] | null {
  if (from === to) return [from];
  const path: CatState[] = [from];
  let cur = from;
  for (let guard = 0; guard < 24; guard++) {
    const step = NEXT.get(cur)?.get(to);
    if (!step) return null;
    path.push(step);
    if (step === to) return path;
    cur = step;
  }
  return null;
}

export function isSleep(s: CatState): boolean {
  return SLEEP_STATES.has(s);
}

export function isAirborne(s: CatState): boolean {
  return AIRBORNE_STATES.has(s);
}

export function isGrounded(s: CatState): boolean {
  const p = STATE_META[s].posture;
  return p !== 'air' && p !== 'wall' && p !== 'held';
}

export function isHeld(s: CatState): boolean {
  return STATE_META[s].posture === 'held';
}

export function isLying(s: CatState): boolean {
  const p = STATE_META[s].posture;
  return p === 'lie' || p === 'sleep';
}

export function isSitting(s: CatState): boolean {
  return STATE_META[s].posture === 'sit';
}

/** Restorable from a snapshot without a chain (transient states collapse to a calm neighbour). */
export function restorableState(s: CatState): CatState {
  const meta = STATE_META[s];
  if (meta.posture === 'air' || meta.posture === 'wall' || meta.posture === 'held' || s === 'EDGE_PEEK') return 'IDLE_STAND';
  if (s === 'EATING' || s === 'DRINKING') return 'IDLE_STAND';
  if (s === 'EMPTY_BOWL_WAIT') return 'IDLE_SIT';
  if (meta.duration) {
    if (meta.posture === 'sit') return 'IDLE_SIT';
    if (meta.posture === 'lie') return 'CAT_LOAF';
    if (meta.posture === 'react') return 'CURLED_SLEEP';
    return 'IDLE_STAND';
  }
  if (meta.locomotion) return 'IDLE_STAND';
  return s;
}

/**
 * Static, settled postures in which a cat's tail lies completely still (v3):
 * sitting, loafing, watching the cursor or the keyboard, resting on a ledge and
 * every kind of sleep. Annoyed or playful states (TAIL_LASH, the judgmental
 * squint, belly-up kicks, grooming…) keep their tail motion.
 */
export const TAIL_STILL_STATES: ReadonlySet<CatState> = new Set<CatState>([
  'IDLE_SIT',
  'CAT_LOAF',
  'SPHINX_POSE',
  'DANGLE_PAWS',
  'CURSOR_GAZE',
  'KEYBOARD_WATCH',
  'PURRING',
  'LEDGE_CHIN_REST',
  'WIDE_PAW_SPLAY',
  'EMPTY_BOWL_WAIT',
  'ALLOGROOM_RECEIVE',
  ...SLEEP_STATES,
]);

export function isTailStill(s: CatState): boolean {
  return TAIL_STILL_STATES.has(s);
}
