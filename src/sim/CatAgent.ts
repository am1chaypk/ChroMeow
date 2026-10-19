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
 */
import type { CatState } from '../shared/catStates';
import { clamp, clamp01, dist, type Vec2 } from '../shared/math';
import { Rng, hashString } from '../shared/rng';
import type { CatProfile, CatRuntimeSnapshot, Drives } from '../shared/types';
import { FelineFSM } from '../ai/FelineFSM';
import { STATE_META, isAirborne, isLying, isSitting, isSleep } from '../ai/States';
import { UtilityBrain, type BrainContext, type IntentKind } from '../ai/UtilityBrain';
import { defaultDrives, driftDrives, updateDrives } from '../ai/Drives';
import { ZONE_EFFECTS, type PetZone } from '../ai/HitboxZones';
import { ArticulatedCatRenderer, type Landmarks, type Skeleton } from '../engine/ArticulatedCatRenderer';
import { SpriteRenderer } from '../engine/SpriteRenderer';
import { DEFAULT_POSE_CONTEXT, GAITS, canLook, computePose, type PoseContext } from '../engine/PoseLibrary';
import { clonePose, followPose, makePose, type Pose } from '../engine/Pose';
import { VerletTail, type TailParams } from '../engine/VerletTail';
import { findLanding, isScrollViolent, platformBelow, platformWidth, solveJump, trajectoryAt, applyFriction, fallStep, type JumpPlan, type Platform, type PlatformSource, type WorldBounds } from '../engine/Physics';
import { planRoute, type NavJump, type NavPlan } from '../engine/Navigator';
import type { ParticleSystem } from '../engine/Particles';
import type { SoundSynthesizer } from '../engine/SoundSynthesizer';
import type { AnyCtx } from '../engine/canvas';
import type { Toy, ToyManager } from '../content/ToyManager';

export type Gait = 'SAUNTER_WALK' | 'TROT' | 'ZOOMIES_SPRINT' | 'STALK_CURSOR' | 'PLAY_TAG_CHASE' | 'JEALOUSY_INTERVENTION';

export interface Spot {
  platformId: string;
  x: number;
}

export type Task =
  | { kind: 'goto'; spot: Spot | (() => Spot | null); gait: Gait; face?: 1 | -1; tol?: number; offscreen?: boolean; maxTime?: number }
  | { kind: 'state'; state: CatState; dur: number; face?: 1 | -1 | (() => 1 | -1 | 0); role?: 0 | 1 }
  | { kind: 'climb'; side: 1 | -1; height: number; cling: number }
  | { kind: 'pounce'; target: () => Vec2 | null; onPin?: () => void }
  | { kind: 'eat'; toy: Toy }
  | { kind: 'do'; fn: () => void };

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
  sound: SoundSynthesizer | null;
  others: CatAgent[];
  catScale: number;
  calm: boolean;
  hour: number;
  social: SocialHooks;
}

export interface SocialLink {
  sessionId: number;
  role: 0 | 1;
  partner: CatAgent | null;
}

