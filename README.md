# ChroMeow

Alex and Anna, two cats that live on the web pages you visit. They walk along headers and cards, nap in their own named beds or on warm video players, chase your cursor, a feather wand and a toy mouse, keep out of your way while you type, eat and drink from their own bowls, groom each other, curl up together when you step away, and complain when you pet the other one for too long. You can pick them up by the scruff and carry them anywhere. There is only one Alex and one Anna in the whole browser: they follow you from tab to tab and window to window, and now and then one wanders off to visit another tab. Everything runs locally in your browser: no servers, no analytics, no network requests at all.

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

Alex and Anna are enabled out of the box. Both are brown-and-white tabbies modelled on real cats, with a white bib and belly, the tabby "M" on the forehead, dark eyeliner and a ringed tail with a dark tip. Their default coats, bodies and personalities are the owner's own tuned versions of the cats.

| | Alex (אלכס) | Anna (אנה) |
|---|---|---|
| Coat | Patched brown tabby with white. A white band crosses his back behind the shoulders ("broken saddle"), splitting the tabby shoulder patch from the rear saddle, and an amber patch sits low on his flank where the tabby meets the white belly. Narrow blaze climbing high up the forehead, tabby front legs with white paws, high white hind stockings, three tail rings | Mantled brown tabby with white: one continuous tabby mantle from crown to tail (no white band, no orange patch) with a small white crest near the rump. Broad, soft blaze, bold cheek stripes, white mittens, seven tail rings |
| Build | Big and chonky (size 1.2) | A little smaller (size 1.1) |
| Temperament | Very lazy, very affectionate and a bit sassy. Loves to sprawl and stretch his front paws out, gets hungry a bit faster, adores head, chin and back rubs, devoted to Anna | Keen cursor hunter with expressive "airplane ears" when annoyed or overstimulated. Often starts grooming sessions and cuddles with Alex |
| Signature sleep | Chin propped on a ledge (`CHIN_PROP_SLEEP`) | Melted loaf on a narrow ledge (`MELTED_LOAF_SLEEP`) |

Rename them in the popup or the Cat Studio (their names show as אלכס and אנה in Hebrew). You can run up to six cats, and switch any of them off or remove them. If you used ChroMeow 1.x, your factory "Cat 1" and "Cat 2" become Alex and Anna on update, and an Alex or Anna still wearing the 2.0 factory coat gets the new defaults. Any name, colours, paint or photos you changed are kept.

## Using it

**The popup** (toolbar icon) shows every cat with a live portrait, current activity, energy and affection. Each card has an **on/off switch** (hide a cat without deleting it), **Edit** (opens the Cat Studio on that cat) and **Remove** (click twice to confirm; the last cat can only be switched off). From the popup you can also:

- Pick up a toy, **Treats**, **Laser pointer**, **Toy ball** or **Feather Wand**, and play on the page with the left mouse button (see below), let the **Toy mouse** loose, or **Call cats** to the middle of the window
- **Bowls** and **Beds**: quick toggles that show or hide the food & water station and the cats' beds
- **Clear all**: removes every treat, ball, laser dot, feather wand and toy mouse from the page (the cats stay)
- **Click-through lock**: cats stop catching the mouse so you can click whatever is under them. Shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>
- **Pause on this site** (remembered per domain) or **Pause everywhere**
- **Food & water**: how full each bowl is (with a "running low" badge), **Refill food 🍖** and **Refill water 💧**
- **Cuddle up when I'm away**: how long without mouse or keyboard input before the cats curl up together (30 seconds to 30 minutes, 2 minutes by default)
- **Cats roam between tabs** (on by default)
- Cat size, name tags and calm mode
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

Petting for a long time eventually overstimulates a cat (Anna's ears flatten much sooner than Alex's). Click a cat to poke it. Pet one cat for more than about eight seconds and the other may walk over and push in.

**Picking a cat up.** Press on a cat and drag (more than 5 px), or press right on the scruff behind the ears, to lift it by the scruff. The cat goes calm, half-closes its eyes and hangs below your pointer: front paws dangle, hind legs tuck in, the tail droops, and the body swings with your hand and settles when you hold still. While you hold a cat, the overlay keeps the pointer however fast you move, so you never select text by accident. Let go to drop it or flick to throw it. It falls, lands on the ledge or floor below, and licks a paw to smooth its fur. Leaving the window or a cancelled pointer sets it down gently.

**Food and water.** A small mat with a food bowl and a water bowl sits on the bottom of the window (on the right by default). Hunger and thirst build over time, faster with zoomies, pouncing and play. A hungry or thirsty cat walks over, eats or drinks with its head in the bowl, and then sits down for a quick face wash. The bowls empty gradually: every meal takes a little, and on top of that the kibble slowly goes (about 14 % an hour) and the water evaporates (about 22 % an hour) while the cats are on screen. While no page shows the cats the bowls keep emptying at half that rate, but by no more than 35 points per absence. Once a bowl is down to 20 % a hungry or thirsty cat keeps thinking about it (a fish or water-drop thought bubble every so often); when it is empty, a very hungry cat sits beside it and looks up at you until you refill it. Click a bowl to refill it (or use the popup), or drag the mat to move the station. Bowl levels are shared by all tabs.

