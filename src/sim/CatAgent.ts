/**
 * CatAgent — one living cat.
 *
 *   drives ─► UtilityBrain ─► intent ─► plan (tasks) ─► Navigator / FSM requests
 *                                                    │
 *   physics (ground-following, jumps, falls, climbing) ◄┘
 *                                                    │
 *   FelineFSM state ─► PoseLibrary ─► blended Pose + expressions ─► renderer
 *                                         └► Verlet tail (world space)
 *
 * Petting, pokes, toys and social directives feed back into drives and plans.
 *
 * v2: a cat can be picked up by the scruff (SCRUFF_HELD: the nape is pinned to
 * the cursor and the body hangs below it as a damped pendulum), thrown, and it
 * walks to the food & water station when hungry or thirsty.
 *
 * v3: toys are hunted with a `chase` task that stalks, pounces and — for things
 * in the air (a dangling string, a laser dot on the wall, a ball in flight) —
 * leaps straight up, always turning to face the target first (no backward
 * leaps). Cats nap in their own named bed, keep their personal space (they
 * nudge apart instead of overlapping), avoid mirroring each other's actions,
 * hold their tails completely still while sitting or resting, and can wander
 * off to visit another tab.
 */
import type { CatState } from '../shared/catStates';
import { clamp, clamp01, dist, matApply, noise1, smoothstep, type Vec2 } from '../shared/math';
import { Rng, hashString } from '../shared/rng';
import type { BowlKind, CatProfile, CatRuntimeSnapshot, Drives } from '../shared/types';
import { FelineFSM } from '../ai/FelineFSM';
import { STATE_META, isAirborne, isLying, isSitting, isSleep, isTailStill } from '../ai/States';
import { EMPTY_BOWL, UtilityBrain, type BrainContext, type IntentKind } from '../ai/UtilityBrain';
import { BEG_LEVEL, HUNGER_SEEK, THIRST_SEEK, WAKE_SCRATCH_SPIKE, completeDrives, defaultDrives, driftDrives, updateDrives } from '../ai/Drives';
import { ZONE_EFFECTS, type PetZone } from '../ai/HitboxZones';
import { ArticulatedCatRenderer, type Landmarks, type Skeleton } from '../engine/ArticulatedCatRenderer';
import { SpriteRenderer } from '../engine/SpriteRenderer';
import { DEFAULT_POSE_CONTEXT, GAITS, canLook, computePose, type PoseContext } from '../engine/PoseLibrary';
import { PoseSpring, clonePose, makePose, type Pose } from '../engine/Pose';
import { VerletTail, type TailParams } from '../engine/VerletTail';
import { LEAP_REACH, MAX_LEAP_UP, clampThrow, findLanding, isScrollViolent, pendulumStep, planLeap, platformBelow, platformWidth, solveJump, trajectoryAt, applyFriction, fallStep, type JumpPlan, type PendulumState, type Platform, type PlatformSource, type WorldBounds } from '../engine/Physics';
import { planRoute, type NavJump, type NavPlan } from '../engine/Navigator';
import type { ParticleSystem } from '../engine/Particles';
import type { AnyCtx } from '../engine/canvas';
import type { Toy, ToyManager } from '../content/ToyManager';
import type { StationModel } from './FeedingStation';
import { mouseBody } from './MouseToy';
import { blockedSpan, clampWalk, pointInZone, rectsIntersect, safeFloorX, type NoGoRect } from './ExclusionZone';
import { wandTip } from './FeatherWand';
import { BED_LIFT, type BedsModel } from './CatBeds';
import { TOWER_TIER1, TOWER_TOP, batPom, isTowerPlatform, type TowerModel } from './CatTower';
import { ANNA_ID } from '../shared/presets';

export type Gait = 'SAUNTER_WALK' | 'TROT' | 'ZOOMIES_SPRINT' | 'STALK_CURSOR' | 'PLAY_TAG_CHASE' | 'JEALOUSY_INTERVENTION' | 'SEEKING_FOOD' | 'SEEKING_WATER';

export interface Spot {
  platformId: string;
  x: number;
}

export type Task =
  | { kind: 'goto'; spot: Spot | (() => Spot | null); gait: Gait; face?: 1 | -1; tol?: number; offscreen?: boolean; maxTime?: number }
  | { kind: 'state'; state: CatState; dur: number; face?: 1 | -1 | (() => 1 | -1 | 0); role?: 0 | 1 }
  | { kind: 'climb'; side: 1 | -1; height: number; cling: number }
  /** Stalk to within `range` (default 68 px·S), wiggle for `wiggle` s (default a long butt wiggle), then lunge forward. */
  | { kind: 'pounce'; target: () => Vec2 | null; onPin?: () => void; range?: number; wiggle?: number }
  | { kind: 'eat'; toy: Toy }
  | { kind: 'meal'; bowl: BowlKind }
  | { kind: 'beg'; bowl: BowlKind; dur: number }
  | { kind: 'wait'; until: () => boolean; maxTime: number; face?: () => 1 | -1 }
  | { kind: 'do'; fn: () => void }
  /** Hunt a toy until `until` (env seconds): stalk, pounce, or leap at it when it is in the air. */
  | { kind: 'chase'; toy: Toy; until: number }
  /** A vertical pounce at something in the air: turn to face it, crouch, spring up, swat at the apex. */
  | { kind: 'leap'; target: () => Vec2 | null; onSwat?: (paw: Vec2) => void };

export interface CursorInfo {
  x: number;
  y: number;
  present: boolean;
  speed: number;
  erratic: number;
  idle: number;
  down: boolean;
}

export interface TypingInfo {
  platformId: string;
  xMin: number;
  xMax: number;
  y: number;
  caret: Vec2;
  lastInput: number;
}

export interface SocialHooks {
  request(agent: CatAgent, env: AgentEnv, kind: IntentKind): boolean;
}

export interface AgentEnv {
  source: PlatformSource;
  platforms: Platform[];
  bounds: WorldBounds;
  /** seconds */
  now: number;
  cursor: CursorInfo;
  typing: TypingInfo | null;
  toys: ToyManager;
  particles: ParticleSystem;
  others: CatAgent[];
  catScale: number;
  calm: boolean;
  hour: number;
  social: SocialHooks;
  /** The food & water station (null when switched off). */
  station: StationModel | null;
  /** True while the user is away from the keyboard and mouse. */
  userIdle: boolean;
  /** The cats' personal beds (null when hidden). */
  beds?: BedsModel | null;
  /** Visiting other tabs (null when there are none / roaming is off). */
  wander?: WanderHooks | null;
  /** The box around the text field you are typing in (cats keep out), or null. */
  noGo?: NoGoRect | null;
  /** The vertical cat tree & scratching tower (null when switched off, v4). */
  tower?: TowerModel | null;
  /** The tower's dangling pom-pom as a play target (follows the ball; null when the tower is off). */
  pomToy?: Toy | null;
}

/** Lets a cat walk off the screen to visit another of the user's tabs. */
export interface WanderHooks {
  /** May this cat go roaming right now? */
  allowed(agent: CatAgent): boolean;
  /** The cat has walked off the screen edge on `side` (−1 left, +1 right). */
  leave(agent: CatAgent, side: 1 | -1): void;
}

/** A cat never starts what another cat started less than this long ago (anti-mirroring, s). */
const STAGGER_MIN_S = 2;

/** Fraction of the mean body length two cats keep between them (unless cuddling, grooming, playing…). */
export const PERSONAL_SPACE = 0.85;

export interface SocialLink {
  sessionId: number;
  role: 0 | 1;
  partner: CatAgent | null;
}

const BODY_LEN = 74;
/** How far (px at scale 1) a rearing cat's front paws reach ahead of its body at the sisal post (matches the SCRATCH_POST pose). */
const SCRATCH_REACH = 27;
/** Eating / drinking rates while at the bowl (per second). */
const MEAL = { eatNeed: 9, eatBowl: 1.4, drinkNeed: 11, drinkBowl: 1.3, full: 12, maxTime: 14 };
/** Seconds a cat waits by an empty bowl before giving up for a while, and how long that while is. */
export const BEG_TIME = 26;
export const BEG_COOLDOWN = 45;

interface HoldState extends PendulumState {
  /** Where the nape should be (the cursor). */
  tx: number;
  ty: number;
  /** Smoothed hand velocity (px/s). */
  vx: number;
  vy: number;
  /** Initial offset from the cursor to the nape, eased away so the cat never teleports. */
  offX: number;
  offY: number;
  t: number;
}

export class CatAgent {
  profile: CatProfile;
  readonly id: string;
  renderer: ArticulatedCatRenderer;
  sprite: SpriteRenderer | null = null;
  fsm: FelineFSM;
  brain: UtilityBrain;
  drives: Drives;
  readonly rng: Rng;
  readonly seed: number;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  flip = 1;
  groundId: string | null = 'floor';
  private jump: { plan: JumpPlan; t: number; targetId: string; fromId: string } | null = null;
  /** Set during a vertical pounce: what to swat at the top of the leap. */
  private leapSwat: { target: () => Vec2 | null; onSwat?: (paw: Vec2) => void; done: boolean } | null = null;
  /** −1..1 personal-space push from the social coordinator this frame (− = move left). */
  separation = 0;
  private crowdT = 0;
  /** How far the body is raised onto a bed's cushion (px, eased). */
  bedLift = 0;
  /** How far the body is sunk into the tower's cubby (px, eased): a cat curled up inside peeks out of the hole. */
  cubbyDrop = 0;
  private wasAsleep = false;
  /** The tower tier this cat is heading for to nap on (so the other cat picks the other one). */
  private towerTarget: string | null = null;
  /** Curled up inside the tower's cubby (below the roof it is standing on). */
  get inCubby(): boolean {
    return this.cubbyDrop > 8;
  }
  private scratchFxIn = 0;
  /** 0..1 tail stillness (eased toward 1 in seated / resting states). */
  tailStill = 0;
  /** When this cat last picked a new intent (for anti-mirroring). */
  intentAt = -999;
  /** A chase ended in a catch. */
  private chaseDone = false;
  /** Walked off the screen (migrating / roaming): stays exactly there, out of sight. */
  parked = false;
  /** Where this cat is walking to right now (other cats keep clear of it), and since when. */
  dest: { platformId: string; x: number; at: number } | null = null;
  private hungerCueIn = 6;
  private falling = false;
  private softFall = false;
  private climb: { side: 1 | -1; targetY: number; timer: number; phase: 'up' | 'cling' } | null = null;
  private desiredVX = 0;
  private slip = 0;

  pose: Pose;
  private skel: Skeleton | null = null;
  tail: VerletTail;
  gaitPhase = 0;
  lm: Landmarks | null = null;
  catScale = 1;

  plan: Task[] = [];
  planLabel = '';
  planLocked = false;
  private taskTime = 0;
  private taskEntered = false;
  private taskFlag = 0;
  private route: NavPlan | null = null;
  private hop = 0;
  private routeKey = '';
  private decideIn = 0.5;
  intent: IntentKind | null = null;

  lookTarget: Vec2 | null = null;
  private lookActive = 0;
  edgeAhead = Infinity;
  partnerTopY = NaN;
  poseRole: 0 | 1 = 0;

  petTime = 0;
  petZone: PetZone | null = null;
  private petZoneTime = 0;
  private lastPetAt = -10;
  private bellyVerdict: 'bliss' | 'kick' | null = null;
  private blinkT = -1;
  private readonly poseSpring = new PoseSpring();
  /** Non-null while a hand holds this cat by the scruff. */
  private held: HoldState | null = null;
  /** Set when the cat was dropped / thrown: it tidies its fur after landing. */
  private afterDrop = false;
  /** Slow eye blink as a sleeper wakes (seconds into the blink, −1 = none). */
  private slowBlinkT = -1;
  /** Until this time the tail is held up in a "question mark" (a friendly greeting). */
  private greetUntil = -1;
  /** When this cat last gave up asking for a refill. */
  lastBegEnd = -999;
  private begMeowIn = 0;
  /** Idle glance: a held gaze offset that makes an awake cat look around on its own. */
  private glance = { x: 0, y: 0, t: 0, next: 3 };
  private nextBlink = 3;
  private earTwitch = 0;
  private earTwitchSide: 1 | -1 = 1;
  private bliss = 0;
  private peekEye = 0;
  private purring = false;

  lastGroom = 0;
  lastZoomies = -999;
  lastClimb = -999;
  squintReadyAt = 0;
  private pawTuckReadyAt = 0;
  social: SocialLink | null = null;
  hovered = false;
  private now = 0;

  constructor(profile: CatProfile, x: number, y: number, facing: 1 | -1 = 1) {
    this.profile = profile;
    this.id = profile.id;
    this.seed = (hashString(profile.id) % 1000) / 1000;
    this.rng = new Rng(hashString(profile.id) ^ Date.now());
    this.renderer = new ArticulatedCatRenderer(profile);
    if (profile.renderMode === 'sprite' && profile.sprite) this.sprite = new SpriteRenderer(profile.sprite);
    this.fsm = new FelineFSM('IDLE_SIT', hashString(profile.id));
    this.brain = new UtilityBrain(hashString(profile.id) + 17);
    this.drives = defaultDrives(profile.personality, profile.traits);
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.flip = facing;
    this.pose = computePose('IDLE_SIT', DEFAULT_POSE_CONTEXT);
    this.tail = new VerletTail(6, 10.5 * profile.morphology.tailLength, x - facing * 30, y - 20, facing > 0 ? Math.PI : 0);
    this.fsm.onTransition((from, to) => this.onTransition(from, to));
  }

  /* ----------------------------------------------------------- profile */

  setProfile(profile: CatProfile): void {
    this.profile = profile;
    this.renderer.setProfile(profile);
    if (profile.renderMode === 'sprite' && profile.sprite) {
      if (this.sprite) this.sprite.setSheet(profile.sprite);
      else this.sprite = new SpriteRenderer(profile.sprite);
    } else this.sprite = null;
  }

  get S(): number {
    return this.profile.morphology.size * this.catScale;
  }

  bodyLen(): number {
    return BODY_LEN * this.S;
  }

  get state(): CatState {
    return this.fsm.current;
  }

  isAsleep(): boolean {
    return isSleep(this.fsm.current);
  }

  isAirborne(): boolean {
    return !!this.jump || this.falling || isAirborne(this.fsm.current);
  }

  /** True while held by the scruff. */
  isHeld(): boolean {
    return !!this.held;
  }

  isClimbing(): boolean {
    return !!this.climb;
  }

  isResting(): boolean {
    const p = STATE_META[this.fsm.current].posture;
    return p === 'sit' || p === 'lie';
  }

  isPetted(): boolean {
    return this.now - this.lastPetAt < 0.6;
  }

  availableForSocial(): boolean {
    return !this.social && !this.planLocked && !this.held && !this.isAirborne() && !this.climb && !this.isPetted() && this.groundId !== null;
  }

  currentPlatform(env: AgentEnv): Platform | null {
    if (!this.groundId) return null;
    // (A ledge taken out of play by a typing zone is still the one the cat stands on.)
    return env.platforms.find((p) => p.id === this.groundId) ?? (this.groundId === 'floor' ? env.source.floor() : env.source.get(this.groundId) ?? null);
  }

  /* --------------------------------------------------------------- plans */

