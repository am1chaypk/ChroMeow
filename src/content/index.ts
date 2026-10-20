/**
 * ChroMeow content script entry — boots the cats on the current page.
 *
 * Lifecycle: load settings & profiles (chrome.storage.local) → if this site is
 * not paused, mount the Shadow DOM overlay, start the DOM platform scanner and
 * the simulation loop, and hydrate the cats from the service worker's canonical
 * cross-tab snapshot. While visible, the tab streams snapshots back (≈1 Hz and
 * on hide) so the next tab you focus continues exactly where these cats left off.
 *
 * v2: picking a cat up locks the pointer to the overlay; the food & water
 * station is shared through chrome.storage.local; and after `idleThreshold`
 * seconds without input here (or when chrome.idle reports the computer idle or
 * locked) the cats curl up together until you come back.
 *
 * v3:
 *  • Single instance: the page reports its presence to the service worker,
 *    which elects one leader tab in the whole browser. Only the leader hosts
 *    the cats (and empties the bowls); every other tab shows the furniture but
 *    no cats. Switching between two windows on screen migrates the cats (they
 *    run off one window and walk into the other); a cat may also go roaming to
 *    another tab for a while and come back.
 *  • Right-click a cat for the mini-games menu; pick the ball or the toy mouse
 *    straight up off the page and throw it; named beds you can drag along the
 *    floor; "clear all" from the popup.
 */
import { isRuntimeMessage, sendRuntime, type HydrateResponse, type RoleMessage, type TabMessage } from '../shared/messages';
import {
  KEY_BEDS,
  KEY_PROFILES,
  KEY_SETTINGS,
  KEY_STATION,
  isBlacklisted,
  loadBeds,
  loadProfiles,
  loadSettings,
  loadStation,
  normalizeBeds,
  normalizeProfiles,
  normalizeSettings,
  normalizeStation,
  patchBeds,
  patchStation,
} from '../shared/storage';
import type { BowlKind, CatBedsState, CatProfile, FeedingStation, PageInfo, Settings } from '../shared/types';
import { DomPlatformScanner } from '../engine/DomPlatformScanner';
import { World } from '../sim/World';
import { catchUpStation } from '../sim/FeedingStation';
import { renderQuality } from '../engine/ArticulatedCatRenderer';
import { displayName, useLanguage } from '../shared/i18n';
import { InputInterceptor, deepActiveElement } from './InputInterceptor';
import { TYPING_LINGER_MS, exclusionZone } from '../sim/ExclusionZone';
import { PlayMode } from './PlayMode';
import { GamesMenu, type GameAction } from './GamesMenu';
import { ShadowDOMOverlay } from './ShadowDOMOverlay';

declare global {
  interface Window {
    __chromeowLoaded?: boolean;
  }
}

const SNAPSHOT_INTERVAL = 1000;
/** How often bowl levels / station position are written back to storage (ms). */
const STATION_SAVE_INTERVAL = 1500;
/** Presence heartbeat to the service worker (ms) — also how often a roaming cat's return is checked. */
const PRESENCE_INTERVAL = 12000;
/** A migration (cats running off to another window) never takes longer than this (ms). */
const EXIT_TIMEOUT = 2600;

type Role = 'pending' | 'leader' | 'follower';

