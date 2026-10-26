/**
 * PopupController — status cards for each cat (live portrait, editable name,
 * state badge, energy/affection meters) plus toys, the food & water station
 * (levels, refill buttons), click-through lock, per-site pause, the idle-cuddle
 * delay and size controls. v3 adds the toy mouse, quick toggles that show or
 * hide the bowls and the beds, "Clear all" (removes every toy and treat but
 * never the cats), tab roaming and a "visiting another tab" status. Talks to
 * the active tab's content script and to the service worker; never to the network.
 */
import { isCatState, type CatState } from '../shared/catStates';
import { displayName, lang, setLanguage, stateLabel, t, translateDom } from '../shared/i18n';
import { sendRuntime, sendToTab, type HydrateResponse } from '../shared/messages';
import { loadBeds, loadTower, patchTower, KEY_TOWER, normalizeTower, loadProfiles, loadSettings, loadStation, patchBeds, patchProfile, patchSettings, patchStation, removeProfile, hostnameMatches, KEY_BEDS, KEY_PROFILES, KEY_STATION, normalizeBeds, normalizeProfiles, normalizeStation } from '../shared/storage';
import { LOW_BOWL } from '../sim/FeedingStation';
import type { CatTowerState, CatBedsState, CatProfile, CatRuntimeSnapshot, FeedingStation, PageInfo, PopupAction, Settings } from '../shared/types';

/** Idle-cuddle delays offered in the popup (seconds). */
const IDLE_CHOICES = [30, 60, 120, 300, 600, 1800];
import { CatPortrait } from '../engine/CatPortrait';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface CardRefs {
  root: HTMLElement;
  portrait: CatPortrait;
  name: HTMLInputElement;
  state: HTMLElement;
  energy: HTMLElement;
  affection: HTMLElement;
}

class PopupController {
  private settings!: Settings;
  private profiles: CatProfile[] = [];
  private tabId: number | null = null;
  private page: PageInfo | null = null;
  private cards = new Map<string, CardRefs>();
  private snapshots = new Map<string, CatRuntimeSnapshot>();
  private last = performance.now();
  private nameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private station!: FeedingStation;
  private beds!: CatBedsState;
  private tower!: CatTowerState;
  /** Cats off visiting another tab. */
  private away = new Set<string>();

