/**
 * chrome.storage wrappers. Everything stays on-device:
 *  • chrome.storage.local   — profiles (incl. painted masks & sprite sheets) and settings
 *  • chrome.storage.session — the live cross-tab world snapshot (service worker only)
 */
import { defaultProfiles, migrateProfile, normalizeProfile, MAX_CATS } from './presets';
import type { CatProfile, FeedingStation, Settings, WorldSnapshot } from './types';

export const KEY_PROFILES = 'chromeow:profiles';
export const KEY_SETTINGS = 'chromeow:settings';
export const KEY_WORLD = 'chromeow:world';
export const KEY_STATION = 'chromeow:station';

export const DEFAULT_STATION: FeedingStation = {
  enabled: true,
  xNormalized: 0.9,
  foodLevel: 80,
  waterLevel: 80,
};

export const IDLE_THRESHOLD_RANGE: readonly [number, number] = [30, 1800];

export const DEFAULT_SETTINGS: Settings = {
  clickThroughLock: false,
  soundEnabled: true,
  volume: 0.45,
  blacklist: [],
  catScale: 1,
  globalPause: false,
  language: 'auto',
  showNameTags: true,
  calmMode: false,
  idleThreshold: 120,
};

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
}

async function localGet(key: string): Promise<unknown> {
  if (!hasChromeStorage()) {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  }
  const res = (await chrome.storage.local.get(key)) as Record<string, unknown>;
  return res[key];
}

async function localSet(key: string, value: unknown): Promise<void> {
  if (!hasChromeStorage()) {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return;
  }
  await chrome.storage.local.set({ [key]: value });
}

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    blacklist: Array.isArray(s.blacklist) ? s.blacklist.filter((h) => typeof h === 'string') : [],
    volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : DEFAULT_SETTINGS.volume,
    catScale: typeof s.catScale === 'number' ? Math.min(1.8, Math.max(0.5, s.catScale)) : DEFAULT_SETTINGS.catScale,
    idleThreshold:
      typeof s.idleThreshold === 'number' && Number.isFinite(s.idleThreshold)
        ? Math.round(Math.min(IDLE_THRESHOLD_RANGE[1], Math.max(IDLE_THRESHOLD_RANGE[0], s.idleThreshold)))
        : DEFAULT_SETTINGS.idleThreshold,
  };
}

function level(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
}

export function normalizeStation(raw: unknown): FeedingStation {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<FeedingStation>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_STATION.enabled,
    xNormalized: typeof s.xNormalized === 'number' && Number.isFinite(s.xNormalized) ? Math.min(1, Math.max(0, s.xNormalized)) : DEFAULT_STATION.xNormalized,
    foodLevel: level(s.foodLevel, DEFAULT_STATION.foodLevel),
    waterLevel: level(s.waterLevel, DEFAULT_STATION.waterLevel),
  };
}

export function normalizeProfiles(raw: unknown): CatProfile[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultProfiles();
  const valid = (raw as Partial<CatProfile>[]).filter((p) => p && typeof p === 'object').slice(0, MAX_CATS);
  const taken = new Set(valid.map((p) => p.id).filter((id): id is string => typeof id === 'string'));
  const list = valid.map((p, i) => normalizeProfile(migrateProfile(p, taken), typeof p.slot === 'number' ? p.slot : i + 1));
  list.sort((a, b) => a.slot - b.slot);
  return list;
}

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await localGet(KEY_SETTINGS));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await localSet(KEY_SETTINGS, normalizeSettings(settings));
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await localSet(KEY_SETTINGS, next);
  return next;
}

export async function loadProfiles(): Promise<CatProfile[]> {
  return normalizeProfiles(await localGet(KEY_PROFILES));
}

export async function saveProfiles(profiles: CatProfile[]): Promise<void> {
  await localSet(KEY_PROFILES, profiles.slice(0, MAX_CATS));
}

export async function patchProfile(id: string, patch: Partial<CatProfile>): Promise<CatProfile[]> {
  const list = await loadProfiles();
  const next = list.map((p) => (p.id === id ? normalizeProfile({ ...p, ...patch }, p.slot) : p));
  await saveProfiles(next);
  return next;
}

/** Pure helper: the list without `id`, but never empty (the last cat can only be turned off). */
export function withoutProfile(list: CatProfile[], id: string): CatProfile[] {
  if (list.length <= 1) return list;
  return list.filter((p) => p.id !== id);
}

export async function removeProfile(id: string): Promise<CatProfile[]> {
  const list = await loadProfiles();
  const next = withoutProfile(list, id);
  if (next.length !== list.length) await saveProfiles(next);
  return next;
}

/** Writes factory defaults on first install (and migrates older data) without clobbering user data. */
export async function ensureDefaults(): Promise<void> {
  const [profiles, settings, station] = await Promise.all([localGet(KEY_PROFILES), localGet(KEY_SETTINGS), localGet(KEY_STATION)]);
  if (!Array.isArray(profiles) || profiles.length === 0) await localSet(KEY_PROFILES, defaultProfiles());
  else await localSet(KEY_PROFILES, normalizeProfiles(profiles));
  await localSet(KEY_SETTINGS, normalizeSettings(settings));
  await localSet(KEY_STATION, normalizeStation(station));
}

export async function loadStation(): Promise<FeedingStation> {
  return normalizeStation(await localGet(KEY_STATION));
}

export async function patchStation(patch: Partial<FeedingStation>): Promise<FeedingStation> {
  const next = normalizeStation({ ...(await loadStation()), ...patch });
  await localSet(KEY_STATION, next);
  return next;
}

export async function resetToFactory(): Promise<void> {
  await localSet(KEY_PROFILES, defaultProfiles());
}

export function hostnameMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  const p = pattern.toLowerCase().trim().replace(/^www\./, '');
  return !!p && (h === p || h.endsWith(`.${p}`));
}

export function isBlacklisted(settings: Settings, hostname: string): boolean {
  return settings.blacklist.some((p) => hostnameMatches(hostname, p));
}

export async function readWorldSession(): Promise<WorldSnapshot | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return null;
  const res = (await chrome.storage.session.get(KEY_WORLD)) as Record<string, unknown>;
  return (res[KEY_WORLD] as WorldSnapshot | undefined) ?? null;
}

export async function writeWorldSession(world: WorldSnapshot): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  await chrome.storage.session.set({ [KEY_WORLD]: world });
}
