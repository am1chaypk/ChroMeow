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
 *  • IDLE_GATHER → CUDDLE_SLEEP — when you step away, the bonded pair walks
 *    together, trades a quick lick and falls asleep pressed together; when you
 *    come back they blink, stretch, yawn, and one trots over to greet you.
 *
 * Cats prefer their bonded partner (traits.bondedWith), and cats with a high
 * social initiative choose grooming and cuddles over boops and chases.
 *
 * v3 anti-overlap: every frame the coordinator measures personal space between
 * cats on the same ledge and hands each a separation push (CatAgent turns it
 * into a speed nudge while moving, or steps aside once settled) — except for
 * pairs in a session together (cuddles, grooming, boops, play). Choreographed
 * pair transitions are staggered by 2–5 s so the two never mirror each other,
 * and the idle cuddle happens in the cats' own beds when they are out.
 */
import { clamp, dist } from '../shared/math';
import type { CatState } from '../shared/catStates';
import type { Rng } from '../shared/rng';
import { platformWidth } from '../engine/Physics';
import { PERSONAL_SPACE, type AgentEnv, type CatAgent, type SocialHooks, type Task } from '../sim/CatAgent';
import type { IntentKind } from './UtilityBrain';

/** Stagger between two cats reacting to the same event (seconds). */
export const STAGGER_MIN = 2;
export const STAGGER_MAX = 5;

export function staggerDelay(rng: Rng): number {
  return STAGGER_MIN + rng.next() * (STAGGER_MAX - STAGGER_MIN);
}

/** A held pause at the start of a plan (the second cat follows a few seconds later). */
function hold(delay: number): Task {
  return { kind: 'wait', until: () => false, maxTime: delay };
}

