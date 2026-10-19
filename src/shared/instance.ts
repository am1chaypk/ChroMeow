/**
 * Single instance across tabs and windows (v3) — the pure leader-election core
 * used by the service worker (unit-tested without Chrome).
 *
 * Every page with ChroMeow reports its presence (visible? focused?). Exactly one
 * tab — the leader — hosts the cats; every other tab shows the furniture but no
 * cats, so Alex and Anna exist once in the whole browser.
 *
 *  • The leader is the visible tab that most recently gained focus. It keeps
 *    the cats while it stays visible, even when the browser loses focus; when it
 *    is hidden or closed, the most recently focused visible tab takes over. With
 *    no tab visible at all the cats stay where they were (and continue when you
 *    come back).
 *  • Switching windows that are both on screen is a migration: the cats run off
 *    the old window toward the new one and walk in from the facing edge.
 *  • Roaming: a cat may walk off the screen to visit another open tab for a
 *    while. It is then hosted nowhere until it comes back to the leader's edge —
 *    or until you switch to the tab it went to, where it is waiting for you.
 */
import type { WorldSnapshot } from './types';

export interface Presence {
  visible: boolean;
  focused: boolean;
}

export interface TabRecord extends Presence {
  tabId: number;
  windowId: number;
  /** When this tab last became focused (ms). */
  focusedAt: number;
  /** When it last reported (ms). */
  seen: number;
}

export interface AwayRecord {
  /** The tab the cat went to visit. */
  tabId: number;
  /** When it comes back (ms). */
  until: number;
  /** The edge it left by (it comes back the same way). */
  side?: 1 | -1;
}

export interface InstanceSnapshot {
  leader: number | null;
  epoch: number;
  tabs: TabRecord[];
  away: Record<string, AwayRecord>;
}

export interface LeaderChange {
  from: number | null;
  to: number | null;
  epoch: number;
  /** The previous leader is still on screen (another window): the cats should migrate visibly. */
  visibleHandoff: boolean;
}

export interface RoleInfo {
  leader: boolean;
  epoch: number;
  /** Cats this tab must not host (they are off visiting another tab). */
  away: string[];
  /** Other tabs a cat could go and visit. */
  others: number;
}

/** A tab that has not reported for this long is forgotten (ms). */
export const TAB_STALE_MS = 10 * 60 * 1000;
/** How long a roaming cat stays away (ms). */
export const AWAY_MIN_MS = 45 * 1000;
export const AWAY_MAX_MS = 120 * 1000;

export class InstanceRegistry {
  private tabs = new Map<number, TabRecord>();
  leader: number | null = null;
  epoch = 0;
  away: Record<string, AwayRecord> = {};

  static from(snap: InstanceSnapshot | null | undefined): InstanceRegistry {
    const r = new InstanceRegistry();
    if (!snap || typeof snap !== 'object') return r;
    for (const t of Array.isArray(snap.tabs) ? snap.tabs : []) if (typeof t?.tabId === 'number') r.tabs.set(t.tabId, { ...t });
    r.leader = typeof snap.leader === 'number' && r.tabs.has(snap.leader) ? snap.leader : null;
    r.epoch = typeof snap.epoch === 'number' ? snap.epoch : 0;
    r.away = snap.away && typeof snap.away === 'object' ? { ...snap.away } : {};
    return r;
  }

  snapshot(): InstanceSnapshot {
    return { leader: this.leader, epoch: this.epoch, tabs: [...this.tabs.values()].map((t) => ({ ...t })), away: { ...this.away } };
  }

  get tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  tab(id: number): TabRecord | undefined {
    return this.tabs.get(id);
  }

  /** A tab reported its presence. Returns the leadership change it caused, if any. */
  report(tabId: number, windowId: number, p: Presence, now: number): LeaderChange | null {
    const prev = this.tabs.get(tabId);
    const gainedFocus = p.focused && p.visible && (!prev || !prev.focused || !prev.visible);
    this.tabs.set(tabId, {
      tabId,
      windowId,
      visible: p.visible,
      focused: p.focused,
      focusedAt: gainedFocus ? now : prev?.focusedAt ?? 0,
      seen: now,
    });
    // The user came to the tab a roaming cat went to visit: it is simply here.
    if (gainedFocus) for (const [cat, a] of Object.entries(this.away)) if (a.tabId === tabId) delete this.away[cat];
    return this.elect(now);
  }