const BODY_LEN = 74;

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
  private jump: { plan: JumpPlan; t: number; targetId: string } | null = null;
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
    this.drives = defaultDrives(profile.personality);
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
    return !this.social && !this.planLocked && !this.isAirborne() && !this.climb && !this.isPetted() && this.groundId !== null;
  }

  currentPlatform(env: AgentEnv): Platform | null {
    if (!this.groundId) return null;
    return env.platforms.find((p) => p.id === this.groundId) ?? (this.groundId === 'floor' ? env.source.floor() : null);
  }

  /* --------------------------------------------------------------- plans */

  setPlan(tasks: Task[], label: string, locked = false): void {
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
    this.plan = [];
    this.planLocked = false;
    this.planLabel = '';
    this.route = null;
    this.decideIn = this.rng.range(0.4, 1.4);
  }

  private completeTask(): void {
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
    if (to === 'CROUCH_PREP_JUMP') this.fsm.setDuration(this.taskFlag === 2 ? this.rng.range(1.0, 1.6) : this.rng.range(0.26, 0.34) + 0.2);
    void from;
  }

  /* -------------------------------------------------------------- update */

  update(dt: number, env: AgentEnv): void {
    this.now = env.now;
    this.catScale = env.catScale;
    this.updateDrivesAndTimers(dt, env);

    // Brain
    this.brain.tick(dt);
    this.decideIn -= dt;
    if (!this.planLocked && !this.isAirborne() && !this.climb && this.decideIn <= 0) this.think(env);

    this.desiredVX = 0;
    this.runTasks(dt, env);
    this.physics(dt, env);
    this.fsm.update(dt);
    this.animate(dt, env);
  }

  private updateDrivesAndTimers(dt: number, env: AgentEnv): void {
    const pettedNicely = this.isPetted() && this.petZone !== null && ZONE_EFFECTS[this.petZone].affection > 2;
    const partner = this.nearestOther(env);
    updateDrives(this.drives, this.fsm.current, dt, this.profile.personality, {
      social: !!this.social,
      pettedNicely,
      alone: !partner || dist(partner.x, partner.y, this.x, this.y) > 500,
    });
    if (!this.isPetted()) {
      this.petTime = 0;
      this.petZoneTime = 0;
      this.bellyVerdict = null;
      this.bliss = Math.max(0, this.bliss - dt * 2.5);
      if (this.purring && this.fsm.current !== 'PURRING' && this.fsm.current !== 'KNEADING_BISCUITS') this.setPurr(env, false);
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
      if (this.blinkT > 0.16) this.blinkT = -1;
    } else {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) {
        this.blinkT = 0;
        this.nextBlink = this.rng.range(2.2, 6.5);
      }
    }
    // Sleeping cats drift little z's.
    if (this.isAsleep() && this.rng.chance(dt * 0.35) && this.lm) env.particles.emit('z', this.lm.head.x + this.facing * 8 * this.S, this.lm.head.y - 12 * this.S, 1, this.S);
    if (this.purring && this.lm && this.rng.chance(dt * 1.4)) env.particles.emit('heart', this.lm.head.x, this.lm.head.y - 14 * this.S, 1, this.S);
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
    };
  }

  think(env: AgentEnv): void {
    if (this.isPetted()) {
      this.decideIn = 1;
      return;
    }
    const decision = this.brain.decide(this.brainContext(env));
    this.decideIn = this.rng.range(3, 5.5);
    if (!decision.switched && this.plan.length > 0) return;
    // Don't abandon a nap the cat is already enjoying just to re-plan it.
    if (decision.intent === 'sleep' && this.isAsleep() && this.plan.length > 0) return;
    this.intent = decision.intent;
    this.makePlan(decision.intent, env);
  }

  /** Forces an intent from outside (popup "call cats", studio state buttons…). */
  command(intent: IntentKind, env: AgentEnv): void {
    this.brain.set(intent);
    this.intent = intent;
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
        let p: Platform | null = null;
        let state: CatState = r.chance(0.55) ? 'CURLED_SLEEP' : 'SPRAWLED_SLEEP';
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
        this.setPlan(
          [
            { kind: 'goto', spot: spot ?? this.spotOn(p, p.id === here.id ? this.x : undefined), gait: 'SAUNTER_WALK', face },
            ...(state === 'CHIN_PROP_SLEEP' ? [{ kind: 'state', state: 'LEDGE_CHIN_REST', dur: r.range(3, 7) } as Task] : []),
            { kind: 'state', state, dur: r.range(45, 140) },
          ],
          'sleep',
        );
        return;
      }
      case 'rest': {
        const stay = r.chance(0.6);
        const p = stay ? here : this.pickPlatform(env, (pl) => 1 / (1 + dist(pl.xMin, pl.y, this.x, this.y) / 400)) ?? here;
        const elevated = p.kind === 'dom';
        let state: CatState = r.weighted<CatState>(['IDLE_SIT', 'CAT_LOAF', 'SPHINX_POSE'], [1, 1 + pers.laziness, 0.8]);
        let spot = this.spotOn(p, stay ? this.x : undefined);
        let face: 1 | -1 | undefined;
        if (elevated && r.chance(0.45)) {
          const e = this.edgeSpotOn(p);
          spot = e.spot;
          face = e.face;
          state = sig.widePawSplay && r.chance(0.5) ? 'WIDE_PAW_SPLAY' : r.weighted<CatState>(['DANGLE_PAWS', 'LEDGE_CHIN_REST'], [1, sig.chinPropSleep ? 2 : 0.8]);
        }
        this.setPlan([{ kind: 'goto', spot, gait: 'SAUNTER_WALK', face }, { kind: 'state', state, dur: r.range(8, 22) }], 'rest');
        return;
      }
      case 'perch': {
        const p = this.pickPlatform(env, (pl) => (pl.kind === 'dom' ? 1 + (pl.narrow ? (sig.meltedLoafSleep ? 2 : 0.5) : 0) + (1 - pl.y / env.bounds.height) : 0)) ?? here;
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
                env.sound?.chirp();
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
        const spot: Spot = usable ? { platformId: t.platformId, x: clamp(t.caret.x + 46 * S, t.xMin + 30 * S, t.xMax - 30 * S) } : { platformId: 'floor', x: t.caret.x };
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
        const toy = env.toys.nearest(this.x, this.y, ['ball', 'laser']);
        if (!toy) {
          this.makePlan('explore', env);
          return;
        }
        const spotFn = (): Spot | null => {
          if (!env.toys.toys.includes(toy)) return null;
          const pl = platformBelow(toy.x, toy.y - 4, env.platforms) ?? env.source.floor();
          return { platformId: pl.id, x: toy.x - Math.sign(toy.x - this.x || 1) * 34 * S };
        };
        this.setPlan(
          [
            { kind: 'goto', spot: spotFn, gait: toy.kind === 'laser' ? 'ZOOMIES_SPRINT' : 'TROT', tol: 18 * S, maxTime: 5 },
            {
              kind: 'pounce',
              target: () => (env.toys.toys.includes(toy) ? { x: toy.x, y: toy.y } : null),
              onPin: () => {
                if (env.toys.toys.includes(toy)) env.toys.swat(toy, this.facing, 1);
                if (this.lm) env.particles.emit('spark', this.lm.paws[0].x, this.lm.paws[0].y, 5, S);
              },
            },
          ],
          'toy',
        );
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
        env.sound?.meow(1.05 + this.seed * 0.2, 0.5);
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

  /* ------------------------------------------------------------ executor */

  private turn(dir: 1 | -1): void {
    if (dir !== this.facing) this.facing = dir;
  }

  private get turning(): boolean {
    return Math.abs(this.flip - this.facing) > 0.08;
  }

  private walkTo(targetX: number, gait: Gait, env: AgentEnv, tol: number): boolean {
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
    this.jump = { plan, t: 0, targetId: hop.to };
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
          this.route = planRoute(env.platforms, this.groundId, this.x, spot.platformId, spot.x, env.bounds);
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
        if (this.walkTo(fx, task.gait, env, task.tol ?? 6 * this.S)) {
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
          if (Math.abs(dx) > 68 * S) {
            const dir: 1 | -1 = dx > 0 ? 1 : -1;
            this.walkTo(tg.x - dir * 52 * S, 'STALK_CURSOR', env, 10 * S);
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
            env.sound?.chirp();
          } else if (this.fsm.current !== 'CROUCH_PREP_JUMP' && this.taskTime > 3) this.completeTask();
          else if (this.fsm.current !== 'CROUCH_PREP_JUMP') this.fsm.request('CROUCH_PREP_JUMP');
          return;
        }
        if (this.taskFlag >= 3) {
          if (this.fsm.current === 'POUNCE_AND_PIN') {
            if (this.fsm.time < 0.38) {
              // The lunge: snap velocity straight to the target (no gait smoothing).
              const goal = tg.x - this.facing * 34 * S;
              this.desiredVX = clamp((goal - this.x) / 0.18, -520 * S, 520 * S);
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
      case 'do': {
        this.completeTask();
        task.fn();
        return;
      }
    }
  }

  /* ------------------------------------------------------------- physics */

  private startFall(env: AgentEnv, startled: boolean): void {
    this.groundId = null;
    this.jump = null;
    this.climb = null;
    this.falling = true;
    this.softFall = startled;
    this.vy = startled ? -90 * this.S : 0;
    if (startled) {
      if (!this.fsm.force('STARTLED_AIRBORNE')) this.fsm.restore('IDLE_STAND');
      if (this.lm) env.particles.emit('bang', this.lm.head.x + 10 * this.S, this.lm.head.y - 18 * this.S, 1, this.S);
      env.sound?.mrrp(1.4);
    } else if (!this.fsm.force('FALL_DESCEND')) this.fsm.force('STARTLED_AIRBORNE');
    this.plan = [];
    this.planLocked = false;
    this.route = null;
    this.social = null;
  }

  private land(p: Platform, env: AgentEnv, impact: number): void {
    this.jump = null;
    this.falling = false;
    this.groundId = p.id;
    this.y = p.y;
    this.vy = 0;
    this.fsm.force('LAND_RECOVERY');
    if (impact > 520) env.particles.emit('puff', this.x, this.y - 2, 4, this.S);
    const route = this.route;
    if (route && route.hops[this.hop] && route.hops[this.hop].to === p.id) this.hop++;
    else this.route = null;
    // Clumsiness: a cute slip on landing, followed by dignified "I meant that" grooming.
    if (p.kind === 'dom' && this.rng.chance(this.profile.personality.clumsiness * 0.14)) {
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
      const step = dt * 11;
      this.flip = Math.abs(this.facing - this.flip) <= step ? this.facing : this.flip + Math.sign(this.facing - this.flip) * step;
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
      if (this.vy > 0 && this.fsm.current === 'JUMP_ASCEND') this.fsm.force('FALL_DESCEND');
      if (this.vy > 0) {
        const land = findLanding(prevY, this.y, this.x, env.platforms);
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
      this.x = clamp(this.x + this.vx * dt, 4, W - 4);
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
        if (isScrollViolent(dy, dt) && !this.climb) {
          this.startFall(env, true);
          return;
        }
        if (p.y > env.bounds.height - 3) {
          this.groundId = 'floor';
          this.y = env.source.floor().y;
          this.route = null;
        } else if (p.y < 30) {
          this.startFall(env, true);
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
      const offscreenTask = this.plan[0]?.kind === 'goto' && (this.plan[0] as { offscreen?: boolean }).offscreen;
      const p = this.currentPlatform(env);
      if (p && !offscreenTask) {
        const lo = p.kind === 'floor' ? 6 * S : p.xMin + 4;
        const hi = p.kind === 'floor' ? W - 6 * S : p.xMax - 4;
        nx = clamp(nx, lo, hi);
      } else if (offscreenTask) nx = clamp(nx, -this.bodyLen(), W + this.bodyLen());
      this.x = nx;
    }
    const g = GAITS[this.fsm.current];
    if (g && Math.abs(this.vx) > 1) this.gaitPhase += (Math.abs(this.vx) * dt * g.stance) / (g.stride * S);
  }

  /* --------------------------------------------------------------- petting */

  /** Continuous stroke over a zone (intensity 0..1). */
  pet(zone: PetZone, dt: number, intensity: number, env: AgentEnv): void {
    if (this.isAirborne() || this.climb) return;
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
    sound(env)?.unlock();
    const p = this.profile.personality;
    const eff = ZONE_EFFECTS[zone];
    this.drives.affection = clamp(this.drives.affection + eff.affection * intensity * dt, 0, 100);
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
    sound(env)?.unlock();
    if (this.isAirborne() || this.climb) return;
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
    env.sound?.mrrp(1 + this.seed * 0.3);
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
    env.sound?.mrrp(0.8);
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
    env.sound?.purr(this.id, on, intensity);
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
    if (!this.isAsleep() && this.drives.irritation > 58) {
      target.earL = Math.min(target.earL, -34);
      target.earR = Math.min(target.earR, -34);
      target.tailWhip = Math.max(target.tailWhip, 0.5);
    }
    if (this.peekEye > 0 && this.isAsleep()) target.eyeOpen = Math.max(target.eyeOpen, 0.35 * Math.sin(Math.PI * clamp01(this.peekEye / 1.1)));
    if (this.earTwitch > 0) {
      const tw = Math.sin((this.earTwitch / 0.28) * Math.PI) * 16;
      if (this.earTwitchSide > 0) target.earR += tw;
      else target.earL += tw;
    }
    if (this.blinkT >= 0 && target.eyeOpen > 0.15) target.eyeOpen *= 1 - Math.sin((this.blinkT / 0.16) * Math.PI);

    // Blend toward the target pose; airborne & reactive states blend faster.
    const meta = STATE_META[state];
    const rate = meta.posture === 'air' ? 14 : meta.posture === 'sleep' ? 3.2 : state === 'POUNCE_AND_PIN' || state === 'BUNNY_KICK_SWAT' || state === 'TAIL_LASH' ? 12 : meta.locomotion ? 10 : 6.5;
    // Gait-driven feet must not lag (prevents foot skating).
    followPose(this.pose, target, rate, dt);
    if (meta.locomotion) {
      this.pose.fnX = target.fnX;
      this.pose.fnY = target.fnY;
      this.pose.ffX = target.ffX;
      this.pose.ffY = target.ffY;
      this.pose.hnX = target.hnX;
      this.pose.hnY = target.hnY;
      this.pose.hfX = target.hfX;
      this.pose.hfY = target.hfY;
    }

    // Skeleton + tail (world-space Verlet).
    const S = this.S;
    const tr = { x: this.x, y: this.y, flip: this.flip === 0 ? 0.001 : this.flip, scale: S };
    this.skel = this.renderer.skeleton(this.pose, tr, env.now);
    const anchor = this.renderer.tailAnchorWorld(this.skel, this.pose);
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
    };
    this.tail.segLen = 10.5 * S * this.profile.morphology.tailLength;
    const p = this.groundId ? this.currentPlatform(env) : null;
    const groundY = p ? p.y : Infinity;
    const ground = p ? (x: number) => (x >= p.xMin - 2 && x <= p.xMax + 2 ? groundY : Infinity) : null;
    this.tail.step(dt, anchor.x, anchor.y, params, ground, 2.6 * S);
  }

  /* ---------------------------------------------------------------- draw */

  draw(ctx: AnyCtx, env: AgentEnv, alpha = 1): Landmarks | null {
    const S = this.S;
    if (this.sprite && this.sprite.ready) {
      const moving: 1 | -1 | 0 = Math.abs(this.vx) > 5 ? (this.vx > 0 ? 1 : -1) : 0;
      this.lm = this.sprite.draw(ctx, this.fsm.current, this.fsm.time, this.x, this.y, this.facing, S, moving, alpha);
      return this.lm;
    }
    if (!this.skel) return null;
    const groundY = this.groundId ? this.y : NaN;
    this.lm = this.renderer.draw(ctx, this.skel, this.pose, this.tail, S, { time: env.now, grounded: !!this.groundId, groundY, alpha });
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
    this.drives = { ...snap.drives };
    if (elapsedSeconds > 0) driftDrives(this.drives, elapsedSeconds, this.profile.personality);
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
    this.tail.reset(this.x - this.facing * 30 * this.S, this.y - 20 * this.S, this.facing > 0 ? Math.PI : 0);
    this.plan = [];
    this.planLocked = false;
    if (this.isAsleep()) this.setPlan([{ kind: 'state', state: this.fsm.current, dur: this.rng.range(30, 90) }], 'sleep');
    this.decideIn = this.rng.range(0.5, 2);
  }

  /** Places the cat on a platform (used when spawning or calling cats). */
  placeOn(p: Platform, x: number): void {
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
  }

  /** Forces an exact state (Studio "trigger state" buttons) via the natural chain. */
  requestState(state: CatState, env: AgentEnv, hold = 12): void {
    this.setPlan([{ kind: 'state', state, dur: hold }], `debug:${state}`, true);
    void env;
  }

  dispose(env: AgentEnv | null): void {
    env?.sound?.purr(this.id, false);
  }
}

function sound(env: AgentEnv): SoundSynthesizer | null {
  return env.sound;
}
