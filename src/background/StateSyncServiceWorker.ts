/**
 * StateSyncServiceWorker — the canonical, tab-independent home of the cats.
 *
 *  • Keeps the live world snapshot (state, mood drives, relative positions) in
 *    memory and mirrored to chrome.storage.session, so the next tab you focus
 *    hydrates both cats in their exact current state.
 *  • Seeds factory presets on install, handles the Alt+Shift+C click-through
 *    shortcut, and opens Cat Studio. Makes zero network requests.
 */
import { isRuntimeMessage, type HydrateResponse, type RuntimeMessage } from '../shared/messages';
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

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults().then(refreshBadge);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaults().then(refreshBadge);
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
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }
    case 'cm:ping': {
      sendResponse({ ok: true });
      return;
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-click-through') return;
  void loadSettings()
    .then((s) => patchSettings({ clickThroughLock: !s.clickThroughLock }))
    .then(refreshBadge);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['chromeow:settings']) void refreshBadge();
});
