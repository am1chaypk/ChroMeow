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
import { InputInterceptor } from './InputInterceptor';
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
  private sound = new SoundSynthesizer();
  private raf = 0;
  private last = 0;
  private frame = 0;
  private lastSnapshot = 0;
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
      down: (x, y) => world.pointerDown(x, y),
      up: (x, y) => world.pointerUp(x, y),
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
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frame++;
    this.scanner.update(now);
    this.world.update(dt);
    // Sleepy throttle: when everyone is napping, draw at ~20 fps.
    const drowsy = this.world.isDrowsy() || this.settings.calmMode;
    if (drowsy && this.frame % (this.settings.calmMode && !this.world.isDrowsy() ? 2 : 3) !== 0) return;
    this.overlay.ensureMounted();
    const ctx = this.overlay.beginFrame();
    const rects = this.world.render(ctx);
    this.overlay.endFrame(rects);
    this.overlay.syncHitboxes(this.world.agents.map((a) => ({ id: a.id, lm: a.lm, state: a.state, ground: a.groundId })));
    if (now - this.lastSnapshot > SNAPSHOT_INTERVAL) this.pushSnapshot();
  };

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