export type SocialKind = 'boop' | 'allogroom' | 'yinyang' | 'tandem' | 'pillow' | 'play' | 'jealousy' | 'idle';

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
    const initiative = agent.profile.traits.socialInitiative;
    if (kind === 'sleep' || (partner.isAsleep() && (tired || agent.rng.chance(0.4 * initiative)))) return this.startCuddle(agent, partner, env);
    // Groomers (Anna) reach for a grooming session first.
    if (partner.isResting() && !partner.isAsleep() && agent.rng.chance(initiative) && this.cooled(agent, partner, 'groom', now)) return this.startAllogroom(agent, partner, env);
    const playful = agent.drives.playfulness > 55 && partner.drives.playfulness > 45 && agent.drives.energy > 45 && partner.drives.energy > 40 && !partner.isAsleep();
    if (playful && this.cooled(agent, partner, 'play', now)) return this.startPlay(agent, partner, env);
    if (partner.isResting() && !partner.isAsleep() && this.cooled(agent, partner, 'groom', now)) return this.startAllogroom(agent, partner, env);
    if (!partner.isAsleep() && this.cooled(agent, partner, 'boop', now)) return this.startBoop(agent, partner, env);
    return false;
  }

  /** True when either cat names the other as its bonded partner. */
  static bonded(a: CatAgent, b: CatAgent): boolean {
    return a.profile.traits.bondedWith === b.id || b.profile.traits.bondedWith === a.id;
  }

  private pickPartner(agent: CatAgent, env: AgentEnv): CatAgent | null {
    let best: CatAgent | null = null;
    let bd = Infinity;
    for (const o of env.others) {
      if (o === agent || o.social || this.sessionOf(o)) continue;
      if (!(o.availableForSocial() || o.isAsleep())) continue;
      if (o.isAirborne() || o.isClimbing() || o.isHeld()) continue;
      // The bonded partner counts as much closer than it is.
      const d = dist(o.x, o.y, agent.x, agent.y) * (SocialCoordinator.bonded(agent, o) ? 0.3 : 1);
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
        const calm: CatState = st === 'PILLOW_STACK_CUDDLE' || st === 'YIN_YANG_CUDDLE_SLEEP' || st === 'CUDDLE_SLEEP' ? 'CURLED_SLEEP' : st === 'TANDEM_BELLY_HOLD_SLEEP' ? 'SPRAWLED_SLEEP' : st;
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

  /* ------------------------------------------------------- idle cuddle */

  /** The pair that cuddles while the user is away: a bonded pair if there is one, else the first two cats. */
  idlePair(agents: CatAgent[]): [CatAgent, CatAgent] | null {
    const ok = agents.filter((a) => !a.isHeld() && !a.isClimbing());
    for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) if (SocialCoordinator.bonded(ok[i], ok[j])) return [ok[i], ok[j]];
    return ok.length >= 2 ? [ok[0], ok[1]] : null;
  }

  /**
   * IDLE_GATHER: the pair walks to a comfortable spot (the floor, or a wide ledge
   * they share), trades a brief mutual lick, then curls up pressed together in
   * CUDDLE_SLEEP with synchronised breathing. Everyone else just naps.
   */
  startIdleGather(agents: CatAgent[], env: AgentEnv): boolean {
    const pair = this.idlePair(agents);
    for (const a of agents) {
      if (pair && (a === pair[0] || a === pair[1])) continue;
      if (!a.isAsleep() && !a.isHeld()) a.command('sleep', env);
    }
    if (!pair) return false;
    for (const s of [...this.sessions]) if (s.a === pair[0] || s.b === pair[0] || s.a === pair[1] || s.b === pair[1]) this.end(s);
    // The snuggler drapes over the other (Anna over Alex); the other is the pillow.
    const [p0, p1] = pair;
    const drapeScore = (c: CatAgent) => c.profile.traits.socialInitiative + (c.profile.signature.pillowSnuggler ? 0.5 : 0);
    const draper = drapeScore(p1) >= drapeScore(p0) ? p1 : p0;
    const pillow = draper === p0 ? p1 : p0;
    const spot = this.cuddleSpot(pillow, draper, env);
    const L = Math.max(pillow.bodyLen(), draper.bodyLen());
    const f = spot.face;
    const xPillow = spot.x + f * L * 0.3;
    const xDraper = spot.x - f * L * 0.32;
    const s = this.begin('idle', pillow, draper, env, 3600);
    const arrived = (c: CatAgent, x: number) => c.groundId === spot.platformId && Math.abs(c.x - x) < 14 * c.S && !c.isAirborne() && Math.abs(c.vx) < 20;
    const both = () => arrived(pillow, xPillow) && arrived(draper, xDraper);
    const lick = 2.6;
    const towards = (me: CatAgent, other: CatAgent) => (): 1 | -1 => (other.x >= me.x ? 1 : -1);
    const sleepDur = 3600;
    pillow.setPlan(
      [
        { kind: 'goto', spot: { platformId: spot.platformId, x: xPillow }, gait: 'SAUNTER_WALK', maxTime: 40 },
        { kind: 'wait', until: both, maxTime: 40, face: towards(pillow, draper) },
        { kind: 'state', state: 'ALLOGROOM_RECEIVE', dur: lick },
        { kind: 'state', state: 'ALLOGROOMING', dur: lick, face: towards(pillow, draper) },
        { kind: 'state', state: 'CUDDLE_SLEEP', dur: sleepDur, face: f, role: 0 },
      ],
      'idle-cuddle',
      true,
    );
    draper.setPlan(
      [
        // The second cat follows a few seconds later (never in lockstep).
        hold(staggerDelay(draper.rng)),
        { kind: 'goto', spot: { platformId: spot.platformId, x: xDraper }, gait: 'SAUNTER_WALK', maxTime: 40 },
        { kind: 'wait', until: both, maxTime: 40, face: towards(draper, pillow) },
        { kind: 'state', state: 'ALLOGROOMING', dur: lick, face: towards(draper, pillow) },
        { kind: 'do', fn: () => pillow.lm && env.particles.emit('heart', pillow.lm.head.x, pillow.lm.head.y - 12 * pillow.S, 2, pillow.S) },
        { kind: 'state', state: 'ALLOGROOM_RECEIVE', dur: lick },
        { kind: 'state', state: 'CUDDLE_SLEEP', dur: sleepDur, face: f, role: 1 },
      ],
      'idle-cuddle',
      true,
    );
    void s;
    return true;
  }

  /**
   * A spot both cats can reach: the pillow cat's own bed when the beds are out
   * (it curls up on its cushion, the other drapes over the bolster beside it), a
   * wide ledge they already share, otherwise the floor between them, clear of the bowls.
   */
  private cuddleSpot(a: CatAgent, b: CatAgent, env: AgentEnv): { platformId: string; x: number; face: 1 | -1 } {
    const L = Math.max(a.bodyLen(), b.bodyLen());
    const bed = env.beds?.spotFor(a.id, env.bounds) ?? env.beds?.spotFor(b.id, env.bounds) ?? null;
    if (bed) {
      // The draper lies on the side with more room.
      const face: 1 | -1 = bed.x < env.bounds.width / 2 ? -1 : 1;
      return { platformId: 'floor', x: bed.x - face * L * 0.3, face };
    }
    const pa = a.currentPlatform(env);
    let plat = pa && pa.kind === 'dom' && a.groundId === b.groundId && platformWidth(pa) > L * 2.8 ? pa : env.source.floor();
    if (!plat) plat = env.source.floor();
    const lo = plat.xMin + L * 1.1;
    const hi = plat.xMax - L * 1.1;
    let x = clamp((a.x + b.x) / 2, lo, Math.max(lo, hi));
    const st = env.station;
    if (plat.kind === 'floor' && st?.enabled) {
      const r = st.rect(env.bounds);
      const pad = L * 1.25;
      if (x > r.minX - pad && x < r.maxX + pad) {
        const left = r.minX - pad;
        const right = r.maxX + pad;
        x = left > lo && (x - left < right - x || right > hi) ? left : right < hi ? right : left;
      }
    }
    const face: 1 | -1 = x < env.bounds.width / 2 ? 1 : -1;
    return { platformId: plat.id, x, face };
  }

  /**
   * The user is back: the cuddling pair wakes slowly (a long blink, a stretch, a
   * yawn) and the more affectionate one trots over to the cursor, tail up in a
   * question mark, purring.
   */
  wakeFromIdle(agents: CatAgent[], env: AgentEnv): void {
    const session = this.sessions.find((s) => s.kind === 'idle');
    const pair = session ? [session.a, session.b] : this.idlePair(agents);
    if (session) {
      this.sessions = this.sessions.filter((x) => x !== session);
      for (const c of [session.a, session.b]) {
        c.social = null;
        c.poseRole = 0;
      }
    }
    if (!pair) return;
    const [a, b] = pair;
    if (!agents.includes(a) || !agents.includes(b)) return;
    const greeter = a.profile.personality.affection >= b.profile.personality.affection ? a : b;
    for (const c of [a, b]) {
      const wake: Task[] = [];
      // The second sleeper wakes 2–5 s after the first, so they never stretch and yawn in unison.
      const late = c !== greeter ? staggerDelay(c.rng) : 0;
      if (c.isAsleep()) {
        if (late > 0) wake.push({ kind: 'state', state: c.state, dur: late });
        wake.push(
          { kind: 'do', fn: () => c.slowBlink() },
          { kind: 'state', state: c.state, dur: 1.5 },
          { kind: 'state', state: 'WAKE_ARCH_STRETCH', dur: 99 },
          { kind: 'state', state: 'BIG_YAWN', dur: 99 },
        );
      }
      if (c === greeter) {
        wake.push(
          { kind: 'do', fn: () => c.greet(env, 9) },
          {
            kind: 'goto',
            spot: () => {
              const live = c.liveEnv ?? env;
              const cur = live.cursor;
              const floor = live.source.floor();
              const tx = cur.present ? cur.x : live.bounds.width / 2;
              const side = tx >= c.x ? 1 : -1;
              return { platformId: floor.id, x: clamp(tx - side * 46 * c.S, 30, live.bounds.width - 30) };
            },
            gait: 'TROT',
            maxTime: 12,
          },
          { kind: 'state', state: 'CURSOR_GAZE', dur: 6, face: () => ((c.liveEnv ?? env).cursor.x >= c.x ? 1 : -1) },
        );
      } else {
        if (!c.isAsleep() && late > 0) wake.push(hold(late));
        wake.push({ kind: 'state', state: 'IDLE_SIT', dur: c.rng.range(2, 4) }, { kind: 'state', state: 'GROOM_WASH_FACE', dur: 99 });
      }
      c.setPlan(wake, 'idle-wake', true);
    }
  }

  /* --------------------------------------------------------------- update */

  /** True when two cats are meant to be close right now (a shared session: cuddle, grooming, boop, play…). */
  static together(a: CatAgent, b: CatAgent): boolean {
    return (!!a.social && a.social.partner === b) || (!!b.social && b.social.partner === a);
  }

  /**
   * Personal space: for every pair on the same ledge closer than
   * PERSONAL_SPACE × their mean body length, a push of 0..1 (scaled by how deep
   * the overlap is) away from each other. Sleepers and pairs in a session together
   * are left alone.
   */
  separate(agents: CatAgent[], width = Infinity): void {
    for (const a of agents) a.separation = 0;
    const offscreen = (c: CatAgent) => c.parked || c.x < 0 || c.x > width;
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        if (!a.groundId || a.groundId !== b.groundId) continue;
        // Nobody can see them out there (walking off to another tab / window).
        if (offscreen(a) || offscreen(b)) continue;
        if (a.isHeld() || b.isHeld() || a.isAirborne() || b.isAirborne()) continue;
        // A cat curled up inside the tower's cubby is below the roof: the other cat walks right over it.
        if (a.inCubby || b.inCubby) continue;
        if (SocialCoordinator.together(a, b) || (a.isAsleep() && b.isAsleep())) continue;
        const ps = ((a.bodyLen() + b.bodyLen()) / 2) * PERSONAL_SPACE;
        const dx = b.x - a.x;
        if (Math.abs(dx) >= ps) continue;
        const push = (ps - Math.abs(dx)) / ps;
        const dir = dx !== 0 ? (dx > 0 ? -1 : 1) : a.id < b.id ? -1 : 1;
        // A sleeping cat stays put; the awake one does all the moving.
        if (!a.isAsleep()) a.separation = clamp(a.separation + dir * push * (b.isAsleep() ? 2 : 1), -1, 1);
        if (!b.isAsleep()) b.separation = clamp(b.separation - dir * push * (a.isAsleep() ? 2 : 1), -1, 1);
      }
    }
  }

  update(agents: CatAgent[], env: AgentEnv): void {
    const now = env.now;
    this.separate(agents, env.bounds.width);
    // Validate running sessions.
    for (const s of [...this.sessions]) {
      // A partner switched off or removed mid-session ends it cleanly.
      const gone = !agents.includes(s.a) || !agents.includes(s.b);
      const broken = gone || s.a.social?.sessionId !== s.id || s.b.social?.sessionId !== s.id;
      const stale = now - s.started > s.maxDuration;
      const fell = (s.a.isAirborne() && !s.a.plan.length) || s.a.isHeld() || s.b.isHeld();
      if (broken || stale || fell) {
        const sleepy = s.kind === 'yinyang' || s.kind === 'tandem' || s.kind === 'pillow' || s.kind === 'idle';
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