class ContentApp {
  private settings: Settings;
  private profiles: CatProfile[];
  private overlay: ShadowDOMOverlay | null = null;
  private scanner: DomPlatformScanner | null = null;
  private world: World | null = null;
  private input: InputInterceptor | null = null;
  private play: PlayMode | null = null;
  private games: GamesMenu | null = null;
  private raf = 0;
  private last = 0;
  private frame = 0;
  private lastSnapshot = 0;
  /** Smoothed frame interval (s) and how long it has been slow / fast, for adaptive quality. */
  private frameEma = 1 / 60;
  private slowFor = 0;
  private fastFor = 0;
  private running = false;
  private alive = true;
  private station: FeedingStation;
  private beds: CatBedsState;
  private lastStationSave = 0;
  private lastStationWrite = '';
  private lastBedsWrite = '';
  /** Last pointer / key / wheel / scroll input in this tab (performance.now ms). */
  private lastInput = performance.now();
  /** chrome.idle says the whole computer is idle or locked. */
  private systemIdle = false;
  private lastPointerId = 1;
  /* single instance */
  private role: Role = 'pending';
  private epoch = -1;
  private away = new Set<string>();
  private otherTabs = 0;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private exiting: ReturnType<typeof setTimeout> | null = null;
  private entering: ReturnType<typeof setTimeout> | null = null;
  /* typing exclusion zone */
  private field: HTMLElement | null = null;
  private lastKey = -Infinity;

  constructor(settings: Settings, profiles: CatProfile[], station: FeedingStation, beds: CatBedsState) {
    this.settings = settings;
    this.profiles = profiles;
    this.station = station;
    this.beds = beds;
  }

  get shouldRun(): boolean {
    return !this.settings.globalPause && !isBlacklisted(this.settings, location.hostname) && this.profiles.some((p) => p.enabled);
  }

  get isLeader(): boolean {
    return this.role === 'leader';
  }