**Beds.** Each cat has its own round bed on the bottom of the window with its name stitched on the front ("Alex", "Anna"; אלכס and אנה in Hebrew). A sleepy cat prefers its own bed and never naps in the other's; when you step away the pair cuddles up in one of their beds. Drag a bed sideways to move it. Positions are shared by all tabs; the **Beds** toggle in the popup hides them.

**When you step away.** After the idle delay with no mouse or keyboard input (or when the computer goes idle or locks), Alex and Anna walk to each other, trade a quick lick and fall asleep pressed together, Anna draped over Alex, breathing in sync. While they sleep, the page scanner slows down to save battery. Move the mouse or press a key and they wake slowly: a long blink, a stretch, a yawn, then Alex trots over to your pointer with his tail up like a question mark.

**Right-click a cat** for the mini-games menu (instead of the browser's context menu; everywhere else right-click works as usual): treats, laser, ball, the feather wand, the toy mouse, call the cats, or clear all toys. <kbd>Esc</kbd> or a click outside closes it.

**The toy mouse** is a little grey felt mouse with its own thin tail and twitching whiskers (no string). It runs about by itself like a real mouse: scuttles in short bursts, pauses to sniff, darts off, freezes or bolts when a cat comes close (a cat creeping up low and slow gets much closer than a trotting one), and drops off ledges. The cats aim for its body: they stalk it, chase it flat out when it runs, pounce and pin it; after three catches it gives up and lies there until you clear it. Press on the mouse to pick it up: it wriggles in your hand, and you can throw it.

**The feather wand** is a teaser rod held at your pointer, with a string and a fluttering feather lure (with a little bead and bell) on the end. The rod tilts as you move your hand. The string is a 14-segment Verlet rope (gravity 0.45 px/frame², damping 0.97, 7 relaxation passes) that collides with the floor and the page's ledges, so when you lower the wand the string and feather lie down and slide along the surface. Drag the feather along the floor (within 25 px of it) and the cats drop into a low stalk, wiggle their bums and pounce to pin it; dangle it 40–260 px above them and they face it and leap straight up to swat it. A swat kicks the feather away, the string jerks, and a few wisps of fluff drift down. The two cats take turns, a few seconds apart.

**The ball** can be picked straight up off the page too, no toy needed: press on it, drag, and let go to throw.

**Playing with toys.** After you pick a toy, a small toolbar appears at the top of the page and the left mouse button plays instead of clicking links:

| Toy | Left mouse button |
|---|---|
| Treats | Click anywhere to drop a treat; it falls onto the ledge below and the cats come to eat |
| Laser pointer | Hold the button to shine the dot under the pointer; the cats chase it |
| Toy ball | Press to pick the ball up, drag and let go to throw it; a faster flick throws farther |
| Feather wand | Just move the pointer: the wand follows it. Lower it to drag the feather along the floor, raise it to dangle the feather above the cats |

Switch toys from the toolbar. Press <kbd>Esc</kbd>, right-click or choose **Done** to put the toy away. Scrolling still works while you play. The same toys work in the Cat Studio's live preview.

**On their own** the cats sleep through full rest chains (curled sleep, sprawl, arch stretch, big yawn, sit), groom, explore, perch on page elements, track and stalk the cursor, pounce on erratic movement, peek over screen edges, climb the sides of the window, boop noses, groom each other, play tag and wrestle, and sleep together in a yin-yang curl, a pillow stack or a tandem belly hold. A cat on a page element moves with it as you scroll. When the element scrolls off the top of the window, the cat hops down to the floor.

**Jumps and pounces.** For something in the air (a dangling feather, a laser dot on the wall, a ball in flight) a cat leaps straight up, or up and forward, and swats at the top of the leap. It never leaps or lunges backward: if the target is behind it, it turns around first.

**Personal space.** Alex and Anna don't stand or sit on top of each other: a cat heading for a spot the other one has already taken (or is already walking to) settles beside it instead, and two cats that end up overlapping nudge apart. Cuddles, grooming, boops and play are the exceptions. They also never mirror each other: when something happens to both (you call them, drop a toy, come back to the computer) the second one reacts 2–5 seconds after the first, and a cat waits a moment before starting the same thing the other one just started.

**Typing in peace.** Click into a text field (an input, a textarea, a rich-text editor or a search box, including ones inside web components) and the cats move out of the way. The field's box plus 90 px on each side, 110 px above and 70 px below becomes a no-go zone while the field is focused (and for at least 8 seconds after your last keystroke): ledges in it can't be used, a cat napping on or next to the field wakes up and walks at least 140 px away, and no cat walks into or across the zone. From there they sit and watch you type. The zone follows the field as you scroll or resize the window.

**Calm tails.** Tail motion is rate-limited (how fast each joint can bend and each segment can move), and a cat that is sitting, loafing, watching the cursor or the keyboard, resting or asleep keeps its tail completely still.

**One Alex, one Anna.** Every page reports to the extension's service worker whether it is on screen and focused, and exactly one tab in the whole browser (the visible tab you focused most recently) hosts the cats. Other tabs show the bowls and beds but no cats. Switch tabs and the cats are simply there; focus another window that is also on screen and they run off one window and walk into the other from the facing edge. Now and then a curious cat walks off the screen to visit one of your other tabs. It comes back from the same side after a minute or two, or you find it waiting in that tab when you switch to it. Switch this off with **Cats roam between tabs** in the popup.

## Cat Studio

Open it from the popup (or **Extension options**). The live preview at the top runs the same engine as the content script: pet the preview cat, pick it up, play with the toys, click the bowls, or trigger any of the 56 behaviour states (including the scruff hold, eating, drinking, asking for a refill and the cuddle).

The cat list on the left has an on/off switch and a remove button for each cat. Below it:

- **Export this cat** or **Export all** saves a `.chromeow.json` file containing everything about the cat: coat, markings, body, personality, painted fur, reference photos and any sprite sheet.
- **Import cats** (or drop a `.chromeow.json` file on the list) adds the cats from a file to free slots. Imported files are checked field by field, and anything unexpected is ignored.

- **Photos.** Add 1–3 photos of your cat. Pick a body part (primary fur, belly, stripes, each eye, nose, paw socks) and click the photo to sample it; drag pins to adjust. Pins remember which photo they sit on, so you can sample eyes from a daylight close-up and fur from another shot. "Correct lamp colour using the white fur" white-balances every sample from the white fur patch, and eye samples that are only pupil are ignored. **Analyze photo** runs local K-Means in CIE-Lab space and suggests a whole palette with each colour's share of the coat.
- **Coat & markings.** Choose a pattern (solid, tuxedo, classic or mackerel tabby, spotted, calico, tortoiseshell, colourpoint, bicolour/van, Alex's patched tabby and Anna's mantled tabby, or a custom paintable mask), edit every palette colour and tune markings like blaze width and asymmetry, the white saddle band, the amber flank patch, stockings and tail rings. Photo colours never remove a cat's markings, and while the flank patch is on it only takes a genuinely warm amber.
- **Templates.** **Add cat** can start from Alex or Anna (a separate copy to inspect or customise) or from the other presets.
- **Paint brush.** Paint directly on the cat's texture atlas (torso, head, legs, tail, ears) with optional UV guides.
- **Personality.** Name, bio, body shape (chonk, fur length, ears, tail, size, heterochromia), personality sliders (laziness, hunt drive, sociability, sassiness, clumsiness, affection) and quirks: appetite and thirst, playfulness, love of head and back rubs, how expressive the ears are, how often the cat starts cuddles and grooming, love of sprawling, and which cat it is bonded with.
- **Sprite sheets.** Bake the procedural cat to a sprite sheet and download it as a `.zip` (`pet.json` + `spritesheet.webp`) or a bare `.webp`:
  - **ChroMeow HD**: 8 columns, one row per behaviour state, 192×208 px cells (sheets baked with 1.x have 49 rows and still import)
  - **OpenPets V1**: 8×9 grid (idle, running right/left, waving, jumping, failed, waiting, running, review)

  Import works with ChroMeow HD, OpenPets V1 (8×9), OpenPets V2 (8×11, adds sleeping and sitting) and legacy 9×8 sheets, as `.zip`, `.png` or `.webp`. Switch a cat between procedural and sprite rendering at any time.

## Privacy

- No network access. The extension pages ship with `connect-src 'none'` and the code makes no requests.
- No analytics, telemetry, accounts or remote code.
- Photos are decoded and analysed on a canvas in your browser and kept only as downscaled copies in `chrome.storage.local`.
- Cat positions and which tab hosts the cats sync between tabs through the extension's service worker and `chrome.storage.session`, which is cleared when the browser closes.
- Permissions: `storage`, `unlimitedStorage` (for sprite sheets) and `idle` (to know when the computer is idle or locked; Chrome shows no warning for it). The content script runs on all sites so cats can appear anywhere; pause it per site from the popup.

## How it works

```
src/
  shared/      types, 56-state catalogue, presets (Alex & Anna, v1 migration), storage, i18n (EN/HE),
               cat files, zip, colour maths, instance (single-instance leader election, roaming)
  engine/      Physics, Navigator, DomPlatformScanner, VerletTail, VerletRope, CoatTexture, UVLayout,
               Pose, PoseLibrary, ArticulatedCatRenderer, SpriteRenderer,
               Particles, CatPortrait
  ai/          States (transition graph), FelineFSM, Drives, UtilityBrain, SocialCoordinator,
               HitboxZones
  sim/         CatAgent (tasks, plans, chase & leap, personal space, petting, scruff hold),
               World (cursor, grabbing cats and toys, staggered reactions, roaming, render loop,
               snapshots), FeedingStation, CatBeds, MouseToy, FeatherWand, ExclusionZone (typing zones),
               ToyTool, StaticPlatformSource
  content/     ContentApp, ShadowDOMOverlay, InputInterceptor, ToyManager, PlayMode, GamesMenu
  background/  StateSyncServiceWorker (cross-tab state, leader election, chrome.idle, keyboard
               command, badge)
  popup/       PopupController
  studio/      CatStudioApp, PhotoColorExtractor, CoatPainter, PreviewSandbox, SpriteSheetBaker
tests/         Vitest suites
```

**Overlay.** A single `<div id="chromeow-host">` holds an open shadow root with one full-viewport canvas (`position: fixed; inset: 0; z-index: 2147483647; pointer-events: none`). Mouse tracking uses passive window listeners. Each cat gets an invisible hitbox `<div>` shaped to its silhouette with `clip-path`, which is the only thing that catches the pointer, and only while click-through lock is off. The food & water station, each bed and each toy you can pick up (ball, mouse) have hitboxes of their own, and a right-click on a cat's hitbox opens the mini-games menu. When a cat is picked up, a full-window drag shield takes pointer capture (`pointer-events: auto`, `cursor: grabbing`, `selectstart` blocked) until the button is released, the pointer is cancelled or the window loses focus. Every frame clears the whole canvas before drawing.

**Physics.** `DomPlatformScanner` finds standable surfaces during idle time: semantic elements (header, nav, article, images, video, code blocks, inputs, buttons, dialogs) and card-like containers with a visible border, shadow or rounded filled background. An IntersectionObserver tracks what is on screen, ResizeObserver and MutationObserver flag layout changes, scroll is throttled, and `elementsFromPoint` rejects ledges hidden under sticky headers. Each platform is `{ xMin, xMax, y, elementRef }`; the viewport bottom is always the floor. Gravity is 980 px/s². Jumps are solved in closed form for a parabolic arc to the target ledge, and `Navigator` runs Dijkstra over possible hops so a cat can chain jumps to reach a high spot. When the page scrolls, the world applies the scroll delta to cats standing on elements that scroll with the page before physics runs, and the scanner shifts its cached ledges by the same amount between measurements. Fixed and sticky elements are left in place. A ledge that leaves through the top of the window makes the cat hop down; one that jumps on its own faster than about 2,600 px/s (an animation or layout shift) still throws the cat off (`STARTLED_AIRBORNE`).

**Holding.** `SCRUFF_HELD` can interrupt any state. The rig rotates so the hips hang below the nape, the nape is pinned to the pointer, and the swing is a spring-damper toward `clamp(−handVx · 0.045, −0.65, 0.65)` rad (hand speed in px per 60 Hz frame). On release the smoothed hand velocity (last 90 ms, capped) becomes the throw.

**Behaviour.** Every cat has drives (energy, playfulness, affection, curiosity, irritation, social need, hunger, thirst), a fixed personality and quirks. `UtilityBrain` scores 16 intents (sleep, rest, perch, groom, explore, zoomies, gaze, hunt, keyboard, social, toy, treat, climb, peek, eat, drink) as

U(a) = Σᵢ wᵢ · fᵢ(dᵢ, context) + ε

with a minimum commitment time, a commitment bonus and a switching margin as hysteresis, so cats don't flicker between activities. Above hunger 65 or thirst 60 (with something in the bowl) eating or drinking outranks everything. Above 75 with an empty bowl (5 % or less) the cat asks for a refill, then gives up for 45 seconds. Intents become plans of tasks (go to, climb, play a state, pounce, eat). `FelineFSM` enforces the transition graph, so a sleeping cat always wakes through stretch and yawn, while physics interrupts (falls, startles, landings) can cut in anywhere. `SocialCoordinator` pairs cats for greetings, allogrooming, the cuddle formations, tag, wrestling, jealousy, and the idle gather → mutual lick → `CUDDLE_SLEEP` → blink, stretch, yawn and greeting. Bonded partners prefer each other.

Spec names map to states like this: FALLING/JUMPING = `FALL_DESCEND`/`JUMP_ASCEND`, GROOM = `GROOM_LICK_PAW`/`GROOM_WASH_FACE`, SOCIAL_GROOM = `ALLOGROOMING`, STRETCH = `WAKE_ARCH_STRETCH`, YAWN = `BIG_YAWN`, and the empty-bowl wait is `EMPTY_BOWL_WAIT`.

**Rendering.** Each procedural cat is an articulated 2D rig with realistic proportions: a small skull on a short neck, a torso with deep chest, waist and primordial pouch and shoulder blades that roll as it walks, digitigrade legs (thigh to hock to long metatarsus behind; elbow, wrist and pastern in front) solved with two-bone IK, and a six-node Verlet tail (Jakobsen relaxation, bend limits, ledge collision, per-joint bend-rate and node-speed limits, and a still lock for seated and resting cats). The neck is a constrained bone: the head never sits more than 22.5 units from the shoulders, and the head–torso joint bends only within anatomical limits, so cuddle and sleep poses reach with the shoulders instead of stretching the neck. Coats are painted into a 512×512 UV atlas from the palette, pattern masks, fur-stroke tabby markings and your brush strokes, then mapped onto the body as seamless triangle strips. Every frame the furred parts are painted into an offscreen layer at screen resolution and lit as one body: a world-fixed key light, soft core shadow, sheen and ambient occlusion from blurred silhouettes, contact shadows where parts overlap, and hair fringes instead of outlines. The face has layered irises with slit pupils and wet highlights, nose leather with nostrils, whisker pads and tapered whiskers.

**Motion.** Poses blend with critically damped springs, so every change eases in and out and a target that changes mid-move never kinks. Paws stay planted during the stance phase, swing with eased acceleration, and the head stays steady while the body walks. Blinks close fast and open slowly, idle cats glance around, and turning around is an eased swing rather than a flip.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Rebuilds `dist/` on change |
| `npm run build` | Production build: pages and service worker, then the content script as an IIFE |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm test` | Vitest: transition graph and FSM (including the scruff hold), utility scoring, hysteresis and meals, scruff pendulum and throws, pose springs and neck limits, Verlet tail (rate limits, still lock), photo colour extraction and white balance, jump and vertical-leap physics, hand-held toys, cat export/import, zip round trips, Alex & Anna presets and migration, settings, the mini-games menu, bowl depletion, the toy mouse, the feather wand's rope (gravity, floor draping, swats), typing exclusion zones and evacuation, beds, single-instance leader election and roaming, personal space and staggering, and headless World runs (eating, empty bowls, picking up and throwing cats and toys, idle cuddle and wake-up, scrolling) |
| `npm run verify` | All three of the above |

After rebuilding, press the reload button on the ChroMeow card in `chrome://extensions` and reload your open tabs.

## Credits

Made by APK.

---

<div dir="rtl">

## ChroMeow בעברית

אלכס ואנה, שני חתולים שגרים בדפי האינטרנט שאתם גולשים בהם. הם מטיילים על כותרות וכרטיסים, נרדמים במיטות שלהם או על נגני וידאו חמימים, רודפים אחרי סמן העכבר אחרי חכת נוצה ואחרי עכבר צעצוע, מפנים לכם מקום כשאתם מקלידים, אוכלים ושותים מהקערות שלהם, מלקקים זה את זה, מתכרבלים יחד כשאתם הולכים ומתלוננים כשמלטפים את השני יותר מדי זמן. אפשר להרים אותם בעורף ולשאת אותם לכל מקום. הכול רץ מקומית בדפדפן: בלי שרתים, בלי מעקב ובלי שום בקשת רשת.

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

אלכס ואנה פעילים כבר מההתחלה. שניהם טאבי מקרל חום-לבן בדמות חתולים אמיתיים: חזה ובטן לבנים, סימן ה-M על המצח, "אייליינר" כהה וזנב עם טבעות וקצה כהה.

- **אלכס**: טאבי חום מוטלא עם לבן, גדול ושמנמן. פס לבן חוצה את הגב מאחורי הכתפיים ("אוכף שבור"), וכתם ענבר נמצא נמוך בצד, היכן שהטאבי פוגש את הבטן הלבנה. להבה צרה שעולה גבוה על המצח, רגליים קדמיות מפוספסות עם כפות לבנות, גרביים לבנים גבוהים מאחור. עצלן מאוד, מלא חיבה וקצת חצוף: אוהב להשתרע ולמתוח את הכפות הקדמיות, נעשה רעב קצת יותר מהר, מת על ליטופים בראש, בסנטר ובגב, ומסור לאנה.
- **אנה**: טאבי חום עם גלימה ולבן: גלימת טאבי אחת רציפה מהראש ועד הזנב (בלי פס לבן ובלי כתם כתום) עם כתם לבן קטן ליד העכוז. להבה רחבה ורכה, פסי לחיים בולטים, כפפות לבנות. ציידת נלהבת של סמן העכבר עם "אוזני מטוס" כשהיא מתעצבנת, ולרוב היא זו שמתחילה ללקק ולהתכרבל עם אלכס.

ברירות המחדל של הפרווה, הגוף והאישיות הן הגרסאות שהבעלים כיוונו בעצמם.

אפשר לשנות את השמות בחלון הקופץ או בסטודיו, ולהוסיף עד שישה חתולים. מי שהשתמש ב-ChroMeow 1.x יקבל את "חתול 1" ו"חתול 2" כאלכס ואנה; שם, צבעים, ציור ותמונות ששיניתם נשמרים.

### שימוש

**החלון הקופץ** (האייקון בסרגל הכלים) מציג כל חתול עם דיוקן חי, הפעילות הנוכחית, אנרגיה וחיבה. בכל כרטיס יש **מתג הפעלה וכיבוי** (להסתיר חתול בלי למחוק אותו), **עריכה** (פותח את הסטודיו על החתול הזה) ו**הסרה** (שתי לחיצות לאישור; את החתול האחרון אפשר רק לכבות). משם אפשר גם:

- לקחת צעצוע, חטיפים, לייזר, כדור או חכת נוצה, ולשחק בדף עם הכפתור השמאלי של העכבר, לשחרר את **עכבר הצעצוע**, או לקרוא לחתולים למרכז החלון
- **קערות** ו**מיטות**: כפתורים מהירים להצגה או הסתרה של פינת האוכל ושל המיטות
- **ניקוי הכול**: מסיר מהדף את כל החטיפים, הכדורים, נקודת הלייזר ועכבר הצעצוע (החתולים נשארים)
- **נעילת מעבר לחיצות**: החתולים מפסיקים לתפוס את העכבר וניתן ללחוץ על מה שמתחתם. קיצור מקלדת: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>
- להשהות באתר הנוכחי (נשמר לפי דומיין) או בכל מקום
- **אוכל ומים**: כמה מלאה כל קערה (עם תווית "עומד להיגמר"), **מילוי אוכל 🍖** ו**מילוי מים 💧**
- **החתולים מטיילים בין כרטיסיות** (פעיל כברירת מחדל)
- **להתכרבל יחד כשאני לא ליד המחשב**: אחרי כמה זמן בלי עכבר ומקלדת החתולים מתכרבלים (30 שניות עד 30 דקות, ברירת המחדל 2 דקות)
- גודל החתולים, תגיות שם ומצב רגוע
- לפתוח את סטודיו החתולים

**ליטוף.** העבירו את העכבר הלוך ושוב מעל החתול. סנטר ולחיים: גרגור בעיניים חצי עצומות. ראש ואוזניים: רעד באוזניים, גרגור ואז לישת עוגיות. גב ובסיס הזנב: "מעלית" עם הישבן וגרגור. כפות קדמיות: קיפול כפות. בטן: התגלגלות על הגב, ואז לפי מצב הרוח נהנים או עונים בבעיטות ובחבטה. זנב: הצלפות זנב ואוזני מטוס. ליטוף ארוך של חתול אחד (כשמונה שניות) עלול להביא את השני לדחוף את עצמו פנימה.

**הרמת חתול.** לוחצים על חתול וגוררים (יותר מ-5 פיקסלים), או לוחצים ישר על העורף מאחורי האוזניים, והחתול מורם בעורף. הוא נרגע, עוצם חצי עיניים ותלוי מתחת לסמן: הכפות הקדמיות משתלשלות, הרגליים האחוריות מתקפלות פנימה, הזנב צונח והגוף מתנדנד עם היד ונרגע כשהיא עומדת. בזמן ההחזקה הסמן ננעל על השכבה של החתולים, כך שגם תנועה מהירה לא בוחרת טקסט בדף. משחררים כדי להוריד, או מנערים כדי לזרוק. החתול נופל, נוחת על המדף או הרצפה, ומלקק כף כדי ליישר את הפרווה.

**אוכל ומים.** בתחתית החלון (מימין כברירת מחדל) יש מחצלת עם קערת אוכל וקערת מים. רעב וצמא מצטברים עם הזמן, מהר יותר אחרי ריצות ומשחק. חתול רעב או צמא הולך לקערה, אוכל או שותה, ואחר כך מתיישב לרחיצת פנים קצרה. הקערות מתרוקנות בהדרגה: כל ארוחה לוקחת קצת, ובנוסף האוכל נגמר לאט (כ-14% בשעה) והמים מתאדים (כ-22% בשעה) כל עוד החתולים על המסך. כשאף דף לא מציג אותם הקערות ממשיכות להתרוקן בחצי הקצב, ולא יותר מ-35 נקודות בכל היעדרות. כשקערה יורדת ל-20% חתול רעב או צמא ממשיך לחשוב עליה (בועת מחשבה של דג או טיפה מדי פעם), וכשהיא ריקה חתול רעב מאוד מתיישב לידה ומסתכל עליכם עד שתמלאו. לחיצה על קערה ממלאת אותה (או מהחלון הקופץ), וגרירת המחצלת מזיזה את הפינה. כמות האוכל משותפת לכל הלשוניות.

**מיטות.** לכל חתול יש מיטה עגולה משלו בתחתית החלון, עם השם רקום בחזית (אלכס, אנה). חתול עייף מעדיף את המיטה שלו ולעולם לא ישן במיטה של השני, וכשאתם הולכים הזוג מתכרבל באחת המיטות. גוררים מיטה הצידה כדי להזיז אותה. המיקומים משותפים לכל הלשוניות, והכפתור **מיטות** בחלון הקופץ מסתיר אותן.

**כשאתם הולכים.** אחרי זמן ההמתנה בלי עכבר ומקלדת (או כשהמחשב ננעל), אלכס ואנה הולכים זה אל זה, מלקקים זה את זה לרגע ונרדמים צמודים, אנה שעונה על אלכס, נושמים באותו קצב. כשאתם חוזרים הם מתעוררים לאט: מצמוץ ארוך, מתיחה, פיהוק, ואז אלכס ניגש לסמן עם זנב בצורת סימן שאלה .

**לחיצה ימנית על חתול** פותחת את תפריט המשחקים (במקום תפריט ההקשר של הדפדפן; בכל מקום אחר הלחיצה הימנית עובדת כרגיל): חטיפים, לייזר, כדור, חכת הנוצה, עכבר הצעצוע, לקרוא לחתולים או לנקות את כל הצעצועים. <kbd>Esc</kbd> או לחיצה מחוץ לתפריט סוגרים אותו.

**עכבר הצעצוע** הוא עכבר לבד אפור קטן עם זנב דק משלו ושפם רועד (בלי חוט). הוא מתרוצץ לבד כמו עכבר אמיתי: ריצות קצרות, עצירות לרחרח, זינוקים, קפיאה או בריחה כשחתול מתקרב (חתול שמתגנב נמוך ולאט מגיע קרוב הרבה יותר), ונפילה ממדפים. החתולים מכוונים לגוף שלו: הם אורבים לו, רודפים אחריו כשהוא בורח, מזנקים ותופסים אותו; אחרי שלוש תפיסות הוא מוותר ונשאר לשכב עד שתנקו. לחיצה על העכבר מרימה אותו: הוא מתפתל ביד, ואפשר לזרוק אותו.

**חכת הנוצה** היא מוט משחק שמוחזק בסמן העכבר, עם חוט ופיתיון נוצות מתנפנף (עם חרוז ופעמון קטן) בקצה. המוט נוטה כשמזיזים את היד. החוט הוא חבל ורלה של 14 מקטעים (כבידה 0.45 פיקסל/פריים², ריסון 0.97, 7 מעברי הרפיה) שמתנגש ברצפה ובמדפים של הדף, כך שכשמורידים את החכה החוט והנוצה נשכבים ומחליקים על המשטח. גררו את הנוצה על הרצפה (עד 25 פיקסלים ממנה) והחתולים נשכבים לארוב, מנענעים את הישבן ומזנקים להצמיד אותה; תנו לה להשתלשל 40–260 פיקסלים מעליהם והם מסתובבים אליה וקופצים ישר למעלה לחבוט בה. חבטה מעיפה את הנוצה, החוט נמשך, וכמה פתיתי פלומה צונחים. שני החתולים מתחלפים, בהפרש של כמה שניות.

**את הכדור** אפשר להרים ישר מהדף, בלי לבחור צעצוע: לוחצים עליו, גוררים ומשחררים לזריקה.

**משחק עם צעצועים.** אחרי שבוחרים צעצוע מופיע סרגל קטן בראש הדף, והכפתור השמאלי משחק במקום ללחוץ על קישורים. חטיפים: לחיצה בכל מקום מפילה חטיף. לייזר: מחזיקים את הכפתור והנקודה זזה עם העכבר. כדור: לוחצים, גוררים ומשחררים כדי לזרוק. חכת נוצה: פשוט מזיזים את העכבר; מורידים כדי לגרור את הנוצה על הרצפה, ומרימים כדי שתשתלשל מעל החתולים. <kbd>Esc</kbd>, לחיצה ימנית או "סיום" מחזירים את הדף לרגיל.

**הקלדה בשקט.** לחיצה בתוך שדה טקסט (תיבת קלט, אזור טקסט, עורך טקסט עשיר או תיבת חיפוש, גם בתוך רכיבי ווב) והחתולים מפנים את הדרך. התיבה של השדה, ועוד 90 פיקסלים מכל צד, 110 מעל ו-70 מתחת, הופכת לאזור אסור כל עוד השדה בפוקוס (ולפחות 8 שניות אחרי ההקשה האחרונה): אי אפשר להשתמש במדפים שבתוכו, חתול שישן על השדה או לידו מתעורר והולך לפחות 140 פיקסלים משם, ואף חתול לא נכנס לאזור או חוצה אותו. משם הם יושבים ומסתכלים עליכם מקלידים. האזור זז עם השדה כשגוללים או משנים את גודל החלון.

**קפיצות.** אל משהו באוויר (נוצה משתלשלת, נקודת לייזר על הקיר, כדור באוויר) החתול קופץ ישר למעלה, או למעלה וקדימה, וחובט בשיא הקפיצה. הוא אף פעם לא קופץ או מזנק אחורה: אם המטרה מאחוריו, הוא מסתובב קודם.

**מרחב אישי.** אלכס ואנה לא עומדים ולא יושבים זה על זה: חתול שהולך למקום שהשני כבר תפס (או כבר בדרך אליו) מתיישב לידו, ושני חתולים שנעמדו חופפים מתרחקים מעט. כרבולים, ליקוקים, נגיעות אף ומשחק הם החריגים. הם גם לא מחקים זה את זה: כשמשהו קורה לשניהם (קוראים להם, זורקים צעצוע, חוזרים למחשב) השני מגיב 2–5 שניות אחרי הראשון.

**זנב רגוע.** תנועת הזנב מוגבלת בקצב, וחתול שיושב, שוכב כמו כיכר לחם, צופה בסמן או במקלדת, נח או ישן מחזיק את הזנב דומם לגמרי.

**אלכס אחד ואנה אחת.** כל דף מדווח ל-service worker של התוסף אם הוא על המסך ובפוקוס, ורק לשונית אחת בכל הדפדפן (הלשונית הגלויה שהתמקדתם בה לאחרונה) מארחת את החתולים. בלשוניות האחרות רואים את הקערות והמיטות, בלי חתולים. עוברים ללשונית והחתולים פשוט שם; עוברים לחלון אחר שגם הוא על המסך והם רצים החוצה מחלון אחד ונכנסים לשני מהצד הקרוב. מדי פעם חתול סקרן יוצא מהמסך לבקר באחת הלשוניות האחרות, וחוזר מאותו צד אחרי דקה-שתיים, או שמחכה לכם שם כשתעברו אליה. אפשר לכבות זאת בחלון הקופץ.

### סטודיו החתולים

- **תמונות**: העלו 1–3 תמונות, בחרו איבר ולחצו על התמונה כדי לדגום את הצבע. כל סיכה זוכרת לאיזו תמונה היא שייכת, כך שאפשר לדגום עיניים מתמונה אחת ופרווה מאחרת. האפשרות "תיקון גוון התאורה לפי הפרווה הלבנה" מאזנת את הלבן של כל הדגימות. "ניתוח תמונה" מריץ K-Means מקומי ומציע פלטה שלמה.
- **פרווה וסימנים**: בחירת דוגמה, עריכת כל צבע בפלטה וכוונון הסימנים, כולל אי-הסימטריה של הלהבה, הפס הלבן על הגב וכתם הענבר. צבעים מתמונה לא מוחקים את הסימנים של החתול.
- **תבניות**: "הוספת חתול" יכולה להתחיל מאלכס או מאנה (עותק נפרד לבדיקה ולהתאמה).
- **מכחול**: ציור ישיר על מפת הטקסטורה של החתול.
- **אישיות**: שם, ביוגרפיה, מבנה גוף, מחווני אישיות ותכונות מיוחדות: תיאבון וצמא, שובבות, אהבה לליטופים, אוזניים אקספרסיביות, יוזמה לכרבולים, אהבה להשתרע, ועם מי החתול קשור.
- **גיליונות ספרייטים**: ייצוא לקובץ `.zip` (עם `pet.json`) או `.webp` בפורמט ChroMeow HD או OpenPets V1, וייבוא של ChroMeow HD,‏ OpenPets V1/V2 וגיליונות 9×8 ישנים.
- **ייצוא וייבוא חתולים**: "ייצוא החתול" או "ייצוא הכול" שומרים קובץ `.chromeow.json` עם כל פרטי החתול (פרווה, סימנים, גוף, אישיות, ציור, תמונות וספרייטים). "ייבוא חתולים" (או גרירת הקובץ לרשימה) מוסיף אותם למקומות פנויים.
- ברשימת החתולים יש לכל חתול מתג הפעלה וכפתור הסרה.

### פרטיות

- אין גישה לרשת: דפי התוסף מוגדרים עם `connect-src 'none'` והקוד לא שולח שום בקשה.
- אין אנליטיקה, טלמטריה, חשבונות או קוד מרוחק.
- התמונות מנותחות על קנבס בדפדפן ונשמרות רק כעותקים מוקטנים ב-`chrome.storage.local`.
- מיקומי החתולים, וגם איזו לשונית מארחת אותם, מסונכרנים בין לשוניות דרך ה-service worker של התוסף ו-`chrome.storage.session`, שנמחק כשהדפדפן נסגר.
- הרשאות: `storage`,‏ `unlimitedStorage` ו-`idle` (כדי לדעת מתי המחשב לא בשימוש או נעול; Chrome לא מציג עליה אזהרה).

### פיתוח

`npm run dev` לבנייה מתמשכת, `npm run build` לבניית גרסה, `npm run typecheck` לבדיקת טיפוסים ו-`npm test` להרצת הבדיקות. אחרי בנייה מחדש לחצו על כפתור הרענון של ChroMeow ב-`chrome://extensions` ורעננו את הלשוניות הפתוחות.

### קרדיטים

נוצר על ידי APK.

</div>
