/**
 * World — runs the shared simulation: all cats, the social coordinator, toys,
 * the food & water station, particles and pointer interaction. DOM-agnostic: the
 * content script feeds it the real page (DomPlatformScanner) while Cat Studio
 * feeds it a mock page.
 *
 * Pointer: hovering pets; a press that drags more than 5 px (or a press right on
 * the scruff) picks the cat up, and letting go drops or throws it.
 */
import type { CatState } from '../shared/catStates';
import { clamp, clamp01, dist } from '../shared/math';
import type { BowlKind, CatProfile, FeedingStation, Settings, WorldSnapshot } from '../shared/types';
import { DEFAULT_STATION } from '../shared/storage';
import { displayName } from '../shared/i18n';
import { mixHex } from '../shared/color';
import { releaseVelocity, type MotionSample } from './ToyTool';
import { StationModel, type StationHit } from './FeedingStation';
import { SocialCoordinator } from '../ai/SocialCoordinator';
import { classifyZone, onCat, type PetZone } from '../ai/HitboxZones';
import type { IntentKind } from '../ai/UtilityBrain';
import { ParticleSystem } from '../engine/Particles';
import { allPlatforms, type Platform, type PlatformSource } from '../engine/Physics';
import type { AnyCtx } from '../engine/canvas';
import { ToyManager } from '../content/ToyManager';
import { CatAgent, type AgentEnv, type CursorInfo, type TypingInfo } from './CatAgent';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CursorSample {
  x: number;
  y: number;
  t: number;
}

/** Tracks pointer motion to derive speed, idleness and "prey-like" erraticness. */
export class CursorTracker {
  x = -9999;
  y = -9999;
  present = false;
  down = false;
  private samples: CursorSample[] = [];
  private lastMove = -Infinity;
  speed = 0;
  erratic = 0;

  move(x: number, y: number, t: number): void {
    this.x = x;
    this.y = y;
    this.present = true;
    this.lastMove = t;
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 1.2) this.samples.shift();
  }

  leave(): void {
    this.present = false;
  }

  update(t: number): void {
    const s = this.samples;
    if (s.length < 2 || t - this.lastMove > 0.25) {
      this.speed *= 0.85;
    } else {
      let i = s.length - 1;
      while (i > 0 && t - s[i].t < 0.1) i--;
      const a = s[i];
      const b = s[s.length - 1];
      const dt = Math.max(0.016, b.t - a.t);
      this.speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    }
    // Erraticness: direction reversals per second + speed variance (prey-like darting).
    let rev = 0;
    let prevDx = 0;
    const speeds: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const dx = s[i].x - s[i - 1].x;
      const dtt = Math.max(0.008, s[i].t - s[i - 1].t);
      speeds.push(Math.hypot(dx, s[i].y - s[i - 1].y) / dtt);
      if (Math.abs(dx) > 2) {
        if (prevDx !== 0 && Math.sign(dx) !== Math.sign(prevDx)) rev++;
        prevDx = dx;
      }
    }
    const span = s.length > 1 ? Math.max(0.3, s[s.length - 1].t - s[0].t) : 1;
    const mean = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
    const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, speeds.length));
    const target = t - this.lastMove > 1.5 ? 0 : clamp01(((rev / span) / 3.5) * 0.65 + clamp01(sd / 700) * 0.35);
    this.erratic += (target - this.erratic) * 0.08;
  }

  idle(t: number): number {
    return t - this.lastMove;
  }

  info(t: number): CursorInfo {
    return { x: this.x, y: this.y, present: this.present, speed: this.speed, erratic: this.erratic, idle: this.idle(t), down: this.down };
  }
}

export interface WorldOptions {
  source: PlatformSource;
  settings: Settings;
  /** Hostname-independent local clock offset (studio uses real time too). */
  clock?: () => number;
  /** Initial food & water station state. */
  station?: FeedingStation;
}

/** Callbacks the host page uses to lock the pointer while a cat is held. */
export interface WorldHooks {
  grabStart?(agent: CatAgent): void;
  grabEnd?(agent: CatAgent): void;
}

