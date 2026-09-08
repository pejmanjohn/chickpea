# Chickpea — brand & UI guidelines

Living visual guidance for the Chickpea `/admin` UI. One friendly chickpea
speaks for a team of many agents. Warm hummus creams, chickpea gold, sprout
green, chunky rounded "clay" surfaces, and buttons that physically press. The
shipped admin page and canonical assets are the implementation reference; this
guide records the design rules that should remain consistent as the UI evolves.

## Name & logo

- Product name: **Chickpea** (capitalized in UI copy); the default install-wide
  Slack bot display name is **@Chickpea**.
- Mark: one chunky, smiling gold Chickpea with a broad, softly flattened body,
  a gentle asymmetrical bump, two cocoa eyes, and a small curved smile. Its
  surface is matte felt / fine flocking with soft diffuse shading—never smooth,
  shiny, plastic, or glossy. Canonical source:
  [`assets/chickpea-mark.png`](../../assets/chickpea-mark.png).
- Product surfaces use that same standalone character without a doorway,
  background tile, floor, or cast shadow. The 128px web asset and 32px favicon
  are size-optimized derivatives of the canonical mark and are embedded from
  `src/brand/chickpea-mark.generated.ts`.
- Wordmark: custom medium-bold rounded lettering with open counters and a
  subtle smile-shaped lift on the open terminals and final `a`. The canonical
  design master is the transparent monochrome alpha mask
  [`assets/chickpea-wordmark-mask.png`](../../assets/chickpea-wordmark-mask.png).
  `npm run brand:build` creates the size-optimized 512px runtime derivative
  `assets/chickpea-wordmark-512.png` and embeds it in the shared brand module.
  Product UI renders the mask with `currentColor`: cocoa `#3B3220` on light
  surfaces and white on dark or photographic surfaces. Do not redraw it with a
  nearby font or maintain separate cocoa and white artwork.
- Use the full mark-and-wordmark lockup in Admin navigation, onboarding, and
  authentication/setup headers. Keep the standalone mark for the favicon,
  Slack avatars, square icons, and any compact state where the wordmark would
  render below 18px tall.
- Never add the sprout leaf back; never put faces on more than one pea in a
  lockup. Secondary peas (marketing/illustration) are faceless.
- Minimum sizes: the full mark is preferred at ≥ 20px. The approved 32px
  favicon derivative is the smallest product rendering; do not redraw it.
- Slack avatars are one soft-clay family: a large matte Chickpea sits inside a
  warm, moonless architectural portal. The square background runs to
  every edge so Slack owns the corner treatment. The install-wide bot keeps
  the canonical gold Chickpea ([`assets/bot-avatar.png`](../../assets/bot-avatar.png)).
  New Agents cycle through twelve approved body colors, subtle shape changes,
  and restrained expressions in
  [`assets/chickpea-avatars/agent-defaults`](../../assets/chickpea-avatars/agent-defaults).
  Gold is reserved for the install-wide identity. Keep the character large
  enough to read at 40px, avoid glossy materials, eyebrows, half-smiles, and
  symmetrical two-lobed silhouettes.

## Color

Surfaces
- Canvas (page bg):       `#F4EBD8` (tan)
- Card (rail, main, popovers): `#FFFDF6` (cream) + shadow `0 2px 0 rgba(59,50,32,0.08)`
- Well (inset panels on cards): `#F8F1DF` (clay) — no border/ring
- Divider on clay wells: `1.5px solid #FFFDF6`; on cards: `1.5px dashed rgba(59,50,32,0.15)`

Ink
- Heading `#3B3220` · body `#6B5C42` · faint `#9F8F72`

Accent — chickpea gold
- Primary `#DDA033` · hover `#E5AC44` · press-shadow `#B27E1F`
- Text-on-gold `#3A2A08` · gold text on cream `#8A6410` · tint `rgba(221,160,51,0.18)`