  async init(): Promise<void> {
    this.settings = await loadSettings();
    setLanguage(this.settings.language);
    translateDom();
    this.profiles = await loadProfiles();
    this.station = await loadStation();
    this.beds = await loadBeds();
    this.tower = await loadTower();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.tabId = tab?.id ?? null;
    if (this.tabId !== null) this.page = await sendToTab<PageInfo>(this.tabId, { type: 'cm:getPageInfo' });
    this.buildCards();
    this.bindControls();
    this.renderControls();
    await this.refreshWorld();
    setInterval(() => void this.refreshWorld(), 700);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY_STATION]) {
        this.station = normalizeStation(changes[KEY_STATION].newValue);
        this.renderStation();
      }
      if (area === 'local' && changes[KEY_TOWER]) {
        this.tower = normalizeTower(changes[KEY_TOWER].newValue);
        this.renderQuick();
      }
      if (area === 'local' && changes[KEY_BEDS]) {
        this.beds = normalizeBeds(changes[KEY_BEDS].newValue);
        this.renderQuick();
      }
      if (area !== 'local' || !changes[KEY_PROFILES]) return;
      const next = normalizeProfiles(changes[KEY_PROFILES].newValue);
      const shape = (l: CatProfile[]) => l.map((p) => `${p.id}:${p.enabled ? 1 : 0}`).join(',');
      const rebuild = shape(next) !== shape(this.profiles);
      this.profiles = next;
      if (rebuild && !document.activeElement?.classList.contains('cat__name')) this.buildCards();
    });
    requestAnimationFrame(this.frame);
  }

  private buildCards(): void {
    const host = $('cats');
    host.textContent = '';
    this.cards.clear();
    const canRemove = this.profiles.length > 1;
    for (const prof of this.profiles) {
      const root = document.createElement('article');
      root.className = `cat${prof.enabled ? '' : ' is-off'}`;
      root.innerHTML = `
        <canvas class="cat__portrait" width="92" height="70" aria-hidden="true"></canvas>
        <div class="cat__info">
          <div class="cat__head">
            <input class="cat__name" type="text" maxlength="28" dir="auto" spellcheck="false" />
            <button class="cat__icon" type="button" data-act="edit">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 13.6V16h2.4l7.1-7.1-2.4-2.4L4 13.6zm11.3-6.5a.8.8 0 0 0 0-1.1l-1.3-1.3a.8.8 0 0 0-1.1 0l-1 1 2.4 2.4 1-1z" fill="currentColor"/></svg>
            </button>
            <button class="cat__icon cat__icon--danger" type="button" data-act="remove">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3.5h5l.6 1.3H16v1.5H4V4.8h2.9l.6-1.3zM5.4 7.3h9.2l-.7 8.3a1 1 0 0 1-1 .9H7.1a1 1 0 0 1-1-.9l-.7-8.3z" fill="currentColor"/></svg>
              <span class="cat__confirm"></span>
            </button>
            <input class="switch switch--sm cat__toggle" type="checkbox" />
          </div>
          <p class="cat__state"></p>
          <div class="meter meter--energy"><span class="meter__label"></span><span class="meter__track"><span class="meter__fill"></span></span></div>
          <div class="meter meter--affection"><span class="meter__label"></span><span class="meter__track"><span class="meter__fill"></span></span></div>
        </div>`;
      host.append(root);
      const canvas = root.querySelector('canvas') as HTMLCanvasElement;
      const name = root.querySelector('.cat__name') as HTMLInputElement;
      name.value = displayName(prof);
      name.setAttribute('aria-label', t('name'));
      name.addEventListener('input', () => this.queueName(prof.id, name.value));
      (root.querySelector('.meter--energy .meter__label') as HTMLElement).textContent = t('energy');
      (root.querySelector('.meter--affection .meter__label') as HTMLElement).textContent = t('affection');

      // On / off
      const toggle = root.querySelector('.cat__toggle') as HTMLInputElement;
      toggle.checked = prof.enabled;
      toggle.setAttribute('aria-label', `${t('catToggle')}: ${prof.name}`);
      toggle.title = t('catToggle');
      toggle.addEventListener('change', async () => {
        root.classList.toggle('is-off', !toggle.checked);
        this.profiles = await patchProfile(prof.id, { enabled: toggle.checked });
        this.applySnapshot(prof.id);
        this.renderEmptyNote();
      });

      // Edit: opens the Studio focused on this cat.
      const edit = root.querySelector('[data-act="edit"]') as HTMLButtonElement;
      edit.title = t('editCat');
      edit.setAttribute('aria-label', `${t('editCat')}: ${prof.name}`);
      edit.addEventListener('click', async () => {
        await sendRuntime({ type: 'cm:openStudio', catId: prof.id });
        window.close();
      });

      // Remove: two-step, so a stray click never deletes a cat.
      const remove = root.querySelector('[data-act="remove"]') as HTMLButtonElement;
      const confirmLabel = remove.querySelector('.cat__confirm') as HTMLElement;
      remove.disabled = !canRemove;
      remove.title = canRemove ? t('removeCat') : t('keepOneCat');
      remove.setAttribute('aria-label', `${t('removeCat')}: ${prof.name}`);
      let armed: ReturnType<typeof setTimeout> | null = null;
      remove.addEventListener('click', async () => {
        if (!armed) {
          remove.classList.add('is-armed');
          confirmLabel.textContent = t('removeCatConfirm');
          armed = setTimeout(() => {
            armed = null;
            remove.classList.remove('is-armed');
            confirmLabel.textContent = '';
          }, 3000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        this.profiles = await removeProfile(prof.id);
        this.buildCards();
      });

      const portrait = new CatPortrait(canvas, prof, lang() === 'he' ? -1 : 1);
      this.cards.set(prof.id, {
        root,
        portrait,
        name,
        state: root.querySelector('.cat__state') as HTMLElement,
        energy: root.querySelector('.meter--energy .meter__fill') as HTMLElement,
        affection: root.querySelector('.meter--affection .meter__fill') as HTMLElement,
      });
      this.applySnapshot(prof.id);
    }
    this.renderEmptyNote();
  }

  private renderEmptyNote(): void {
    const host = $('cats');
    host.querySelector('.cats__empty')?.remove();
    if (this.profiles.some((p) => p.enabled)) return;
    const p = document.createElement('p');
    p.className = 'note cats__empty';
    p.textContent = t('noCats');
    host.append(p);
  }

  private queueName(id: string, value: string): void {
    clearTimeout(this.nameTimers.get(id));
    this.nameTimers.set(
      id,
      setTimeout(() => {
        const name = value.trim() || this.profiles.find((p) => p.id === id)?.name || 'Cat';
        void patchProfile(id, { name }).then((list) => (this.profiles = list));
      }, 350),
    );
  }

  private applySnapshot(id: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    const snap = this.snapshots.get(id);
    const enabled = this.profiles.find((p) => p.id === id)?.enabled ?? true;
    const state: CatState = !enabled ? 'CURLED_SLEEP' : snap && isCatState(snap.state) ? snap.state : 'IDLE_SIT';
    card.portrait.setState(state);
    card.state.textContent = !enabled ? t('catOff') : this.away.has(id) ? t('visitingTab') : stateLabel(state);
    card.energy.style.width = `${Math.round(snap?.drives.energy ?? 60)}%`;
    card.affection.style.width = `${Math.round(snap?.drives.affection ?? 70)}%`;
  }

  private async refreshWorld(): Promise<void> {
    const res = await sendRuntime<HydrateResponse>({ type: 'cm:getWorld' });
    if (res) this.away = new Set(res.away ?? []);
    if (res?.world) for (const c of res.world.cats) this.snapshots.set(c.id, c);
    if (res) for (const id of this.cards.keys()) this.applySnapshot(id);
  }

  private readonly frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    for (const c of this.cards.values()) c.portrait.tick(dt);
    requestAnimationFrame(this.frame);
  };

  /* ------------------------------------------------------------ controls */

  private bindControls(): void {
    $('lang').addEventListener('click', async () => {
      const next = lang() === 'he' ? 'en' : 'he';
      this.settings = await patchSettings({ language: next });
      setLanguage(next);
      translateDom();
      this.buildCards();
      this.renderControls();
    });
    document.querySelectorAll<HTMLButtonElement>('.toy').forEach((btn) => {
      btn.addEventListener('click', () => void this.action(btn.dataset.action as PopupAction, btn));
    });
    $('lock').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ clickThroughLock: (e.target as HTMLInputElement).checked });
      this.renderControls();
    });
    $('site').addEventListener('change', async (e) => {
      const host = this.page?.hostname;
      if (!host) return;
      const on = (e.target as HTMLInputElement).checked;
      const list = this.settings.blacklist.filter((h) => !hostnameMatches(host, h));
      if (on) list.push(host.replace(/^www\./, ''));
      this.settings = await patchSettings({ blacklist: list });
      this.renderControls();
    });
    $('scale').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ catScale: Number((e.target as HTMLInputElement).value) });
    });
    $('names').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ showNameTags: (e.target as HTMLInputElement).checked });
    });
    $('calm').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ calmMode: (e.target as HTMLInputElement).checked });
    });
    $('global').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ globalPause: (e.target as HTMLInputElement).checked });
      this.renderControls();
    });
    $('toggleStation').addEventListener('click', async () => {
      this.station = await patchStation({ enabled: !this.station.enabled });
      this.renderStation();
    });
    $('toggleBeds').addEventListener('click', async () => {
      this.beds = await patchBeds({ enabled: !this.beds.enabled });
      this.renderQuick();
    });
    $('toggleTower').addEventListener('click', async () => {
      this.tower = await patchTower({ enabled: !this.tower.enabled });
      this.renderQuick();
    });
    $('clearAll').addEventListener('click', () => void this.action('clear', $('clearAll') as HTMLButtonElement));
    $('roam').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ tabRoaming: (e.target as HTMLInputElement).checked });
    });
    $('refillFood').addEventListener('click', async () => {
      this.station = await patchStation({ foodLevel: 100, enabled: true });
      this.renderStation();
    });
    $('refillWater').addEventListener('click', async () => {
      this.station = await patchStation({ waterLevel: 100, enabled: true });
      this.renderStation();
    });
    $('idle').addEventListener('change', async (e) => {
      this.settings = await patchSettings({ idleThreshold: Number((e.target as HTMLSelectElement).value) });
    });
    $('studio').addEventListener('click', () => {
      void chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  private renderStation(): void {
    const st = this.station;
    $('station').classList.toggle('is-off', !st.enabled);
    const low: string[] = [];
    for (const [kind, level] of [
      ['food', st.foodLevel],
      ['water', st.waterLevel],
    ] as const) {
      const pct = Math.round(level);
      $(`${kind}Fill`).style.width = `${pct}%`;
      $(`${kind}Pct`).textContent = `${pct}%`;
      const meter = $(`${kind}Meter`);
      meter.setAttribute('aria-valuenow', String(pct));
      const bowl = meter.closest('.bowl');
      bowl?.classList.toggle('is-empty', pct <= 5);
      bowl?.classList.toggle('is-low', pct > 5 && level <= LOW_BOWL);
      if (level <= LOW_BOWL) low.push(t(kind));
    }
    const badge = $('stationLow');
    badge.hidden = !st.enabled || low.length === 0;
    badge.textContent = low.length ? `${t('runningLow')}: ${low.join(', ')}` : '';
    this.renderQuick();
  }

  /** The "show on the page" chips. */
  private renderQuick(): void {
    const st = $('toggleStation');
    st.setAttribute('aria-pressed', String(!!this.station?.enabled));
    st.title = t(this.station?.enabled ? 'hideBowls' : 'showBowls');
    const beds = $('toggleBeds');
    beds.setAttribute('aria-pressed', String(!!this.beds?.enabled));
    beds.title = t(this.beds?.enabled ? 'hideBeds' : 'showBeds');
    const tower = $('toggleTower');
    tower.setAttribute('aria-pressed', String(!!this.tower?.enabled));
    tower.title = t(this.tower?.enabled ? 'hideTower' : 'showTower');
    $('clearAll').title = t('clearHint');
  }

  private renderIdleChoices(): void {
    const sel = $('idle') as HTMLSelectElement;
    sel.textContent = '';
    const cur = this.settings.idleThreshold;
    const choices = IDLE_CHOICES.includes(cur) ? IDLE_CHOICES : [...IDLE_CHOICES, cur].sort((a, b) => a - b);
    for (const sec of choices) {
      const o = document.createElement('option');
      o.value = String(sec);
      o.textContent = sec < 60 ? `${t('idleAfter')} ${sec} ${t('secondsShort')}` : `${t('idleAfter')} ${Math.round(sec / 60)} ${t('minutesShort')}`;
      sel.append(o);
    }
    sel.value = String(cur);
  }

  private renderControls(): void {
    const s = this.settings;
    this.renderStation();
    this.renderIdleChoices();
    ($('lock') as HTMLInputElement).checked = s.clickThroughLock;
    $('lockSub').textContent = s.clickThroughLock ? t('clickThroughOn') : t('clickThroughOff');
    const host = this.page?.hostname ?? '';
    const paused = !!host && s.blacklist.some((h) => hostnameMatches(host, h));
    const site = $('site') as HTMLInputElement;
    site.checked = paused;
    site.disabled = !host;
    $('siteSub').textContent = host || '—';
    ($('scale') as HTMLInputElement).value = String(s.catScale);
    ($('names') as HTMLInputElement).checked = s.showNameTags;
    ($('calm') as HTMLInputElement).checked = s.calmMode;
    ($('roam') as HTMLInputElement).checked = s.tabRoaming;
    ($('global') as HTMLInputElement).checked = s.globalPause;
    const reachable = !!this.page && this.page.running;
    document.querySelectorAll<HTMLButtonElement>('.toy').forEach((b) => {
      b.disabled = !reachable;
      if (b.dataset.action === 'treat' || b.dataset.action === 'laser' || b.dataset.action === 'ball' || b.dataset.action === 'feather_wand') b.setAttribute('aria-pressed', String(this.page?.playTool === b.dataset.action));
    });
    ($('clearAll') as HTMLButtonElement).disabled = !reachable;
    const note = $('note');
    if (!this.page) {
      note.hidden = false;
      note.textContent = t('restricted');
    } else if (paused || s.globalPause) {
      note.hidden = false;
      note.textContent = `${t('pausedHere')} ${host}`;
    } else note.hidden = true;
  }

  private async action(action: PopupAction, btn: HTMLButtonElement): Promise<void> {
    if (this.tabId === null) return;
    if (action === 'treat' || action === 'laser' || action === 'ball' || action === 'feather_wand') {
      // Toys go into your hand: play on the page with the left mouse button.
      const tool = this.page?.playTool === action ? null : action;
      const res = await sendToTab<{ ok: boolean }>(this.tabId, { type: 'cm:play', tool });
      if (res?.ok) {
        if (this.page) this.page.playTool = tool;
        if (tool) window.close();
        else this.renderControls();
      }
      return;
    }
    const res = await sendToTab<{ ok: boolean }>(this.tabId, { type: 'cm:action', action });
    if (res?.ok) {
      btn.classList.add('is-done');
      setTimeout(() => btn.classList.remove('is-done'), 900);
    }
  }
}

void new PopupController().init();
