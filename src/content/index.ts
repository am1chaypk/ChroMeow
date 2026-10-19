/**
 * ChroMeow content script entry — boots the cats on the current page.
 *
 * Lifecycle: load settings & profiles (chrome.storage.local) → if this site is
 * not paused, mount the Shadow DOM overlay, start the DOM platform scanner and
 * the simulation loop, and hydrate the cats from the service worker's canonical
 * cross-tab snapshot. While visible, the tab streams snapshots back (≈1 Hz and
 * on hide) so the next tab you focus continues exactly where these cats left off.
 */
import { isRuntimeMessage, sendRuntime, type HydrateResponse, type TabMessage } from '../shared/messages';
import { KEY_PROFILES, KEY_SETTINGS, isBlacklisted, loadProfiles, loadSettings, normalizeProfiles, normalizeSettings } from '../shared/storage';
import type { CatProfile, PageInfo, Settings } from '../shared/types';
import { DomPlatformScanner } from '../engine/DomPlatformScanner';
import { SoundSynthesizer } from '../engine/SoundSynthesizer';
import { World } from '../sim/World';
import { renderQuality } from '../engine/ArticulatedCatRenderer';
import { useLanguage } from '../shared/i18n';
import { InputInterceptor } from './InputInterceptor';
import { PlayMode } from './PlayMode';
import { ShadowDOMOverlay } from './ShadowDOMOverlay';

declare global {
  interface Window {
    __chromeowLoaded?: boolean;
  }
}

const SNAPSHOT_INTERVAL = 1000;

class ContentApp {
  private settings: Settings;
  private profiles: CatProfile[];
  private overlay: ShadowDOMOverlay | null = null;
  private scanner: DomPlatformScanner | null = null;
  private world: World | null = null;
  private input: InputInterceptor | null = null;
  private play: PlayMode | null = null;
  private sound = new SoundSynthesizer();
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

  constructor(settings: Settings, profiles: CatProfile[]) {
    this.settings = settings;
    this.profiles = profiles;
  }

  get shouldRun(): boolean {
    return !this.settings.globalPause && !isBlacklisted(this.settings, location.hostname) && this.profiles.some((p) => p.enabled);
  }

