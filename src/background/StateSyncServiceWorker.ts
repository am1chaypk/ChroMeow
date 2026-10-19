/**
 * StateSyncServiceWorker — the canonical, tab-independent home of the cats.
 *
 *  • Keeps the live world snapshot (state, mood drives, relative positions) in
 *    memory and mirrored to chrome.storage.session, so the next tab you focus
 *    hydrates both cats in their exact current state.
 *  • Seeds factory presets on install (and migrates v1 data to Alex & Anna),
 *    handles the Alt+Shift+C click-through shortcut, and opens Cat Studio.
 *  • Watches chrome.idle (the whole computer going idle or locking) and tells
 *    every tab, so the cats can cuddle up while you are away.
 * Makes zero network requests.
 */
import { isRuntimeMessage, type HydrateResponse, type IdleBroadcast, type RuntimeMessage } from '../shared/messages';
import { ensureDefaults, loadSettings, patchSettings, readWorldSession, writeWorldSession } from '../shared/storage';
import type { WorldSnapshot } from '../shared/types';

let cache: WorldSnapshot | null = null;
let pendingWrite: ReturnType<typeof setTimeout> | null = null;

async function currentWorld(): Promise<WorldSnapshot | null> {
  if (cache) return cache;
  cache = await readWorldSession();
  return cache;
}

function scheduleWrite(): void {
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = null;
    if (cache) void writeWorldSession(cache);
  }, 400);
}

async function refreshBadge(): Promise<void> {
  try {
    const s = await loadSettings();
    await chrome.action.setBadgeBackgroundColor({ color: '#6B4F3A' });
    await chrome.action.setBadgeText({ text: s.globalPause ? '❚❚' : s.clickThroughLock ? '🔒' : '' });
  } catch {
    /* action API unavailable in some contexts */
  }
}

/** chrome.idle reports after `idleThreshold` seconds without input anywhere (minimum 15 s). */
async function configureIdle(): Promise<void> {
  try {
    if (!chrome.idle) return;
    const s = await loadSettings();
    chrome.idle.setDetectionInterval(Math.max(15, Math.round(s.idleThreshold)));
  } catch {
    /* idle API unavailable */
  }
}

async function broadcastIdle(state: chrome.idle.IdleState): Promise<void> {
  const msg: IdleBroadcast = { type: 'cm:idleState', state };
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (typeof t.id === 'number') void chrome.tabs.sendMessage(t.id, msg).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

if (chrome.idle?.onStateChanged) chrome.idle.onStateChanged.addListener((state) => void broadcastIdle(state));
void configureIdle();

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults().then(refreshBadge).then(configureIdle);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaults().then(refreshBadge).then(configureIdle);
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) return;
  const msg = message as RuntimeMessage;
  switch (msg.type) {
    case 'cm:snapshot': {
      const w = msg.world;
      if (w && Array.isArray(w.cats) && (!cache || w.updatedAt >= cache.updatedAt)) {
        cache = w;
        scheduleWrite();
      }
      sendResponse({ ok: true });
      return;
    }
    case 'cm:hydrate':
    case 'cm:getWorld': {
      void currentWorld().then((world) => sendResponse({ world } satisfies HydrateResponse));
      return true;
    }
    case 'cm:openStudio': {
      void openStudio(msg.catId);
      sendResponse({ ok: true });
      return;
    }
    case 'cm:ping': {
      sendResponse({ ok: true });
      return;
    }
  }
});

/** Opens the Cat Studio (focused on one cat when `catId` is given), reusing an open Studio tab. */
async function openStudio(catId?: string): Promise<void> {
  const url = chrome.runtime.getURL(`studio.html${catId ? `#cat=${encodeURIComponent(catId)}` : ''}`);
  try {
    const base = chrome.runtime.getURL('studio.html');
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
    const open = contexts.find((c) => typeof c.tabId === 'number' && c.tabId >= 0 && (c.documentUrl ?? '').startsWith(base));
    if (open && open.tabId !== undefined) {
      const tab = await chrome.tabs.update(open.tabId, { active: true, url });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch {
    /* getContexts unavailable: fall through and open a fresh tab */
  }
  await chrome.tabs.create({ url });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-click-through') return;
  void loadSettings()
    .then((s) => patchSettings({ clickThroughLock: !s.clickThroughLock }))
    .then(refreshBadge);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['chromeow:settings']) {
    void refreshBadge();
    void configureIdle();
  }
});
