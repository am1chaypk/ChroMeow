/**
 * SocialCoordinator — shared social awareness between cats.
 *
 * Choreographs two-cat interactions by issuing synchronised, locked plans to
 * both participants and monitoring them until they finish or get interrupted:
 *
 *  • NOSE_BOOP_GREETING       — cats passing each other stop and touch noses
 *  • ALLOGROOMING             — A licks B's forehead while B closes its eyes
 *  • YIN_YANG_CUDDLE_SLEEP    — both curl into one shared ball
 *  • TANDEM_BELLY_HOLD_SLEEP  — side by side, bellies out, paws on chest (photo)
 *  • PILLOW_STACK_CUDDLE      — one uses the other as a pillow (photo)
 *  • PLAY_TAG_CHASE → PLAY_WRESTLE
 *  • JEALOUSY_INTERVENTION    — pet one cat > 8 s and the other muscles in
 *  • JUDGMENTAL_AIRPLANE_SQUINT when the cursor whips past a sleeping pair
 */
import { clamp, dist } from '../shared/math';
import type { CatState } from '../shared/catStates';
import { platformWidth } from '../engine/Physics';
import type { AgentEnv, CatAgent, SocialHooks, Task } from '../sim/CatAgent';
import type { IntentKind } from './UtilityBrain';

export type SocialKind = 'boop' | 'allogroom' | 'yinyang' | 'tandem' | 'pillow' | 'play' | 'jealousy';

export interface SocialSession {
  id: number;
  kind: SocialKind;
  a: CatAgent;
  b: CatAgent;
  started: number;
  maxDuration: number;
}

const JEALOUSY_SECONDS = 8;

export class SocialCoordinator implements SocialHooks {
  sessions: SocialSession[] = [];
  private nextId = 1;
  private pairCooldown = new Map<string, number>();
  private jealousyReadyAt = 0;

  private key(a: CatAgent, b: CatAgent, kind: string): string {
    return [a.id, b.id].sort().join('|') + ':' + kind;
  }

  private cooled(a: CatAgent, b: CatAgent, kind: string, now: number): boolean {
    return (this.pairCooldown.get(this.key(a, b, kind)) ?? 0) <= now;
  }

  private setCooldown(a: CatAgent, b: CatAgent, kind: string, now: number, seconds: number): void {
    this.pairCooldown.set(this.key(a, b, kind), now + seconds);
  }

  sessionOf(agent: CatAgent): SocialSession | null {
    return this.sessions.find((s) => s.a === agent || s.b === agent) ?? null;
  }

  /** Called by a cat whose brain chose a social intent. */
  request(agent: CatAgent, env: AgentEnv, kind: IntentKind): boolean {
    const partner = this.pickPartner(agent, env);
    if (!partner) return false;
    const now = env.now;
    const tired = agent.drives.energy < 45;
    if (kind === 'sleep' || (partner.isAsleep() && tired)) return this.startCuddle(agent, partner, env);
    const playful = agent.drives.playfulness > 55 && partner.drives.playfulness > 45 && agent.drives.energy > 45 && partner.drives.energy > 40 && !partner.isAsleep();
    if (playful && this.cooled(agent, partner, 'play', now)) return this.startPlay(agent, partner, env);
    if (partner.isResting() && !partner.isAsleep() && this.cooled(agent, partner, 'groom', now)) return this.startAllogroom(agent, partner, env);
    if (!partner.isAsleep() && this.cooled(agent, partner, 'boop', now)) return this.startBoop(agent, partner, env);
    return false;
  }

