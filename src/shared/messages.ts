/** Typed message contracts between content script, service worker and popup. */
import type { PageInfo, PopupAction, ToolKind, WorldSnapshot } from './types';

export type RuntimeMessage =
  | { type: 'cm:snapshot'; world: WorldSnapshot }
  | { type: 'cm:hydrate' }
  | { type: 'cm:getWorld' }
  | { type: 'cm:openStudio'; catId?: string }
  | { type: 'cm:ping' }
  /** A page reports whether it is on screen / focused (leader election, v3). Answered with a RoleMessage. */
  | { type: 'cm:presence'; visible: boolean; focused: boolean }
  /** A cat walked off the leader's screen to visit another tab. Answered with a RoleMessage. */
  | { type: 'cm:catLeft'; catId: string; side: 1 | -1 };

/** Which tab hosts the cats (sent to every tab when it changes, and in reply to cm:presence). */
export interface RoleMessage {
  type: 'cm:role';
  leader: boolean;
  epoch: number;
  /** Cats off visiting another tab (not hosted anywhere right now). */
  away: string[];
  /** Number of other tabs a cat could go and visit. */
  others: number;
  /** Cross-window handoff: the side the cats run off (old leader) or walk in from (new leader). */
  exit?: 1 | -1 | null;
  enter?: 1 | -1 | null;
  /** Wait this long (ms) before the cats walk in (the old window's cats run off first). */
  delay?: number;
  /** Roaming cats coming back now, and the edge they walk in from. */
  returning?: { catId: string; side: 1 | -1 }[];
}

/** Browser-wide idle state from chrome.idle (sent by the service worker to every tab). */
export type IdleBroadcast = { type: 'cm:idleState'; state: 'active' | 'idle' | 'locked' };

export type TabMessage =
  | { type: 'cm:action'; action: PopupAction }
  | { type: 'cm:getPageInfo' }
  | { type: 'cm:applyWorld'; world: WorldSnapshot }
  | { type: 'cm:play'; tool: ToolKind | null }
  | IdleBroadcast
  | RoleMessage;

export interface HydrateResponse {
  world: WorldSnapshot | null;
  /** Cats currently off visiting another tab. */
  away?: string[];
}

export type PageInfoResponse = PageInfo;

/** Sends to the service worker; resolves null instead of throwing when the context is gone. */
export async function sendRuntime<T = unknown>(msg: RuntimeMessage): Promise<T | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return null;
    return ((await chrome.runtime.sendMessage(msg)) as T) ?? null;
  } catch {
    return null;
  }
}

export async function sendToTab<T = unknown>(tabId: number, msg: TabMessage): Promise<T | null> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, msg)) as T) ?? null;
  } catch {
    return null;
  }
}

export function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string' && (m as { type: string }).type.startsWith('cm:');
}

export function isTabMessage(m: unknown): m is TabMessage {
  return isRuntimeMessage(m as RuntimeMessage);
}