/** Press-and-drag distance (px) that turns a press on a cat into picking it up. */
export const GRAB_DISTANCE = 5;

export class World {
  agents: CatAgent[] = [];
  readonly social = new SocialCoordinator();
  readonly toys = new ToyManager();
  readonly particles = new ParticleSystem();
  readonly cursor = new CursorTracker();
  source: PlatformSource;
  settings: Settings;
  typing: TypingInfo | null = null;
  platforms: Platform[] = [];
  hovered: CatAgent | null = null;
  now = 0;
  private lastPointerT = 0;
  private pressedOn: CatAgent | null = null;
  private dragDistance = 0;
  private envCache: AgentEnv | null = null;
  interactive = true;
  readonly station: StationModel;
  hooks: WorldHooks = {};
  /** The cat currently held by the scruff (locked until the button is released). */
  held: CatAgent | null = null;
  private grabSamples: MotionSample[] = [];
  private grabVel = { x: 0, y: 0 };
  /** Mouse / keyboard away for longer than the idle threshold. */
  userIdle = false;
  private lastScroll: { x: number; y: number } | null = null;
  /** Studio "trigger SCRUFF_HELD": a scripted hand. */
  private demoHold: { agent: CatAgent; t: number; x: number; y: number } | null = null;

  constructor(opts: WorldOptions) {
    this.source = opts.source;
    this.settings = opts.settings;
    this.station = new StationModel(opts.station ?? DEFAULT_STATION);
  }

  get calm(): boolean {
    return this.settings.calmMode;
  }

  setSettings(s: Settings): void {
    this.settings = s;
  }

  /** Adds / updates / removes agents to match the enabled profiles. */
  setProfiles(profiles: CatProfile[]): void {
    const enabled = profiles.filter((p) => p.enabled);
    const b = this.source.bounds();
    const floor = this.source.floor();
    for (const a of [...this.agents]) {
      if (!enabled.find((p) => p.id === a.id)) {
        a.dispose(this.envCache);
        this.agents = this.agents.filter((x) => x !== a);
      }
    }
    enabled.forEach((p, i) => {
      const existing = this.agents.find((a) => a.id === p.id);
      if (existing) existing.setProfile(p);
      else {
        const x = b.width * (0.32 + ((i * 0.27) % 0.5));
        const a = new CatAgent(p, x, floor.y, i % 2 === 0 ? 1 : -1);
        a.catScale = this.settings.catScale;
        a.placeOn(floor, x);
        this.agents.push(a);
      }
    });
  }

  env(): AgentEnv {
    const d = new Date();
    const env: AgentEnv = {
      source: this.source,
      platforms: this.platforms,
      bounds: this.source.bounds(),
      now: this.now,
      cursor: this.cursor.info(this.now),
      typing: this.typing,
      toys: this.toys,
      particles: this.particles,
      others: this.agents,
      catScale: this.settings.catScale,
      calm: this.settings.calmMode,
      hour: d.getHours() + d.getMinutes() / 60,
      social: this.social,
      station: this.station.enabled ? this.station : null,
      userIdle: this.userIdle,
    };
    this.envCache = env;
    return env;
  }

  update(dt: number): void {
    const h = clamp(dt, 0, 1 / 15);
    this.now += h;
    this.platforms = allPlatforms(this.source);
    this.cursor.update(this.now);
    this.station.scale = clamp(this.settings.catScale, 0.6, 1.6);
    this.station.update(h, this.now);
    const env = this.env();
    // Page scrolled since last frame: cats riding page elements move with them *before* physics.
    const sc = this.source.scrollOffset?.();
    if (sc) {
      if (this.lastScroll && (sc.x !== this.lastScroll.x || sc.y !== this.lastScroll.y)) {
        const dx = sc.x - this.lastScroll.x;
        const dy = sc.y - this.lastScroll.y;
        for (const a of this.agents) a.shiftForScroll(dx, dy, env);
      }
      this.lastScroll = { x: sc.x, y: sc.y };
    }
    this.toys.update(h, this.platforms, env.bounds);
    if (this.demoHold) this.stepDemoHold(h);
    if (this.held) this.held.holdMove(this.cursor.x, this.cursor.y, this.grabVel.x, this.grabVel.y);
    for (const a of this.agents) a.update(h, env);
    this.social.update(this.agents, env);
    this.particles.update(h);
  }

