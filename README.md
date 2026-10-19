# ChroMeow

Two cats that live on the web pages you visit. They walk along headers and cards, nap on warm video players, chase your cursor, watch you type, groom each other and complain when you pet the other one for too long. Everything runs locally in your browser: no servers, no analytics, no network requests at all.

[עברית למטה](#chromeow-בעברית)

---

## Install

ChroMeow is a Manifest V3 Chrome extension built with TypeScript and Vite.

```bash
npm install
npm run verify      # typecheck + unit tests + production build
```

Then load it:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist/` folder.
4. Open any regular web page. The cats drop in at the bottom of the window.

Chrome does not inject extensions into `chrome://` pages or the Chrome Web Store, so the cats won't appear there. Pages that were already open before you installed the extension need a reload.

## Meet the cats

Two cats are enabled out of the box, both modelled on real piebald brown tabbies: white bib and belly, an inverted white "V" blaze, the tabby "M" on the forehead, dark eyeliner, a ringed tail with a dark tip and a chonk factor around 1.2.

| | Cat 1 | Cat 2 |
|---|---|---|
| Coat | Patched tabby harlequin: a white shoulder band breaks the saddle, golden flank patch, full white front legs, high hind stockings | Mantled bicolour tabby: one continuous tabby mantle, a small white crest on the rump, broader blaze, bold cheek stripes |
| Signature sleep | Chin propped on a ledge (`CHIN_PROP_SLEEP`) | Melted loaf, tail dangling off the edge (`MELTED_LOAF_SLEEP`) |
| Temperament | Lazy, very social, sassy: the judgmental airplane-ear squint is hers | Affectionate pillow snuggler, keener hunter |

Rename them in the popup or the Cat Studio (Hebrew names work). You can run up to six cats, and switch any of them off or remove them.

## Using it

**The popup** (toolbar icon) shows every cat with a live portrait, current activity, energy and affection. Each card has an **on/off switch** (hide a cat without deleting it), **Edit** (opens the Cat Studio on that cat) and **Remove** (click twice to confirm; the last cat can only be switched off). From the popup you can also:

- Pick up a toy, **Treats**, **Laser pointer** or **Toy ball**, and play on the page with the left mouse button (see below), or **Call cats** to the middle of the window
- **Click-through lock**: cats stop catching the mouse so you can click whatever is under them. Shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>
- **Pause on this site** (remembered per domain) or **Pause everywhere**
- Sound and volume, cat size, name tags and calm mode
- **Open Cat Studio**

**Petting.** Hover over a cat and move the mouse back and forth. Different spots get different reactions:

| Zone | Reaction |
|---|---|
| Chin and cheeks | Purring with half-closed eyes |
| Crown and ears | Ear twitches and purring, then kneading biscuits |
| Back and base of the tail | Elevator butt and purring |
| Front paws | Paw tuck |
| Belly | A roll onto the back. Depending on mood (and sass) she either enjoys it or answers with bunny kicks and a swat |
| Tail | Tail lashing and airplane ears, or Cat 1's judgmental squint if you woke her |

Click a cat to poke it. Pet one cat for more than about eight seconds and the other may walk over and push in.

**Playing with toys.** After you pick a toy, a small toolbar appears at the top of the page and the left mouse button plays instead of clicking links:

| Toy | Left mouse button |
|---|---|
| Treats | Click anywhere to drop a treat; it falls onto the ledge below and the cats come to eat |
| Laser pointer | Hold the button to shine the dot under the pointer; the cats chase it |
| Toy ball | Press to pick the ball up, drag and let go to throw it; a faster flick throws farther |

Switch toys from the toolbar. Press <kbd>Esc</kbd>, right-click or choose **Done** to put the toy away. Scrolling still works while you play. The same toys work in the Cat Studio's live preview.

**On their own** the cats sleep through full rest chains (curled sleep, sprawl, arch stretch, big yawn, sit), groom, explore, perch on page elements, track and stalk the cursor, pounce on erratic movement, sit near the caret while you type, peek over screen edges, climb the sides of the window, boop noses, groom each other, play tag and wrestle, and sleep together in a yin-yang curl, a pillow stack or a tandem belly hold. Scroll violently and a cat on a page element gets thrown off and lands on its feet.

## Cat Studio

Open it from the popup (or **Extension options**). The live preview at the top runs the same engine as the content script: pet the preview cat, play with the toys or trigger any of the 49 behaviour states.

The cat list on the left has an on/off switch and a remove button for each cat. Below it:

- **Export this cat** or **Export all** saves a `.chromeow.json` file containing everything about the cat: coat, markings, body, personality, painted fur, reference photos and any sprite sheet.
- **Import cats** (or drop a `.chromeow.json` file on the list) adds the cats from a file to free slots. Imported files are checked field by field, and anything unexpected is ignored.

- **Photos.** Add 1–3 photos of your cat. Pick a body part (primary fur, belly, stripes, each eye, nose, paw socks) and click the photo to sample it; drag pins to adjust. Pins remember which photo they sit on, so you can sample eyes from a daylight close-up and fur from another shot. "Correct lamp colour using the white fur" white-balances every sample from the white fur patch, and eye samples that are only pupil are ignored. **Analyze photo** runs local K-Means in CIE-Lab space and suggests a whole palette with each colour's share of the coat.
- **Coat & markings.** Choose a pattern (solid, tuxedo, classic or mackerel tabby, spotted, calico, tortoiseshell, colourpoint, bicolour/van, the two factory harlequin and mantled tabby coats, or a custom paintable mask), edit every palette colour and tune markings like blaze width, stockings and tail rings.
- **Paint brush.** Paint directly on the cat's texture atlas (torso, head, legs, tail, ears) with optional UV guides.
- **Personality.** Name, bio, body shape (chonk, fur length, ears, tail, size, heterochromia) and personality sliders (laziness, hunt drive, sociability, sassiness, clumsiness, affection).
- **Sprite sheets.** Bake the procedural cat to a sprite sheet and download it as a `.zip` (`pet.json` + `spritesheet.webp`) or a bare `.webp`:
  - **ChroMeow HD**: 8 columns, one row per behaviour state, 192×208 px cells
  - **OpenPets V1**: 8×9 grid (idle, running right/left, waving, jumping, failed, waiting, running, review)

  Import works with ChroMeow HD, OpenPets V1 (8×9), OpenPets V2 (8×11, adds sleeping and sitting) and legacy 9×8 sheets, as `.zip`, `.png` or `.webp`. Switch a cat between procedural and sprite rendering at any time.

## Privacy

- No network access. The extension pages ship with `connect-src 'none'` and the code makes no requests.
- No analytics, telemetry, accounts or remote code.
- Photos are decoded and analysed on a canvas in your browser and kept only as downscaled copies in `chrome.storage.local`.
- Cat positions sync between tabs through the extension's service worker and `chrome.storage.session`, which is cleared when the browser closes.
- Permissions: `storage` and `unlimitedStorage` (for sprite sheets). The content script runs on all sites so cats can appear anywhere; pause it per site from the popup.

## How it works

```
src/
  shared/      types, 49-state catalogue, presets, storage, i18n (EN/HE), zip, colour maths
  engine/      Physics, Navigator, DomPlatformScanner, VerletTail, CoatTexture, UVLayout,
               Pose, PoseLibrary, ArticulatedCatRenderer, SpriteRenderer, SoundSynthesizer,
               Particles, CatPortrait
  ai/          States (transition graph), FelineFSM, Drives, UtilityBrain, SocialCoordinator,
               HitboxZones
  sim/         CatAgent (tasks, plans, petting), World (cursor, toys, render loop, snapshots)
  content/     ContentApp, ShadowDOMOverlay, InputInterceptor, ToyManager
  background/  StateSyncServiceWorker (cross-tab state, keyboard command, badge)
  popup/       PopupController
  studio/      CatStudioApp, PhotoColorExtractor, CoatPainter, PreviewSandbox, SpriteSheetBaker
tests/         Vitest suites
```

**Overlay.** A single `<div id="chromeow-host">` holds an open shadow root with one full-viewport canvas (`position: fixed; inset: 0; z-index: 2147483647; pointer-events: none`). Mouse tracking uses passive window listeners. Each cat gets an invisible hitbox `<div>` shaped to its silhouette with `clip-path`, which is the only thing that catches the pointer, and only while click-through lock is off.

**Physics.** `DomPlatformScanner` finds standable surfaces during idle time: semantic elements (header, nav, article, images, video, code blocks, inputs, buttons, dialogs) and card-like containers with a visible border, shadow or rounded filled background. An IntersectionObserver tracks what is on screen, ResizeObserver and MutationObserver flag layout changes, scroll is throttled, and `elementsFromPoint` rejects ledges hidden under sticky headers. Each platform is `{ xMin, xMax, y, elementRef }`; the viewport bottom is always the floor. Gravity is 980 px/s². Jumps are solved in closed form for a parabolic arc to the target ledge, and `Navigator` runs Dijkstra over possible hops so a cat can chain jumps to reach a high spot. Cats ride the element they stand on when the page scrolls. A scroll faster than about 2,600 px/s throws them off (`STARTLED_AIRBORNE`).

**Behaviour.** Every cat has drives (energy, playfulness, affection, curiosity, irritation, social need) and a fixed personality. `UtilityBrain` scores 14 intents (sleep, rest, perch, groom, explore, zoomies, gaze, hunt, keyboard, social, toy, treat, climb, peek) as

U(a) = Σᵢ wᵢ · fᵢ(dᵢ, context) + ε

with a minimum commitment time, a commitment bonus and a switching margin as hysteresis, so cats don't flicker between activities. Intents become plans of tasks (go to, climb, play a state, pounce, eat). `FelineFSM` enforces the transition graph, so a sleeping cat always wakes through stretch and yawn, while physics interrupts (falls, startles, landings) can cut in anywhere. `SocialCoordinator` pairs cats for greetings, allogrooming, the three cuddle formations, tag, wrestling and jealousy.

**Rendering.** Each procedural cat is an articulated 2D rig with realistic proportions: a small skull on a short neck, a torso with deep chest, waist and primordial pouch and shoulder blades that roll as it walks, digitigrade legs (thigh to hock to long metatarsus behind; elbow, wrist and pastern in front) solved with two-bone IK, and a six-node Verlet tail (Jakobsen relaxation, bend limits, ledge collision). Coats are painted into a 512×512 UV atlas from the palette, pattern masks, fur-stroke tabby markings and your brush strokes, then mapped onto the body as seamless triangle strips. Every frame the furred parts are painted into an offscreen layer at screen resolution and lit as one body: a world-fixed key light, soft core shadow, sheen and ambient occlusion from blurred silhouettes, contact shadows where parts overlap, and hair fringes instead of outlines. The face has layered irises with slit pupils and wet highlights, nose leather with nostrils, whisker pads and tapered whiskers.

**Motion.** Poses blend with critically damped springs, so every change eases in and out and a target that changes mid-move never kinks. Paws stay planted during the stance phase, swing with eased acceleration, and the head stays steady while the body walks. Blinks close fast and open slowly, idle cats glance around, and turning around is an eased swing rather than a flip. Sounds (purrs, meows, trills, chirps) are synthesised with the Web Audio API.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Rebuilds `dist/` on change |
| `npm run build` | Production build: pages and service worker, then the content script as an IIFE |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm test` | Vitest: transition graph and FSM, utility scoring and hysteresis, pose springs, Verlet tail, photo colour extraction and white balance, jump physics, hand-held toys, cat export/import, zip round trips, presets and settings |
| `npm run verify` | All three of the above |

After rebuilding, press the reload button on the ChroMeow card in `chrome://extensions` and reload your open tabs.

## Credits

Made by APK.

---

<div dir="rtl">

## ChroMeow בעברית

שני חתולים שגרים בדפי האינטרנט שאתם גולשים בהם. הם מטיילים על כותרות וכרטיסים, נרדמים על נגני וידאו חמימים, רודפים אחרי סמן העכבר, צופים בכם מקלידים, מלקקים זה את זה ומתלוננים כשמלטפים את השני יותר מדי זמן. הכול רץ מקומית בדפדפן: בלי שרתים, בלי מעקב ובלי שום בקשת רשת.

### התקנה

</div>

```bash
npm install
npm run verify
```

<div dir="rtl">

1. פתחו את `chrome://extensions`.
2. הפעילו את **מצב מפתח** (Developer mode) בפינה העליונה.
3. לחצו על **Load unpacked** ובחרו את התיקייה `dist/`.
4. פתחו דף אינטרנט רגיל. החתולים ינחתו בתחתית החלון.

Chrome לא מריץ תוספים בדפי `chrome://` ובחנות התוספים, ולכן החתולים לא יופיעו שם. דפים שהיו פתוחים לפני ההתקנה צריכים רענון.

### הכירו את החתולים

שני חתולים פעילים כבר מההתחלה, שניהם בדמות טאבי חום-לבן אמיתי: חזה ובטן לבנים, להבה לבנה בצורת V הפוך, סימן ה-M על המצח, "אייליינר" כהה, זנב עם טבעות וקצה כהה.

- **חתול 1**: פס כתפיים לבן שחוצה את האוכף, כתם זהוב בצד, רגליים קדמיות לבנות לגמרי. ישנה עם הסנטר על מדף, עצלנית, חברותית ועם הרבה עמדה: מבט ה"אוזני מטוס" השיפוטי שייך לה.
- **חתול 2**: גלימת טאבי רציפה, כתם לבן קטן על הגב התחתון, להבה רחבה יותר. ישן כ"כיכר נמסה" עם זנב שמשתלשל מהקצה, אוהב להתכרבל כמו כרית וצייד נלהב יותר.

אפשר לשנות את השמות בחלון הקופץ או בסטודיו (שמות בעברית עובדים), ולהוסיף עד שישה חתולים.

### שימוש

**החלון הקופץ** (האייקון בסרגל הכלים) מציג כל חתול עם דיוקן חי, הפעילות הנוכחית, אנרגיה וחיבה. בכל כרטיס יש **מתג הפעלה וכיבוי** (להסתיר חתול בלי למחוק אותו), **עריכה** (פותח את הסטודיו על החתול הזה) ו**הסרה** (שתי לחיצות לאישור; את החתול האחרון אפשר רק לכבות). משם אפשר גם:

- לקחת צעצוע, חטיפים, לייזר או כדור, ולשחק בדף עם הכפתור השמאלי של העכבר, או לקרוא לחתולים למרכז החלון
- **נעילת מעבר לחיצות**: החתולים מפסיקים לתפוס את העכבר וניתן ללחוץ על מה שמתחתם. קיצור מקלדת: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>
- להשהות באתר הנוכחי (נשמר לפי דומיין) או בכל מקום
- צליל ועוצמה, גודל החתולים, תגיות שם ומצב רגוע
- לפתוח את סטודיו החתולים

**ליטוף.** העבירו את העכבר הלוך ושוב מעל החתול. סנטר ולחיים: גרגור בעיניים חצי עצומות. ראש ואוזניים: רעד באוזניים, גרגור ואז לישת עוגיות. גב ובסיס הזנב: "מעלית" עם הישבן וגרגור. כפות קדמיות: קיפול כפות. בטן: התגלגלות על הגב, ואז לפי מצב הרוח נהנים או עונים בבעיטות ובחבטה. זנב: הצלפות זנב ואוזני מטוס. ליטוף ארוך של חתול אחד (כשמונה שניות) עלול להביא את השני לדחוף את עצמו פנימה.

**משחק עם צעצועים.** אחרי שבוחרים צעצוע מופיע סרגל קטן בראש הדף, והכפתור השמאלי משחק במקום ללחוץ על קישורים. חטיפים: לחיצה בכל מקום מפילה חטיף. לייזר: מחזיקים את הכפתור והנקודה זזה עם העכבר. כדור: לוחצים, גוררים ומשחררים כדי לזרוק. <kbd>Esc</kbd>, לחיצה ימנית או "סיום" מחזירים את הדף לרגיל.

### סטודיו החתולים

- **תמונות**: העלו 1–3 תמונות, בחרו איבר ולחצו על התמונה כדי לדגום את הצבע. כל סיכה זוכרת לאיזו תמונה היא שייכת, כך שאפשר לדגום עיניים מתמונה אחת ופרווה מאחרת. האפשרות "תיקון גוון התאורה לפי הפרווה הלבנה" מאזנת את הלבן של כל הדגימות. "ניתוח תמונה" מריץ K-Means מקומי ומציע פלטה שלמה.
- **פרווה וסימנים**: בחירת דוגמה, עריכת כל צבע בפלטה וכוונון הסימנים.
- **מכחול**: ציור ישיר על מפת הטקסטורה של החתול.
- **אישיות**: שם, ביוגרפיה, מבנה גוף ומחווני אישיות.
- **גיליונות ספרייטים**: ייצוא לקובץ `.zip` (עם `pet.json`) או `.webp` בפורמט ChroMeow HD או OpenPets V1, וייבוא של ChroMeow HD,‏ OpenPets V1/V2 וגיליונות 9×8 ישנים.
- **ייצוא וייבוא חתולים**: "ייצוא החתול" או "ייצוא הכול" שומרים קובץ `.chromeow.json` עם כל פרטי החתול (פרווה, סימנים, גוף, אישיות, ציור, תמונות וספרייטים). "ייבוא חתולים" (או גרירת הקובץ לרשימה) מוסיף אותם למקומות פנויים.
- ברשימת החתולים יש לכל חתול מתג הפעלה וכפתור הסרה.

### פרטיות

- אין גישה לרשת: דפי התוסף מוגדרים עם `connect-src 'none'` והקוד לא שולח שום בקשה.
- אין אנליטיקה, טלמטריה, חשבונות או קוד מרוחק.
- התמונות מנותחות על קנבס בדפדפן ונשמרות רק כעותקים מוקטנים ב-`chrome.storage.local`.
- מיקומי החתולים מסונכרנים בין לשוניות דרך ה-service worker של התוסף ו-`chrome.storage.session`, שנמחק כשהדפדפן נסגר.

### פיתוח

`npm run dev` לבנייה מתמשכת, `npm run build` לבניית גרסה, `npm run typecheck` לבדיקת טיפוסים ו-`npm test` להרצת הבדיקות. אחרי בנייה מחדש לחצו על כפתור הרענון של ChroMeow ב-`chrome://extensions` ורעננו את הלשוניות הפתוחות.

### קרדיטים

נוצר על ידי APK.

</div>