  async start(): Promise<void> {
    if (this.running || !this.alive) return;
    if (!document.documentElement) return;
    this.running = true;
    const overlay = new ShadowDOMOverlay({ down: () => undefined, up: () => undefined });
    overlay.mount();
    overlay.setClickThrough(this.settings.clickThroughLock);
    this.overlay = overlay;
    useLanguage(this.settings.language);
    this.play = new PlayMode(overlay.root, () => this.world);
    const scanner = new DomPlatformScanner(overlay.host);
    scanner.start();
    this.scanner = scanner;
    this.sound.setEnabled(this.settings.soundEnabled);
    this.sound.setVolume(this.settings.volume);
    const world = new World({ source: scanner, sound: this.sound, settings: this.settings });
    world.interactive = !this.settings.clickThroughLock;
    world.setProfiles(this.profiles);
    this.world = world;

    this.input = new InputInterceptor({
      move: (x, y, t) => world.pointerMove(x, y, t),
      // While a toy is in hand, left clicks belong to the toy, not to petting.
      down: (x, y) => {
        if (!this.play?.active) world.pointerDown(x, y);
      },
      up: (x, y) => {
        if (!this.play?.active) world.pointerUp(x, y);
      },
      leave: () => world.pointerLeave(),
      typing: (el, caret) => {
        const id = scanner.track(el);
        const r = el.getBoundingClientRect();
        world.typing = { platformId: id, xMin: r.left, xMax: r.right, y: r.top, caret, lastInput: world.now };
      },
    });
    this.input.start();

    await this.hydrate();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onHide);
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
    this.input?.stop();
    this.play?.destroy();
    this.play = null;
    this.scanner?.stop();
    this.world?.dispose();
    this.overlay?.unmount();
    this.sound.dispose();
    this.sound = new SoundSynthesizer();
    this.input = null;
    this.scanner = null;
    this.world = null;
    this.overlay = null;
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.pushSnapshot();
    else {
      void this.hydrate();
      this.last = performance.now();
    }
  };

  private readonly onHide = () => this.pushSnapshot();

  private async hydrate(): Promise<void> {
    const res = await sendRuntime<HydrateResponse>({ type: 'cm:hydrate' });
    if (!this.contextAlive()) return;
    if (res?.world && this.world) this.world.applySnapshot(res.world);
  }

  private pushSnapshot(): void {
    if (!this.world || !this.contextAlive()) return;
    if (document.visibilityState === 'hidden' && this.lastSnapshot === 0) return;
    void sendRuntime({ type: 'cm:snapshot', world: this.world.snapshot(location.href) });
    this.lastSnapshot = performance.now();
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
    this.scanner.update(now);
    this.world.update(dt);
    // Sleepy throttle: when everyone is napping (or calm mode is on), draw at ~30 fps.
    // Breathing is slow enough that this stays perfectly smooth while halving the work.
    const drowsy = this.world.isDrowsy() || this.settings.calmMode;
    if (drowsy && this.frame % 2 !== 0) return;
    this.overlay.ensureMounted();
    const ctx = this.overlay.beginFrame();
    const rects = this.world.render(ctx);
    this.overlay.endFrame(rects);
    this.overlay.syncHitboxes(this.world.agents.map((a) => ({ id: a.id, lm: a.lm, state: a.state, ground: a.groundId })));
    if (now - this.lastSnapshot > SNAPSHOT_INTERVAL) this.pushSnapshot();
  };

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
    this.world?.setSettings(next);
    if (this.world) this.world.interactive = !next.clickThroughLock;
    this.overlay?.setClickThrough(next.clickThroughLock);
    useLanguage(next.language);
    this.play?.render();
  }

  applyProfiles(next: CatProfile[]): void {
    this.profiles = next;
    if (!this.shouldRun) {
      this.stop();
      return;
    }
    if (!this.running) void this.start();
    else this.world?.setProfiles(next);
  }

  pageInfo(): PageInfo {
    return {
      hostname: location.hostname,
      blacklisted: isBlacklisted(this.settings, location.hostname),
      running: this.running,
      catCount: this.world?.agents.length ?? 0,
      playTool: this.play?.current ?? null,
    };
  }

  handle(msg: TabMessage): unknown {
    switch (msg.type) {
      case 'cm:getPageInfo':
        return this.pageInfo();
      case 'cm:action': {
        const w = this.world;
        if (!w) return { ok: false };
        this.sound.unlock();
        if (msg.action === 'treat') w.dropTreat();
        else if (msg.action === 'laser') w.tossLaser();
        else if (msg.action === 'ball') w.tossBall();
        else if (msg.action === 'call') w.callCats();
        return { ok: true };
      }
      case 'cm:play': {
        if (!this.world || !this.play) return { ok: false };
        this.sound.unlock();
        this.play.set(msg.tool);
        return { ok: true, tool: this.play.current };
      }
      case 'cm:applyWorld':
        this.world?.applySnapshot(msg.world);
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
  const [settings, profiles] = await Promise.all([loadSettings(), loadProfiles()]);
  const app = new ContentApp(settings, profiles);

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(msg)) return;
    const res = app.handle(msg as unknown as TabMessage);
    if (res !== undefined) sendResponse(res);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEY_SETTINGS]) app.applySettings(normalizeSettings(changes[KEY_SETTINGS].newValue));
    if (changes[KEY_PROFILES]) app.applyProfiles(normalizeProfiles(changes[KEY_PROFILES].newValue));
  });

  if (app.shouldRun) await app.start();
}

void boot().catch(() => {
  /* never break the host page */
});