  async start(): Promise<void> {
    if (this.running || !this.alive) return;
    if (!document.documentElement) return;
    this.running = true;
    const overlay = new ShadowDOMOverlay({
      down: () => undefined,
      up: () => undefined,
      lost: () => this.world?.pointerCancel(),
      context: (id, x, y) => this.openGames(id, x, y),
    });
    overlay.mount();
    overlay.setClickThrough(this.settings.clickThroughLock);
    this.overlay = overlay;
    useLanguage(this.settings.language);
    this.play = new PlayMode(overlay.root, () => this.world);
    this.games = new GamesMenu(overlay.root, (a) => this.playGame(a));
    const scanner = new DomPlatformScanner(overlay.host);
    scanner.start();
    this.scanner = scanner;
    const world = new World({ source: scanner, settings: this.settings, station: this.station, beds: this.beds });
    world.interactive = !this.settings.clickThroughLock;
    // No cats until the service worker says this tab is the one that hosts them.
    world.setProfiles([], this.profiles);
    world.hooks = {
      // Held by the scruff (or a toy in hand): the overlay owns the pointer until the button comes up.
      grabStart: () => overlay.lockPointer(this.lastPointerId),
      grabEnd: () => overlay.unlockPointer(),
      toyGrabStart: () => overlay.lockPointer(this.lastPointerId),
      toyGrabEnd: () => overlay.unlockPointer(),
      canRoam: () => this.isLeader && this.otherTabs > 0 && document.visibilityState === 'visible',
      catLeft: (id, side) => this.catLeft(id, side),
    };
    this.world = world;
    overlay.setStationHandlers({
      hit: (x, y) => (this.play?.active ? null : world.stationHit(x, y)),
      refill: (kind) => {
        world.refill(kind);
        this.saveStation(true);
      },
      drag: (x, phase) => {
        world.station.moveTo(x / Math.max(1, scanner.bounds().width));
        if (phase === 'end') this.saveStation(true);
      },
    });
    overlay.setBedHandlers({
      drag: (id, x, phase) => {
        world.beds.moveTo(id, x / Math.max(1, scanner.bounds().width));
        if (phase === 'end') this.saveBeds();
      },
    });

    this.input = new InputInterceptor({
      move: (x, y, t) => world.pointerMove(x, y, t),
      // While a toy is in hand, left clicks belong to the toy, not to petting.
      down: (x, y, e) => {
        this.lastPointerId = e.pointerId;
        if (!this.play?.active && !this.games?.open && e.button === 0) world.pointerDown(x, y, performance.now() / 1000);
      },
      up: (x, y) => {
        if (!this.play?.active) world.pointerUp(x, y);
      },
      cancel: () => world.pointerCancel(),
      activity: () => this.onActivity(),
      leave: () => world.pointerLeave(),
      focusField: (el, typed) => {
        if (el) this.field = el;
        else if (performance.now() - this.lastKey > TYPING_LINGER_MS) this.field = null;
        if (typed) this.lastKey = performance.now();
      },
      typing: (el, caret) => {
        const id = scanner.track(el);
        const r = el.getBoundingClientRect();
        world.typing = { platformId: id, xMin: r.left, xMax: r.right, y: r.top, caret, lastInput: world.now };
      },
    });
    this.input.start();

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onHide);
    window.addEventListener('focus', this.onFocusChange);
    window.addEventListener('blur', this.onFocusChange);
    this.presenceTimer = setInterval(() => void this.announce(), PRESENCE_INTERVAL);
    await this.announce();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (!this.running) return;
    this.pushSnapshot();
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onHide);
    window.removeEventListener('focus', this.onFocusChange);
    window.removeEventListener('blur', this.onFocusChange);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.exiting) clearTimeout(this.exiting);
    if (this.entering) clearTimeout(this.entering);
    this.presenceTimer = this.exiting = this.entering = null;
    this.input?.stop();
    this.overlay?.unlockPointer();
    this.saveStation(true);
    this.games?.close();
    this.games = null;
    this.play?.destroy();
    this.play = null;
    this.scanner?.stop();
    this.world?.dispose();
    this.overlay?.unmount();
    this.input = null;
    this.scanner = null;
    this.world = null;
    this.overlay = null;
    this.role = 'pending';
    this.epoch = -1;
    // Hand the cats on: the next visible tab becomes the leader.
    if (this.contextAliveQuiet()) void sendRuntime({ type: 'cm:presence', visible: false, focused: false });
  }

  /* ------------------------------------------------------- single instance */

  /** Tells the service worker whether this page is on screen / focused; applies the role it answers with. */
  private async announce(): Promise<void> {
    if (!this.running || !this.contextAlive()) return;
    const visible = document.visibilityState === 'visible';
    const res = await sendRuntime<RoleMessage>({ type: 'cm:presence', visible, focused: visible && document.hasFocus() });
    if (!this.running) return;
    if (res && res.type === 'cm:role') this.applyRole(res);
    else if (!res && this.role === 'pending') {
      // No service worker to ask (very old browser, tests): host the cats here.
      this.applyRole({ type: 'cm:role', leader: true, epoch: 0, away: [], others: 0 });
    }
  }

  private readonly onFocusChange = () => void this.announce();

  /**
   * The user is playing with the cats from this tab's popup: bring them here.
   * (Opening the popup takes focus away from the page, so this counts as focus.)
   */
  private claim(): void {
    if (this.role === 'leader' || document.visibilityState !== 'visible') return;
    void sendRuntime<RoleMessage>({ type: 'cm:presence', visible: true, focused: true }).then((res) => {
      if (res && res.type === 'cm:role') this.applyRole(res);
    });
  }

  /** The service worker decided which tab hosts the cats. */
  applyRole(msg: RoleMessage): void {
    if (!this.world || msg.epoch < this.epoch) return;
    this.epoch = msg.epoch;
    this.away = new Set(msg.away);
    this.otherTabs = msg.others;
    const was = this.role;
    if (msg.leader && was !== 'leader') {
      this.role = 'leader';
      if (this.exiting) {
        clearTimeout(this.exiting);
        this.exiting = null;
      }
      const begin = () => {
        this.entering = null;
        void this.becomeLeader(msg.enter ?? null);
      };
      if (msg.delay && msg.delay > 0) this.entering = setTimeout(begin, msg.delay);
      else begin();
    } else if (!msg.leader && was !== 'follower') {
      this.role = 'follower';
      if (this.entering) {
        clearTimeout(this.entering);
        this.entering = null;
      }
      this.handOff(msg.exit ?? null);
    } else if (msg.leader && !this.entering) {
      const added = this.hostCats();
      if (added.length) void this.hydrate(added);
    }
    for (const r of msg.returning ?? []) void this.welcomeBack(r.catId, r.side);
  }

  /** The cats this tab should show right now. */
  private hostedProfiles(): CatProfile[] {
    if (this.role !== 'leader') return [];
    return this.profiles.filter((p) => p.enabled && !this.away.has(p.id));
  }

  private hostCats(): string[] {
    const w = this.world;
    if (!w) return [];
    const before = new Set(w.agents.map((a) => a.id));
    w.setProfiles(this.hostedProfiles(), this.profiles);
    return w.agents.map((a) => a.id).filter((id) => !before.has(id));
  }

  /** This tab now hosts the cats: continue them from the shared snapshot (walking in from an edge after a window switch). */
  private async becomeLeader(enter: 1 | -1 | null): Promise<void> {
    if (!this.world || this.role !== 'leader') return;
    // Fetch first, then add and place the cats in one go (no frame with cats at default spots).
    const res = await sendRuntime<HydrateResponse>({ type: 'cm:hydrate' });
    const w = this.world;
    if (!w || this.role !== 'leader' || !this.contextAlive()) return;
    // The bowls kept emptying slowly while no page showed the cats.
    w.setStation(catchUpStation(w.station.state, Date.now()));
    w.station.dirty = true;
    const added = this.hostCats();
    if (res?.world) w.applySnapshot(res.world, added);
    // Coming over from another window: they walk in from the facing edge, one after the other.
    if (enter) w.arriveAll(enter);
  }

  /** Another tab hosts the cats now: run them off toward it (another window on screen) or just let go. */
  private handOff(exit: 1 | -1 | null): void {
    const w = this.world;
    if (!w) return;
    this.pushSnapshot(true);
    this.saveStation(true);
    this.play?.set(null);
    this.games?.close();
    // The toys go with the game: nobody is left here to play with them.
    w.clearObjects();
    if (exit && document.visibilityState === 'visible' && w.agents.length) {
      const done = () => {
        if (this.exiting) clearTimeout(this.exiting);
        this.exiting = null;
        if (this.role === 'follower') this.hostCats();
      };
      w.exitAll(exit, done);
      this.exiting = setTimeout(done, EXIT_TIMEOUT);
    } else this.hostCats();
  }

  /** A cat walked off the screen to visit another tab. */
  private catLeft(id: string, side: 1 | -1): void {
    this.away.add(id);
    this.pushSnapshot(true);
    void sendRuntime<RoleMessage>({ type: 'cm:catLeft', catId: id, side }).then((res) => {
      if (res && res.type === 'cm:role') this.applyRole(res);
    });
  }

  /** A roaming cat is back from its visit: it walks in from the edge it left by. */
  private async welcomeBack(id: string, side: 1 | -1): Promise<void> {
    this.away.delete(id);
    if (!this.isLeader || !this.world) return;
    const res = await sendRuntime<HydrateResponse>({ type: 'cm:hydrate' });
    const w = this.world;
    if (!w || !this.isLeader) return;
    const added = this.hostCats();
    if (!added.includes(id)) return;
    if (res?.world) w.applySnapshot(res.world, [id]);
    w.arrive(id, side);
  }

  /* ------------------------------------------------------------ lifecycle */

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.world?.pointerCancel();
      this.saveStation(true);
      this.pushSnapshot();
    } else {
      if (this.isLeader) void this.hydrate();
      this.last = performance.now();
      this.onActivity();
    }
    void this.announce();
  };

  /** Any input: the user is here. Wakes the cuddling cats straight away. */
  private onActivity(): void {
    this.lastInput = performance.now();
    if (this.world?.userIdle && !this.systemIdle) this.setIdle(false);
  }

  private setIdle(idle: boolean): void {
    if (!this.world || this.world.userIdle === idle) return;
    this.world.setUserIdle(idle);
    this.scanner?.setThrottled(idle);
  }

  private updateIdle(now: number): void {
    const away = (now - this.lastInput) / 1000 >= this.settings.idleThreshold;
    this.setIdle(this.systemIdle || away);
  }

  /** Writes bowl levels / position back to storage (throttled unless forced). Only the leader writes levels. */
  private saveStation(force = false): void {
    const w = this.world;
    if (!w || !w.station.dirty || !this.contextAlive()) return;
    const now = performance.now();
    if (!force && now - this.lastStationSave < STATION_SAVE_INTERVAL) return;
    this.lastStationSave = now;
    w.station.dirty = false;
    const st: FeedingStation = {
      ...w.station.state,
      foodLevel: Math.round(w.station.state.foodLevel * 10) / 10,
      waterLevel: Math.round(w.station.state.waterLevel * 10) / 10,
      updatedAt: this.isLeader ? Date.now() : w.station.state.updatedAt ?? Date.now(),
    };
    this.lastStationWrite = JSON.stringify(st);
    this.station = st;
    void patchStation(st).catch(() => undefined);
  }

  private saveBeds(): void {
    const w = this.world;
    if (!w || !this.contextAlive()) return;
    w.beds.dirty = false;
    const next: CatBedsState = { enabled: w.beds.state.enabled, positions: { ...w.beds.state.positions } };
    this.lastBedsWrite = JSON.stringify(next);
    this.beds = next;
    void patchBeds(next).catch(() => undefined);
  }

  /** Bowls changed elsewhere (popup refill, another tab, the toggle). */
  applyStation(next: FeedingStation): void {
    if (JSON.stringify(next) === this.lastStationWrite) return;
    const prev = this.world?.station.state ?? this.station;
    this.station = next;
    const w = this.world;
    if (!w) return;
    w.setStation(next);
    // A refill from the popup gets the same kibble / splash burst as a click on the bowl.
    for (const k of ['food', 'water'] as BowlKind[]) {
      const before = k === 'food' ? prev.foodLevel : prev.waterLevel;
      const after = k === 'food' ? next.foodLevel : next.waterLevel;
      if (next.enabled && after >= 99.5 && after - before > 10) w.refill(k);
    }
    w.station.dirty = false;
  }

  /** Beds moved or switched on / off elsewhere. */
  applyBeds(next: CatBedsState): void {
    if (JSON.stringify(next) === this.lastBedsWrite) return;
    this.beds = next;
    this.world?.beds.setState(next);
  }

  /** chrome.idle: the computer went idle / was locked, or became active again. */
  applySystemIdle(state: 'active' | 'idle' | 'locked'): void {
    this.systemIdle = state !== 'active';
    if (state === 'active') this.onActivity();
    else this.setIdle(true);
  }

  private readonly onHide = () => this.pushSnapshot();

  /** Continues the hosted cats (or just `only`) from the service worker's snapshot. */
  private async hydrate(only?: string[]): Promise<void> {
    const res = await sendRuntime<HydrateResponse>({ type: 'cm:hydrate' });
    if (!this.contextAlive()) return;
    if (res?.world && this.world) this.world.applySnapshot(res.world, only);
  }

  private pushSnapshot(force = false): void {
    if (!this.world || !this.isLeader || !this.world.agents.length || !this.contextAlive()) return;
    if (!force && document.visibilityState === 'hidden' && this.lastSnapshot === 0) return;
    void sendRuntime({ type: 'cm:snapshot', world: this.world.snapshot(location.href) });
    this.lastSnapshot = performance.now();
  }

  private contextAliveQuiet(): boolean {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  private contextAlive(): boolean {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) throw new Error('gone');
      return true;
    } catch {
      // Extension was reloaded/removed: tear everything down quietly.
      this.alive = false;
      this.stop();
      return false;
    }
  }

  private readonly loop = (now: number) => {
    if (!this.running || !this.world || !this.overlay || !this.scanner) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.visibilityState === 'hidden') return;
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, raw);
    this.last = now;
    this.frame++;
    this.adaptQuality(Math.min(0.1, raw));
    this.updateIdle(now);
    this.scanner.update(now);
    this.world.setExclusion(this.typingZone(now));
    this.world.update(dt);
    this.saveStation();
    // Sleepy throttle: when everyone is napping (or calm mode is on), draw at ~30 fps.
    // Breathing is slow enough that this stays perfectly smooth while halving the work.
    const drowsy = this.world.isDrowsy() || this.settings.calmMode;
    if (drowsy && this.frame % 2 !== 0) return;
    this.overlay.ensureMounted();
    const ctx = this.overlay.beginFrame();
    const rects = this.world.render(ctx);
    this.overlay.endFrame(rects);
    const w = this.world;
    const b = this.scanner.bounds();
    this.overlay.syncHitboxes(w.agents.map((a) => ({ id: a.id, lm: a.lm, state: a.state, ground: a.groundId })));
    const furniture = !this.play?.active;
    this.overlay.syncStation(w.station.enabled && furniture ? w.station.hitRect(b) : null);
    this.overlay.syncBeds(
      furniture
        ? w.beds
            .all(b)
            .map((g) => ({ id: g.id, rect: w.beds.hitRect(g.id, b) }))
            .filter((x): x is { id: string; rect: NonNullable<ReturnType<typeof w.beds.hitRect>> } => !!x.rect)
        : [],
    );
    this.overlay.syncToys(
      furniture && w.interactive
        ? w.toys.toys.filter((t) => (t.kind === 'ball' || t.kind === 'mouse') && !t.held).map((t) => ({ id: t.id, x: t.x, y: t.kind === 'mouse' ? t.y - 5 : t.y, r: t.kind === 'mouse' ? 15 : 14 }))
        : [],
    );
    if (now - this.lastSnapshot > SNAPSHOT_INTERVAL) this.pushSnapshot();
  };

  /**
   * The no-go box around the text field you are in: while it has focus (and for
   * a few seconds after the last keystroke), its live bounding box plus margins.
   */
  private typingZone(now: number): ReturnType<typeof exclusionZone> | null {
    const el = this.field;
    if (!el) return null;
    if (!el.isConnected) {
      this.field = null;
      return null;
    }
    const focused = deepActiveElement() === el || el.contains(deepActiveElement());
    if (!focused && now - this.lastKey > TYPING_LINGER_MS) {
      this.field = null;
      return null;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > window.innerHeight) return null;
    return exclusionZone(r);
  }

  /**
   * Keeps animation smooth on slower machines: if frames run long for a few
   * seconds, lighten the fur and lighting work; restore full quality once
   * there is headroom again.
   */
  private adaptQuality(raw: number): void {
    if (this.world?.isDrowsy() || this.settings.calmMode) return;
    this.frameEma += (raw - this.frameEma) * 0.05;
    if (this.frameEma > 0.024) {
      this.slowFor += raw;
      this.fastFor = 0;
    } else if (this.frameEma < 0.0185) {
      this.fastFor += raw;
      this.slowFor = 0;
    }
    if (renderQuality.level >= 1 && this.slowFor > 3) {
      renderQuality.level = 0;
      this.slowFor = 0;
    } else if (renderQuality.level < 1 && this.fastFor > 10) {
      renderQuality.level = 1;
      this.fastFor = 0;
    }
  }

  /* ------------------------------------------------------------- mini-games */

  /** Right-click on a cat: the mini-games menu, right there. */
  private openGames(catId: string, x: number, y: number): void {
    if (!this.world || this.settings.clickThroughLock) return;
    const prof = this.profiles.find((p) => p.id === catId);
    this.world.pointerCancel();
    this.games?.show(x, y, prof ? displayName(prof) : 'Cat');
  }

  private playGame(action: GameAction): void {
    const w = this.world;
    if (!w) return;
    if (action === 'treat' || action === 'laser' || action === 'ball' || action === 'feather_wand') this.play?.set(action);
    else this.doAction(action);
  }

  private doAction(action: 'treat' | 'laser' | 'ball' | 'feather_wand' | 'call' | 'mouse' | 'clear'): boolean {
    const w = this.world;
    if (!w) return false;
    if (action === 'feather_wand') {
      this.play?.set('feather_wand');
      return true;
    }
    if (action === 'treat') w.dropTreat();
    else if (action === 'laser') w.tossLaser();
    else if (action === 'ball') w.tossBall();
    else if (action === 'call') w.callCats();
    else if (action === 'mouse') w.releaseMouse();
    else if (action === 'clear') {
      this.play?.set(null);
      w.clearObjects();
    }
    return true;
  }

  /* ------------------------------------------------------------- settings */

  applySettings(next: Settings): void {
    this.settings = next;
    if (!this.shouldRun) {
      this.stop();
      return;
    }
    if (!this.running) {
      void this.start();
      return;
    }
    useLanguage(next.language);
    this.world?.setSettings(next);
    if (this.world) this.world.interactive = !next.clickThroughLock;
    this.overlay?.setClickThrough(next.clickThroughLock);
    if (next.clickThroughLock) this.games?.close();
    this.play?.render();
  }

  applyProfiles(next: CatProfile[]): void {
    this.profiles = next;
    if (!this.shouldRun) {
      this.stop();
      return;
    }
    if (!this.running) void this.start();
    else {
      const added = this.hostCats();
      if (added.length) void this.hydrate(added);
    }
  }

  pageInfo(): PageInfo {
    return {
      hostname: location.hostname,
      blacklisted: isBlacklisted(this.settings, location.hostname),
      running: this.running,
      catCount: this.world?.agents.length ?? 0,
      playTool: this.play?.current ?? null,
      leader: this.isLeader,
    };
  }

  handle(msg: TabMessage): unknown {
    switch (msg.type) {
      case 'cm:getPageInfo':
        return this.pageInfo();
      case 'cm:action': {
        const w = this.world;
        if (!w) return { ok: false };
        this.claim();
        return { ok: this.doAction(msg.action) };
      }
      case 'cm:play': {
        if (!this.world || !this.play) return { ok: false };
        this.claim();
        this.play.set(msg.tool);
        return { ok: true, tool: this.play.current };
      }
      case 'cm:applyWorld':
        if (this.isLeader) this.world?.applySnapshot(msg.world);
        return { ok: true };
      case 'cm:idleState':
        this.applySystemIdle(msg.state);
        return { ok: true };
      case 'cm:role':
        this.applyRole(msg);
        return { ok: true };
      default:
        return undefined;
    }
  }
}

async function boot(): Promise<void> {
  if (window.top !== window) return;
  if (window.__chromeowLoaded) return;
  window.__chromeowLoaded = true;
  if (document.contentType && !/html|xml/.test(document.contentType)) return; // skip raw images, PDFs, JSON…
  const [settings, profiles, station, beds] = await Promise.all([loadSettings(), loadProfiles(), loadStation(), loadBeds()]);
  const app = new ContentApp(settings, profiles, station, beds);

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(msg)) return;
    const res = app.handle(msg as unknown as TabMessage);
    if (res !== undefined) sendResponse(res);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEY_SETTINGS]) app.applySettings(normalizeSettings(changes[KEY_SETTINGS].newValue));
    if (changes[KEY_PROFILES]) app.applyProfiles(normalizeProfiles(changes[KEY_PROFILES].newValue));
    if (changes[KEY_STATION]) app.applyStation(normalizeStation(changes[KEY_STATION].newValue));
    if (changes[KEY_BEDS]) app.applyBeds(normalizeBeds(changes[KEY_BEDS].newValue));
  });

  if (app.shouldRun) await app.start();
}

void boot().catch(() => {
  /* never break the host page */
});