Status
- Green (solid, badges/toggles): `#6FA25B`, shadow `rgba(78,122,62,0.6)`, text `#FFFDF6`
- Green text: `#4E7A3E`
- Danger text `#B5473A` · danger well `#FBE3DC` · danger deep `#8F3428`

Logo color is baked into the raster asset. Do not recolor it with CSS filters
or introduce gradients on top of the felt texture.

## Type

- Display / headings / brand: **Baloo 2** 700 (page titles, section titles,
  provider names, step numbers, modal titles)
- UI / body: **Quicksand** — 500 body, 600 emphasis, 700 labels & buttons
- Code / models / IDs: **JetBrains Mono** 400–500
- Load: Google Fonts (`Baloo 2`, `Quicksand`, `JetBrains Mono`) — the live admin
  stylesheet `@import`s them.

## Shape & depth

- Radius scale: chips 8 · options 10 · buttons 12 · inputs 13 · rows/wells 14–16 ·
  provider cards 18 · main cards 20 · page container 24 · badges/pills 999
- Depth is playful, not glassy:
  - Cards float with a hard 2px under-shadow (`0 2px 0`), not blur.
  - Buttons are **pressable**: resting `0 2px 0 <darker>`, `:active` translates
    down ~2px and flattens the shadow. Primary gold uses `#B27E1F` under.
  - Inputs are debossed: `inset 0 2px 3px` + 1.5px inset ring.
  - Popovers (dropdowns) get the one soft shadow: `0 10px 26px -10px rgba(59,50,32,0.4)`.

## Component notes

- **Topbar**: transparent on tan; no border. Active nav = solid cocoa `#3B3220`
  pill with cream text. Idle nav = cream pressable button.
- **Badges**: connected/on = solid green pill with cream text; off/missing =
  translucent cocoa pill.
- **Toggles**: track green when on, cream thumb, inset track shadow, 46px wide.
- **Checkboxes**: 18px, radius 6, gold fill with cocoa check + press shadow.
- **Steppers**: 28px circles — done solid green w/ check, active gold, idle faint.
- **Callouts / warnings**: gold tint `rgba(221,160,51,0.16)`, radius 14,
  gold-deep icon. Warnings stay gold; only destructive things go red.
- **Danger**: soft red well `#FBE3DC`. The destructive *primary* inside it
  (Delete profile) is solid deep red `#B5473A` with cream text `#FFF6F3` and a
  `#8F3428` press-shadow — it must contrast with its tinted container.
  Secondary destructive actions on neutral surfaces (Detach, Remove) stay
  soft-red pressable. Never solid-red full-bleed panels; playful brands fail
  loud — keep errors soft but explicit, and show raw provider errors in the
  mono `.raw-error` block.
- **Model/starred rows**: cream pill-rows (radius 13, hard 1px under-shadow) on
  clay, separated by 6px gaps instead of hairlines. Stars: `#D9962C` when on.
- **Tabs (`.ptabs` + panel)**: one "ringed tray" — cream container outlined by
  a 1.5px ring, dashed seam under the tab bar, panel flush below. Active tab is
  a solid cocoa pill (shares the topbar active-nav idiom); inactive tabs hover
  clay. Rows inside the panel are clay, like everywhere else. Counts in mono;
  the attention dot is gold with a tint halo. Tabs are never gold-filled.
- **Segmented control (`.seg`)**: cream field with inset ring; the selected
  segment is solid gold (this is the one gold-fill selection idiom).
- **Connection status pills**: tinted (green/cocoa/red-well) and smaller than
  badges — solid green stays reserved for top-level connected state.
- **Focus**: 2px `#B27E1F` outline, 2px offset — everywhere.

## Voice

Friendly but competent; playfulness lives in the visuals, not exclamation
marks. Keep existing copy. No emoji in UI chrome.

## Don'ts

- No pure white `#FFFFFF` or pure black; everything warms toward cream/cocoa.
- No blur-heavy glassmorphism, no gradients on buttons (that was branch 1c).
- No new hues beyond gold / green / soft red; neutrals come from cocoa alpha.
- Don't mix radius sizes within one component class.
