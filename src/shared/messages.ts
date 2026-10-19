/** Typed message contracts between content script, service worker and popup. */
import type { PageInfo, PopupAction, ToyKind, WorldSnapshot } from './types';

export type RuntimeMessage =
  | { type: 'cm:snapshot'; world: WorldSnapshot }
  | { type: 'cm:hydrate' }
  | { type: 'cm:getWorld' }
  | { type: 'cm:openStudio'; catId?: string }
  | { type: 'cm:ping' };

export type TabMessage =
  | { type: 'cm:action'; action: PopupAction }
  | { type: 'cm:getPageInfo' }
  | { type: 'cm:applyWorld'; world: WorldSnapshot }
  | { type: 'cm:play'; tool: ToyKind | null };

export interface HydrateResponse {
  world: WorldSnapshot | null;
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
