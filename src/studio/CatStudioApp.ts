/**
 * CatStudioApp — the Options page. Build your real cats from photos:
 * anatomical colour sampling, K-Means auto palette, coat pattern & marking
 * editor, UV paint brush, morphology & personality, a live 60 FPS sandbox, and
 * sprite sheet baking / importing. Every edit previews instantly and autosaves
 * to chrome.storage.local, so cats on open tabs update live.
 */
import { ALL_STATES, type CatState } from '../shared/catStates';
import { displayName, lang, patternLabel, setLanguage, stateLabel, t, tf, translateDom } from '../shared/i18n';
import { ALEX_ID, ANNA_ID, EXTRA_PRESETS, MAX_CATS, createFromBuiltin, createFromTemplate, normalizeProfile } from '../shared/presets';
import { KEY_PROFILES, KEY_SETTINGS, loadProfiles, loadSettings, normalizeProfiles, normalizeSettings, patchSettings, resetToFactory, saveProfiles, withoutProfile } from '../shared/storage';
import { COAT_PATTERNS, type CatProfile, type CatTraits, type CoatMarkings, type CoatPalette, type CoatPattern, type Morphology, type Personality, type Settings, type SignatureBehaviors } from '../shared/types';
import { dataUrlToBytes } from '../shared/zip';
import { rgbToHex, type RGB } from '../shared/color';
import { uid } from '../shared/rng';
import { CatPortrait } from '../engine/CatPortrait';
import { buildCoatTexture } from '../engine/CoatTexture';
import { UV } from '../engine/UVLayout';
import { PreviewSandbox } from './PreviewSandbox';
import { CoatPainter } from './CoatPainter';
import { SAMPLE_ROLES, analyzePhoto, averagePatch, interpretSamples, loadPhoto, mergePalette, thumbnail, type PixelSource, type SampleRole } from './PhotoColorExtractor';
import { bakeZip, downloadBlob, importSpriteFile, type ImportLayout } from './SpriteSheetBaker';
import type { ToolKind } from '../sim/ToyTool';
import { MAX_CAT_FILE_BYTES, exportFileName, mergeImported, parseCatFile, serializeCats } from '../shared/catFile';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

let fieldCounter = 0;

function sliderField(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void, fmt: (v: number) => string = (v) => v.toFixed(2)): HTMLElement {
  const id = `f${++fieldCounter}`;
  const input = el('input', { type: 'range', id, min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const out = el('span', { class: 'field__value', text: fmt(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  return el('div', { class: 'field' }, el('label', { class: 'field__label', for: id, text: label }), input, out);
}

function toggleField(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check' }, input, el('span', { text: label }));
}

function segmented<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const wrap = el('div', { class: 'segmented', role: 'group' });
  for (const [v, label] of options) {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === value), text: label });
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onChange(v);
    });
    wrap.append(b);
  }
  return wrap;
}

interface PhotoEntry {
  canvas: HTMLCanvasElement;
  pixels: PixelSource;
}

interface Pin {
  /** Which of the cat's photos the pin sits on (eyes can come from one photo, fur from another). */
  photo: number;
  x: number;
  y: number;
  color: RGB;
}

const PALETTE_KEYS: (keyof CoatPalette)[] = ['baseWhite', 'undercoatWarm', 'tabbyBase', 'tabbyStripe', 'rufus', 'flankPatch', 'patchSecondary', 'noseLeather', 'pawPads', 'innerEar', 'eyeLeft', 'eyeRight', 'eyeRim'];
const PALETTE_LABEL_KEY: Partial<Record<keyof CoatPalette, string>> = { flankPatch: 'flankPatchColor' };

const MARKING_SLIDERS: (keyof CoatMarkings)[] = ['whiteAmount', 'blazeWidth', 'blazeSoftness', 'blazeAsymmetry', 'blazeHeight', 'eyeliner', 'cheekStripes', 'eyeHalo', 'frontLegWhite', 'hindLegWhite', 'stripeDensity'];
const MARKING_TOGGLES: (keyof CoatMarkings)[] = ['shoulderBand', 'flankPatch', 'rumpCrest', 'mMark', 'tailTipDark'];
const PERSONALITY_LABEL: Record<keyof Personality, string> = { laziness: 'laziness', huntDrive: 'huntDrive', sociability: 'sociability', sassiness: 'sassiness', clumsiness: 'clumsiness', affection: 'affectionTrait' };
const SIGNATURE_KEYS: (keyof SignatureBehaviors)[] = ['chinPropSleep', 'meltedLoafSleep', 'airplaneSquint', 'pillowSnuggler', 'widePawSplay'];
/** Trait sliders: key, i18n label, range, step. */
const TRAIT_SLIDERS: [Exclude<keyof CatTraits, 'bondedWith'>, string, number, number, number][] = [
  ['hungerRateMultiplier', 'hungerRateMultiplier', 0.5, 2, 0.05],
  ['thirstRateMultiplier', 'thirstRateMultiplier', 0.5, 2, 0.05],
  ['playfulness', 'playTrait', 0, 1, 0.01],
  ['pettingAffinity', 'pettingAffinity', 0.5, 2, 0.05],
  ['earExpressiveness', 'earExpressiveness', 0, 1, 0.01],
  ['socialInitiative', 'socialInitiative', 0, 1, 0.01],
  ['sprawlLover', 'sprawlLover', 0, 1, 0.01],
];