  setPlan(tasks: Task[], label: string, locked = false): void {
    this.dest = null;
    this.parked = false;
    this.plan = tasks;
    this.planLabel = label;
    this.planLocked = locked;
    this.taskTime = 0;
    this.taskEntered = false;
    this.taskFlag = 0;
    this.route = null;
    this.decideIn = locked ? 9999 : this.rng.range(3, 5.5);
  }

  clearPlan(): void {
    this.dest = null;
    this.plan = [];
    this.planLocked = false;
    this.planLabel = '';
    this.route = null;
    this.decideIn = this.rng.range(0.4, 1.4);
  }

  private completeTask(): void {
    this.dest = null;
    this.plan.shift();
    this.taskTime = 0;
    this.taskEntered = false;
    this.taskFlag = 0;
    this.route = null;
    if (this.plan.length === 0) {
      this.planLocked = false;
      this.decideIn = Math.min(this.decideIn, this.rng.range(0.6, 2.2));
    }
  }

  /* ---------------------------------------------------------- transitions */

  private onTransition(from: CatState, to: CatState): void {
    if (to === 'GROOM_LICK_PAW' || to === 'GROOM_WASH_FACE' || to === 'GROOM_BACK_LEG') this.lastGroom = this.now;
    if (to === 'ZOOMIES_SPRINT') this.lastZoomies = this.now;
    if (to === 'WALL_CLIMB') this.lastClimb = this.now;
    if (to === 'CROUCH_PREP_JUMP') {
      const t = this.plan[0];
      const wiggle = t?.kind === 'pounce' ? t.wiggle : undefined;
      this.fsm.setDuration(this.taskFlag === 2 ? wiggle ?? this.rng.range(1.0, 1.6) : this.rng.range(0.26, 0.34) + 0.2);
    }
    void from;
  }

  /* -------------------------------------------------------------- update */

  /** The environment of the most recent frame (plan callbacks read live cursor / bounds from it). */
  liveEnv: AgentEnv | null = null;

  update(dt: number, env: AgentEnv): void {
    this.liveEnv = env;
    this.now = env.now;
    this.catScale = env.catScale;
    this.updateDrivesAndTimers(dt, env);

    if (this.held) {
      this.holdPhysics(dt, env);
      this.fsm.update(dt);
      this.animate(dt, env);
      return;
    }

    // Brain
    this.brain.tick(dt);
    this.decideIn -= dt;
    if (!this.planLocked && !this.isAirborne() && !this.climb && this.decideIn <= 0) this.think(env);

    this.desiredVX = 0;
    this.runTasks(dt, env);
    this.handleCrowding(dt, env);
    this.physics(dt, env);
    this.fsm.update(dt);
    this.animate(dt, env);
  }

