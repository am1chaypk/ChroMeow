/**
 * v3 #1 — right-click on a cat opens the mini-games menu. The DOM part lives in
 * the content script; here: the menu's games, where it opens, and that a
 * right-click point maps to the cat under it (the overlay's hitbox does the same).
 */
import { describe, expect, it } from 'vitest';
import { GAME_ITEMS, MENU_WIDTH, menuHeight, menuPosition } from '../src/content/GamesMenu';
import { World } from '../src/sim/World';
import { StaticPlatformSource } from '../src/sim/StaticPlatformSource';
import { DEFAULT_SETTINGS } from '../src/shared/storage';
import { createAlex, createAnna } from '../src/shared/presets';
import { setLanguage, t, tf } from '../src/shared/i18n';

const B = { width: 1200, height: 700 };

describe('mini-games menu (right-click on a cat)', () => {
  it('offers every game: treats, laser, ball, the feather wand, the toy mouse, calling the cats and clearing up', () => {
    expect(GAME_ITEMS.map((i) => i.action)).toEqual(['treat', 'laser', 'ball', 'feather_wand', 'mouse', 'call', 'clear']);
    for (const lang of ['en', 'he'] as const) {
      setLanguage(lang);
      for (const item of GAME_ITEMS) {
        expect(t(item.label)).not.toBe(item.label);
        expect(t(item.hint)).not.toBe(item.hint);
      }
      expect(tf('gamesTitle', { name: 'Alex' })).toContain('Alex');
    }
    setLanguage('en');
  });

  it('opens next to the pointer and always stays fully on screen', () => {
    const h = menuHeight();
    expect(menuPosition(100, 100, MENU_WIDTH, h, 1200, 700)).toEqual({ left: 104, top: 104 });
    // Near the right / bottom edges it flips to the other side of the pointer.
    const br = menuPosition(1190, 690, MENU_WIDTH, h, 1200, 700);
    expect(br.left + MENU_WIDTH).toBeLessThanOrEqual(1192);
    expect(br.top + h).toBeLessThanOrEqual(692);
    expect(br.left).toBeLessThan(1190);
    // Right-to-left layouts open to the left of the pointer.
    const rtl = menuPosition(600, 100, MENU_WIDTH, h, 1200, 700, true);
    expect(rtl.left + MENU_WIDTH).toBeLessThanOrEqual(600);
    // A tiny viewport still keeps the 8 px margin.
    const tiny = menuPosition(50, 50, MENU_WIDTH, h, 200, 200);
    expect(tiny.left).toBeGreaterThanOrEqual(8);
    expect(tiny.top).toBeGreaterThanOrEqual(8);
  });

  it('maps a right-click on a cat to that cat (and nothing on empty page)', () => {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS } });
    w.setProfiles([createAlex(), createAnna()]);
    const [alex, anna] = w.agents;
    alex.placeOn(w.source.floor(), 300);
    anna.placeOn(w.source.floor(), 800);
    for (let i = 0; i < 10; i++) {
      w.update(1 / 30);
      for (const a of w.agents) a.refreshLandmarks();
    }
    const lm = anna.lm!;
    expect(w.hitTest(lm.head.x, lm.head.y)).toBe(anna);
    expect(w.hitTest(alex.lm!.head.x, alex.lm!.head.y)).toBe(alex);
    expect(w.hitTest(600, 100)).toBeNull();
  });

  it('the games act on the world: the toy mouse is let loose and "clear" tidies it away', () => {
    const w = new World({ source: new StaticPlatformSource(B, []), settings: { ...DEFAULT_SETTINGS } });
    w.setProfiles([createAlex()]);
    w.releaseMouse(500);
    expect(w.toys.toys.some((t) => t.kind === 'mouse')).toBe(true);
    w.clearObjects();
    expect(w.toys.count).toBe(0);
    expect(w.agents).toHaveLength(1);
  });
});