class CatStudioApp {
  private profiles: CatProfile[] = [];
  private selectedId = '';
  private settings!: Settings;
  private sandbox!: PreviewSandbox;
  private painter!: CoatPainter;
  private portraits = new Map<string, CatPortrait>();
  private photos = new Map<string, PhotoEntry[]>();
  private activePhoto = 0;
  private pins = new Map<string, Partial<Record<SampleRole, Pin>>>();
  private activeRole: SampleRole = 'primaryFur';
  private analysis: ReturnType<typeof analyzePhoto> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private painterTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshQueued = false;
  private lastSave = 0;
  private last = performance.now();
  private patternJob = 0;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    setLanguage(this.settings.language);
    translateDom();
    this.profiles = await loadProfiles();
    this.selectedId = this.profiles[0]?.id ?? '';
    this.sandbox = new PreviewSandbox($('preview') as HTMLCanvasElement, this.settings);
    this.painter = new CoatPainter((mask) => this.update({ paintMask: mask }, { skipPainter: true }));
    $('painterHost').append(this.painter.view);
    const hashId = /(?:^|[#&])cat=([^&]+)/.exec(location.hash);
    if (hashId && this.profiles.some((p) => p.id === decodeURIComponent(hashId[1]))) this.selectedId = decodeURIComponent(hashId[1]);
    this.bindStatic();
    this.renderAll();
    this.sandbox.start();
    window.addEventListener('hashchange', () => this.selectFromHash());
    requestAnimationFrame(this.frame);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEY_SETTINGS]) {
        this.settings = normalizeSettings(changes[KEY_SETTINGS].newValue);
        this.sandbox.setSettings(this.settings);
      }
      if (changes[KEY_PROFILES] && Date.now() - this.lastSave > 1500) {
        this.profiles = normalizeProfiles(changes[KEY_PROFILES].newValue);
        if (!this.profiles.find((p) => p.id === this.selectedId)) this.selectedId = this.profiles[0]?.id ?? '';
        this.renderAll();
      }
    });
  }

  private get current(): CatProfile {
    return this.profiles.find((p) => p.id === this.selectedId) ?? this.profiles[0];
  }

  private readonly frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    for (const p of this.portraits.values()) p.tick(dt);
    requestAnimationFrame(this.frame);
  };

  /* ------------------------------------------------------------- updates */

  private update(patch: Partial<CatProfile>, opts: { skipPainter?: boolean; rail?: boolean } = {}): void {
    const i = this.profiles.findIndex((p) => p.id === this.selectedId);
    if (i < 0) return;
    this.profiles[i] = normalizeProfile({ ...this.profiles[i], ...patch }, this.profiles[i].slot);
    this.queueRefresh();
    if (!opts.skipPainter && (patch.palette || patch.pattern || patch.markings)) this.queuePainter();
    if (opts.rail || patch.name !== undefined || patch.pattern !== undefined || patch.enabled !== undefined) this.updateRailItem(this.profiles[i]);
    this.scheduleSave();
  }

  private updateNested<K extends 'palette' | 'markings' | 'morphology' | 'personality' | 'signature' | 'traits'>(key: K, field: string, value: unknown): void {
    const cur = this.current;
    this.update({ [key]: { ...(cur[key] as object), [field]: value } } as Partial<CatProfile>);
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.sandbox.setProfiles(this.profiles, this.selectedId, ($('showBoth') as HTMLInputElement).checked);
      for (const p of this.profiles) this.portraits.get(p.id)?.setProfile(p);
    });
  }

  private queuePainter(): void {
    if (this.painterTimer) clearTimeout(this.painterTimer);
    this.painterTimer = setTimeout(() => void this.painter.setProfile(this.current), 180);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    $('saveState').textContent = '';
    this.saveTimer = setTimeout(async () => {
      this.lastSave = Date.now();
      try {
        await saveProfiles(this.profiles);
        $('saveState').textContent = t('saved');
        setTimeout(() => ($('saveState').textContent = ''), 1800);
      } catch (e) {
        $('saveState').textContent = String((e as Error).message ?? e);
      }
    }, 450);
  }

  /* -------------------------------------------------------------- static */

  private bindStatic(): void {
    $('lang').addEventListener('click', async () => {
      const next = lang() === 'he' ? 'en' : 'he';
      this.settings = await patchSettings({ language: next });
      setLanguage(next);
      translateDom();
      this.renderAll();
    });
    $('reset').addEventListener('click', async () => {
      if (!confirm(t('confirmReset'))) return;
      await resetToFactory();
      this.lastSave = Date.now();
      this.profiles = await loadProfiles();
      this.selectedId = this.profiles[0].id;
      this.photos.clear();
      this.pins.clear();
      this.renderAll();
    });
    $('addCat').addEventListener('click', () => this.addCat());
    // Export / import
    $('exportCat').addEventListener('click', () => this.exportCats([this.current]));
    $('exportAll').addEventListener('click', () => this.exportCats(this.profiles));
    const imp = $('importCats') as HTMLInputElement;
    $('importBtn').addEventListener('click', () => imp.click());
    imp.addEventListener('change', () => {
      if (imp.files?.[0]) void this.importCats(imp.files[0]);
      imp.value = '';
    });
    this.makeDropzone(document.querySelector('.rail') as HTMLElement, (files) => {
      const f = files.find((x) => x.name.endsWith('.json') || x.type === 'application/json');
      if (f) void this.importCats(f);
    });
    $('showBoth').addEventListener('change', () => this.queueRefresh());
    $('triggerBtn').addEventListener('click', () => this.sandbox.trigger(($('stateSelect') as HTMLSelectElement).value as CatState));
    // Toy buttons put a toy in your hand for the preview: left-click to play, again (or Esc) to put it down.
    document.querySelectorAll<HTMLButtonElement>('[data-toy]').forEach((b) =>
      b.addEventListener('click', () => {
        const kind = b.dataset.toy as ToolKind;
        this.setPreviewTool(this.sandbox.tool.kind === kind ? null : kind);
      }),
    );
    $('preview').addEventListener('contextmenu', (e) => {
      if (!this.sandbox.tool.active) return;
      e.preventDefault();
      this.setPreviewTool(null);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sandbox.tool.active) this.setPreviewTool(null);
    });
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) =>
      tab.addEventListener('click', () => {
        document.querySelectorAll<HTMLButtonElement>('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
        document.querySelectorAll<HTMLElement>('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
        if (tab.dataset.tab === 'paint') void this.painter.setProfile(this.current);
        if (tab.dataset.tab === 'coat') this.renderPatternPreviews();
      }),
    );
    // Photos
    const input = $('photoInput') as HTMLInputElement;
    input.addEventListener('change', () => {
      if (input.files) void this.addPhotos(Array.from(input.files));
      input.value = '';
    });
    this.makeDropzone($('photoDrop'), (files) => void this.addPhotos(files.filter((f) => f.type.startsWith('image/'))));
    $('photoStage').addEventListener('pointerdown', (e) => this.samplePhoto(e));
    $('applySamples').addEventListener('click', () => {
      const pins = this.pins.get(this.selectedId) ?? {};
      const samples: Partial<Record<SampleRole, RGB>> = {};
      for (const r of SAMPLE_ROLES) if (pins[r]) samples[r] = (pins[r] as Pin).color;
      const msg = $('sampleMsg');
      if (!Object.keys(samples).length) {
        msg.textContent = t('noSamples');
        return;
      }
      const result = interpretSamples(samples, { whiteBalance: ($('whiteBalance') as HTMLInputElement).checked });
      this.update({ palette: mergePalette(this.current, result.palette) });
      this.renderCoat();
      msg.textContent = [t('samplesApplied'), result.whiteBalanced ? t('samplesBalanced') : '', result.skippedEyes.length ? t('eyesSkipped') : ''].filter(Boolean).join(' ');
    });
    $('analyze').addEventListener('click', () => {
      const entry = (this.photos.get(this.selectedId) ?? [])[this.activePhoto];
      if (!entry) {
        $('clusters').textContent = t('noPhoto');
        return;
      }
      this.analysis = analyzePhoto(entry.pixels, 7);
      this.renderClusters();
    });
    $('applySuggestion').addEventListener('click', () => {
      if (!this.analysis) return;
      this.update({ palette: mergePalette(this.current, this.analysis.suggestion.palette) });
      this.renderCoat();
    });
    // Paint tools
    const brush = this.painter.brush;
    $('brushColor').addEventListener('input', (e) => (brush.color = (e.target as HTMLInputElement).value));
    $('brushSize').addEventListener('input', (e) => (brush.size = Number((e.target as HTMLInputElement).value)));
    $('brushOpacity').addEventListener('input', (e) => (brush.opacity = Number((e.target as HTMLInputElement).value)));
    $('brushErase').addEventListener('change', (e) => (brush.erase = (e.target as HTMLInputElement).checked));
    $('guides').addEventListener('change', (e) => {
      this.painter.showGuides = (e.target as HTMLInputElement).checked;
      this.painter.composite();
    });
    $('clearPaint').addEventListener('click', () => this.painter.clear());
    // Sprites
    $('bakeHD').addEventListener('click', () => void this.bake('chromeow-hd', 'zip'));
    $('bakeOP').addEventListener('click', () => void this.bake('openpets-v1', 'zip'));
    $('bakeWebp').addEventListener('click', () => void this.bake('chromeow-hd', 'webp'));
    const sInput = $('spriteInput') as HTMLInputElement;
    sInput.addEventListener('change', () => {
      if (sInput.files?.[0]) void this.importSprite(sInput.files[0]);
      sInput.value = '';
    });
    this.makeDropzone($('spriteDrop'), (files) => files[0] && void this.importSprite(files[0]));
  }

  private makeDropzone(zone: HTMLElement, onFiles: (files: File[]) => void): void {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      if (e.dataTransfer?.files) onFiles(Array.from(e.dataTransfer.files));
    });
  }

  /* -------------------------------------------------------------- render */

  private renderAll(): void {
    this.renderRail();
    this.renderStateSelect();
    this.renderPresetSelect();
    void this.renderPhotos();
    this.renderCoat();
    void this.painter.setProfile(this.current);
    this.renderPaintQuick();
    this.renderBody();
    this.renderSprites();
    this.queueRefresh();
  }

  private renderRail(): void {
    const list = $('catList');
    list.textContent = '';
    for (const p of this.profiles) {
      const canvas = el('canvas', { class: 'cat-item__portrait', width: '62', height: '48', 'aria-hidden': 'true' });
      const toggle = el('input', { class: 'switch switch--sm cat-item__toggle', type: 'checkbox', title: t('catToggle'), 'aria-label': `${t('catToggle')}: ${p.name}` }) as HTMLInputElement;
      toggle.checked = p.enabled;
      const remove = el('button', { class: 'cat-item__remove', type: 'button', title: this.profiles.length > 1 ? t('removeCat') : t('keepOneCat'), 'aria-label': `${t('removeCat')}: ${p.name}` });
      remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3.5h5l.6 1.3H16v1.5H4V4.8h2.9l.6-1.3zM5.4 7.3h9.2l-.7 8.3a1 1 0 0 1-1 .9H7.1a1 1 0 0 1-1-.9l-.7-8.3z" fill="currentColor"/></svg>';
      (remove as HTMLButtonElement).disabled = this.profiles.length <= 1;
      const item = el(
        'li',
        { class: `cat-item${p.enabled ? '' : ' is-off'}`, 'aria-current': String(p.id === this.selectedId), tabindex: '0', 'data-id': p.id },
        canvas,
        el('div', { class: 'cat-item__text' }, el('div', { class: 'cat-item__name', text: displayName(p) }), el('div', { class: 'cat-item__meta', text: patternLabel(p.pattern) })),
        el('div', { class: 'cat-item__tools' }, toggle, remove),
      );
      const select = () => this.select(p.id);
      item.addEventListener('click', select);
      item.addEventListener('keydown', (e) => {
        if (e.target !== item) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      // The switch and bin act on this cat without changing which one is being edited.
      toggle.addEventListener('click', (e) => e.stopPropagation());
      toggle.addEventListener('change', () => this.setEnabled(p.id, toggle.checked));
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeCat(p.id);
      });
      list.append(item);
      requestAnimationFrame(() => {
        const portrait = new CatPortrait(canvas, p, lang() === 'he' ? -1 : 1);
        this.portraits.set(p.id, portrait);
      });
    }
    ($('addCat') as HTMLButtonElement).disabled = this.profiles.length >= MAX_CATS;
  }

  private updateRailItem(p: CatProfile): void {
    const item = $('catList').querySelector<HTMLElement>(`[data-id="${p.id}"]`);
    if (!item) return;
    (item.querySelector('.cat-item__name') as HTMLElement).textContent = displayName(p);
    (item.querySelector('.cat-item__meta') as HTMLElement).textContent = patternLabel(p.pattern);
    (item.querySelector('.cat-item__toggle') as HTMLInputElement).checked = p.enabled;
    item.classList.toggle('is-off', !p.enabled);
  }

  private select(id: string): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.activePhoto = 0;
    this.analysis = null;
    $('catList')
      .querySelectorAll<HTMLElement>('.cat-item')
      .forEach((x) => x.setAttribute('aria-current', String(x.dataset.id === id)));
    void this.renderPhotos();
    this.renderCoat();
    void this.painter.setProfile(this.current);
    this.renderPaintQuick();
    this.renderBody();
    this.renderSprites();
    this.queueRefresh();
  }

  private renderStateSelect(): void {
    const sel = $('stateSelect') as HTMLSelectElement;
    const prev = sel.value;
    sel.textContent = '';
    for (const s of ALL_STATES) sel.append(el('option', { value: s, text: stateLabel(s) }));
    sel.value = prev || 'PURRING';
  }

  private renderPresetSelect(): void {
    const sel = $('addPreset') as HTMLSelectElement;
    sel.textContent = '';
    const he = lang() === 'he';
    sel.append(el('option', { value: ALEX_ID, text: t('templateAlex') }));
    sel.append(el('option', { value: ANNA_ID, text: t('templateAnna') }));
    for (const p of EXTRA_PRESETS) sel.append(el('option', { value: p.key, text: he ? p.labelHe : p.label }));
  }

  private addCat(): void {
    if (this.profiles.length >= MAX_CATS) return;
    const used = new Set(this.profiles.map((p) => p.slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    const key = ($('addPreset') as HTMLSelectElement).value;
    // Alex / Anna load as full templates (coat, markings, body and quirks) to inspect or customise.
    const cat: CatProfile = createFromBuiltin(key, slot, uid('cat')) ?? createFromTemplate(key, slot);
    this.profiles.push(cat);
    this.profiles.sort((a, b) => a.slot - b.slot);
    this.selectedId = cat.id;
    this.scheduleSave();
    this.renderAll();
  }

  private setPreviewTool(kind: ToolKind | null): void {
    this.sandbox.tool.select(kind);
    document.querySelectorAll<HTMLButtonElement>('[data-toy]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.toy === kind)));
    const preview = $('preview');
    preview.dataset.tool = kind ?? '';
    const hint = document.querySelector('.stage__hint') as HTMLElement | null;
    if (hint) hint.textContent = kind ? `${t(kind === 'treat' ? 'playTreat' : kind === 'laser' ? 'playLaser' : 'playBall')} ${t('playEsc')}.` : t('previewHint');
  }

  private exportCats(cats: CatProfile[]): void {
    if (!cats.length) return;
    downloadBlob(new Blob([serializeCats(cats)], { type: 'application/json' }), exportFileName(cats));
  }

  private async importCats(file: File): Promise<void> {
    const msg = $('ioMsg');
    if (file.size > MAX_CAT_FILE_BYTES) {
      msg.textContent = t('importTooBig');
      return;
    }
    let cats: CatProfile[];
    try {
      cats = parseCatFile(await file.text());
    } catch {
      msg.textContent = t('importBad');
      return;
    }
    const res = mergeImported(this.profiles, cats);
    const parts: string[] = [];
    if (res.added.length) {
      this.profiles = res.profiles;
      this.selectedId = res.added[0].id;
      this.scheduleSave();
      this.renderAll();
      parts.push(tf('importedCats', { n: res.added.map((c) => c.name).join(', ') }));
    }
    if (res.skipped) parts.push(tf('importSkipped', { n: res.skipped }));
    msg.textContent = parts.join(' ');
  }

  private removeCurrent(): void {
    this.removeCat(this.selectedId);
  }

  private removeCat(id: string): void {
    const cat = this.profiles.find((p) => p.id === id);
    if (!cat || this.profiles.length <= 1) return;
    if (!confirm(`${t('confirmRemove')}\n${cat.name}`)) return;
    this.profiles = withoutProfile(this.profiles, id);
    this.portraits.delete(id);
    this.photos.delete(id);
    this.pins.delete(id);
    if (this.selectedId === id) this.selectedId = this.profiles[0].id;
    this.scheduleSave();
    this.renderAll();
  }

  private setEnabled(id: string, enabled: boolean): void {
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.profiles[i] = { ...this.profiles[i], enabled };
    this.updateRailItem(this.profiles[i]);
    if (id === this.selectedId) this.renderBody();
    this.queueRefresh();
    this.scheduleSave();
  }

  /** `studio.html#cat=<id>` (from the popup's Edit button) selects that cat. */
  private selectFromHash(): void {
    const m = /(?:^|[#&])cat=([^&]+)/.exec(location.hash);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (this.profiles.some((p) => p.id === id)) this.select(id);
  }

  /* -------------------------------------------------------------- photos */

  private async ensurePhotos(): Promise<PhotoEntry[]> {
    const id = this.selectedId;
    let entries = this.photos.get(id);
    if (entries) return entries;
    entries = [];
    for (const url of this.current.photos) {
      try {
        const { bytes, mime } = dataUrlToBytes(url);
        entries.push(await loadPhoto(new Blob([bytes as BlobPart], { type: mime }), 900));
      } catch {
        /* skip unreadable */
      }
    }
    this.photos.set(id, entries);
    return entries;
  }

  private async addPhotos(files: File[]): Promise<void> {
    const entries = await this.ensurePhotos();
    const thumbs = [...this.current.photos];
    for (const f of files) {
      if (entries.length >= 3) break;
      const entry = await loadPhoto(f, 900);
      entries.push(entry);
      thumbs.push(thumbnail(entry.canvas, 720));
    }
    this.activePhoto = Math.max(0, entries.length - 1);
    this.update({ photos: thumbs.slice(0, 3) });
    await this.renderPhotos();
  }

  private async renderPhotos(): Promise<void> {
    const entries = await this.ensurePhotos();
    const thumbs = $('thumbs');
    thumbs.textContent = '';
    entries.forEach((entry, i) => {
      const img = el('img', { alt: '', src: entry.canvas.toDataURL('image/jpeg', 0.6) });
      const x = el('button', { class: 'thumb__x', type: 'button', 'aria-label': t('removePhoto'), text: '×' });
      const b = el('button', { class: 'thumb', type: 'button', 'aria-current': String(i === this.activePhoto) }, img, x);
      b.addEventListener('click', (e) => {
        if (e.target === x) {
          entries.splice(i, 1);
          const photos = [...this.current.photos];
          photos.splice(i, 1);
          this.activePhoto = 0;
          // Drop the removed photo's pins and re-index pins on the photos after it.
          const pins = this.pins.get(this.selectedId) ?? {};
          for (const r of SAMPLE_ROLES) {
            const pin = pins[r];
            if (!pin) continue;
            if (pin.photo === i) delete pins[r];
            else if (pin.photo > i) pin.photo--;
          }
          this.update({ photos });
        } else {
          this.activePhoto = i;
        }
        void this.renderPhotos();
      });
      thumbs.append(b);
    });
    const canvas = $('photoCanvas') as HTMLCanvasElement;
    const entry = entries[this.activePhoto];
    if (entry) {
      canvas.width = entry.canvas.width;
      canvas.height = entry.canvas.height;
      (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(entry.canvas, 0, 0);
      canvas.hidden = false;
    } else {
      canvas.hidden = true;
    }
    $('photoStage').hidden = !entry;
    this.renderRoles();
    this.renderPins();
    this.renderClusters();
  }

  private renderRoles(): void {
    const roles = $('roles');
    roles.textContent = '';
    const pins = this.pins.get(this.selectedId) ?? {};
    for (const r of SAMPLE_ROLES) {
      const sw = el('span', { class: 'role__swatch' });
      const pin = pins[r];
      if (pin) sw.style.background = rgbToHex(pin.color);
      const b = el('button', { class: 'role', type: 'button', role: 'radio', 'aria-checked': String(r === this.activeRole) }, sw, el('span', { text: t(r) }));
      b.addEventListener('click', () => {
        this.activeRole = r;
        this.renderRoles();
      });
      roles.append(b);
    }
  }

  private renderPins(): void {
    const layer = $('pins');
    layer.textContent = '';
    const entry = (this.photos.get(this.selectedId) ?? [])[this.activePhoto];
    if (!entry) return;
    const pins = this.pins.get(this.selectedId) ?? {};
    for (const r of SAMPLE_ROLES) {
      const pin = pins[r];
      if (!pin || pin.photo !== this.activePhoto) continue;
      const dot = el('div', { class: 'pin', title: t(r) }, el('span', { text: t(r) }));
      dot.style.left = `${(pin.x / entry.canvas.width) * 100}%`;
      dot.style.top = `${(pin.y / entry.canvas.height) * 100}%`;
      dot.style.background = rgbToHex(pin.color);
      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        dot.setPointerCapture(e.pointerId);
        // A drag moves this pin; a plain tap samples the *active* body part right here, so a
        // neighbouring pin (an eye next to the nose) never swallows the click.
        const sx = e.clientX;
        const sy = e.clientY;
        let dragging = false;
        const move = (ev: PointerEvent) => {
          if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          dragging = true;
          this.placePin(r, ev, false);
        };
        const up = (ev: PointerEvent) => {
          dot.removeEventListener('pointermove', move);
          dot.removeEventListener('pointerup', up);
          if (!dragging && r !== this.activeRole) {
            this.samplePhoto(ev);
            return;
          }
          this.renderPins();
          this.renderRoles();
        };
        dot.addEventListener('pointermove', move);
        dot.addEventListener('pointerup', up);
      });
      layer.append(dot);
    }
  }

  private placePin(role: SampleRole, e: PointerEvent, rerender = true): void {
    const entry = (this.photos.get(this.selectedId) ?? [])[this.activePhoto];
    if (!entry) return;
    const rect = ($('photoCanvas') as HTMLCanvasElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * entry.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * entry.canvas.height;
    if (x < 0 || y < 0 || x > entry.canvas.width || y > entry.canvas.height) return;
    const radius = Math.max(2, Math.round(entry.canvas.width / 180));
    const color = averagePatch(entry.pixels, x, y, radius);
    const pins = this.pins.get(this.selectedId) ?? {};
    pins[role] = { photo: this.activePhoto, x, y, color };
    this.pins.set(this.selectedId, pins);
    if (rerender) {
      this.renderPins();
      this.renderRoles();
    } else {
      const dot = Array.from($('pins').children).find((d) => (d as HTMLElement).title === t(role)) as HTMLElement | undefined;
      if (dot) {
        dot.style.left = `${(x / entry.canvas.width) * 100}%`;
        dot.style.top = `${(y / entry.canvas.height) * 100}%`;
        dot.style.background = rgbToHex(color);
      }
    }
  }

  private samplePhoto(e: PointerEvent): void {
    this.placePin(this.activeRole, e, true);
    // Advance to the next body part that hasn't been sampled yet.
    const pins = this.pins.get(this.selectedId) ?? {};
    const next = SAMPLE_ROLES.find((r) => !pins[r]);
    if (next) {
      this.activeRole = next;
      this.renderRoles();
    }
  }

  private renderClusters(): void {
    const box = $('clusters');
    box.textContent = '';
    const btn = $('applySuggestion') as HTMLButtonElement;
    btn.disabled = !this.analysis;
    if (!this.analysis) return;
    const roleOf = new Map<string, string[]>();
    for (const [key, hex] of Object.entries(this.analysis.suggestion.roles)) {
      if (!hex) continue;
      const list = roleOf.get(hex) ?? [];
      list.push(t(PALETTE_LABEL_KEY[key as keyof CoatPalette] ?? key));
      roleOf.set(hex, list);
    }
    for (const c of this.analysis.clusters) {
      const sw = el('span', { class: 'cluster__swatch' });
      sw.style.background = c.hex;
      const bar = el('span', { class: 'cluster__bar' });
      bar.style.background = c.hex;
      bar.style.width = `${Math.max(4, c.share * 100)}%`;
      const roles = roleOf.get(c.hex);
      box.append(
        el('div', { class: 'cluster' }, sw, el('div', {}, bar, el('div', { class: 'cluster__role', text: roles ? roles.join(', ') : c.hex })), el('span', { class: 'field__value', text: `${Math.round(c.share * 100)}%` })),
      );
    }
    box.append(el('p', { class: 'hint', text: `Contrast spread: ${Math.round(this.analysis.contrast * 100)}%` }));
  }

  /* ---------------------------------------------------------------- coat */

  private renderCoat(): void {
    const cur = this.current;
    const grid = $('patterns');
    grid.textContent = '';
    for (const pat of COAT_PATTERNS) {
      const canvas = el('canvas', { width: '240', height: '90', 'data-pattern': pat });
      const b = el('button', { class: 'pattern', type: 'button', 'aria-pressed': String(pat === cur.pattern) }, canvas, el('span', { text: patternLabel(pat) }));
      b.addEventListener('click', () => {
        grid.querySelectorAll('.pattern').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        this.update({ pattern: pat as CoatPattern });
      });
      grid.append(b);
    }
    this.renderPatternPreviews();

    const sw = $('swatches');
    sw.textContent = '';
    for (const key of PALETTE_KEYS) {
      const input = el('input', { type: 'color', 'aria-label': t(PALETTE_LABEL_KEY[key] ?? key) });
      input.value = cur.palette[key].length === 7 ? cur.palette[key] : '#888888';
      input.addEventListener('input', () => this.updateNested('palette', key, input.value.toUpperCase()));
      sw.append(el('label', { class: 'swatch' }, input, el('span', { text: t(PALETTE_LABEL_KEY[key] ?? key) })));
    }

    const mk = $('markings');
    mk.textContent = '';
    for (const key of MARKING_SLIDERS) {
      mk.append(sliderField(t(key), cur.markings[key] as number, 0, 1, 0.01, (v) => this.updateNested('markings', key, v)));
    }
    mk.append(sliderField(t('tailRings'), cur.markings.tailRings, 0, 8, 1, (v) => this.updateNested('markings', 'tailRings', v), (v) => String(Math.round(v))));
    for (const key of MARKING_TOGGLES) mk.append(toggleField(t(key), cur.markings[key] as boolean, (v) => this.updateNested('markings', key, v)));
  }

  /** Renders a torso swatch of each coat pattern with the current palette (idle-chunked). */
  private renderPatternPreviews(): void {
    const job = ++this.patternJob;
    const canvases = Array.from($('patterns').querySelectorAll<HTMLCanvasElement>('canvas'));
    const cur = this.current;
    let i = 0;
    const step = () => {
      if (job !== this.patternJob || i >= canvases.length) return;
      const c = canvases[i++];
      const pattern = c.dataset.pattern as CoatPattern;
      const tex = buildCoatTexture({ ...cur, pattern, paintMask: null }, null);
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(tex.canvas as CanvasImageSource, UV.torso.x, UV.torso.y, UV.torso.w, UV.torso.h, 0, 0, c.width, c.height);
      setTimeout(step, 0);
    };
    setTimeout(step, 30);
  }

  /* --------------------------------------------------------------- paint */

  private renderPaintQuick(): void {
    const q = $('quickColors');
    q.textContent = '';
    const pal = this.current.palette;
    for (const key of ['tabbyStripe', 'tabbyBase', 'rufus', 'flankPatch', 'baseWhite', 'patchSecondary', 'noseLeather'] as (keyof CoatPalette)[]) {
      const b = el('button', { type: 'button', title: t(PALETTE_LABEL_KEY[key] ?? key), 'aria-label': t(PALETTE_LABEL_KEY[key] ?? key) });
      b.style.background = pal[key];
      b.addEventListener('click', () => {
        this.painter.brush.color = pal[key];
        this.painter.brush.erase = false;
        ($('brushColor') as HTMLInputElement).value = pal[key];
        ($('brushErase') as HTMLInputElement).checked = false;
      });
      q.append(b);
    }
  }

  /* ---------------------------------------------------------------- body */

  private renderBody(): void {
    const cur = this.current;
    const idBox = $('identity');
    idBox.textContent = '';
    const nameInput = el('input', { type: 'text', maxlength: '28', dir: 'auto', spellcheck: 'false' });
    nameInput.value = cur.name;
    nameInput.addEventListener('input', () => this.update({ name: nameInput.value.trim() || `Cat ${cur.slot}` }));
    const bio = el('textarea', { dir: 'auto', rows: '4' });
    bio.value = cur.bio;
    bio.addEventListener('input', () => this.update({ bio: bio.value }));
    const remove = el('button', { class: 'btn btn--quiet btn--danger', type: 'button', text: t('removeCat') });
    remove.disabled = this.profiles.length <= 1;
    remove.addEventListener('click', () => this.removeCurrent());
    idBox.append(
      el('h3', { class: 'group-title', text: t('name') }),
      el('div', { class: 'field field--wide' }, nameInput),
      el('div', { class: 'field field--wide' }, el('span', { class: 'field__label', text: t('bio') }), bio),
      toggleField(t('enabled'), cur.enabled, (v) => this.update({ enabled: v })),
      el('h3', { class: 'group-title', text: t('signature') }),
      ...SIGNATURE_KEYS.map((k) => toggleField(t(k), cur.signature[k], (v) => this.updateNested('signature', k, v))),
      remove,
    );

    const morph = $('morph');
    morph.textContent = '';
    const m = cur.morphology;
    const setM = (k: keyof Morphology, v: unknown) => this.updateNested('morphology', k, v);
    morph.append(
      el('h3', { class: 'group-title', text: t('morphology') }),
      sliderField(t('chonk'), m.chonk, 0.7, 1.4, 0.01, (v) => setM('chonk', v), (v) => `${v.toFixed(2)}×`),
      el(
        'div',
        { class: 'field field--wide' },
        el('span', { class: 'field__label', text: t('furLength') }),
        segmented<'short' | 'medium' | 'long'>(
          [
            ['short', t('short')],
            ['medium', t('medium')],
            ['long', t('long')],
          ],
          m.furLength,
          (v) => setM('furLength', v),
        ),
      ),
      sliderField(t('earSize'), m.earSize, 0.7, 1.4, 0.01, (v) => setM('earSize', v), (v) => `${v.toFixed(2)}×`),
      sliderField(t('tailLength'), m.tailLength, 0.6, 1.4, 0.01, (v) => setM('tailLength', v), (v) => `${v.toFixed(2)}×`),
      sliderField(t('bodySize'), m.size, 0.7, 1.4, 0.01, (v) => setM('size', v), (v) => `${v.toFixed(2)}×`),
      toggleField(t('heterochromia'), m.heterochromia, (v) => setM('heterochromia', v)),
    );

    const pers = $('personality');
    pers.textContent = '';
    pers.append(el('h3', { class: 'group-title', text: t('personality') }));
    for (const k of Object.keys(PERSONALITY_LABEL) as (keyof Personality)[]) {
      pers.append(sliderField(t(PERSONALITY_LABEL[k]), cur.personality[k], 0, 1, 0.01, (v) => this.updateNested('personality', k, v)));
    }
    // Quirks: appetite, play, favourite petting spots, ears, cuddles, and who this cat is bonded with.
    pers.append(el('h3', { class: 'group-title', text: t('traits') }));
    for (const [k, label, min, max, step] of TRAIT_SLIDERS) {
      const fmt = max > 1 ? (v: number) => `${v.toFixed(2)}×` : (v: number) => v.toFixed(2);
      pers.append(sliderField(t(label), cur.traits[k], min, max, step, (v) => this.updateNested('traits', k, v), fmt));
    }
    const bond = el('select', { 'aria-label': t('bondedWith') }) as HTMLSelectElement;
    bond.append(el('option', { value: '', text: t('nobody') }));
    for (const p of this.profiles) if (p.id !== cur.id) bond.append(el('option', { value: p.id, text: displayName(p) }));
    bond.value = this.profiles.some((p) => p.id === cur.traits.bondedWith) ? cur.traits.bondedWith : '';
    bond.addEventListener('change', () => this.updateNested('traits', 'bondedWith', bond.value));
    pers.append(el('div', { class: 'field field--wide' }, el('span', { class: 'field__label', text: t('bondedWith') }), bond));
  }

  /* ------------------------------------------------------------- sprites */

  private renderSprites(): void {
    const cur = this.current;
    const mode = $('renderMode');
    mode.replaceWith(
      Object.assign(
        segmented<'procedural' | 'sprite'>(
          [
            ['procedural', t('procedural')],
            ['sprite', t('sprite')],
          ],
          cur.renderMode,
          (v) => {
            if (v === 'sprite' && !this.current.sprite) {
              $('spriteMsg').textContent = t('importHint');
              this.renderSprites();
              return;
            }
            this.update({ renderMode: v });
          },
        ),
        { id: 'renderMode' },
      ),
    );
    const info = $('spriteInfo');
    info.textContent = '';
    if (cur.sprite) {
      const s = cur.sprite;
      info.append(
        el('div', { text: tf('spriteGrid', { source: s.source, cols: s.columns, rows: s.rows, w: Math.round(s.cellWidth), h: Math.round(s.cellHeight), n: Object.keys(s.animations).length }) }),
        el('img', { src: s.dataUrl, alt: '' }),
      );
    }
  }

  private async bake(layout: 'chromeow-hd' | 'openpets-v1', kind: 'zip' | 'webp'): Promise<void> {
    const bar = $('bakeProgress');
    const fill = bar.querySelector('.progress__bar') as HTMLElement;
    bar.hidden = false;
    fill.style.width = '0%';
    $('spriteMsg').textContent = t('baking');
    document.querySelectorAll<HTMLButtonElement>('#bakeHD, #bakeOP, #bakeWebp').forEach((b) => (b.disabled = true));
    try {
      const res = await bakeZip(this.current, layout, (f) => (fill.style.width = `${Math.round(f * 100)}%`));
      if (kind === 'zip') downloadBlob(res.zip, `${res.fileBase}.zip`);
      else downloadBlob(res.webp, `${res.fileBase}.webp`);
      $('spriteMsg').textContent = t('done');
    } catch (e) {
      $('spriteMsg').textContent = String((e as Error).message ?? e);
    } finally {
      document.querySelectorAll<HTMLButtonElement>('#bakeHD, #bakeOP, #bakeWebp').forEach((b) => (b.disabled = false));
      setTimeout(() => (bar.hidden = true), 800);
    }
  }

  private async importSprite(file: File): Promise<void> {
    try {
      const res = await importSpriteFile(file, ($('importLayout') as HTMLSelectElement).value as ImportLayout);
      this.update({ sprite: res.sheet, renderMode: 'sprite' });
      $('spriteMsg').textContent = `${t('importOk')}${res.displayName ? ` (${res.displayName})` : ''}`;
      this.renderSprites();
    } catch (e) {
      $('spriteMsg').textContent = `${t('importFail')}: ${String((e as Error).message ?? e)}`;
    }
  }
}

void new CatStudioApp().init();