  private updateDrivesAndTimers(dt: number, env: AgentEnv): void {
    const pettedNicely = this.isPetted() && this.petZone !== null && ZONE_EFFECTS[this.petZone].affection > 2;
    const partner = this.nearestOther(env);
    const tr = this.profile.traits;
    updateDrives(this.drives, this.fsm.current, dt, this.profile.personality, {
      social: !!this.social,
      pettedNicely,
      alone: !partner || dist(partner.x, partner.y, this.x, this.y) > 500,
      hungerRate: tr.hungerRateMultiplier,
      thirstRate: tr.thirstRateMultiplier,
      playTrait: tr.playfulness,
    });
    // Waking up from a nap: a good stretch at the scratching post is in order.
    const asleepNow = this.isAsleep();
    if (this.wasAsleep && !asleepNow && !this.held) this.drives.scratchUrge = Math.min(100, this.drives.scratchUrge + WAKE_SCRATCH_SPIKE);
    this.wasAsleep = asleepNow;
    this.scratchPost(dt, env);
    // Overstimulation: long petting sessions slowly wear thin, sooner for expressive cats.
    if (this.isPetted() && this.petTime > 10 + 14 * (1 - tr.earExpressiveness)) this.drives.irritation = Math.min(100, this.drives.irritation + dt * 2.2 * tr.earExpressiveness);
    if (this.slowBlinkT >= 0) {
      this.slowBlinkT += dt;
      if (this.slowBlinkT > 1.6) this.slowBlinkT = -1;
    }
    if (!this.isPetted()) {
      this.petTime = 0;
      this.petZoneTime = 0;
      this.bellyVerdict = null;
      this.bliss = Math.max(0, this.bliss - dt * 2.5);
      if (this.purring && this.fsm.current !== 'PURRING' && this.fsm.current !== 'KNEADING_BISCUITS' && !this.held && env.now > this.greetUntil) this.setPurr(env, false);
    }
    if (this.peekEye > 0) this.peekEye -= dt;
    if (this.earTwitch > 0) this.earTwitch -= dt;
    else if (this.rng.chance(dt * 0.18)) {
      this.earTwitch = 0.28;
      this.earTwitchSide = this.rng.chance(0.5) ? 1 : -1;
    }
    // Blink
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT > 0.21) this.blinkT = -1;
    } else {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) {
        this.blinkT = 0;
        // Cats blink rarely and slowly; now and then a quick double blink.
        this.nextBlink = this.rng.chance(0.18) ? 0.32 : this.rng.range(3, 9);
      }
    }
    // Idle glances.
    this.glance.next -= dt;
    if (this.glance.t > 0) this.glance.t -= dt;
    if (this.glance.next <= 0) {
      this.glance = { x: this.rng.range(-0.7, 0.8), y: this.rng.range(-0.45, 0.35), t: this.rng.range(0.7, 2.4), next: this.rng.range(3, 9) };
    }
    // Running low on food or water: a hungry cat keeps thinking about the bowl (until you refill it).
    this.hungerCueIn -= dt;
    if (this.hungerCueIn <= 0) {
      this.hungerCueIn = 4;
      const st = env.station;
      if (st?.enabled && !this.isAsleep() && this.lm && this.fsm.current !== 'EMPTY_BOWL_WAIT') {
        const hungry = this.drives.hunger > HUNGER_SEEK && st.low('food');
        const thirsty = this.drives.thirst > THIRST_SEEK && st.low('water');
        if (hungry || thirsty) {
          const food = hungry && (!thirsty || this.drives.hunger >= this.drives.thirst);
          env.particles.emit(food ? 'thoughtFood' : 'thoughtWater', this.lm.head.x + this.facing * 10 * this.S, this.lm.head.y - 26 * this.S, 1, this.S);
          this.drives.irritation = Math.min(100, this.drives.irritation + 1.5);
          this.hungerCueIn = this.rng.range(14, 24);
        }
      }
    }
    // Sleeping cats drift little z's.
    if (this.isAsleep() && this.rng.chance(dt * 0.35) && this.lm) env.particles.emit('z', this.lm.head.x + this.facing * 8 * this.S, this.lm.head.y - 12 * this.S, 1, this.S);
    if (this.purring && this.lm && this.rng.chance(dt * 1.4)) env.particles.emit('heart', this.lm.head.x, this.lm.head.y - 14 * this.S, 1, this.S);
  }

  /**
   * Raking the sisal: loose fibres fly off the claws, the post wears a little, the itch is gone
   * (`updateDrives` resets the urge) and the cat is visibly pleased with itself.
   */
  private scratchPost(dt: number, env: AgentEnv): void {
    if (this.fsm.current !== 'SCRATCH_POST') {
      this.scratchFxIn = 0;
      return;
    }
    const tw = env.tower;
    if (!tw?.enabled) return;
    tw.scratch(dt);
    this.drives.affection = Math.min(100, this.drives.affection + dt * 2.4);
    this.drives.irritation = Math.max(0, this.drives.irritation - dt * 3);
    this.scratchFxIn -= dt;
    if (this.scratchFxIn <= 0 && this.lm) {
      this.scratchFxIn = this.rng.range(0.1, 0.2);
      const paw = this.lm.paws[this.rng.chance(0.5) ? 0 : 1] ?? this.lm.paws[0];
      env.particles.emit('sisal', paw.x, paw.y, 1 + (this.rng.chance(0.4) ? 1 : 0), this.S);
    }
  }

  nearestOther(env: AgentEnv): CatAgent | null {
    let best: CatAgent | null = null;
    let bd = Infinity;
    for (const o of env.others) {
      if (o === this) continue;
      const d = dist(o.x, o.y, this.x, this.y);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- brain */

  private brainContext(env: AgentEnv): BrainContext {
    const partner = this.nearestOther(env);
    const toy = env.toys.nearest(this.x, this.y);
    const head = this.lm ? this.lm.head : { x: this.x, y: this.y - 50 * this.S };
    const c = env.cursor;
    const cursorDist = c.present ? dist(c.x, c.y, head.x, head.y) : Infinity;
    const plats = env.platforms;
    return {
      drives: this.drives,
      personality: this.profile.personality,
      signature: this.profile.signature,
      cursor: { present: c.present, dist: cursorDist, speed: c.speed, erratic: c.erratic, idle: c.idle },
      typing: { active: !!env.typing && env.now - env.typing.lastInput < 4, dist: env.typing ? dist(env.typing.caret.x, env.typing.caret.y, this.x, this.y) : Infinity },
      partner: {
        exists: !!partner,
        dist: partner ? dist(partner.x, partner.y, this.x, this.y) : Infinity,
        asleep: !!partner && partner.isAsleep(),
        available: !!partner && (partner.availableForSocial() || partner.isAsleep()) && !partner.social,
      },
      toy: { kind: toy ? toy.kind : null, dist: toy ? dist(toy.x, toy.y, this.x, this.y) : Infinity },
      warmSpot: plats.some((p) => p.warm > 0.8 && platformWidth(p) > this.bodyLen()),
      narrowLedge: plats.some((p) => p.narrow && platformWidth(p) > this.bodyLen() * 1.2),
      edgeSpot: plats.some((p) => p.kind === 'dom' && platformWidth(p) > this.bodyLen() * 1.3),
      timeSinceGroom: env.now - this.lastGroom,
      timeSinceZoomies: env.now - this.lastZoomies,
      timeSinceClimb: env.now - this.lastClimb,
      hour: env.hour,
      calm: env.calm,
      petted: this.isPetted(),
      traits: this.profile.traits,
      station: env.station?.enabled
        ? {
            exists: true,
            food: env.station.level('food'),
            water: env.station.level('water'),
            dist: Math.abs(env.station.centerX(env.bounds) - this.x),
            begReady: env.now - this.lastBegEnd > BEG_COOLDOWN,
          }
        : undefined,
      tower: env.tower?.enabled ? { exists: true, pomLive: !!env.tower.pom && env.tower.pom.sinceDisturbed < 12 } : undefined,
    };
  }

  think(env: AgentEnv): void {
    if (this.isPetted()) {
      this.decideIn = 1;
      return;
    }
    // While you are away the cats nap; the coordinator brings the bonded pair together.
    if (env.userIdle && !this.social) {
      if (!this.isAsleep() || this.plan.length === 0) this.makePlan('sleep', env);
      this.decideIn = this.rng.range(8, 14);
      return;
    }
    const decision = this.brain.decide(this.brainContext(env));
    this.decideIn = this.rng.range(3, 5.5);
    if (!decision.switched && this.plan.length > 0) return;
    // Don't abandon a nap the cat is already enjoying just to re-plan it.
    if (decision.intent === 'sleep' && this.isAsleep() && this.plan.length > 0) return;
    // Anti-mirroring: if a nearby cat just started the very same thing, wait a few seconds first.
    if (decision.switched && !this.social && this.mirrors(decision.intent, env)) {
      this.decideIn = this.rng.range(2, 5);
      return;
    }
    this.intent = decision.intent;
    this.intentAt = env.now;
    this.makePlan(decision.intent, env);
  }

  /** True when another cat picked the same intent less than two seconds ago. */
  private mirrors(intent: IntentKind, env: AgentEnv): boolean {
    return env.others.some((o) => o !== this && o.intent === intent && env.now - o.intentAt < STAGGER_MIN_S);
  }

  /** Forces an intent from outside (popup "call cats", studio state buttons…). */
  command(intent: IntentKind, env: AgentEnv): void {
    this.brain.set(intent);
    this.intent = intent;
    this.intentAt = env.now;
    this.makePlan(intent, env);
  }

  private pickPlatform(env: AgentEnv, score: (p: Platform) => number): Platform | null {
    const cands = env.platforms.filter((p) => platformWidth(p) > this.bodyLen() * 0.9);
    if (!cands.length) return null;
    const weights = cands.map((p) => Math.max(0, score(p)));
    if (weights.every((w) => w <= 0)) return null;
    return this.rng.weighted(cands, weights);
  }

  private spotOn(p: Platform, near?: number): Spot {
    const m = this.bodyLen() * 0.55;
    const lo = p.xMin + m;
    const hi = Math.max(lo, p.xMax - m);
    const x = near === undefined ? this.rng.range(lo, hi) : clamp(near, lo, hi);
    return { platformId: p.id, x };
  }

  private edgeSpotOn(p: Platform): { spot: Spot; face: 1 | -1 } {
    const right = this.rng.chance(0.5);
    const inset = 30 * this.S;
    return { spot: { platformId: p.id, x: right ? p.xMax - inset : p.xMin + inset }, face: right ? 1 : -1 };
  }

  makePlan(intent: IntentKind, env: AgentEnv): void {
    const here = this.currentPlatform(env) ?? env.source.floor();
    const S = this.S;
    const sig = this.profile.signature;
    const pers = this.profile.personality;
    const r = this.rng;
    switch (intent) {
      case 'sleep': {
        const partner = this.nearestOther(env);
        if (partner && partner.isAsleep() && r.chance(0.35 + 0.6 * pers.sociability) && env.social.request(this, env, 'sleep')) return;
        // The cat tower is the nap spot when the floor beds are hidden (and an elevated favourite when they are not).
        if (env.tower?.enabled && r.chance(!env.beds ? 1 : this.profile.presetKey === ANNA_ID ? 0.5 : 0.28) && this.planTowerBed('sleep', env)) return;
        // Its very own bed is the favourite place for a nap.
        const bed = env.beds?.spotFor(this.id, env.bounds) ?? null;
        if (bed && r.chance(0.78)) {
          const curl: CatState = r.chance(0.8 - 0.3 * this.profile.traits.sprawlLover) ? 'CURLED_SLEEP' : 'SPRAWLED_SLEEP';
          this.setPlan(
            [
              { kind: 'goto', spot: () => ({ platformId: 'floor', x: (this.liveEnv ?? env).beds?.spotFor(this.id, (this.liveEnv ?? env).bounds)?.x ?? bed.x }), gait: 'SAUNTER_WALK', tol: 5 * S, maxTime: 40, face: r.chance(0.5) ? 1 : -1 },
              { kind: 'state', state: curl, dur: r.range(60, 160) },
            ],
            'sleep-bed',
          );
          return;
        }
        let p: Platform | null = null;
        // Sprawlers (Alex) stretch right out; others mostly curl into a ball.
        let state: CatState = r.chance(0.3 + 0.5 * this.profile.traits.sprawlLover) ? 'SPRAWLED_SLEEP' : 'CURLED_SLEEP';
        let face: 1 | -1 | undefined;
        let spot: Spot | null = null;
        if (sig.meltedLoafSleep && r.chance(0.8)) {
          p = this.pickPlatform(env, (pl) => (pl.narrow ? 3 : pl.kind === 'dom' ? 0.6 : 0.15));
          if (p) state = p.narrow || p.kind === 'dom' ? 'MELTED_LOAF_SLEEP' : state;
        } else if (sig.chinPropSleep && r.chance(0.75)) {
          p = this.pickPlatform(env, (pl) => (pl.kind === 'dom' ? 2 : 0.4));
          if (p) {
            const e = this.edgeSpotOn(p);
            spot = e.spot;
            face = e.face;
            state = 'CHIN_PROP_SLEEP';
          }
        }
        if (!p) p = this.pickPlatform(env, (pl) => 0.4 + pl.warm * 2.5 * pers.laziness + (pl.id === here.id ? 1.2 : 0));
        if (!p) p = here;
        const napSpot = spot ?? this.spotOn(p, p.id === here.id ? this.x : undefined);
        // Never in someone else's bed.
        if (napSpot.platformId === 'floor') napSpot.x = this.offOthersBeds(napSpot.x, env);
        this.setPlan(
          [
            { kind: 'goto', spot: napSpot, gait: 'SAUNTER_WALK', face },
            ...(state === 'CHIN_PROP_SLEEP' ? [{ kind: 'state', state: 'LEDGE_CHIN_REST', dur: r.range(3, 7) } as Task] : []),
            { kind: 'state', state, dur: r.range(45, 140) },
          ],
          'sleep',
        );
        return;
      }
      case 'rest': {
        if (env.tower?.enabled && r.chance(!env.beds ? 0.55 : this.profile.presetKey === ANNA_ID ? 0.25 : 0.12) && this.planTowerBed('rest', env)) return;
        const bed = env.beds?.spotFor(this.id, env.bounds) ?? null;
        if (bed && r.chance(0.18 + 0.2 * pers.laziness)) {
          this.setPlan(
            [
              { kind: 'goto', spot: { platformId: 'floor', x: bed.x }, gait: 'SAUNTER_WALK', tol: 5 * S, maxTime: 30 },
              { kind: 'state', state: r.weighted<CatState>(['CAT_LOAF', 'IDLE_SIT', 'SPHINX_POSE'], [2, 1, 1]), dur: r.range(10, 24) },
            ],
            'rest-bed',
          );
          return;
        }
        const stay = r.chance(0.6);
        const p = stay ? here : this.pickPlatform(env, (pl) => 1 / (1 + dist(pl.xMin, pl.y, this.x, this.y) / 400)) ?? here;
        const elevated = p.kind === 'dom';
        let state: CatState = r.weighted<CatState>(['IDLE_SIT', 'CAT_LOAF', 'SPHINX_POSE'], [1, 1 + pers.laziness, 0.8]);
        let spot = this.spotOn(p, stay ? this.x : undefined);
        if (spot.platformId === 'floor') spot.x = this.offOthersBeds(spot.x, env);
        let face: 1 | -1 | undefined;
        if (elevated && r.chance(0.45)) {
          const e = this.edgeSpotOn(p);
          spot = e.spot;
          face = e.face;
          state = sig.widePawSplay && r.chance(0.5) ? 'WIDE_PAW_SPLAY' : r.weighted<CatState>(['DANGLE_PAWS', 'LEDGE_CHIN_REST'], [1, sig.chinPropSleep ? 2 : 0.8]);
        }
        // A good long front-paw stretch before settling down.
        const stretch: Task[] = r.chance(0.35 * this.profile.traits.sprawlLover) ? [{ kind: 'state', state: 'WAKE_ARCH_STRETCH', dur: 99 }] : [];
        this.setPlan([{ kind: 'goto', spot, gait: 'SAUNTER_WALK', face }, ...stretch, { kind: 'state', state, dur: r.range(8, 22) }], 'rest');
        return;
      }
      case 'eat':
      case 'drink': {
        if (!this.planMeal(intent === 'eat' ? 'food' : 'water', env)) this.makePlan('rest', env);
        return;
      }
      case 'perch': {
        const p = this.pickPlatform(env, (pl) => (pl.kind === 'dom' ? (1 + (pl.narrow ? (sig.meltedLoafSleep ? 2 : 0.5) : 0) + (1 - pl.y / env.bounds.height)) * this.towerPref(pl.id) : 0)) ?? here;
        const e = this.edgeSpotOn(p);
        const atEdge = p.kind === 'dom' && r.chance(0.5);
        this.setPlan(
          [
            { kind: 'goto', spot: atEdge ? e.spot : this.spotOn(p), gait: this.drives.energy > 55 ? 'TROT' : 'SAUNTER_WALK', face: atEdge ? e.face : undefined },
            { kind: 'state', state: atEdge ? 'DANGLE_PAWS' : r.pick<CatState>(['IDLE_SIT', 'CAT_LOAF', 'SPHINX_POSE']), dur: r.range(10, 24) },
          ],
          'perch',
        );
        return;
      }
      case 'groom': {
        const seq: Task[] = r.weighted<Task[]>(
          [
            [
              { kind: 'state', state: 'GROOM_LICK_PAW', dur: 99 },
              { kind: 'state', state: 'GROOM_WASH_FACE', dur: 99 },
            ],
            [{ kind: 'state', state: 'GROOM_BACK_LEG', dur: 99 }],
            [{ kind: 'state', state: 'SCRATCH_EAR_HIND_LEG', dur: 99 }],
          ],
          [3, 1.5, 1],
        );
        this.setPlan([...seq, { kind: 'state', state: 'IDLE_SIT', dur: r.range(2, 5) }], 'groom');
        return;
      }
      case 'explore': {
        // Now and then a curious cat wanders off the screen to visit another of your tabs.
        if (env.wander?.allowed(this) && r.chance(0.12)) {
          const side: 1 | -1 = this.x > env.bounds.width / 2 ? 1 : -1;
          this.exitTo(side, env, () => env.wander?.leave(this, side), 'roam');
          return;
        }
        const p = this.pickPlatform(env, (pl) => (pl.id === here.id ? 0.6 : 1) * (0.5 + platformWidth(pl) / env.bounds.width));
        const target = p ?? here;
        this.setPlan(
          [
            { kind: 'goto', spot: this.spotOn(target), gait: this.drives.energy > 60 && r.chance(0.5) ? 'TROT' : 'SAUNTER_WALK' },
            { kind: 'state', state: r.chance(0.5) ? 'IDLE_STAND' : 'IDLE_SIT', dur: r.range(1.5, 4) },
          ],
          'explore',
        );
        return;
      }
      case 'zoomies': {
        const p = platformWidth(here) > 320 * S ? here : env.source.floor();
        const m = this.bodyLen() * 0.6;
        const a = { platformId: p.id, x: p.xMin + m };
        const b = { platformId: p.id, x: p.xMax - m };
        const first = Math.abs(this.x - a.x) > Math.abs(this.x - b.x) ? a : b;
        const second = first === a ? b : a;
        this.setPlan(
          [
            { kind: 'goto', spot: first, gait: 'ZOOMIES_SPRINT', tol: 10 },
            { kind: 'goto', spot: second, gait: 'ZOOMIES_SPRINT', tol: 10 },
            { kind: 'goto', spot: { platformId: p.id, x: (a.x + b.x) / 2 + r.range(-80, 80) }, gait: 'TROT' },
            { kind: 'state', state: 'IDLE_SIT', dur: r.range(3, 6) },
          ],
          'zoomies',
        );
        return;
      }
      case 'gaze': {
        const face = env.cursor.x >= this.x ? 1 : -1;
        this.setPlan([{ kind: 'state', state: 'IDLE_STAND', dur: 0.1, face }, { kind: 'state', state: 'CURSOR_GAZE', dur: r.range(4, 9) }], 'gaze');
        return;
      }
      case 'hunt': {
        const c = env.cursor;
        const onLevel = Math.abs(c.y - (this.y - 10 * S)) < 70 * S && c.x > here.xMin && c.x < here.xMax;
        if (!onLevel) {
          this.makePlan('gaze', env);
          return;
        }
        this.setPlan(
          [
            {
              kind: 'pounce',
              target: () => (env.cursor.present ? { x: env.cursor.x, y: env.cursor.y } : null),
              onPin: () => {
                if (this.lm) env.particles.emit('spark', this.lm.paws[0].x, this.lm.paws[0].y - 4, 6, S);
              },
            },
            { kind: 'state', state: 'IDLE_SIT', dur: r.range(2, 4) },
          ],
          'hunt',
        );
        return;
      }
      case 'keyboard': {
        const t = env.typing;
        if (!t) {
          this.makePlan('rest', env);
          return;
        }
        const width = t.xMax - t.xMin;
        const usable = width > this.bodyLen() * 0.9;
        let spot: Spot = usable ? { platformId: t.platformId, x: clamp(t.caret.x + 46 * S, t.xMin + 30 * S, t.xMax - 30 * S) } : { platformId: 'floor', x: t.caret.x };
        // While you type, the field is off-limits: watch from a polite distance on the floor instead.
        const z = env.noGo;
        if (z) {
          const floor = env.source.floor();
          spot = { platformId: 'floor', x: blockedSpan(floor, z, S) ? safeFloorX(this.x, z, env.bounds.width, this.bodyLen() * 0.8) : clamp(t.caret.x, 30 * S, env.bounds.width - 30 * S) };
        }
        this.setPlan(
          [
            { kind: 'goto', spot, gait: 'TROT', maxTime: 14 },
            { kind: 'state', state: 'KEYBOARD_WATCH', dur: r.range(10, 22), face: () => (env.typing && env.typing.caret.x < this.x ? -1 : 1) },
          ],
          'keyboard',
        );
        return;
      }
      case 'social': {
        if (!env.social.request(this, env, 'social')) this.makePlan('rest', env);
        return;
      }
      case 'toy': {
        // A feather wand in your hand beats every other toy.
        const toy = env.toys.wand ?? env.toys.nearest(this.x, this.y, ['ball', 'laser', 'mouse']);
        if (!toy) {
          this.makePlan('explore', env);
          return;
        }
        const span = toy.kind === 'feather_wand' ? r.range(18, 28) : toy.kind === 'mouse' ? r.range(14, 22) : toy.kind === 'laser' ? r.range(9, 15) : r.range(7, 11);
        this.chaseDone = false;
        this.setPlan([{ kind: 'chase', toy, until: env.now + span }, { kind: 'state', state: 'IDLE_SIT', dur: r.range(1.5, 3) }], 'toy');
        return;
      }
      case 'treat': {
        const toy = env.toys.nearest(this.x, this.y, ['treat']);
        if (!toy) {
          this.makePlan('rest', env);
          return;
        }
        const spotFn = (): Spot | null => {
          if (!env.toys.toys.includes(toy) || (toy.claimedBy && toy.claimedBy !== this.id)) return null;
          if (!toy.ground) return null;
          return { platformId: toy.ground, x: toy.x - Math.sign(toy.x - this.x || 1) * 30 * S };
        };
        this.setPlan(
          [
            { kind: 'goto', spot: spotFn, gait: 'TROT', tol: 10 * S, maxTime: 10 },
            { kind: 'eat', toy },
            { kind: 'state', state: 'GROOM_WASH_FACE', dur: 99 },
          ],
          'treat',
        );
        return;
      }
      case 'scratch': {
        const tw = env.tower;
        const reach = SCRATCH_REACH * S;
        const ss = tw?.enabled ? tw.scratchSpot(this.x, reach, env.bounds) : null;
        if (!tw || !ss) {
          this.makePlan('rest', env);
          return;
        }
        // The cat picks a post side once and keeps it, even if the tower is dragged on the way.
        const side = ss.face;
        const live = () => this.liveEnv ?? env;
        this.setPlan(
          [
            { kind: 'goto', spot: () => { const g = live().tower?.scratchSpot(this.x, reach, live().bounds, side); return g ? { platformId: 'floor', x: g.x } : null; }, gait: 'TROT', face: side, tol: 5 * S, maxTime: 30 },
            { kind: 'state', state: 'SCRATCH_POST', dur: r.range(3, 5), face: side },
            { kind: 'state', state: 'IDLE_SIT', dur: r.range(1.5, 3) },
          ],
          'scratch',
          // Locked: a cat finishes its scratch (3–5 s at the post) rather than being talked out of it mid-stroke.
          true,
        );
        return;
      }
      case 'pom': {
        const toy = env.pomToy;
        if (!env.tower?.enabled || !toy) {
          this.makePlan('rest', env);
          return;
        }
        this.chaseDone = false;
        this.setPlan([{ kind: 'chase', toy, until: env.now + r.range(10, 18) }, { kind: 'state', state: 'IDLE_SIT', dur: r.range(1.5, 3) }], 'pom');
        return;
      }
      case 'climb': {
        const side: 1 | -1 = this.x > env.bounds.width / 2 ? 1 : -1;
        const wx = side > 0 ? env.bounds.width - 6 * S : 6 * S;
        this.setPlan(
          [
            { kind: 'goto', spot: { platformId: 'floor', x: wx }, gait: 'TROT', face: side, tol: 6, offscreen: true },
            { kind: 'climb', side, height: env.bounds.height * r.range(0.3, 0.6), cling: r.range(3, 6) },
          ],
          'climb',
        );
        return;
      }
      case 'peek': {
        const side: 1 | -1 = this.x > env.bounds.width / 2 ? 1 : -1;
        const out = side > 0 ? env.bounds.width + this.bodyLen() * 0.42 : -this.bodyLen() * 0.42;
        const back = side > 0 ? env.bounds.width - this.bodyLen() * 1.5 : this.bodyLen() * 1.5;
        this.setPlan(
          [
            { kind: 'goto', spot: { platformId: 'floor', x: out }, gait: 'SAUNTER_WALK', offscreen: true },
            { kind: 'state', state: 'EDGE_PEEK', dur: r.range(4, 8), face: (side > 0 ? -1 : 1) as 1 | -1 },
            { kind: 'goto', spot: { platformId: 'floor', x: back }, gait: 'SAUNTER_WALK', offscreen: true },
          ],
          'peek',
        );
        return;
      }
    }
  }

  /** How much this cat likes a tower tier: Anna, the agile climber, loves the top lookout (+25 %); Alex the cubby roof. */
  private towerPref(id: string): number {
    const anna = this.profile.presetKey === ANNA_ID;
    if (id === TOWER_TOP) return anna ? 1.25 : 1;
    if (id === TOWER_TIER1) return anna ? 1 : 1.25;
    return 1;
  }

  /**
   * A nap or rest on the cat tower: curled up inside the cubby (head and paws peeking out of its hole) or
   * on the crown's bolster. The tower is the cats' bed when the floor beds are hidden. A tier the other
   * cat already holds (or is walking to) is left to it; returns false when there is nothing free to use.
   */
  private planTowerBed(kind: 'sleep' | 'rest', env: AgentEnv): boolean {
    const tw = env.tower;
    if (!tw?.enabled) return false;
    const r = this.rng;
    const S = this.S;
    const taken = (id: string) => env.others.some((o) => o !== this && !o.parked && (o.groundId === id || o.dest?.platformId === id || (o.planLabel.endsWith('-tower') && o.towerTarget === id)));
    const tiers = [TOWER_TOP, TOWER_TIER1].filter((id) => env.platforms.some((p) => p.id === id) && !taken(id));
    if (!tiers.length) return false;
    const id = r.weighted(tiers, tiers.map((t) => this.towerPref(t)));
    this.towerTarget = id;
    const g = tw.geom(env.bounds);
    if (!g) return false;
    const cubby = id === TOWER_TIER1;
    const live = () => this.liveEnv ?? env;
    const spot = (): Spot | null => {
      const gg = live().tower?.geom(live().bounds);
      return gg ? { platformId: id, x: cubby ? gg.cubby.holeX : (gg.top.xMin + gg.top.xMax) / 2 } : null;
    };
    if (kind === 'sleep') {
      const curl: CatState = r.chance(0.85) ? 'CURLED_SLEEP' : 'SPRAWLED_SLEEP';
      this.setPlan(
        [
          { kind: 'goto', spot, gait: 'SAUNTER_WALK', tol: 5 * S, maxTime: 60, face: r.chance(0.5) ? 1 : -1 },
          { kind: 'state', state: cubby && curl === 'SPRAWLED_SLEEP' ? 'CURLED_SLEEP' : curl, dur: r.range(60, 160) },
        ],
        'sleep-tower',
      );
    } else {
      this.setPlan(
        [
          { kind: 'goto', spot, gait: 'SAUNTER_WALK', tol: 5 * S, maxTime: 60 },
          { kind: 'state', state: cubby ? r.weighted<CatState>(['CAT_LOAF', 'SPHINX_POSE'], [2, 1]) : r.weighted<CatState>(['CAT_LOAF', 'IDLE_SIT', 'SPHINX_POSE'], [2, 1.4, 1]), dur: r.range(10, 24) },
        ],
        'rest-tower',
      );
    }
    return true;
  }

  /**
   * Walks to the food or water bowl. With something in it the cat eats / drinks
   * and then washes its face; with an empty bowl it sits beside it and asks.
   */
  planMeal(bowl: BowlKind, env: AgentEnv): boolean {
    const st = env.station;
    if (!st || !st.enabled) return false;
    const S = this.S;
    const app = st.approach(bowl, S, env.bounds);
    const busy = st.occupiedBy(bowl, this.id);
    const level = st.level(bowl);
    const need = bowl === 'food' ? this.drives.hunger : this.drives.thirst;
    const gait: Gait = bowl === 'food' ? 'SEEKING_FOOD' : 'SEEKING_WATER';
    if (level > EMPTY_BOWL) {
      if (busy) {
        // Someone else is at this bowl: wait nearby, then try again.
        const waitX = app.x - app.face * this.bodyLen() * 1.05;
        this.setPlan([{ kind: 'goto', spot: { platformId: 'floor', x: waitX }, gait, face: app.face, maxTime: 20 }, { kind: 'state', state: 'IDLE_SIT', dur: this.rng.range(3, 5) }], `wait-${bowl}`);
        this.decideIn = 4;
        return true;
      }
      this.setPlan(
        [
          { kind: 'goto', spot: () => ({ platformId: 'floor', x: st.approach(bowl, this.S, (this.liveEnv ?? env).bounds).x }), gait, face: app.face, tol: 4 * S, maxTime: 30 },
          { kind: 'meal', bowl },
          // Every meal ends with a quick sit-down wash.
          { kind: 'state', state: 'GROOM_WASH_FACE', dur: 3 },
          { kind: 'state', state: 'IDLE_SIT', dur: this.rng.range(1.5, 3) },
        ],
        bowl === 'food' ? 'eat' : 'drink',
        // Locked: a cat finishes its meal (and its wash) rather than wandering off mid-bite.
        true,
      );
      return true;
    }
    if (need <= BEG_LEVEL || env.now - this.lastBegEnd < BEG_COOLDOWN) return false;
    // Empty bowl: sit beside it, look up at the human, meow now and then.
    const sitX = app.x - app.face * 6 * S;
    this.setPlan(
      [
        { kind: 'goto', spot: { platformId: 'floor', x: sitX }, gait, tol: 6 * S, maxTime: 30 },
        { kind: 'beg', bowl, dur: BEG_TIME },
      ],
      `beg-${bowl}`,
      true,
    );
    return true;
  }

  /* ------------------------------------------------------------ executor */

  private turn(dir: 1 | -1): void {
    if (dir === this.facing) return;
    // Never mid-way through an animation that has to play out (a boop, a landing, a lunge…).
    const meta = STATE_META[this.fsm.current];
    if (!meta.interruptible && !meta.locomotion && this.fsm.current !== 'CROUCH_PREP_JUMP') return;
    this.facing = dir;
  }

  private get turning(): boolean {
    return Math.abs(this.flip - this.facing) > 0.08;
  }

  private walkTo(rawTargetX: number, gait: Gait, env: AgentEnv, tol: number, offscreen = false): boolean {
    // Keep clear of where the other cats are sitting or already heading (personal space),
    // and of the text field you are typing in (never stopping in or crossing its strip).
    let targetX = offscreen ? rawTargetX : this.roomAt(rawTargetX, env);
    const here = env.noGo && !offscreen ? this.currentPlatform(env) : null;
    if (here) targetX = clampWalk(this.x, targetX, here, env.noGo ?? null, this.S, this.bodyLen() * 0.8);
    if (this.groundId && (!this.dest || this.dest.platformId !== this.groundId || Math.abs(this.dest.x - targetX) > 24 * this.S)) this.dest = { platformId: this.groundId, x: targetX, at: env.now };
    else if (this.dest) this.dest.x = targetX;
    const dx = targetX - this.x;
    if (Math.abs(dx) <= tol) {
      if (STATE_META[this.fsm.current].locomotion && this.fsm.current !== 'WALL_CLIMB') this.fsm.request('IDLE_STAND');
      return Math.abs(this.vx) < 12 * this.S;
    }
    const dir: 1 | -1 = dx > 0 ? 1 : -1;
    const posture = STATE_META[this.fsm.current].posture;
    if (posture !== 'stand') {
      this.fsm.request(gait);
      return false;
    }
    if (dir !== this.facing) {
      this.turn(dir);
      return false;
    }
    if (this.turning) return false;
    this.fsm.request(gait);
    if (this.fsm.current === gait) {
      const g = GAITS[gait];
      const base = (g ? g.speed : 46) * this.S;
      const ease = clamp(Math.abs(dx) / (base * 0.25 + 8), 0.35, 1);
      this.desiredVX = dir * base * (gait === 'ZOOMIES_SPRINT' ? 1 : ease);
    }
    void env;
    return false;
  }

  private beginJump(hop: NavJump, env: AgentEnv): void {
    if (this.fsm.current !== 'CROUCH_PREP_JUMP') {
      this.fsm.request('CROUCH_PREP_JUMP');
      return;
    }
    if (this.fsm.time < 0.24) return;
    const q = hop.to === 'floor' ? env.source.floor() : env.source.get(hop.to) ?? env.platforms.find((p) => p.id === hop.to) ?? null;
    if (!q) {
      this.route = null;
      return;
    }
    const plan = solveJump(this.x, this.y, hop.landX, q.y, 30 + 10 * this.S);
    if (!plan) {
      this.route = null;
      this.completeTask();
      return;
    }
    // Never leap backward: a landing behind the cat means turning around first.
    if (Math.abs(plan.vx) > 20 && Math.sign(plan.vx) !== this.facing) {
      this.turn(plan.vx > 0 ? 1 : -1);
      this.fsm.request('IDLE_STAND');
      return;
    }
    this.jump = { plan, t: 0, targetId: hop.to, fromId: hop.from };
    this.groundId = null;
    this.fsm.force('JUMP_ASCEND');
  }

  private runTasks(dt: number, env: AgentEnv): void {
    if (this.jump || this.falling || this.climb) return;
    const task = this.plan[0];
    if (!task) return;
    this.taskTime += dt;
    switch (task.kind) {
      case 'goto': {
        const spot = typeof task.spot === 'function' ? task.spot() : task.spot;
        if (!spot || (task.maxTime && this.taskTime > task.maxTime)) {
          if (STATE_META[this.fsm.current].locomotion) this.fsm.request('IDLE_STAND');
          this.completeTask();
          return;
        }
        if (!this.groundId) return;
        const key = spot.platformId;
        const hopNow = this.route?.hops[this.hop];
        const stale = !this.route || this.routeKey !== key || (hopNow ? hopNow.from !== this.groundId : this.groundId !== spot.platformId);
        if (stale) {
          // (The ledge it stands on may be off-limits right now — it can still leave it.)
          const here = this.currentPlatform(env);
          const graph = here && !env.platforms.some((p) => p.id === here.id) ? [...env.platforms, here] : env.platforms;
          this.route = planRoute(graph, this.groundId, this.x, spot.platformId, spot.x, env.bounds);
          this.hop = 0;
          this.routeKey = key;
          if (!this.route) {
            // Unreachable: approach as close as possible on the current ledge, then give up.
            this.completeTask();
            return;
          }
        }
        const route = this.route as NavPlan;
        const hop = route.hops[this.hop];
        if (hop) {
          if (this.walkTo(hop.takeoffX, task.gait, env, 7 * this.S)) {
            const dir: 1 | -1 = hop.landX >= this.x ? 1 : -1;
            if (Math.abs(hop.landX - this.x) > 4 && dir !== this.facing) {
              this.turn(dir);
              return;
            }
            if (!this.turning) this.beginJump(hop, env);
          }
          return;
        }
        let fx = task.offscreen ? spot.x : route.finalX;
        if (!task.offscreen && spot.platformId === this.groundId) {
          const p = this.currentPlatform(env);
          if (p) fx = clamp(spot.x, p.xMin + 12 * this.S, p.xMax - 12 * this.S);
        }
        if (this.walkTo(fx, task.gait, env, task.tol ?? 6 * this.S, !!task.offscreen)) {
          if (task.face && task.face !== this.facing) {
            if (STATE_META[this.fsm.current].posture === 'stand') this.turn(task.face);
            else this.fsm.request('IDLE_STAND');
            return;
          }
          if (this.turning) return;
          this.completeTask();
        }
        return;
      }
      case 'state': {
        const face = typeof task.face === 'function' ? task.face() : task.face;
        if (face && face !== this.facing && !this.taskEntered) {
          if (STATE_META[this.fsm.current].posture === 'stand') this.turn(face);
          else this.fsm.request('IDLE_STAND');
          if (this.turning || face !== this.facing) return;
        }
        if (this.turning) return;
        if (task.role !== undefined) this.poseRole = task.role;
        if (!this.taskEntered) {
          this.fsm.request(task.state);
          if (this.fsm.isAt(task.state)) {
            this.taskEntered = true;
            this.taskTime = 0;
          } else if (this.taskTime > 14) this.completeTask();
          return;
        }
        // Brief reactions (a judgmental squint, a shy paw tuck) return to the task's state by themselves.
        const cur = this.fsm.current;
        const reacting = cur === 'JUDGMENTAL_AIRPLANE_SQUINT' || cur === 'PAW_TUCK';
        if (!reacting && (cur !== task.state || this.taskTime >= task.dur)) this.completeTask();
        return;
      }
      case 'climb': {
        if (this.groundId !== 'floor') {
          this.completeTask();
          return;
        }
        this.fsm.request('WALL_CLIMB');
        if (this.fsm.current === 'WALL_CLIMB') {
          this.climb = { side: task.side, targetY: env.bounds.height - task.height, timer: task.cling, phase: 'up' };
          this.groundId = null;
          this.facing = task.side;
          this.completeTask();
        } else if (this.taskTime > 6) this.completeTask();
        return;
      }
      case 'pounce': {
        const tg = task.target();
        if (!tg) {
          if (STATE_META[this.fsm.current].locomotion) this.fsm.request('IDLE_STAND');
          this.completeTask();
          return;
        }
        const S = this.S;
        if (this.taskFlag < 2) {
          // Stalk until within lunge range.
          const dx = tg.x - this.x;
          if (Math.abs(tg.y - (this.y - 10 * S)) > 90 * S || this.taskTime > 12) {
            this.completeTask();
            return;
          }
          const range = (task.range ?? 68) * S;
          // A toy that got away again: back to the chase (which runs after it).
          if (task.range !== undefined && Math.abs(dx) > range + 12 * S) {
            this.completeTask();
            return;
          }
          if (Math.abs(dx) > range) {
            const dir: 1 | -1 = dx > 0 ? 1 : -1;
            this.walkTo(tg.x - dir * (range - 16 * S), 'STALK_CURSOR', env, 10 * S);
            return;
          }
          const dir: 1 | -1 = dx > 0 ? 1 : -1;
          if (dir !== this.facing) {
            if (STATE_META[this.fsm.current].posture === 'stand') this.turn(dir);
            else this.fsm.request('IDLE_STAND');
            return;
          }
          this.taskFlag = 2;
          this.fsm.request('CROUCH_PREP_JUMP');
          return;
        }
        if (this.taskFlag === 2) {
          if (this.fsm.current === 'CROUCH_PREP_JUMP') this.fsm.request('POUNCE_AND_PIN');
          if (this.fsm.current === 'POUNCE_AND_PIN') {
            this.taskFlag = 3;
          } else if (this.fsm.current !== 'CROUCH_PREP_JUMP' && this.taskTime > 3) this.completeTask();
          else if (this.fsm.current !== 'CROUCH_PREP_JUMP') this.fsm.request('CROUCH_PREP_JUMP');
          return;
        }
        if (this.taskFlag >= 3) {
          if (this.fsm.current === 'POUNCE_AND_PIN') {
            if (this.fsm.time < 0.38) {
              // The lunge: snap velocity straight to the target (no gait smoothing).
              const goal = tg.x - this.facing * 34 * S;
              // Forward only: a target that slipped behind mid-crouch is simply missed, never lunged at backward.
              const v = clamp((goal - this.x) / 0.18, -520 * S, 520 * S);
              this.desiredVX = this.facing > 0 ? Math.max(0, v) : Math.min(0, v);
              this.vx = this.desiredVX;
            } else if (this.taskFlag === 3) {
              this.taskFlag = 4;
              task.onPin?.();
            }
          } else this.completeTask();
        }
        return;
      }
      case 'eat': {
        const toy = task.toy;
        if (!env.toys.toys.includes(toy)) {
          this.completeTask();
          return;
        }
        toy.claimedBy = this.id;
        this.fsm.request('EAT_TREAT');
        if (this.fsm.current === 'EAT_TREAT') {
          if (env.toys.nibble(toy, dt)) {
            this.drives.affection = Math.min(100, this.drives.affection + 12);
            this.drives.energy = Math.min(100, this.drives.energy + 8);
            this.drives.irritation = Math.max(0, this.drives.irritation - 20);
            if (this.lm) env.particles.emit('heart', this.lm.head.x, this.lm.head.y - 10 * this.S, 2, this.S);
            this.completeTask();
          } else if (this.fsm.time > 2.0) this.fsm.setDuration(this.fsm.time + 1);
        } else if (this.taskTime > 8) this.completeTask();
        return;
      }
      case 'meal': {
        const st = env.station;
        if (!st || !st.enabled) {
          this.completeTask();
          return;
        }
        const bowl = task.bowl;
        const meal: CatState = bowl === 'food' ? 'EATING' : 'DRINKING';
        if (!st.claim(bowl, this.id)) {
          this.completeTask();
          return;
        }
        if (this.fsm.current !== meal) {
          this.fsm.request(meal);
          if (this.taskTime > 6) {
            st.release(bowl, this.id);
            this.completeTask();
          }
          return;
        }
        const S = this.S;
        const key = bowl === 'food' ? 'hunger' : 'thirst';
        const got = st.consume(bowl, dt * (bowl === 'food' ? MEAL.eatBowl : MEAL.drinkBowl));
        if (got > 0) this.drives[key] = Math.max(0, this.drives[key] - dt * (bowl === 'food' ? MEAL.eatNeed : MEAL.drinkNeed));
        if (this.lm && this.rng.chance(dt * (bowl === 'food' ? 3.2 : 4))) {
          const mx = this.lm.head.x + this.facing * this.lm.head.r * 0.6;
          env.particles.emit(bowl === 'food' ? 'crumb' : 'drop', mx, this.lm.head.y + this.lm.head.r * 0.7, 1, S);
        }
        const done = this.drives[key] < MEAL.full || st.level(bowl) <= 0 || this.fsm.time > MEAL.maxTime;
        if (done) {
          st.release(bowl, this.id);
          this.drives.affection = Math.min(100, this.drives.affection + 4);
          this.completeTask();
        }
        return;
      }
      case 'beg': {
        const st = env.station;
        if (!st || !st.enabled || st.level(task.bowl) > EMPTY_BOWL) {
          // Refilled (or put away): let the brain decide again right now.
          if (this.fsm.current === 'EMPTY_BOWL_WAIT') this.fsm.request('IDLE_SIT');
          this.completeTask();
          this.decideIn = 0.3;
          return;
        }
        const face: 1 | -1 = env.cursor.present ? (env.cursor.x >= this.x ? 1 : -1) : st.centerX(env.bounds) >= this.x ? 1 : -1;
        if (!this.taskEntered) {
          if (face !== this.facing) {
            if (STATE_META[this.fsm.current].posture === 'stand') this.turn(face);
            else this.fsm.request('IDLE_STAND');
            if (this.turning || face !== this.facing) return;
          }
          if (this.turning) return;
          this.fsm.request('EMPTY_BOWL_WAIT');
          if (this.fsm.isAt('EMPTY_BOWL_WAIT')) {
            this.taskEntered = true;
            this.taskTime = 0;
            this.begMeowIn = 0.6;
          } else if (this.taskTime > 10) this.completeTask();
          return;
        }
        this.begMeowIn -= dt;
        if (this.begMeowIn <= 0) {
          this.begMeowIn = this.rng.range(5.5, 8);
          if (this.lm) env.particles.emit(task.bowl === 'food' ? 'thoughtFood' : 'thoughtWater', this.lm.head.x + this.facing * 10 * this.S, this.lm.head.y - 26 * this.S, 1, this.S);
        }
        if (this.fsm.current !== 'EMPTY_BOWL_WAIT' || this.taskTime >= task.dur) {
          this.lastBegEnd = env.now;
          this.completeTask();
        }
        return;
      }
      case 'wait': {
        // Hold the current calm posture until something happens (e.g. the partner arrives).
        const face = task.face?.();
        if (face && face !== this.facing && STATE_META[this.fsm.current].posture === 'stand') this.turn(face);
        else if (STATE_META[this.fsm.current].locomotion) this.fsm.request('IDLE_STAND');
        else if (STATE_META[this.fsm.current].posture === 'stand' && !this.turning && this.taskTime > 0.6) this.fsm.request('IDLE_SIT');
        if (task.until() || this.taskTime > task.maxTime) this.completeTask();
        return;
      }
      case 'do': {
        this.completeTask();
        task.fn();
        return;
      }
      case 'chase': {
        this.runChase(task, env);
        return;
      }
      case 'leap': {
        this.runLeap(task, env);
        return;
      }
    }
  }

  /* ---------------------------------------------------------- toy hunting */

  /** Is this toy still there to hunt? (The tower's pom-pom is not in the toy list: it lives as long as the tower is out.) */
  private toyAlive(toy: Toy, env: AgentEnv): boolean {
    return toy.kind === 'pom' ? !!env.tower?.enabled && env.pomToy === toy : env.toys.toys.includes(toy);
  }

  /** What the cat is going for: the mouse's body, the feather at the end of the wand's string, the ball, the laser dot, the pom-pom. */
  private chaseAim(toy: Toy): Vec2 {
    if (toy.mouse) return mouseBody(toy.mouse);
    if (toy.wand) return wandTip(toy.wand);
    return { x: toy.x, y: toy.y };
  }

  /** A swat or pin landed at `paw`. */
  private swatToy(toy: Toy, paw: Vec2, env: AgentEnv): void {
    const S = this.S;
    if (!this.toyAlive(toy, env)) return;
    if (toy.kind === 'pom') {
      // A bat at the pom-pom: it swings away from the paw on its elastic cord and bounces.
      const pom = env.tower?.pom;
      if (pom) {
        batPom(pom, this.facing * this.rng.range(240, 420), -this.rng.range(80, 220));
        env.particles.emit('spark', pom.x, pom.y, 3, S);
        this.drives.playfulness = Math.max(0, this.drives.playfulness - 4);
        this.drives.affection = Math.min(100, this.drives.affection + 1.5);
        this.drives.irritation = Math.max(0, this.drives.irritation - 3);
      }
      return;
    }
    const m = toy.mouse;
    if (m) {
      if (!toy.held && m.ground && Math.hypot(m.x - paw.x, m.y - 4 - paw.y) < 30 * S) {
        env.toys.pinMouse(toy);
        this.chaseDone = true;
        this.drives.playfulness = Math.max(0, this.drives.playfulness - 12);
        if (this.lm) env.particles.emit('heart', this.lm.head.x, this.lm.head.y - 12 * S, 1, S);
      } else if (!toy.held) env.toys.swat(toy, this.facing, 0.8);
    } else if (toy.wand) {
      // Got it! The feather jerks away from the paw and a few wisps of fluff come loose.
      if (env.toys.swatWand(toy, paw, this.facing)) {
        const tip = wandTip(toy.wand);
        env.particles.emit('fluff', tip.x, tip.y, 2 + (this.rng.chance(0.5) ? 1 : 0), S);
        this.drives.playfulness = Math.max(0, this.drives.playfulness - 5);
        this.drives.affection = Math.min(100, this.drives.affection + 2);
        this.drives.irritation = Math.max(0, this.drives.irritation - 4);
      }
      return;
    } else env.toys.swat(toy, this.facing, 1);
    env.particles.emit('spark', paw.x, paw.y, 5, S);
  }

  private runChase(task: Extract<Task, { kind: 'chase' }>, env: AgentEnv): void {
    const toy = task.toy;
    const gone = !this.toyAlive(toy, env) || (toy.mouse && toy.mouse.mode === 'limp');
    if (gone || this.chaseDone || env.now > task.until) {
      this.chaseDone = false;
      if (STATE_META[this.fsm.current].locomotion) this.fsm.request('IDLE_STAND');
      this.completeTask();
      return;
    }
    if (!this.groundId) return;
    const S = this.S;
    const here = this.currentPlatform(env) ?? env.source.floor();
    const aim = this.chaseAim(toy);
    const rise = this.y - aim.y;
    const dx = aim.x - this.x;
    const reach = (MAX_LEAP_UP + LEAP_REACH) * S;
    const overHere = aim.x > here.xMin - 10 && aim.x < here.xMax + 10;
    // The feather counts as "in the air" from 40 px above the cat's surface (dragging below 25 px).
    const inAir = rise > (toy.wand ? 40 : 46) * S;
    const target = () => (this.toyAlive(toy, this.liveEnv ?? env) ? this.chaseAim(toy) : null);
    const swat = (paw: Vec2) => this.swatToy(toy, paw, env);
    // The pom-pom hangs under the tower's middle perch: it is batted from the cubby's roof (tier 1), never from the floor underneath.
    if (toy.kind === 'pom' && this.groundId !== TOWER_TIER1) {
      this.plan.unshift({
        kind: 'goto',
        spot: () => {
          const live = this.liveEnv ?? env;
          const g = live.tower?.geom(live.bounds);
          return g ? { platformId: TOWER_TIER1, x: clamp(toy.x - 18 * S, g.tier1.xMin + 16 * S, g.tier1.xMax - 16 * S) } : null;
        },
        gait: 'TROT',
        tol: 12 * S,
        maxTime: 25,
      });
      this.taskTime = 0;
      this.taskEntered = false;
      return;
    }
    // 1. Up in the air above this ledge and within reach: a vertical pounce (facing it first).
    if (inAir && rise < reach && overHere && Math.abs(dx) < 130 * S) {
      if (Math.abs(dx) > 90 * S) {
        this.walkTo(aim.x - Math.sign(dx) * 40 * S, 'TROT', env, 10 * S);
        return;
      }
      this.plan.unshift({ kind: 'leap', target, onSwat: swat });
      this.taskTime = 0;
      this.taskEntered = false;
      this.taskFlag = 0;
      return;
    }
    // 2. On another ledge (or far above this one): get there first.
    const below = platformBelow(aim.x, aim.y - 4, env.platforms) ?? env.source.floor();
    if (below.id !== this.groundId && (!inAir || rise >= reach || !overHere)) {
      const gait: Gait = toy.kind === 'laser' ? 'ZOOMIES_SPRINT' : 'TROT';
      this.plan.unshift({
        kind: 'goto',
        spot: () => {
          if (!this.toyAlive(toy, this.liveEnv ?? env)) return null;
          const a = this.chaseAim(toy);
          const pl = platformBelow(a.x, a.y - 4, (this.liveEnv ?? env).platforms) ?? env.source.floor();
          return { platformId: pl.id, x: a.x - Math.sign(a.x - this.x || 1) * 36 * S };
        },
        gait,
        tol: 18 * S,
        maxTime: 4,
      });
      this.taskTime = 0;
      this.taskEntered = false;
      return;
    }
    // Out of reach straight above: sit up and watch it, ready to spring.
    if (inAir) {
      if (!this.walkTo(clamp(aim.x - Math.sign(dx || 1) * 30 * S, here.xMin + 20, here.xMax - 20), 'TROT', env, 14 * S)) return;
      const face: 1 | -1 = dx >= 0 ? 1 : -1;
      if (face !== this.facing && STATE_META[this.fsm.current].posture === 'stand') this.turn(face);
      return;
    }
    // 3. Same level: stalk a mouse low and slow, run for the rest, then pounce.
    //    A feather dragged along the floor is stalked low (dilated pupils) and pinned after a long butt wiggle.
    const feather = !!toy.wand;
    if (Math.abs(dx) > (toy.kind === 'mouse' ? 160 : feather ? 140 : 130) * S) {
      // A running mouse gets chased flat out; a still one is crept up on, low and slow, from just outside its notice.
      const mm = toy.mouse?.mode;
      const gait: Gait =
        toy.kind === 'laser' || mm === 'flee' || mm === 'dart'
          ? 'ZOOMIES_SPRINT'
          : (toy.kind === 'mouse' && mm !== 'scuttle') || feather
            ? Math.abs(dx) < (feather ? 260 : 175) * S
              ? 'STALK_CURSOR'
              : 'TROT'
            : 'TROT';
      this.walkTo(aim.x - Math.sign(dx) * 52 * S, gait, env, 10 * S);
      return;
    }
    this.plan.unshift({
      kind: 'pounce',
      target,
      range: toy.kind === 'mouse' ? 150 : feather ? 140 : 120,
      wiggle: feather ? this.rng.range(0.6, 1.1) : this.rng.range(0.3, 0.55),
      onPin: () => {
        const paw = this.lm ? this.lm.paws[0] : { x: this.x + this.facing * 30 * S, y: this.y - 4 };
        swat({ x: paw.x, y: paw.y });
      },
    });
    this.taskTime = 0;
    this.taskEntered = false;
    this.taskFlag = 0;
  }

  /** The vertical pounce: face the target, wiggle, spring up (or up-and-forward), swat at the top. */
  private runLeap(task: Extract<Task, { kind: 'leap' }>, env: AgentEnv): void {
    const tg = task.target();
    if (!tg || !this.groundId) {
      if (!tg) this.completeTask();
      return;
    }
    const S = this.S;
    if (this.taskFlag >= 2) {
      // Landed again.
      this.completeTask();
      return;
    }
    const lp = planLeap(this.x, this.y, this.facing, tg.x, tg.y, S);
    if (lp.turn) {
      // Behind: turn around first, then leap forward.
      this.taskFlag = 0;
      if (STATE_META[this.fsm.current].posture === 'stand' && this.fsm.current !== 'CROUCH_PREP_JUMP') this.turn(tg.x > this.x ? 1 : -1);
      else this.fsm.request('IDLE_STAND');
      if (this.taskTime > 4) this.completeTask();
      return;
    }
    if (this.turning) return;
    if (!lp.plan) {
      this.completeTask();
      return;
    }
    if (this.taskFlag === 0) {
      this.fsm.request('CROUCH_PREP_JUMP');
      if (this.fsm.current === 'CROUCH_PREP_JUMP') this.taskFlag = 1;
      else if (this.taskTime > 3) this.completeTask();
      return;
    }
    if (this.fsm.current !== 'CROUCH_PREP_JUMP') {
      this.fsm.request('CROUCH_PREP_JUMP');
      if (this.taskTime > 3) this.completeTask();
      return;
    }
    if (this.fsm.time < 0.28) return;
    this.jump = { plan: lp.plan, t: 0, targetId: this.groundId, fromId: this.groundId };
    this.leapSwat = { target: task.target, onSwat: task.onSwat, done: false };
    this.groundId = null;
    this.taskFlag = 2;
    this.fsm.force('JUMP_ASCEND');
    void env;
  }

  /* -------------------------------------------------------- personal space */

  /** Moves a destination out of another (settled) cat's personal space. */
  private roomAt(x: number, env: AgentEnv): number {
    if (this.social || this.planLabel === 'eat' || this.planLabel === 'drink' || this.planLabel.startsWith('beg') || this.planLabel === 'sleep-bed' || this.planLabel.endsWith('-tower') || this.planLabel === 'scratch') return x;
    let out = x;
    const mine = this.dest?.at ?? env.now;
    for (let pass = 0; pass < 2; pass++) {
      for (const o of env.others) {
        if (o === this || o.groundId !== this.groundId || o.isAirborne() || o.isHeld() || o.inCubby) continue;
        if (o.social?.partner === this) continue;
        let ox: number | null = null;
        if (!STATE_META[o.state].locomotion) ox = o.x;
        // Already on its way there (and it picked the spot first): leave it that spot.
        else if (o.dest && o.dest.platformId === this.groundId && (o.dest.at < mine || (o.dest.at === mine && o.id < this.id))) ox = o.dest.x;
        if (ox === null) continue;
        const ps = ((this.bodyLen() + o.bodyLen()) / 2) * PERSONAL_SPACE;
        if (Math.abs(out - ox) < ps) out = ox + (this.x <= ox ? -1 : 1) * ps;
      }
    }
    return out;
  }

  /**
   * Separation steering: while moving, the coordinator's push nudges the cat's
   * speed so two cats drift apart instead of walking inside each other; a cat
   * that has settled down on top of another one gets up and makes room.
   */
  private handleCrowding(dt: number, env: AgentEnv): void {
    const sep = this.separation;
    if (Math.abs(sep) < 0.05 || this.isAsleep() || this.held || !this.groundId || this.isAirborne()) {
      this.crowdT = 0;
      return;
    }
    if (STATE_META[this.fsm.current].locomotion) {
      // Steering while walking: a sideways nudge — but not right at the destination (that is kept clear by roomAt).
      const far = !this.dest || Math.abs(this.dest.x - this.x) > this.bodyLen() * 1.5;
      if (far) this.desiredVX += sep * 60 * this.S;
      this.crowdT = 0;
      return;
    }
    if (this.planLocked || this.social || this.isPetted() || this.plan[0]?.kind === 'pounce' || this.plan[0]?.kind === 'leap') {
      this.crowdT = 0;
      return;
    }
    this.crowdT += dt;
    if (this.crowdT < 0.7) return;
    this.crowdT = 0;
    const p = this.currentPlatform(env) ?? env.source.floor();
    const L = this.bodyLen();
    const tx = clamp(this.x + Math.sign(sep) * L * (0.5 + Math.abs(sep) * 0.6), p.xMin + L * 0.5, p.xMax - L * 0.5);
    if (Math.abs(tx - this.x) < 8 * this.S) return;
    this.setPlan(
      [
        { kind: 'goto', spot: { platformId: p.id, x: tx }, gait: 'SAUNTER_WALK', maxTime: 5 },
        { kind: 'state', state: this.rng.chance(0.6) ? 'IDLE_SIT' : 'CAT_LOAF', dur: this.rng.range(2, 5) },
      ],
      'make-room',
    );
  }

  /** Floor x shifted out of any other cat's bed. */
  private offOthersBeds(x: number, env: AgentEnv): number {
    const beds = env.beds;
    if (!beds?.enabled) return x;
    for (const g of beds.all(env.bounds)) {
      if (g.id === this.id) continue;
      const half = g.w / 2 + this.bodyLen() * 0.5;
      if (Math.abs(x - g.cx) < half) x = g.cx + (x < g.cx ? -half : half);
    }
    return clamp(x, this.bodyLen() * 0.6, env.bounds.width - this.bodyLen() * 0.6);
  }

  /* ------------------------------------------------------ typing zones */

  /** Is any part of this cat (or the spot it is heading to) inside the no-go box? */
  inZone(z: NoGoRect, env: AgentEnv): boolean {
    const b = this.lm?.bounds;
    if (b ? rectsIntersect(b, z) : pointInZone(this.x, this.y - 20 * this.S, z)) return true;
    const d = this.dest;
    if (!d) return false;
    const p = d.platformId === this.groundId ? this.currentPlatform(env) : env.platforms.find((q) => q.id === d.platformId) ?? null;
    return !!p && pointInZone(d.x, p.y - 20 * this.S, z);
  }

  /**
   * You started typing next to (or under) this cat: it gets up — even from a
   * nap — and walks to a spot on the floor at least 140 px from the field, then
   * sits and watches from there.
   */
  evade(z: NoGoRect, env: AgentEnv): void {
    if (this.held || this.isAirborne() || this.climb) return;
    const floor = env.source.floor();
    const S = this.S;
    const L = this.bodyLen();
    const floorBlocked = !!blockedSpan(floor, z, S);
    const x = floorBlocked || (this.x >= z.minX && this.x <= z.maxX && this.groundId !== 'floor') ? safeFloorX(this.x, z, env.bounds.width, L * 0.8) : clamp(this.x, L * 0.6, env.bounds.width - L * 0.6);
    if (this.isAsleep()) {
      // A gentle wake: a slow blink and up.
      this.slowBlink();
      this.fsm.restore('IDLE_STAND');
    }
    const face = (): 1 | -1 => ((z.minX + z.maxX) / 2 >= this.x ? 1 : -1);
    this.setPlan(
      [
        { kind: 'goto', spot: { platformId: 'floor', x }, gait: 'TROT', tol: 10 * S, maxTime: 20 },
        { kind: 'state', state: this.rng.chance(0.6) ? 'IDLE_SIT' : 'CAT_LOAF', dur: this.rng.range(6, 12), face },
      ],
      'evade',
      true,
    );
  }

  /* ------------------------------------------------------ coming & going */

  /** Walks off the screen at `side` (−1 left, +1 right), then calls `then`. */
  exitTo(side: 1 | -1, env: AgentEnv, then: () => void, label = 'exit', gait: Gait = 'TROT'): void {
    const W = env.bounds.width;
    const out = side > 0 ? W + this.bodyLen() * 1.1 : -this.bodyLen() * 1.1;
    this.setPlan(
      [
        { kind: 'goto', spot: { platformId: 'floor', x: out }, gait, offscreen: true, maxTime: 14 },
        // Stay parked out of sight until the page lets this cat go.
        {
          kind: 'do',
          fn: () => {
            this.parked = true;
            then();
          },
        },
        { kind: 'wait', until: () => false, maxTime: 30 },
      ],
      label,
      true,
    );
  }

  /** Appears just outside the screen edge `side` (−1 left, +1 right) and walks in. */
  enterFrom(side: 1 | -1, env: AgentEnv, delay = 0): void {
    const W = env.bounds.width;
    const L = this.bodyLen();
    this.held = null;
    this.leapSwat = null;
    this.facing = side > 0 ? -1 : 1;
    this.flip = this.facing;
    this.placeOn(env.source.floor(), side > 0 ? W + L * 0.9 : -L * 0.9);
    this.fsm.restore('IDLE_STAND');
    this.pose = clonePose(computePose('IDLE_STAND', this.poseContext(env, 'IDLE_STAND')));
    this.poseSpring.reset();
    const tx = side > 0 ? W - L * this.rng.range(1.6, 3.4) : L * this.rng.range(1.6, 3.4);
    this.setPlan(
      [
        // Waiting just out of sight until it's this cat's turn to come in.
        ...(delay > 0 ? [{ kind: 'wait', until: () => false, maxTime: delay } as Task] : []),
        { kind: 'goto', spot: { platformId: 'floor', x: tx }, gait: 'SAUNTER_WALK', offscreen: true, maxTime: 14 + delay },
        { kind: 'state', state: 'IDLE_SIT', dur: this.rng.range(1.5, 3.5) },
      ],
      'arrive',
      true,
    );
  }

  /* ------------------------------------------------------------- physics */

  private startFall(env: AgentEnv, startled: boolean): void {
    this.groundId = null;
    this.jump = null;
    this.leapSwat = null;
    this.climb = null;
    this.falling = true;
    this.softFall = startled;
    this.vy = startled ? -90 * this.S : 0;
    if (startled) {
      if (!this.fsm.force('STARTLED_AIRBORNE')) this.fsm.restore('IDLE_STAND');
      if (this.lm) env.particles.emit('bang', this.lm.head.x + 10 * this.S, this.lm.head.y - 18 * this.S, 1, this.S);
    } else if (!this.fsm.force('FALL_DESCEND')) this.fsm.force('STARTLED_AIRBORNE');
    this.plan = [];
    this.planLocked = false;
    this.route = null;
    this.social = null;
  }

  private land(p: Platform, env: AgentEnv, impact: number): void {
    this.jump = null;
    this.leapSwat = null;
    this.falling = false;
    this.groundId = p.id;
    this.y = p.y;
    this.vy = 0;
    this.fsm.force('LAND_RECOVERY');
    if (impact > 520) env.particles.emit('puff', this.x, this.y - 2, 4, this.S);
    const route = this.route;
    if (route && route.hops[this.hop] && route.hops[this.hop].to === p.id) this.hop++;
    else this.route = null;
    if (this.afterDrop) {
      // Put down (or tossed): land, then smooth the ruffled fur with a quick paw lick.
      this.afterDrop = false;
      this.plan = [{ kind: 'state', state: 'GROOM_LICK_PAW', dur: 3 }, { kind: 'state', state: 'IDLE_SIT', dur: this.rng.range(1.5, 3) }];
      this.planLabel = 'after-drop';
      this.planLocked = false;
      this.taskTime = 0;
      this.taskEntered = false;
      this.decideIn = 5;
      if (impact > 380) env.particles.emit('puff', this.x, this.y - 2, 5, this.S);
    } else if (p.kind === 'dom' && this.rng.chance(this.profile.personality.clumsiness * 0.14)) {
      // Clumsiness: a cute slip on landing, followed by dignified "I meant that" grooming.
      this.slip = 0.5;
      this.vx = this.facing * 110 * this.S;
      env.particles.emit('puff', this.x, this.y - 2, 3, this.S);
      if (!this.planLocked) this.plan.unshift({ kind: 'state', state: 'GROOM_LICK_PAW', dur: 99 });
    }
    this.vx *= 0.3;
  }

  private physics(dt: number, env: AgentEnv): void {
    const S = this.S;
    const W = env.bounds.width;
    // Turn animation (flip passes through 0 for a quick "turn around" squash).
    if (this.flip !== this.facing) {
      // Cosine-eased turn (~0.3 s): slow out of profile, quick through the front view, settle in.
      const p = Math.acos(clamp(-this.flip * this.facing, -1, 1)) / Math.PI;
      const np = Math.min(1, p + dt / 0.3);
      this.flip = np >= 1 ? this.facing : -this.facing * Math.cos(np * Math.PI);
    }

    if (this.climb) {
      const c = this.climb;
      this.x = c.side > 0 ? W - 1 : 1;
      if (c.phase === 'up') {
        if (this.fsm.current === 'WALL_CLIMB') {
          const sp = (GAITS.WALL_CLIMB?.speed ?? 64) * S;
          this.y -= sp * dt;
          this.vy = -sp;
          this.gaitPhase += (dt * sp * 0.55) / (20 * S);
          if (this.y <= c.targetY) {
            c.phase = 'cling';
            this.vy = 0;
            this.fsm.request('EDGE_PEEK');
          }
        }
      } else {
        c.timer -= dt;
        if (c.timer <= 0) {
          this.climb = null;
          this.falling = true;
          this.softFall = false;
          this.vx = -c.side * 80 * S;
          this.vy = -60 * S;
          this.facing = c.side > 0 ? -1 : 1;
          if (!this.fsm.force('FALL_DESCEND')) this.fsm.force('STARTLED_AIRBORNE');
        }
      }
      return;
    }

    if (this.jump) {
      const j = this.jump;
      const prevY = this.y;
      j.t += dt;
      const p = trajectoryAt(j.plan, j.t);
      this.x = p.x;
      this.y = p.y;
      this.vx = p.vx;
      this.vy = p.vy;
      // A vertical pounce swats at the top of the arc.
      const ls = this.leapSwat;
      if (ls && !ls.done && this.vy > -60 * this.S) {
        ls.done = true;
        const tg = ls.target();
        const S = this.S;
        const paw = this.lm ? this.lm.paws[0] : { x: this.x + this.facing * 22 * S, y: this.y - LEAP_REACH * S };
        if (tg && Math.hypot(tg.x - paw.x, tg.y - paw.y) < 40 * S) ls.onSwat?.({ x: tg.x, y: tg.y });
      }
      if (this.vy > 0 && this.fsm.current === 'JUMP_ASCEND') this.fsm.force('FALL_DESCEND');
      if (this.vy > 0) {
        // Stepping off a ledge's edge, the arc may dip back over the ledge it left: never land back on it.
        const land = findLanding(prevY, this.y, this.x, env.platforms, j.fromId !== j.targetId ? j.fromId : null);
        if (land) {
          this.land(land, env, this.vy);
          return;
        }
      }
      if (j.t > j.plan.duration + 0.3) {
        this.jump = null;
        this.falling = true;
      }
      return;
    }

    if (this.falling) {
      const prevY = this.y;
      const st = fallStep(this.y, this.vy, dt, this.softFall);
      this.y = st.y;
      this.vy = st.vy;
      this.vx = applyFriction(this.vx, 0.8, dt);
      const fx = this.x + this.vx * dt;
      if (fx < 4 || fx > W - 4) this.vx = -this.vx * 0.35; // a thrown cat bounces softly off the screen edge
      this.x = clamp(fx, 4, W - 4);
      if (this.vy > 0 && this.fsm.current === 'JUMP_ASCEND') this.fsm.force('FALL_DESCEND');
      const land = this.vy > 0 ? findLanding(prevY, this.y, this.x, env.platforms) : null;
      if (land) this.land(land, env, this.vy);
      else if (this.y > env.bounds.height + 60) this.land(env.source.floor(), env, 0);
      return;
    }

    // Grounded: follow the ledge (it moves when the page scrolls).
    if (this.groundId) {
      if (this.groundId === 'floor') {
        this.y = env.source.floor().y;
      } else {
        const p = env.source.get(this.groundId);
        if (!p) {
          this.startFall(env, false);
          return;
        }
        const dy = p.y - this.y;
        // Page scrolling is applied by the world before physics (shiftForScroll), so any jump
        // left here is the ledge itself moving — an animation or a layout shift — which can knock a cat off.
        if (isScrollViolent(dy, dt) && !this.climb) {
          this.startFall(env, true);
          return;
        }
        if (p.y > env.bounds.height - 3) {
          this.groundId = 'floor';
          this.y = env.source.floor().y;
          this.route = null;
        } else if (p.y < this.bodyLen() * 0.55) {
          // The ledge is scrolling away out of the top of the screen: hop down to the floor.
          this.hopDown(env);
          return;
        } else {
          this.y = p.y;
          if (dy !== 0) this.tail.translate(0, dy);
          if (this.x < p.xMin - 14 || this.x > p.xMax + 14) {
            this.startFall(env, false);
            return;
          }
        }
      }
    }

    if (this.parked) {
      this.vx = 0;
      return;
    }
    // Horizontal motion.
    if (this.slip > 0) {
      this.slip -= dt;
      this.vx = applyFriction(this.vx, 3.5, dt);
    } else {
      const k = 1 - Math.exp(-(this.desiredVX === 0 ? 14 : 7) * dt);
      this.vx += (this.desiredVX - this.vx) * k;
      if (Math.abs(this.vx) < 0.5) this.vx = 0;
    }
    if (this.vx !== 0) {
      let nx = this.x + this.vx * dt;
      // Walking off (or in from) beyond the screen edge: no snapping back onto the visible floor.
      const offscreenTask = (this.plan[0]?.kind === 'goto' && (this.plan[0] as { offscreen?: boolean }).offscreen) || this.x < 0 || this.x > W;
      const p = this.currentPlatform(env);
      if (p && !offscreenTask) {
        const lo = p.kind === 'floor' ? 6 * S : p.xMin + 4;
        const hi = p.kind === 'floor' ? W - 6 * S : p.xMax - 4;
        nx = clamp(nx, lo, hi);
      } else if (offscreenTask) nx = clamp(nx, -this.bodyLen() * 1.4, W + this.bodyLen() * 1.4);
      this.x = nx;
    }
    const g = GAITS[this.fsm.current];
    if (g && Math.abs(this.vx) > 1) this.gaitPhase += (Math.abs(this.vx) * dt * g.stance) / (g.stride * S);
  }

  /** Calm step off a ledge that is leaving the viewport (no startle). */
  private hopDown(env: AgentEnv): void {
    this.groundId = null;
    this.jump = null;
    this.falling = true;
    this.softFall = true;
    this.vy = -60 * this.S;
    this.vx = this.facing * 40 * this.S;
    if (!this.fsm.force('FALL_DESCEND')) this.fsm.force('STARTLED_AIRBORNE');
    this.route = null;
    if (!this.planLocked) this.plan = [];
    void env;
  }

  /**
   * The page scrolled by (dx, dy) px since the last frame. A cat riding a page
   * element that scrolled with the page moves with it at once (before physics
   * runs), so it never hovers or gets knocked off by ordinary scrolling. Cats on
   * fixed / sticky elements are left alone, since those don't move.
   */
  /** The ledge under this cat moved by (dx, dy) on its own (the cat tower was dragged or the window resized): ride along. */
  carryWith(dx: number, dy: number): void {
    if (this.held || (dx === 0 && dy === 0)) return;
    this.x += dx;
    this.y += dy;
    this.tail.translate(dx, dy);
    if (this.dest) this.dest = { ...this.dest, x: this.dest.x + dx };
  }

  /** The tower was hidden under this cat: climb out of the cubby's hollow before it falls to the floor. */
  releaseFromTower(): void {
    this.y += this.cubbyDrop;
    this.cubbyDrop = 0;
    this.bedLift = 0;
  }

  shiftForScroll(dx: number, dy: number, env: AgentEnv): void {
    if ((dx === 0 && dy === 0) || this.held) return;
    const movedWithPage = (id: string, oldY: number): Platform | null => {
      const p = env.source.get(id);
      return p && Math.abs(p.y - (oldY - dy)) < 6 ? p : null;
    };
    // The tower is fixed to the window, not to the page: scrolling never carries a cat that is on it.
    if (isTowerPlatform(this.groundId)) return;
    if (this.groundId && this.groundId !== 'floor') {
      const p = movedWithPage(this.groundId, this.y);
      if (!p) return;
      const sx = -dx;
      const sy = p.y - this.y;
      this.x += sx;
      this.y = p.y;
      this.tail.translate(sx, sy);
    } else if (this.jump && this.jump.targetId !== 'floor' && !isTowerPlatform(this.jump.targetId)) {
      // Mid-leap toward a ledge: the whole arc moves with the page.
      const j = this.jump.plan;
      if (!movedWithPage(this.jump.targetId, j.y1)) return;
      j.x0 -= dx;
      j.x1 -= dx;
      j.y0 -= dy;
      j.y1 -= dy;
      j.apexY -= dy;
      this.x -= dx;
      this.y -= dy;
      this.tail.translate(-dx, -dy);
    }
  }

  /* ------------------------------------------------------------- holding */

  /** Picks the cat up by the scruff at (x, y). */
  grab(x: number, y: number, env: AgentEnv): void {
    if (this.held) return;
    this.jump = null;
    this.leapSwat = null;
    this.falling = false;
    this.climb = null;
    this.groundId = null;
    this.plan = [];
    this.planLocked = false;
    this.route = null;
    this.social = null;
    this.afterDrop = false;
    env.station?.releaseAll(this.id);
    if (!this.fsm.force('SCRUFF_HELD')) this.fsm.restore('SCRUFF_HELD');
    const sc = this.lm?.scruff ?? { x, y };
    this.held = { tx: x, ty: y, vx: 0, vy: 0, angle: 0, angVel: 0, offX: sc.x - x, offY: sc.y - y, t: 0 };
    this.vx = 0;
    this.vy = 0;
    this.bliss = 0;
    this.setPurr(env, true, 0.45);
  }

  /** Moves the hand that holds the cat; (vx, vy) is the hand's smoothed velocity in px/s. */
  holdMove(x: number, y: number, vx: number, vy: number): void {
    if (!this.held) return;
    this.held.tx = x;
    this.held.ty = y;
    this.held.vx = vx;
    this.held.vy = vy;
  }

  /** Current pendulum swing angle while held (radians, + = body swings right). */
  get holdAngle(): number {
    return this.held ? this.held.angle : 0;
  }

  /** Lets go: the hand's velocity becomes the throw, then gravity takes over. */
  release(vx: number, vy: number, env: AgentEnv): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    this.setPurr(env, false);
    const S = this.S;
    const W = env.bounds.width;
    const floorY = env.source.floor().y;
    // Re-anchor the physics point under the body's centre (where the feet will be once it
    // rights itself) and fold the difference into the pose root so nothing jumps on screen.
    if (this.skel && !(this.sprite && this.sprite.ready)) {
      const { com } = this.renderer.scruffLocal(this.skel);
      const wc = matApply(this.skel.M, com.x, com.y);
      const nx = clamp(wc.x, 4, W - 4);
      const ny = Math.min(floorY, wc.y + 30 * S);
      const f = this.flip >= 0 ? 1 : -1;
      const ddx = this.x - nx;
      const ddy = this.y - ny;
      // A⁻¹·d with A = Scale(f·S, S)·Rot(rot)
      const ux = ddx / (f * S);
      const uy = ddy / S;
      const c = Math.cos(-this.pose.rot);
      const sn = Math.sin(-this.pose.rot);
      this.pose.rootX += c * ux - sn * uy;
      this.pose.rootY += sn * ux + c * uy;
      this.x = nx;
      this.y = ny;
    } else {
      this.y = Math.min(floorY, this.y);
    }
    const v = clampThrow(vx, vy);
    this.vx = v.vx;
    this.vy = v.vy;
    this.groundId = null;
    this.jump = null;
    this.falling = true;
    this.softFall = false;
    this.afterDrop = true;
    if (!this.fsm.force('FALL_DESCEND')) this.fsm.restore('IDLE_STAND');
    this.decideIn = 4;
  }

  private holdPhysics(dt: number, env: AgentEnv): void {
    const h = this.held as HoldState;
    h.t += dt;
    // Horizontal hand speed (px per 60 Hz frame) drives the swing; the spring-damper settles it.
    pendulumStep(h, h.vx / 60, dt);
    const k = Math.exp(-10 * dt);
    h.offX *= k;
    h.offY *= k;
    this.vx = h.vx;
    this.vy = h.vy;
    // Finish any turn in progress, then hold the facing.
    if (this.flip !== this.facing) this.flip = this.facing;
    // Sprite cats have no rig to pin: line their nape up with the hand using last frame's landmarks.
    if (this.sprite && this.sprite.ready && this.lm) {
      this.x += h.tx + h.offX - this.lm.scruff.x;
      this.y += h.ty + h.offY - this.lm.scruff.y;
    }
    // Held a long time, a cat gets fidgety.
    if (h.t > 8) this.drives.irritation = Math.min(100, this.drives.irritation + dt * 1.5 * (0.5 + this.profile.personality.sassiness));
    void env;
  }

  /* --------------------------------------------------------------- petting */

  /** Continuous stroke over a zone (intensity 0..1). */
  pet(zone: PetZone, dt: number, intensity: number, env: AgentEnv): void {
    if (this.isAirborne() || this.climb || this.held) return;
    const now = env.now;
    if (now - this.lastPetAt > 0.6) {
      this.petTime = 0;
      this.bellyVerdict = null;
    }
    this.lastPetAt = now;
    this.petTime += dt;
    if (zone !== this.petZone) this.petZoneTime = 0;
    this.petZone = zone;
    this.petZoneTime += dt;
    const p = this.profile.personality;
    const eff = ZONE_EFFECTS[zone];
    const loved = zone === 'CHIN_CHEEKS' || zone === 'CROWN_EARS' || zone === 'BACK_BASE_OF_TAIL' || zone === 'SCRUFF';
    const affinity = loved ? this.profile.traits.pettingAffinity : 1;
    this.drives.affection = clamp(this.drives.affection + eff.affection * affinity * intensity * dt, 0, 100);
    this.drives.irritation = clamp(this.drives.irritation + eff.irritation * intensity * dt * (eff.irritation > 0 ? 0.5 + p.sassiness : 1), 0, 100);
    if (eff.affection > 2) this.drives.socialNeed = Math.max(0, this.drives.socialNeed - dt * 1.5);
    // While being petted the cat stays put.
    if (!this.planLocked) {
      this.plan = [];
      this.route = null;
      this.decideIn = 2;
    }
    const st = this.fsm.current;
    const asleep = this.isAsleep();

    if (asleep) {
      if (zone === 'CHIN_CHEEKS' || zone === 'CROWN_EARS' || zone === 'BACK_BASE_OF_TAIL') {
        if (this.petZoneTime > 0.4) this.setPurr(env, true, 0.7);
        return;
      }
      if (this.drives.irritation > 30 || zone === 'TAIL') this.trySquint(env);
      if (this.drives.irritation > 72) this.fsm.request('IDLE_SIT');
      return;
    }
    switch (zone) {
      case 'CHIN_CHEEKS':
        this.bliss = Math.min(1, this.bliss + dt * 3);
        if (this.petZoneTime > 0.5) {
          this.setPurr(env, true, 1);
          if (st !== 'PURRING' && st !== 'KNEADING_BISCUITS' && st !== 'BELLY_UP_ROLL' && !this.social) this.fsm.request('PURRING');
        }
        break;
      case 'CROWN_EARS':
        this.bliss = Math.min(1, this.bliss + dt * 2);
        if (this.rng.chance(dt * 2)) {
          this.earTwitch = 0.22;
          this.earTwitchSide = this.rng.chance(0.5) ? 1 : -1;
        }
        if (this.petZoneTime > 0.6) this.setPurr(env, true, 0.8);
        if (this.petZoneTime > 2.5 && st !== 'KNEADING_BISCUITS' && !this.social) this.fsm.request('KNEADING_BISCUITS');
        break;
      case 'SCRUFF':
        this.bliss = Math.min(1, this.bliss + dt * 1.2);
        if (this.petZoneTime > 0.8) this.setPurr(env, true, 0.6);
        break;
      case 'BACK_BASE_OF_TAIL':
        this.bliss = Math.min(1, this.bliss + dt * 1.5);
        if (this.petZoneTime > 0.7) this.setPurr(env, true, 0.9);
        if (this.petZoneTime > 0.5 && st !== 'ELEVATOR_BUTT' && !this.social && (STATE_META[st].posture === 'stand' || this.drives.affection > 55)) this.fsm.request('ELEVATOR_BUTT');
        break;
      case 'FRONT_PAWS':
        if (now > this.pawTuckReadyAt && (isSitting(st) || isLying(st))) {
          this.pawTuckReadyAt = now + 3;
          this.fsm.request('PAW_TUCK');
        }
        break;
      case 'BELLY':
        if (st === 'BELLY_UP_ROLL' || st === 'BUNNY_KICK_SWAT') {
          if (!this.bellyVerdict) {
            const pBliss = clamp01((this.drives.affection / 100) * (1 - 0.7 * p.sassiness) + 0.12 - this.drives.irritation / 200);
            this.bellyVerdict = this.rng.chance(pBliss) ? 'bliss' : 'kick';
          }
          if (this.bellyVerdict === 'kick') {
            this.fsm.request('BUNNY_KICK_SWAT');
            this.drives.irritation = Math.min(100, this.drives.irritation + dt * 6);
          } else {
            this.bliss = Math.min(1, this.bliss + dt * 2);
            this.setPurr(env, true, 1);
          }
        } else if (this.drives.affection > 72 && isLying(st) && this.petZoneTime > 1) {
          this.fsm.request('BELLY_UP_ROLL');
        }
        break;
      case 'TAIL':
        if (this.drives.irritation > 22 && st !== 'TAIL_LASH' && st !== 'JUDGMENTAL_AIRPLANE_SQUINT') {
          if (this.profile.signature.airplaneSquint && this.isResting() && this.rng.chance(0.5)) this.trySquint(env);
          else this.indignant(env);
        }
        break;
    }
  }

  /** A single click / boop. */
  poke(zone: PetZone | null, env: AgentEnv): void {
    if (this.isAirborne() || this.climb || this.held) return;
    if (this.isAsleep()) {
      if (this.profile.signature.airplaneSquint || this.profile.personality.sassiness > 0.55) this.trySquint(env);
      else this.peekEye = 1.1;
      return;
    }
    if (this.fsm.current === 'BELLY_UP_ROLL' && zone === 'BELLY') {
      this.fsm.request('BUNNY_KICK_SWAT');
      return;
    }
    if (zone === 'TAIL') {
      this.drives.irritation = Math.min(100, this.drives.irritation + 18 * (0.5 + this.profile.personality.sassiness));
      if (this.drives.irritation > 30) this.indignant(env);
      return;
    }
    if (this.lm) env.particles.emit('heart', this.lm.head.x, this.lm.head.y - 12 * this.S, 1, this.S);
  }

  private indignant(env: AgentEnv): void {
    if (this.social) return;
    const away: 1 | -1 = env.cursor.x > this.x ? -1 : 1;
    const p = this.currentPlatform(env) ?? env.source.floor();
    const tx = clamp(this.x + away * 220 * this.S, p.xMin + 30, p.xMax - 30);
    this.setPurr(env, false);
    this.setPlan(
      [
        { kind: 'state', state: 'TAIL_LASH', dur: 99 },
        { kind: 'goto', spot: { platformId: p.id, x: tx }, gait: 'SAUNTER_WALK' },
        { kind: 'state', state: 'IDLE_SIT', dur: this.rng.range(2, 4), face: (away > 0 ? -1 : 1) as 1 | -1 },
        { kind: 'state', state: 'GROOM_LICK_PAW', dur: 99 },
      ],
      'indignant',
      true,
    );
  }

  /** JUDGMENTAL_AIRPLANE_SQUINT: raise head, ears flat at −38°, 40% squint, stare at cursor, back to sleep. */
  trySquint(env: AgentEnv): boolean {
    if (env.now < this.squintReadyAt) return false;
    if (!this.isAsleep() && !this.isResting()) return false;
    this.squintReadyAt = env.now + 9;
    this.fsm.request('JUDGMENTAL_AIRPLANE_SQUINT');
    return true;
  }

  private setPurr(env: AgentEnv, on: boolean, intensity = 1): void {
    if (on === this.purring && !on) return;
    this.purring = on;
  }

  /* ------------------------------------------------------------ animation */

  private poseContext(env: AgentEnv, state: CatState): PoseContext {
    const S = this.S;
    const head = this.lm ? this.lm.head : { x: this.x + this.facing * 35 * S, y: this.y - 56 * S };
    let lx = 0;
    let ly = 0;
    let wantLook = 0;
    let target: Vec2 | null = null;
    const c = env.cursor;
    if (state === 'KEYBOARD_WATCH' && env.typing) target = env.typing.caret;
    else if (this.plan[0]?.kind === 'pounce') target = this.plan[0].target();
    else if (canLook(state) && c.present) {
      const d = dist(c.x, c.y, head.x, head.y);
      if (d < 300 * Math.max(1, S) || state === 'CURSOR_GAZE' || state === 'JUDGMENTAL_AIRPLANE_SQUINT' || state === 'EDGE_PEEK' || state === 'TAIL_LASH' || state === 'STALK_CURSOR') target = { x: c.x, y: c.y };
    }
    if (!target && this.social?.partner?.lm && canLook(state)) target = this.social.partner.lm.head;
    if (target) {
      const dx = (target.x - head.x) * (this.flip >= 0 ? 1 : -1);
      const dy = target.y - head.y;
      lx = clamp(dx / (160 * S), -1, 1);
      ly = clamp(dy / (140 * S), -1, 1);
      wantLook = 1;
    }
    this.lookTarget = target;
    this.lookActive += (wantLook - this.lookActive) * (1 - Math.exp(-4 * 0.016));
    // Distance to the ledge edge ahead (local units), for edge postures.
    const p = this.currentPlatform(env);
    let edge = Infinity;
    if (p && p.kind === 'dom') edge = (this.facing > 0 ? p.xMax - this.x : this.x - p.xMin) / S;
    this.edgeAhead = edge;
    const partner = this.social?.partner ?? null;
    let partnerTopY = NaN;
    if (partner?.lm) partnerTopY = (partner.lm.backTop.y - this.y) / S;
    return {
      t: this.fsm.time,
      progress: this.fsm.progress,
      gaitPhase: this.gaitPhase,
      vx: (this.vx * this.facing) / S,
      vy: this.vy / S,
      lookX: lx,
      lookY: ly,
      lookActive: this.lookActive,
      edgeAhead: edge,
      partnerTopY,
      partnerDX: partner ? ((partner.x - this.x) * this.facing) / S : NaN,
      role: this.poseRole,
      seed: this.seed,
      chonk: this.profile.morphology.chonk,
      sitting: isSitting(this.fsm.previous) || isSitting(this.fsm.current),
      lying: isLying(this.fsm.previous),
    };
  }

  private animate(dt: number, env: AgentEnv): void {
    const state = this.fsm.current;
    const meta0 = STATE_META[state];
    const ctx = this.poseContext(env, state);
    let target: Pose;
    if (this.climb && state === 'EDGE_PEEK') {
      target = computePose('WALL_CLIMB', { ...ctx, gaitPhase: 0.12 });
      target.headRot = 1.05 + ctx.lookY * 0.3;
      target.faceTurn = 0.05;
      target.lookX = ctx.lookX;
      target.lookY = ctx.lookY;
    } else {
      target = computePose(state, ctx);
    }

    // Expression overlays.
    if (this.bliss > 0.05 && !this.isAsleep()) {
      target.eyeOpen *= 1 - 0.85 * this.bliss;
      target.headRot += (this.lookTarget ? clamp((this.lookTarget.x - this.x) * this.facing * 0.002, -0.3, 0.3) : -0.2) * this.bliss;
      target.earL = Math.min(target.earL, -4);
      target.earR = Math.min(target.earR, -4);
    }
    // Annoyed or overstimulated: "airplane ears". Expressive cats (Anna) show it much sooner.
    const earLimit = 58 - 30 * this.profile.traits.earExpressiveness;
    if (!this.isAsleep() && this.drives.irritation > earLimit) {
      const k = smoothstep(earLimit, earLimit + 12, this.drives.irritation);
      target.earL = Math.min(target.earL, target.earL + (-36 - target.earL) * k);
      target.earR = Math.min(target.earR, target.earR + (-36 - target.earR) * k);
      target.tailWhip = Math.max(target.tailWhip, 0.5 * k);
    }
    // Waking slowly: one long, soft blink before the stretch.
    if (this.slowBlinkT >= 0) {
      const b = this.slowBlinkT;
      const open = b < 0.5 ? smoothstep(0, 0.5, b) * 0.45 : b < 0.8 ? 0.45 : b < 1.15 ? 0.45 * (1 - smoothstep(0.8, 1.15, b)) : 0.6 * smoothstep(1.15, 1.6, b);
      target.eyeOpen = Math.max(target.eyeOpen, open);
    }
    // A friendly greeting: tail straight up with a little hook at the tip ("question mark").
    if (env.now < this.greetUntil && !this.isAsleep() && meta0.posture === 'stand') {
      target.tailAngle = -1.62;
      target.tailCurl = 0.62;
      target.tailStiff = 0.78;
      target.tailWave = 0.04;
      target.tailWhip = 0;
      target.earL = Math.max(target.earL, 4);
      target.earR = Math.max(target.earR, 4);
    }
    if (this.peekEye > 0 && this.isAsleep()) target.eyeOpen = Math.max(target.eyeOpen, 0.35 * Math.sin(Math.PI * clamp01(this.peekEye / 1.1)));
    if (this.earTwitch > 0) {
      const tw = Math.sin((this.earTwitch / 0.28) * Math.PI) * 16;
      if (this.earTwitchSide > 0) target.earR += tw;
      else target.earL += tw;
    }
    if (this.blinkT >= 0 && target.eyeOpen > 0.15) {
      // Fast close, brief hold, slower open.
      const b = this.blinkT;
      const closed = b < 0.06 ? smoothstep(0, 0.06, b) : b < 0.085 ? 1 : 1 - smoothstep(0.085, 0.21, b);
      target.eyeOpen *= 1 - closed;
    }
    // Life while idle: slow head drift and the occasional glance around.
    const calm = !meta0.locomotion && meta0.posture !== 'air' && !this.isAsleep() && !this.isPetted();
    if (calm) {
      const tt = env.now;
      target.headRot += noise1(tt * 0.33, this.seed * 91) * 0.035;
      if (this.glance.t > 0 && this.lookActive < 0.5) {
        const w = smoothstep(0, 0.25, this.glance.t) * (1 - this.lookActive * 2);
        target.lookX += (this.glance.x - target.lookX) * w;
        target.lookY += (this.glance.y - target.lookY) * w;
        target.headRot += this.glance.y * 0.18 * w;
      }
    }

    // Vertical pounce: body stretched up, both front paws reaching for the target.
    if (this.leapSwat && this.jump) {
      const up = this.vy < 0 ? 1 : 0.45;
      target.rot = -0.78 * up;
      target.fnX = 44;
      target.fnY = -36 * up - 6;
      target.ffX = 38;
      target.ffY = -26 * up - 4;
      target.fnCurl = target.ffCurl = 0.45;
      target.hnX = -34;
      target.hnY = 2;
      target.hfX = -30;
      target.hfY = 4;
      target.pupil = 1;
      target.earL = target.earR = 5;
      target.headRot = -0.25 * up;
    }

    // Held by the scruff: rotate the hanging body so its centre of mass sits under the nape, plus the swing.
    const held = this.held;
    if (held && this.skel) {
      const { scruff, com } = this.renderer.scruffLocal(this.skel);
      const f = this.flip >= 0 ? 1 : -1;
      target.rot = Math.PI / 2 - Math.atan2(com.y - scruff.y, com.x - scruff.x) - f * held.angle;
    }

    // Blend toward the target pose; airborne & reactive states blend faster.
    const meta = STATE_META[state];
    const rate = meta.posture === 'air' ? 14 : meta.posture === 'held' ? 9 : meta.posture === 'sleep' ? 3.2 : state === 'POUNCE_AND_PIN' || state === 'BUNNY_KICK_SWAT' || state === 'TAIL_LASH' ? 12 : meta.locomotion ? 10 : 6.5;
    // Gait-driven feet must not lag (prevents foot skating).
    this.poseSpring.step(this.pose, target, rate, dt);
    if (meta.locomotion) {
      for (const k of ['fnX', 'fnY', 'ffX', 'ffY', 'hnX', 'hnY', 'hfX', 'hfY'] as const) this.poseSpring.pin(this.pose, k, target[k]);
    }

    // Skeleton + tail (world-space Verlet).
    const S = this.S;
    // Lying or sitting in a bed: the body rests on the cushion, a little above the floor.
    const inBed = this.groundId === 'floor' && !meta.locomotion && (meta.posture === 'sleep' || meta.posture === 'lie' || meta.posture === 'sit') && !!env.beds?.enabled && env.beds.bedAt(this.x, env.bounds) !== null;
    // On the cat tower: lifted onto the crown's bolster, or sunk into the cubby with head and paws peeking out.
    const onTower = env.tower?.enabled && !meta.locomotion && isTowerPlatform(this.groundId) ? env.tower.restOffset(this.groundId, this.x, meta.posture, env.bounds) : null;
    const ease = 1 - Math.exp(-6 * dt);
    this.bedLift += ((inBed ? BED_LIFT * S : onTower ? onTower.lift : 0) - this.bedLift) * ease;
    if (this.bedLift < 0.05) this.bedLift = 0;
    this.cubbyDrop += ((onTower ? onTower.drop : 0) - this.cubbyDrop) * ease;
    if (this.cubbyDrop < 0.05) this.cubbyDrop = 0;
    const tr = { x: this.x, y: this.y - this.bedLift + this.cubbyDrop, flip: this.flip === 0 ? 0.001 : this.flip, scale: S };
    this.skel = this.renderer.skeleton(this.pose, tr, env.now);
    if (held && !(this.sprite && this.sprite.ready)) {
      // Pin the nape to the hand: translate the whole rig (and the physics point) onto it.
      const { scruff } = this.renderer.scruffLocal(this.skel);
      const ws = matApply(this.skel.M, scruff.x, scruff.y);
      const ddx = held.tx + held.offX - ws.x;
      const ddy = held.ty + held.offY - ws.y;
      this.x += ddx;
      this.y += ddy;
      this.skel.M = { ...this.skel.M, e: this.skel.M.e + ddx, f: this.skel.M.f + ddy };
    }
    const anchor = this.renderer.tailAnchorWorld(this.skel, this.pose, dt);
    // Seated, loafing, watching or asleep: the tail settles and then stays perfectly still.
    const still = !held && isTailStill(state) && !this.isPetted() ? 1 : 0;
    const k = 1 - Math.exp(-(still ? 3.2 : 9) * dt);
    this.tailStill += (still - this.tailStill) * k;
    if (still && this.tailStill > 0.985) this.tailStill = 1;
    if (!still && this.tailStill < 0.02) this.tailStill = 0;
    const params: TailParams = {
      baseAngle: anchor.angle,
      curl: this.pose.tailCurl,
      waveAmp: this.pose.tailWave,
      waveFreq: this.pose.tailFreq,
      whip: this.pose.tailWhip,
      stiffness: this.pose.tailStiff,
      gravity: this.pose.tailGravity,
      damping: 0.94,
      maxBend: 1.15,
      handedness: this.flip >= 0 ? 1 : -1,
      still: this.tailStill,
      maxNodeSpeed: 420 * S,
    };
    this.tail.segLen = 10.5 * S * this.profile.morphology.tailLength;
    if (held) {
      // Hanging: the tail droops under gravity and swings against the hand's acceleration.
      params.gravity = 620 + Math.max(0, -held.vy) * 0.4;
      params.stiffness = 0.06;
      params.curl = clamp(-held.angVel * 0.08, -0.25, 0.25);
    }
    const p = this.groundId ? this.currentPlatform(env) : null;
    const groundY = p ? p.y - (p.kind === 'floor' || isTowerPlatform(p.id) ? this.bedLift - this.cubbyDrop : 0) : Infinity;
    const ground = p ? (x: number) => (x >= p.xMin - 2 && x <= p.xMax + 2 ? groundY : Infinity) : null;
    this.tail.step(dt, anchor.x, anchor.y, params, ground, 2.6 * S);
  }

  /* ---------------------------------------------------------------- draw */

  draw(ctx: AnyCtx, env: AgentEnv, alpha = 1): Landmarks | null {
    const S = this.S;
    if (this.sprite && this.sprite.ready) {
      const moving: 1 | -1 | 0 = Math.abs(this.vx) > 5 ? (this.vx > 0 ? 1 : -1) : 0;
      this.lm = this.sprite.draw(ctx, this.fsm.current, this.fsm.time, this.x, this.y + this.cubbyDrop, this.facing, S, moving, alpha);
      return this.lm;
    }
    if (!this.skel) return null;
    const groundY = this.groundId ? this.y - this.bedLift + this.cubbyDrop : NaN;
    this.lm = this.renderer.draw(ctx, this.skel, this.pose, this.tail, S, { time: env.now, grounded: !!this.groundId, groundY, alpha });
    return this.lm;
  }

  /** Recomputes hit-test landmarks from the current rig without drawing (frames skipped by the drowsy throttle, tests). */
  refreshLandmarks(): Landmarks | null {
    if (this.sprite && this.sprite.ready) return this.lm;
    if (this.skel) this.lm = this.renderer.landmarks(this.skel, this.tail, this.S);
    return this.lm;
  }

  /* ------------------------------------------------------- persistence */

  snapshot(bounds: WorldBounds): CatRuntimeSnapshot {
    return {
      id: this.id,
      name: this.profile.name,
      state: this.fsm.current,
      drives: { ...this.drives },
      relX: clamp(this.x / Math.max(1, bounds.width), 0, 1),
      relY: clamp(this.y / Math.max(1, bounds.height), 0, 1),
      facing: this.facing,
      onFloor: this.groundId === 'floor' || this.groundId === null,
    };
  }

  restore(snap: CatRuntimeSnapshot, env: AgentEnv, elapsedSeconds = 0): void {
    this.drives = completeDrives(snap.drives, this.profile.personality, this.profile.traits);
    if (elapsedSeconds > 0) driftDrives(this.drives, elapsedSeconds, this.profile.personality, this.profile.traits);
    this.held = null;
    this.afterDrop = false;
    this.x = clamp(snap.relX * env.bounds.width, 10, env.bounds.width - 10);
    this.facing = snap.facing;
    this.flip = snap.facing;
    let p: Platform = env.source.floor();
    if (!snap.onFloor) {
      const found = platformBelow(this.x, snap.relY * env.bounds.height - 4, env.platforms);
      if (found) p = found;
    }
    this.groundId = p.id;
    this.y = p.y;
    this.jump = null;
    this.falling = false;
    this.climb = null;
    this.fsm.restore(snap.state);
    this.pose = clonePose(computePose(this.fsm.current, this.poseContext(env, this.fsm.current)));
    this.poseSpring.reset();
    this.tail.reset(this.x - this.facing * 30 * this.S, this.y - 20 * this.S, this.facing > 0 ? Math.PI : 0);
    this.plan = [];
    this.planLocked = false;
    if (this.isAsleep()) this.setPlan([{ kind: 'state', state: this.fsm.current, dur: this.rng.range(30, 90) }], 'sleep');
    this.decideIn = this.rng.range(0.5, 2);
  }

  /** Places the cat on a platform (used when spawning or calling cats). */
  placeOn(p: Platform, x: number): void {
    this.parked = false;
    this.groundId = p.id;
    this.x = x;
    this.y = p.y;
    this.jump = null;
    this.falling = false;
    this.climb = null;
    this.tail.reset(this.x - this.facing * 30 * this.S, this.y - 20 * this.S, this.facing > 0 ? Math.PI : 0);
  }

  /** Drops the cat in from above (first appearance on a page). */
  dropIn(x: number, y: number): void {
    this.groundId = null;
    this.x = x;
    this.y = y;
    this.falling = true;
    this.softFall = true;
    this.vy = 0;
    this.fsm.restore('IDLE_STAND');
    this.fsm.force('FALL_DESCEND');
    this.pose = makePose();
    this.poseSpring.reset();
  }

  /** Starts the slow wake-up blink (idle wake-up greeting). */
  slowBlink(): void {
    this.slowBlinkT = 0;
  }

  /** Raises a question-mark tail and purrs for a few seconds (greeting the returning human). */
  greet(env: AgentEnv, seconds = 7): void {
    this.greetUntil = env.now + seconds;
    this.setPurr(env, true, 0.55);
  }

  /** Forces an exact state (Studio "trigger state" buttons) via the natural chain. */
  requestState(state: CatState, env: AgentEnv, hold = 12): void {
    this.setPlan([{ kind: 'state', state, dur: hold }], `debug:${state}`, true);
    void env;
  }

  dispose(env: AgentEnv | null): void {
    env?.station?.releaseAll(this.id);
  }
}