  /** A tab closed or navigated away. */
  remove(tabId: number, now: number): LeaderChange | null {
    if (!this.tabs.delete(tabId)) return null;
    // A cat visiting a tab that closed comes straight home.
    for (const a of Object.values(this.away)) if (a.tabId === tabId) a.until = Math.min(a.until, now);
    const wasLeader = this.leader === tabId;
    if (wasLeader) this.leader = null;
    return this.elect(now, wasLeader ? tabId : null);
  }

  /** Re-runs the election (stale tabs are dropped). */
  elect(now: number, removedLeader: number | null = null): LeaderChange | null {
    for (const [id, t] of this.tabs) if (now - t.seen > TAB_STALE_MS && id !== this.leader) this.tabs.delete(id);
    const from = removedLeader ?? this.leader;
    const cur = this.leader !== null ? this.tabs.get(this.leader) : undefined;
    const visible = [...this.tabs.values()].filter((t) => t.visible);
    // The visible tab that most recently gained focus.
    const best = visible.sort((a, b) => b.focusedAt - a.focusedAt || b.seen - a.seen)[0];
    let next = this.leader;
    if (!cur || !cur.visible) {
      if (best) next = best.tabId;
      else if (!cur) next = null; // nothing on screen and the old leader is gone
    } else if (best && best.tabId !== cur.tabId && best.focused && best.focusedAt > cur.focusedAt) {
      next = best.tabId;
    }
    if (next === this.leader && removedLeader === null) return null;
    const old = cur;
    this.leader = next;
    this.epoch++;
    return { from, to: next, epoch: this.epoch, visibleHandoff: !!old && old.visible && next !== null && old.tabId !== next };
  }

  role(tabId: number): RoleInfo {
    const leader = this.leader === tabId;
    const away = Object.keys(this.away);
    return { leader, epoch: this.epoch, away, others: Math.max(0, this.tabs.size - 1) };
  }

  /** A cat walked off the leader's screen: it goes to visit one of the other tabs. Returns that tab, or null. */
  sendAway(catId: string, fromTab: number, now: number, side: 1 | -1 = 1, rand: () => number = Math.random): number | null {
    const others = [...this.tabs.keys()].filter((id) => id !== fromTab);
    if (!others.length) return null;
    const tabId = others[Math.floor(rand() * others.length) % others.length];
    this.away[catId] = { tabId, until: now + AWAY_MIN_MS + rand() * (AWAY_MAX_MS - AWAY_MIN_MS), side };
    return tabId;
  }

  /** Cats whose visit is over (they come back to the leader); removes them from the away list. */
  takeReturning(now: number): { catId: string; side: 1 | -1 }[] {
    const back: { catId: string; side: 1 | -1 }[] = [];
    for (const [cat, a] of Object.entries(this.away)) {
      if (a.until <= now || !this.tabs.has(a.tabId)) {
        back.push({ catId: cat, side: a.side ?? 1 });
        delete this.away[cat];
      }
    }
    return back;
  }

  isAway(catId: string): boolean {
    return catId in this.away;
  }
}

export interface WindowBox {
  left?: number;
  width?: number;
}

/**
 * Which edges the cats leave and enter by when they move from one window to
 * another: they run off the side facing the new window and come in from the
 * side facing the old one. −1 = left, +1 = right.
 */
export function migrationSides(from: WindowBox | null | undefined, to: WindowBox | null | undefined): { exit: 1 | -1; enter: 1 | -1 } {
  const fc = (from?.left ?? 0) + (from?.width ?? 0) / 2;
  const tc = (to?.left ?? 0) + (to?.width ?? 0) / 2;
  const right = tc >= fc;
  return right ? { exit: 1, enter: -1 } : { exit: -1, enter: 1 };
}

/** Merges the leader's snapshot (the cats it hosts) into the canonical world, keeping roaming cats' last state. */
export function mergeSnapshot(prev: WorldSnapshot | null, next: WorldSnapshot): WorldSnapshot {
  if (!prev) return next;
  const ids = new Set(next.cats.map((c) => c.id));
  return { ...next, cats: [...next.cats, ...prev.cats.filter((c) => !ids.has(c.id))] };
}