  /** True when nothing much is happening (lets the overlay throttle its frame rate). */
  isDrowsy(): boolean {
    if (this.held) return false;
    if (this.toys.count > 0 || this.particles.count > 8) return false;
    if (this.cursor.present && this.cursor.idle(this.now) < 1) return false;
    return this.agents.every((a) => a.isAsleep() && !a.isPetted());
  }

  render(ctx: AnyCtx): Rect[] {
    const env = this.envCache ?? this.env();
    const rects: Rect[] = [];
    if (this.station.enabled) {
      this.station.drawBack(ctx, env.bounds, this.now);
      rects.push(this.station.rect(env.bounds));
    }
    const toyR = this.toys.draw(ctx);
    if (toyR) rects.push(toyR);
    // Sleepers first, then by vertical position so cats in front overlap correctly; a held cat is on top.
    const order = [...this.agents].sort(
      (a, b) => (a.isHeld() ? 1 : 0) - (b.isHeld() ? 1 : 0) || a.y - b.y || (a.isAsleep() ? 0 : 1) - (b.isAsleep() ? 0 : 1) || a.poseRole - b.poseRole,
    );
    // Depth around the bowls: a cat eating or drinking is drawn *behind* the bowls' front walls (its
    // muzzle dips into the bowl); every other cat walks or sits in front of them.
    const atBowl = (a: CatAgent) => a.state === 'EATING' || a.state === 'DRINKING';
    const layers = [order.filter(atBowl), order.filter((a) => !atBowl(a))];
    layers.forEach((layer, i) => {
      if (i === 1 && this.station.enabled) this.station.drawFront(ctx, env.bounds);
      for (const a of layer) {
        const lm = a.draw(ctx, env);
        if (lm) rects.push({ minX: lm.bounds.minX - 12, minY: lm.bounds.minY - 14, maxX: lm.bounds.maxX + 12, maxY: lm.bounds.maxY + 12 });
        if (a.isHeld() && lm) drawScruffPinch(ctx, lm.scruff, a);
      }
    });
    if (this.settings.showNameTags && this.hovered?.lm) rects.push(this.drawNameTag(ctx, this.hovered));
    const pr = this.particles.draw(ctx);
    if (pr) rects.push(pr);
    return rects;
  }