  private pickPartner(agent: CatAgent, env: AgentEnv): CatAgent | null {
    let best: CatAgent | null = null;
    let bd = Infinity;
    for (const o of env.others) {
      if (o === agent || o.social || this.sessionOf(o)) continue;
      if (!(o.availableForSocial() || o.isAsleep())) continue;
      if (o.isAirborne() || o.isClimbing()) continue;
      const d = dist(o.x, o.y, agent.x, agent.y);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private begin(kind: SocialKind, a: CatAgent, b: CatAgent, env: AgentEnv, maxDuration: number): SocialSession {
    const s: SocialSession = { id: this.nextId++, kind, a, b, started: env.now, maxDuration };
    this.sessions.push(s);
    a.social = { sessionId: s.id, role: 0, partner: b };
    b.social = { sessionId: s.id, role: 1, partner: a };
    return s;
  }

  end(s: SocialSession, keepSleeping = false): void {
    this.sessions = this.sessions.filter((x) => x !== s);
    for (const c of [s.a, s.b]) {
      if (c.social?.sessionId !== s.id) continue;
      c.social = null;
      c.poseRole = 0;
      if (keepSleeping && c.isAsleep()) {
        const st = c.state;
        const calm: CatState = st === 'PILLOW_STACK_CUDDLE' || st === 'YIN_YANG_CUDDLE_SLEEP' ? 'CURLED_SLEEP' : st === 'TANDEM_BELLY_HOLD_SLEEP' ? 'SPRAWLED_SLEEP' : st;
        c.setPlan([{ kind: 'state', state: calm, dur: c.rng.range(20, 60) }], 'sleep');
      } else c.clearPlan();
    }
  }

  private finishTask(s: SocialSession, keepSleeping = false): Task {
    return { kind: 'do', fn: () => this.end(s, keepSleeping) };
  }

  /* --------------------------------------------------------- interactions */

  startBoop(a: CatAgent, b: CatAgent, env: AgentEnv): boolean {
    const pb = b.currentPlatform(env);
    if (!pb) return false;
    const side: 1 | -1 = a.x >= b.x ? 1 : -1;
    const L = (a.bodyLen() + b.bodyLen()) / 2;
    const spotX = clamp(b.x + side * L * 0.98, pb.xMin + 20, pb.xMax - 20);
    if (Math.abs(spotX - b.x) < L * 0.6) return false;
    const s = this.begin('boop', a, b, env, 18);
    this.setCooldown(a, b, 'boop', env.now, 45);
    const faceA = (side > 0 ? -1 : 1) as 1 | -1;
    b.setPlan([{ kind: 'state', state: 'IDLE_STAND', dur: 20, face: () => (a.x >= b.x ? 1 : -1) }], 'social', true);
    a.setPlan(
      [
        { kind: 'goto', spot: { platformId: pb.id, x: spotX }, gait: 'SAUNTER_WALK', face: faceA, maxTime: 12 },
        {
          kind: 'do',
          fn: () => {
            b.setPlan([{ kind: 'state', state: 'NOSE_BOOP_GREETING', dur: 99, face: (side > 0 ? 1 : -1) as 1 | -1 }], 'social', true);
            env.sound?.trill(1 + a.seed * 0.2);
          },
        },
        { kind: 'state', state: 'NOSE_BOOP_GREETING', dur: 99, face: faceA },
        {
          kind: 'do',
          fn: () => {
            if (a.lm && b.lm) env.particles.emit('spark', (a.lm.head.x + b.lm.head.x) / 2, (a.lm.head.y + b.lm.head.y) / 2 - 4, 6, a.S);
          },
        },
        this.finishTask(s),
      ],
      'social',
      true,
    );
    return true;
  }

  startAllogroom(a: CatAgent, b: CatAgent, env: AgentEnv): boolean {
    const pb = b.currentPlatform(env);
    if (!pb) return false;
    const L = a.bodyLen();
    const spotX = b.x + b.facing * L * 0.92;
    if (spotX < pb.xMin + 16 || spotX > pb.xMax - 16) return this.startBoop(a, b, env);
    const s = this.begin('allogroom', a, b, env, 30);
    this.setCooldown(a, b, 'groom', env.now, 70);
    const faceA = (b.facing > 0 ? -1 : 1) as 1 | -1;
    b.setPlan([{ kind: 'state', state: 'CAT_LOAF', dur: 30 }], 'social', true);
    const dur = a.rng.range(6, 10);
    a.setPlan(
      [
        { kind: 'goto', spot: { platformId: pb.id, x: spotX }, gait: 'SAUNTER_WALK', face: faceA, maxTime: 14 },
        { kind: 'do', fn: () => b.setPlan([{ kind: 'state', state: 'ALLOGROOM_RECEIVE', dur: dur + 2 }], 'social', true) },
        { kind: 'state', state: 'ALLOGROOMING', dur },
        {
          kind: 'do',
          fn: () => {
            if (b.lm) env.particles.emit('heart', b.lm.head.x, b.lm.head.y - 14 * b.S, 3, b.S);
            b.drives.affection = Math.min(100, b.drives.affection + 10);
          },
        },
        this.finishTask(s),
      ],
      'social',
      true,
    );
    return true;
  }

  startCuddle(a: CatAgent, b: CatAgent, env: AgentEnv): boolean {
    const pb = b.currentPlatform(env);
    if (!pb) return false;
    const L = Math.max(a.bodyLen(), b.bodyLen());
    const width = platformWidth(pb);
    const sleepA = a.rng.range(60, 150);
    const holdB = b.isAsleep() ? b.state : ('CAT_LOAF' as CatState);

    // Cat 2's habit: use the other cat as a pillow.
    if (a.profile.signature.pillowSnuggler && width > L * 1.6) {
      const restX = clamp(b.x - b.facing * 36 * a.S, pb.xMin + L * 0.5, pb.xMax - L * 0.5);
      const s = this.begin('pillow', a, b, env, sleepA + 20);
      b.setPlan([{ kind: 'state', state: holdB, dur: 999 }], 'social', true);
      a.setPlan(
        [
          { kind: 'goto', spot: { platformId: pb.id, x: restX }, gait: 'SAUNTER_WALK', face: b.facing, maxTime: 16 },
          { kind: 'do', fn: () => b.setPlan([{ kind: 'state', state: 'PILLOW_STACK_CUDDLE', dur: sleepA + 10, role: 0 }], 'social', true) },
          { kind: 'state', state: 'PILLOW_STACK_CUDDLE', dur: sleepA, role: 1 },
          this.finishTask(s, true),
        ],
        'social',
        true,
      );
      return true;
    }

    // Wide ledge: the tandem belly-hold from the reference photo.
    if (width > L * 2.5 && a.rng.chance(0.55)) {
      // role 0 = the one that reaches out with its paws (Cat 1's style), lying behind.
      const reacher = a.profile.signature.widePawSplay || a.profile.slot < b.profile.slot ? a : b;
      const holder = reacher === a ? b : a;
      const f = b.facing;
      const s = this.begin('tandem', a, b, env, sleepA + 20);
      if (holder === b) {
        const spotX = clamp(b.x - f * L * 0.62, pb.xMin + L * 0.5, pb.xMax - L * 0.5);
        b.setPlan([{ kind: 'state', state: holdB, dur: 999 }], 'social', true);
        a.setPlan(
          [
            { kind: 'goto', spot: { platformId: pb.id, x: spotX }, gait: 'SAUNTER_WALK', face: f, maxTime: 16 },
            { kind: 'do', fn: () => b.setPlan([{ kind: 'state', state: 'TANDEM_BELLY_HOLD_SLEEP', dur: sleepA + 10, role: 1 }], 'social', true) },
            { kind: 'state', state: 'TANDEM_BELLY_HOLD_SLEEP', dur: sleepA, role: 0 },
            this.finishTask(s, true),
          ],
          'social',
          true,
        );
      } else {
        const spotX = clamp(b.x + f * L * 0.62, pb.xMin + L * 0.5, pb.xMax - L * 0.5);
        b.setPlan([{ kind: 'state', state: holdB, dur: 999 }], 'social', true);
        a.setPlan(
          [
            { kind: 'goto', spot: { platformId: pb.id, x: spotX }, gait: 'SAUNTER_WALK', face: f, maxTime: 16 },
            { kind: 'do', fn: () => b.setPlan([{ kind: 'state', state: 'TANDEM_BELLY_HOLD_SLEEP', dur: sleepA + 10, role: 0 }], 'social', true) },
            { kind: 'state', state: 'TANDEM_BELLY_HOLD_SLEEP', dur: sleepA, role: 1 },
            this.finishTask(s, true),
          ],
          'social',
          true,
        );
      }
      return true;
    }

    // Default: curl up together into one ball.
    const spotX = clamp(b.x + b.facing * L * 0.34, pb.xMin + L * 0.45, pb.xMax - L * 0.45);
    const s = this.begin('yinyang', a, b, env, sleepA + 20);
    b.setPlan([{ kind: 'state', state: holdB, dur: 999 }], 'social', true);
    a.setPlan(
      [
        { kind: 'goto', spot: { platformId: pb.id, x: spotX }, gait: 'SAUNTER_WALK', face: (b.facing > 0 ? -1 : 1) as 1 | -1, maxTime: 16 },
        { kind: 'do', fn: () => b.setPlan([{ kind: 'state', state: 'YIN_YANG_CUDDLE_SLEEP', dur: sleepA + 10, role: 0 }], 'social', true) },
        { kind: 'state', state: 'YIN_YANG_CUDDLE_SLEEP', dur: sleepA, role: 1 },
        this.finishTask(s, true),
      ],
      'social',
      true,
    );
    return true;
  }

  startPlay(a: CatAgent, b: CatAgent, env: AgentEnv): boolean {
    const pb = b.currentPlatform(env) ?? env.source.floor();
    const s = this.begin('play', a, b, env, 24);
    this.setCooldown(a, b, 'play', env.now, 60);
    const away: 1 | -1 = b.x >= a.x ? 1 : -1;
    const runX = clamp(b.x + away * b.rng.range(180, 320) * b.S, pb.xMin + 30, pb.xMax - 30);
    b.setPlan(
      [
        { kind: 'state', state: 'IDLE_STAND', dur: 0.5 },
        { kind: 'goto', spot: { platformId: pb.id, x: runX }, gait: 'PLAY_TAG_CHASE', maxTime: 6 },
        { kind: 'state', state: 'IDLE_STAND', dur: 8, face: () => (a.x >= b.x ? 1 : -1) },
      ],
      'social',
      true,
    );
    const wrestle = 3.2;
    a.setPlan(
      [
        { kind: 'state', state: 'CROUCH_PREP_JUMP', dur: 0.1 },
        {
          kind: 'goto',
          spot: () => {
            const pl = b.currentPlatform(env);
            if (!pl) return null;
            const side: 1 | -1 = a.x >= b.x ? 1 : -1;
            return { platformId: pl.id, x: b.x + side * b.bodyLen() * 0.72 };
          },
          gait: 'PLAY_TAG_CHASE',
          tol: 14,
          maxTime: 9,
        },
        {
          kind: 'do',
          fn: () => {
            b.setPlan([{ kind: 'state', state: 'PLAY_WRESTLE', dur: wrestle, face: () => (a.x >= b.x ? 1 : -1), role: 1 }], 'social', true);
            if (a.lm) env.particles.emit('puff', (a.x + b.x) / 2, a.y - 4, 6, a.S);
          },
        },
        { kind: 'state', state: 'PLAY_WRESTLE', dur: wrestle, face: () => (b.x >= a.x ? 1 : -1), role: 0 },
        this.finishTask(s),
      ],
      'social',
      true,
    );
    return true;
  }

  startJealousy(petted: CatAgent, jealous: CatAgent, env: AgentEnv): boolean {
    const p = petted.currentPlatform(env);
    if (!p) return false;
    const c = env.cursor;
    const side: 1 | -1 = c.x >= petted.x ? 1 : -1;
    const spotX = clamp(c.present ? c.x : petted.x + side * petted.bodyLen() * 0.8, p.xMin + 24, p.xMax - 24);
    const s = this.begin('jealousy', jealous, petted, env, 20);
    this.jealousyReadyAt = env.now + 45;
    jealous.setPlan(
      [
        { kind: 'goto', spot: { platformId: p.id, x: spotX }, gait: 'TROT', maxTime: 10 },
        { kind: 'state', state: 'JEALOUSY_INTERVENTION', dur: 4.5, face: () => (petted.x >= jealous.x ? -1 : 1) },
        { kind: 'do', fn: () => env.sound?.meow(1.15, 0.45) },
        { kind: 'state', state: 'IDLE_SIT', dur: 5 },
        this.finishTask(s),
      ],
      'social',
      true,
    );
    // The petted cat gets nudged aside a little.
    const nudgeX = clamp(petted.x - side * petted.bodyLen() * 0.55, p.xMin + 24, p.xMax - 24);
    petted.setPlan(
      [
        { kind: 'state', state: 'IDLE_STAND', dur: 3.2 },
        { kind: 'goto', spot: { platformId: p.id, x: nudgeX }, gait: 'SAUNTER_WALK', maxTime: 5 },
        { kind: 'state', state: 'IDLE_SIT', dur: 4, face: (side > 0 ? 1 : -1) as 1 | -1 },
      ],
      'social',
      true,
    );
    return true;
  }

  /* --------------------------------------------------------------- update */

  update(agents: CatAgent[], env: AgentEnv): void {
    const now = env.now;
    // Validate running sessions.
    for (const s of [...this.sessions]) {
      // A partner switched off or removed mid-session ends it cleanly.
      const gone = !agents.includes(s.a) || !agents.includes(s.b);
      const broken = gone || s.a.social?.sessionId !== s.id || s.b.social?.sessionId !== s.id;
      const stale = now - s.started > s.maxDuration;
      const fell = s.a.isAirborne() && !s.a.plan.length;
      if (broken || stale || fell) {
        const sleepy = s.kind === 'yinyang' || s.kind === 'tandem' || s.kind === 'pillow';
        this.end(s, sleepy);
      }
    }

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      // Jealousy: someone else is getting all the pets.
      if (a.petTime > JEALOUSY_SECONDS && now > this.jealousyReadyAt && !this.sessionOf(a)) {
        const jealous = agents
          .filter((o) => o !== a && !o.isAsleep() && o.availableForSocial() && o.profile.personality.sociability > 0.4)
          .sort((p, q) => dist(p.x, p.y, a.x, a.y) - dist(q.x, q.y, a.x, a.y))[0];
        if (jealous) this.startJealousy(a, jealous, env);
      }
      // Spontaneous nose boops when two awake cats meet head-on.
      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j];
        if (!a.availableForSocial() || !b.availableForSocial()) continue;
        if (a.groundId !== b.groundId || a.isAsleep() || b.isAsleep()) continue;
        const dx = b.x - a.x;
        const L = (a.bodyLen() + b.bodyLen()) / 2;
        if (Math.abs(dx) > L * 1.5 || Math.abs(dx) < L * 0.5) continue;
        const facingEachOther = a.facing === Math.sign(dx) && b.facing === -Math.sign(dx);
        const moving = Math.abs(a.vx) > 5 || Math.abs(b.vx) > 5;
        if (facingEachOther && moving && this.cooled(a, b, 'boop', now)) this.startBoop(a, b, env);
      }
      // Judgmental squint: the cursor whips past a sleeping (or cuddling) cat.
      if (a.isAsleep() && env.cursor.present && env.cursor.speed > 1500 && a.lm) {
        const sassy = a.profile.signature.airplaneSquint || a.profile.personality.sassiness >= 0.6;
        if (sassy && dist(env.cursor.x, env.cursor.y, a.lm.head.x, a.lm.head.y) < 170 * a.S) a.trySquint(env);
      }
    }
  }
}
