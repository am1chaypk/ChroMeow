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
 *  • v3 single instance: runs the leader election across every tab and window
 *    (InstanceRegistry) so exactly one page hosts Alex and Anna. Pages report
 *    their presence; the leader is the visible tab that most recently gained
 *    focus. Moving between two windows that are both on screen hands the cats
 *    over with a run-off / walk-in migration, and a roaming cat visiting another
 *    tab is hosted nowhere until it comes back. The registry is mirrored to
 *    chrome.storage.session so it survives the worker being suspended.
 * Makes zero network requests.
 */
import { isRuntimeMessage, sendToTab, type HydrateResponse, type IdleBroadcast, type RoleMessage, type RuntimeMessage } from '../shared/messages';
import { KEY_INSTANCE, ensureDefaults, loadSettings, patchSettings, readWorldSession, writeWorldSession } from '../shared/storage';
import { InstanceRegistry, mergeSnapshot, migrationSides, type InstanceSnapshot, type LeaderChange } from '../shared/instance';
import type { WorldSnapshot } from '../shared/types';

let cache: WorldSnapshot | null = null;
let pendingWrite: ReturnType<typeof setTimeout> | null = null;

/* ---------------------------------------------------------- single instance */

let registry: InstanceRegistry | null = null;
let registryLoad: Promise<InstanceRegistry> | null = null;
let registryWrite: ReturnType<typeof setTimeout> | null = null;
/** Serialises registry updates (messages arrive concurrently). */
let queue: Promise<unknown> = Promise.resolve();
/** How long the new window waits for the old window's cats to run off (ms). */
const HANDOFF_DELAY = 1500;

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function loadRegistry(): Promise<InstanceRegistry> {
  if (registry) return registry;
  registryLoad ??= (async () => {
    let snap: InstanceSnapshot | null = null;
    try {
      const res = (await chrome.storage.session.get(KEY_INSTANCE)) as Record<string, unknown>;
      snap = (res[KEY_INSTANCE] as InstanceSnapshot | undefined) ?? null;
    } catch {
      /* no session storage */
    }
    registry = InstanceRegistry.from(snap);
    // A fresh registry starts its epochs from the clock, so pages never mistake new roles for stale ones.
    if (!snap) registry.epoch = Date.now();
    return registry;
  })();
  return registryLoad;
}

function saveRegistry(): void {
  if (registryWrite) return;
  registryWrite = setTimeout(() => {
    registryWrite = null;
    if (registry) void chrome.storage.session.set({ [KEY_INSTANCE]: registry.snapshot() }).catch(() => undefined);
  }, 250);
}

/** Role messages for every tab after a leadership change (with migration edges for a visible handoff). */
async function rolesFor(r: InstanceRegistry, change: LeaderChange | null): Promise<Map<number, RoleMessage>> {
  let sides: { exit: 1 | -1; enter: 1 | -1 } | null = null;
  if (change?.visibleHandoff && change.from !== null && change.to !== null) {
    const a = r.tab(change.from);
    const b = r.tab(change.to);
    if (a && b) {
      if (a.windowId === b.windowId) sides = { exit: 1, enter: -1 };
      else {
        const get = (id: number) => chrome.windows.get(id).catch(() => null);
        const [wa, wb] = await Promise.all([get(a.windowId), get(b.windowId)]);
        sides = migrationSides(wa, wb);
      }
    }
  }
  const out = new Map<number, RoleMessage>();
  for (const id of r.tabIds) {
    const role = r.role(id);
    const msg: RoleMessage = { type: 'cm:role', ...role };
    if (change && sides && id === change.from) msg.exit = sides.exit;
    if (change && sides && id === change.to) {
      msg.enter = sides.enter;
      msg.delay = HANDOFF_DELAY;
    }
    out.set(id, msg);
  }
  return out;
}

/** Applies a registry update and tells every other tab its (possibly new) role; returns the caller's role. */
async function commit(r: InstanceRegistry, change: LeaderChange | null, caller: number | null): Promise<RoleMessage | null> {
  saveRegistry();
  const roles = await rolesFor(r, change);
  if (change) for (const [id, msg] of roles) if (id !== caller) void sendToTab(id, msg);
  return caller !== null ? roles.get(caller) ?? null : null;
}

async function onPresence(tabId: number, windowId: number, visible: boolean, focused: boolean): Promise<RoleMessage | null> {
  return serial(async () => {
    const r = await loadRegistry();
    const now = Date.now();
    const change = r.report(tabId, windowId, { visible, focused }, now);
    const role = await commit(r, change, tabId);
    if (role && role.leader) {
      const back = r.takeReturning(now);
      if (back.length) {
        role.returning = back;
        role.away = role.away.filter((id) => !back.some((b) => b.catId === id));
        saveRegistry();
      }
    }
    return role;
  });
}

async function onCatLeft(tabId: number, catId: string, side: 1 | -1): Promise<RoleMessage | null> {
  return serial(async () => {
    const r = await loadRegistry();
    if (r.leader === tabId) r.sendAway(catId, tabId, Date.now(), side);
    return commit(r, null, tabId);
  });
}

async function onTabGone(tabId: number): Promise<void> {
  await serial(async () => {
    const r = await loadRegistry();
    const change = r.remove(tabId, Date.now());
    await commit(r, change, null);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => void onTabGone(tabId));

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

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRuntimeMessage(message)) return;
  const msg = message as RuntimeMessage;
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'cm:snapshot': {
      const w = msg.world;
      void (async () => {
        const r = await loadRegistry();
        // Only the tab hosting the cats writes their state (a stale tab can never roll it back).
        const fromLeader = tabId === undefined || r.leader === null || r.leader === tabId;
        await currentWorld();
        if (fromLeader && w && Array.isArray(w.cats) && (!cache || w.updatedAt >= cache.updatedAt)) {
          cache = mergeSnapshot(cache, w);
          scheduleWrite();
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'cm:hydrate':
    case 'cm:getWorld': {
      void Promise.all([currentWorld(), loadRegistry()]).then(([world, r]) => sendResponse({ world, away: Object.keys(r.away) } satisfies HydrateResponse));
      return true;
    }
    case 'cm:presence': {
      if (tabId === undefined) return;
      void onPresence(tabId, sender.tab?.windowId ?? -1, msg.visible, msg.focused).then((role) => sendResponse(role));
      return true;
    }
    case 'cm:catLeft': {
      if (tabId === undefined) return;
      void onCatLeft(tabId, msg.catId, msg.side).then((role) => sendResponse(role));
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