  private drawNameTag(ctx: AnyCtx, a: CatAgent): Rect {
    const lm = a.lm as NonNullable<CatAgent['lm']>;
    const name = displayName(a.profile) || 'Cat';
    ctx.save();
    ctx.font = '600 12px ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.direction = /[֐-׿]/.test(name) ? 'rtl' : 'ltr';
    const w = ctx.measureText(name).width + 16;
    const x = lm.head.x - w / 2;
    const y = lm.bounds.minY - 24;
    ctx.fillStyle = 'rgba(32,26,22,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, 19, 9.5);
    ctx.fill();
    ctx.fillStyle = '#FFF8EE';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, lm.head.x, y + 10);
    ctx.restore();
    return { minX: x - 2, minY: y - 2, maxX: x + w + 2, maxY: y + 22 };
  }

  /* ----------------------------------------------------------- pointer */

  hitTest(x: number, y: number): CatAgent | null {
    const order = [...this.agents].sort((a, b) => b.y - a.y);
    for (const a of order) if (a.lm && onCat(x, y, a.lm)) return a;
    return null;
  }

  zoneAt(a: CatAgent, x: number, y: number): PetZone | null {
    return a.lm ? classifyZone(x, y, a.lm) : null;
  }

  pointerMove(x: number, y: number, tSeconds: number): void {
    const dtp = clamp(tSeconds - this.lastPointerT, 0, 0.06);
    this.lastPointerT = tSeconds;
    if (this.pressedOn) this.dragDistance += Math.hypot(x - this.cursor.x, y - this.cursor.y);
    this.cursor.move(x, y, this.now);
    if (this.held) {
      this.trackGrab(x, y, tSeconds);
      return;
    }
    if (!this.interactive) {
      this.hovered = null;
      return;
    }
    if (this.pressedOn && this.dragDistance > GRAB_DISTANCE && !this.pressedOn.isAirborne() && !this.pressedOn.isClimbing()) {
      this.startGrab(this.pressedOn, x, y, tSeconds);
      return;
    }
    this.hovered = this.hitTest(x, y);
    const a = this.hovered;
    if (!a) return;
    const zone = this.zoneAt(a, x, y);
    if (!zone) return;
    const speed = this.cursor.speed;
    if (speed < 1400 && dtp > 0) a.pet(zone, dtp, this.cursor.down ? 1 : 0.65, this.envCache ?? this.env());
  }

  pointerLeave(): void {
    this.cursor.leave();
    this.hovered = null;
  }

  pointerDown(x: number, y: number, tSeconds = this.lastPointerT): boolean {
    this.cursor.down = true;
    if (!this.interactive) return false;
    if (this.held) return true;
    this.cursor.move(x, y, this.now);
    this.pressedOn = this.hitTest(x, y);
    this.dragDistance = 0;
    // A press right on the scruff picks the cat up straight away.
    if (this.pressedOn && this.zoneAt(this.pressedOn, x, y) === 'SCRUFF' && !this.pressedOn.isAirborne() && !this.pressedOn.isClimbing()) {
      this.startGrab(this.pressedOn, x, y, tSeconds);
    }
    return !!this.pressedOn;
  }

  pointerUp(x: number, y: number): void {
    this.cursor.down = false;
    if (this.held) {
      this.endGrab(true);
      this.pressedOn = null;
      return;
    }
    const a = this.pressedOn;
    this.pressedOn = null;
    if (!a || !this.interactive) return;
    if (this.dragDistance < 6 && this.hitTest(x, y) === a) a.poke(this.zoneAt(a, x, y), this.envCache ?? this.env());
  }

  /** The pointer was cancelled or the window lost focus: set a held cat down gently. */
  pointerCancel(): void {
    this.cursor.down = false;
    this.pressedOn = null;
    if (this.held) this.endGrab(false);
  }

  private startGrab(a: CatAgent, x: number, y: number, t: number): void {
    const env = this.envCache ?? this.env();
    const s = this.social.sessionOf(a);
    if (s) this.social.end(s);
    a.grab(x, y, env);
    this.held = a;
    this.hovered = null;
    this.grabSamples = [{ x, y, t }];
    this.grabVel = { x: 0, y: 0 };
    this.hooks.grabStart?.(a);
  }

  private trackGrab(x: number, y: number, t: number): void {
    this.grabSamples.push({ x, y, t });
    while (this.grabSamples.length > 2 && t - this.grabSamples[0].t > 0.25) this.grabSamples.shift();
    const v = releaseVelocity(this.grabSamples, 0.09);
    // Smooth the hand speed a little so the swing follows the gesture, not the jitter.
    this.grabVel.x += (v.vx - this.grabVel.x) * 0.5;
    this.grabVel.y += (v.vy - this.grabVel.y) * 0.5;
  }

  private endGrab(withThrow: boolean): void {
    const a = this.held;
    if (!a) return;
    this.held = null;
    const last = this.grabSamples[this.grabSamples.length - 1];
    // A hand that stopped before letting go doesn't throw.
    const stale = !last || this.lastPointerT - last.t > 0.12;
    const v = withThrow && !stale ? releaseVelocity(this.grabSamples, 0.09) : { vx: 0, vy: 0 };
    a.release(v.vx, v.vy, this.envCache ?? this.env());
    this.grabSamples = [];
    this.hooks.grabEnd?.(a);
  }

  private stepDemoHold(dt: number): void {
    const d = this.demoHold as NonNullable<World['demoHold']>;
    if (this.held !== d.agent) {
      this.demoHold = null;
      return;
    }
    d.t += dt;
    const lift = Math.min(1, d.t / 0.45);
    const x = d.x + Math.sin(Math.max(0, d.t - 0.45) * 2.4) * 46 * (d.t < 2.6 ? 1 : 0.4);
    const y = d.y - 70 * lift * (1 - lift * 0.15);
    const prev = this.grabSamples[this.grabSamples.length - 1];
    this.cursor.x = x;
    this.cursor.y = y;
    this.trackGrab(x, y, this.now);
    if (prev && dt > 0) this.grabVel.x = (x - prev.x) / dt;
    if (d.t > 3.2) {
      this.demoHold = null;
      this.held = null;
      d.agent.release(0, 0, this.envCache ?? this.env());
      this.grabSamples = [];
      this.hooks.grabEnd?.(d.agent);
    }
  }

  /* ------------------------------------------------------ food & water */

  /** What the station has under a point (for the page's hitbox / cursor). */
  stationHit(x: number, y: number): StationHit {
    return this.station.hit(x, y, this.source.bounds());
  }

  /** Fills a bowl to the brim with a little kibble / splash burst. */
  refill(kind: BowlKind): void {
    const b = this.source.bounds();
    this.station.refill(kind);
    const g = this.station.geom(b);
    const bowl = g.bowls[kind];
    this.particles.emit(kind === 'food' ? 'kibble' : 'splash', bowl.x, bowl.rimY - 2, kind === 'food' ? 14 : 10, g.s);
    // Anyone waiting by that bowl reconsiders right away.
    for (const a of this.agents) if (a.planLabel === `beg-${kind}`) a.clearPlan();
  }

  setStation(next: FeedingStation): void {
    this.station.setState(next);
  }

  /** Mouse / keyboard idle state changed (from the page or the browser). */
  setUserIdle(idle: boolean): void {
    if (idle === this.userIdle) return;
    this.userIdle = idle;
    const env = this.envCache ?? this.env();
    if (idle) this.social.startIdleGather(this.agents, env);
    else this.social.wakeFromIdle(this.agents, env);
  }

  /* ----------------------------------------------------------- actions */

  dropTreat(): void {
    const env = this.env();
    this.toys.spawnTreat(env.bounds);
    for (const a of this.agents) {
      const s = this.social.sessionOf(a);
      if (s) this.social.end(s);
      a.command('treat', env);
    }
  }

  tossLaser(): void {
    const env = this.env();
    this.toys.spawnLaser(env.bounds);
    for (const a of this.agents) if (!a.isAsleep() || a.drives.energy > 50) a.command('toy', env);
  }

  tossBall(): void {
    const env = this.env();
    this.toys.spawnBall(env.bounds);
    for (const a of this.agents) if (!a.isAsleep()) a.command('toy', env);
  }

  /* ------------------------------------------ hand-held toys (left click) */

  private lastTreatMeow = -10;

  /** Drops a treat where the user clicked; nearby cats come to eat. */
  placeTreat(x: number, y: number): void {
    const env = this.env();
    this.toys.spawnTreatAt(x, y);
    for (const a of this.agents) {
      if (a.isAsleep() && a.drives.energy < 25) continue;
      const s = this.social.sessionOf(a);
      if (s) this.social.end(s);
      a.command('treat', env);
    }
    if (this.now - this.lastTreatMeow > 2.5) {
      this.lastTreatMeow = this.now;
    }
  }

  private laserOn = false;

  /** The user's laser pointer: shines while the left button is held. */
  laserAt(x: number, y: number, on: boolean): void {
    this.toys.controlLaser(x, y, on);
    if (on && !this.laserOn) {
      const env = this.env();
      for (const a of this.agents) if (!a.isAsleep() || a.drives.energy > 45) a.command('toy', env);
    }
    this.laserOn = on;
  }

  /** Picks up / carries the ball under the cursor. */
  holdBall(x: number, y: number): void {
    this.toys.holdBall(x, y);
  }

  /** Throws the held ball with the hand's velocity; awake cats give chase. */
  throwBall(vx: number, vy: number): void {
    if (!this.toys.throwBall(vx, vy)) return;
    const env = this.env();
    for (const a of this.agents) if (!a.isAsleep()) a.command('toy', env);
  }

  callCats(): void {
    const env = this.env();
    const floor = this.source.floor();
    const cx = env.bounds.width / 2;
    this.agents.forEach((a, i) => {
      const s = this.social.sessionOf(a);
      if (s) this.social.end(s);
      const off = (i - (this.agents.length - 1) / 2) * a.bodyLen() * 1.2;
      const face: 1 | -1 = off <= 0 ? 1 : -1;
      a.setPlan(
        [
          { kind: 'goto', spot: { platformId: floor.id, x: cx + off }, gait: 'TROT', face },
          { kind: 'state', state: 'CURSOR_GAZE', dur: 6 },
        ],
        'called',
      );
    });
  }

  /** Studio sandbox: trigger any state on one cat (social ones choreograph both). */
  triggerState(agent: CatAgent, state: CatState): void {
    const env = this.env();
    const partner = this.agents.find((x) => x !== agent) ?? null;
    const social: Partial<Record<CatState, () => boolean>> = {
      NOSE_BOOP_GREETING: () => !!partner && this.social.startBoop(agent, partner, env),
      ALLOGROOMING: () => !!partner && this.social.startAllogroom(agent, partner, env),
      ALLOGROOM_RECEIVE: () => !!partner && this.social.startAllogroom(partner, agent, env),
      YIN_YANG_CUDDLE_SLEEP: () => !!partner && this.social.startCuddle(agent, partner, env),
      TANDEM_BELLY_HOLD_SLEEP: () => !!partner && this.social.startCuddle(agent, partner, env),
      PILLOW_STACK_CUDDLE: () => !!partner && this.social.startCuddle(agent, partner, env),
      PLAY_TAG_CHASE: () => !!partner && this.social.startPlay(agent, partner, env),
      PLAY_WRESTLE: () => !!partner && this.social.startPlay(agent, partner, env),
      JEALOUSY_INTERVENTION: () => !!partner && this.social.startJealousy(partner, agent, env),
    };
    for (const s of [...this.social.sessions]) if (s.a === agent || s.b === agent) this.social.end(s);
    const fn = social[state];
    if (fn && fn()) return;
    if (state === 'CUDDLE_SLEEP') {
      if (partner && this.social.startIdleGather([agent, partner], env)) return;
    }
    if (state === 'SCRUFF_HELD') {
      // Studio demo: an invisible hand lifts the cat by the scruff, sways it, and sets it down.
      const lm = agent.lm;
      if (lm && !agent.isAirborne()) {
        this.demoHold = { agent, t: 0, x: lm.scruff.x, y: lm.scruff.y };
        this.startGrab(agent, lm.scruff.x, lm.scruff.y, this.now);
      }
      return;
    }
    const meals: Partial<Record<CatState, BowlKind>> = { SEEKING_FOOD: 'food', EATING: 'food', SEEKING_WATER: 'water', DRINKING: 'water', EMPTY_BOWL_WAIT: 'food' };
    const bowl = meals[state];
    if (bowl) {
      this.station.state.enabled = true;
      const key = bowl === 'food' ? 'hunger' : 'thirst';
      if (state === 'EMPTY_BOWL_WAIT') {
        this.station.consume('food', 100);
        agent.drives.hunger = Math.max(agent.drives.hunger, 90);
        agent.lastBegEnd = -999;
      } else {
        if (this.station.level(bowl) < 40) this.station.refill(bowl);
        agent.drives[key] = Math.max(agent.drives[key], 82);
      }
      if (agent.planMeal(bowl, env)) return;
    }
    const intents: Partial<Record<CatState, IntentKind>> = {
      ZOOMIES_SPRINT: 'zoomies',
      WALL_CLIMB: 'climb',
      EDGE_PEEK: 'peek',
      STALK_CURSOR: 'hunt',
      POUNCE_AND_PIN: 'hunt',
      EAT_TREAT: 'treat',
    };
    if (state === 'EAT_TREAT') this.toys.spawnTreat(env.bounds, agent.x + agent.facing * 60);
    const intent = intents[state];
    if (intent) {
      agent.command(intent, env);
      return;
    }
    if (state === 'JUMP_ASCEND' || state === 'FALL_DESCEND' || state === 'CROUCH_PREP_JUMP' || state === 'LAND_RECOVERY' || state === 'SAUNTER_WALK' || state === 'TROT') {
      agent.command('explore', env);
      return;
    }
    if (state === 'STARTLED_AIRBORNE') {
      agent.setPlan([], 'startle');
      agent.dropIn(agent.x, Math.max(20, agent.y - 160));
      agent.fsm.force('STARTLED_AIRBORNE');
      return;
    }
    agent.requestState(state, env, state === 'TAIL_LASH' || state === 'JUDGMENTAL_AIRPLANE_SQUINT' ? 3 : 14);
  }

  /* ---------------------------------------------------------- persistence */

  snapshot(href: string): WorldSnapshot {
    const b = this.source.bounds();
    return { cats: this.agents.map((a) => a.snapshot(b)), updatedAt: Date.now(), href };
  }

  applySnapshot(world: WorldSnapshot): void {
    if (!world || !Array.isArray(world.cats)) return;
    this.platforms = allPlatforms(this.source);
    const env = this.env();
    const elapsed = Math.max(0, (Date.now() - world.updatedAt) / 1000);
    for (const snap of world.cats) {
      const a = this.agents.find((x) => x.id === snap.id);
      if (a) a.restore(snap, env, elapsed);
    }
    for (const s of [...this.social.sessions]) this.social.end(s, true);
  }

  nearestCatTo(x: number, y: number): CatAgent | null {
    let best: CatAgent | null = null;
    let bd = Infinity;
    for (const a of this.agents) {
      const d = dist(a.x, a.y, x, y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  dispose(): void {
    for (const a of this.agents) a.dispose(this.envCache);
    this.agents = [];
  }
}

/** A little gathered tuft of fur where the hand pinches the scruff (the skin lifts into a small peak). */
function drawScruffPinch(ctx: AnyCtx, p: { x: number; y: number }, a: CatAgent): void {
  const s = a.S;
  const pal = a.profile.palette;
  const light = mixHex(pal.tabbyBase, '#FFFFFF', 0.35);
  ctx.save();
  ctx.lineCap = 'round';
  // Lifted skin: a soft fur-coloured peak under the fingers.
  ctx.fillStyle = pal.tabbyBase;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(p.x - 6 * s, p.y + 5 * s);
  ctx.quadraticCurveTo(p.x - 2 * s, p.y + 1 * s, p.x, p.y - 2.5 * s);
  ctx.quadraticCurveTo(p.x + 2 * s, p.y + 1 * s, p.x + 6 * s, p.y + 5 * s);
  ctx.closePath();
  ctx.fill();
  // Hairs gathered toward the pinch point.
  for (let i = 0; i < 9; i++) {
    const f = i / 8 - 0.5;
    const bx = p.x + f * 11 * s;
    const by = p.y + 5 * s + Math.abs(f) * 2.5 * s;
    ctx.strokeStyle = i % 3 === 1 ? pal.tabbyStripe : i % 3 === 2 ? light : pal.tabbyBase;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(0.9, 1.3 * s);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx - f * 2.5 * s, by - 4 * s, p.x + f * 1.8 * s, p.y - 2.6 * s);
    ctx.stroke();
  }
  // Fold shadows either side of the lifted skin.
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#2A1F18';
  ctx.lineWidth = Math.max(0.8, 1 * s);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(p.x + side * 1.5 * s, p.y + 1 * s);
    ctx.quadraticCurveTo(p.x + side * 4 * s, p.y + 4 * s, p.x + side * 7 * s, p.y + 6.5 * s);
    ctx.stroke();
  }
  ctx.restore();
}
