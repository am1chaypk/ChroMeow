/**
 * World — runs the shared simulation: all cats, the social coordinator, toys,
 * particles and pointer interaction. DOM-agnostic: the content script feeds it
 * the real page (DomPlatformScanner) while Cat Studio feeds it a mock page.
 */
import type { CatState } from '../shared/catStates';
import { clamp, clamp01, dist } from '../shared/math';
import type { CatProfile, Settings, WorldSnapshot } from '../shared/types';
import { SocialCoordinator } from '../ai/SocialCoordinator';
import { classifyZone, onCat, type PetZone } from '../ai/HitboxZones';
import type { IntentKind } from '../ai/UtilityBrain';
import { ParticleSystem } from '../engine/Particles';
import type { SoundSynthesizer } from '../engine/SoundSynthesizer';
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
  sound: SoundSynthesizer | null;
  settings: Settings;
  /** Hostname-independent local clock offset (studio uses real time too). */
  clock?: () => number;
}

export class World {
  agents: CatAgent[] = [];
  readonly social = new SocialCoordinator();
  readonly toys = new ToyManager();
  readonly particles = new ParticleSystem();
  readonly cursor = new CursorTracker();
  source: PlatformSource;
  sound: SoundSynthesizer | null;
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

  constructor(opts: WorldOptions) {
    this.source = opts.source;
    this.sound = opts.sound;
    this.settings = opts.settings;
  }

  get calm(): boolean {
    return this.settings.calmMode;
  }

  setSettings(s: Settings): void {
    this.settings = s;
    this.sound?.setEnabled(s.soundEnabled);
    this.sound?.setVolume(s.volume);
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
      sound: this.sound,
      others: this.agents,
      catScale: this.settings.catScale,
      calm: this.settings.calmMode,
      hour: d.getHours() + d.getMinutes() / 60,
      social: this.social,
    };
    this.envCache = env;
    return env;
  }

  update(dt: number): void {
    const h = clamp(dt, 0, 1 / 15);
    this.now += h;
    this.platforms = allPlatforms(this.source);
    this.cursor.update(this.now);
    const env = this.env();
    this.toys.update(h, this.platforms, env.bounds);
    for (const a of this.agents) a.update(h, env);
    this.social.update(this.agents, env);
    this.particles.update(h);
  }

  /** True when nothing much is happening (lets the overlay throttle its frame rate). */
  isDrowsy(): boolean {
    if (this.toys.count > 0 || this.particles.count > 8) return false;
    if (this.cursor.present && this.cursor.idle(this.now) < 1) return false;
    return this.agents.every((a) => a.isAsleep() && !a.isPetted());
  }

  render(ctx: AnyCtx): Rect[] {
    const env = this.envCache ?? this.env();
    const rects: Rect[] = [];
    const toyR = this.toys.draw(ctx);
    if (toyR) rects.push(toyR);
    // Sleepers first, then by vertical position so cats in front overlap correctly.
    const order = [...this.agents].sort((a, b) => a.y - b.y || (a.isAsleep() ? -1 : 1));
    for (const a of order) {
      const lm = a.draw(ctx, env);
      if (lm) rects.push({ minX: lm.bounds.minX - 12, minY: lm.bounds.minY - 14, maxX: lm.bounds.maxX + 12, maxY: lm.bounds.maxY + 12 });
    }
    if (this.settings.showNameTags && this.hovered?.lm) rects.push(this.drawNameTag(ctx, this.hovered));
    const pr = this.particles.draw(ctx);
    if (pr) rects.push(pr);
    return rects;
  }

  private drawNameTag(ctx: AnyCtx, a: CatAgent): Rect {
    const lm = a.lm as NonNullable<CatAgent['lm']>;
    const name = a.profile.name || 'Cat';
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
    if (!this.interactive) {
      this.hovered = null;
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

  pointerDown(x: number, y: number): boolean {
    this.cursor.down = true;
    this.sound?.unlock();
    if (!this.interactive) return false;
    this.pressedOn = this.hitTest(x, y);
    this.dragDistance = 0;
    return !!this.pressedOn;
  }

  pointerUp(x: number, y: number): void {
    this.cursor.down = false;
    const a = this.pressedOn;
    this.pressedOn = null;
    if (!a || !this.interactive) return;
    if (this.dragDistance < 6 && this.hitTest(x, y) === a) a.poke(this.zoneAt(a, x, y), this.envCache ?? this.env());
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
    this.sound?.meow(1.1, 0.5);
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
    this.sound?.meow(1.2, 0.4);
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
