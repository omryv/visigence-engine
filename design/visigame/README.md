Visigame is where people make games by choosing, not coding: pick a world, set a seed, connect a few steps, play it in seconds. The interface is a camera looking into those worlds. Everything that surrounds the world — panels, cards, type — behaves like a film set around a lit subject: dark, quiet and exact, so the 3D work is the only thing in colour.

## Principles

- **The world is the subject.** Chrome stays graphite and bone; renders carry the colour. Never tint a panel to match the art.
- **One light on set.** `tungsten` is the only brand colour and it means *do this*: one primary action per view.
- **Focus, not decoration.** What matters is sharp; what doesn't is blurred (`depth-*`), never faded to grey or hidden behind a dark overlay.
- **Camera grammar over UI clichés.** Selection is a viewfinder, focus is peaking, live is a tally light, a warning is zebra stripes, facts are lens metadata.

## Voice and copy

- Write like a director on set: short, verb first, present tense. "Generate & play", "Start mission", "Choose a world", "Beat this".
- Sentence case for every label, button and title. Capitals only come from the `meta` style (mono metadata, eyebrows, HUD labels) — type them in sentence case and let the style set them.
- Speak to the player as *you*; the platform never says *I* or *we* in the UI. "Your choices. Your game." — not "We'll build your game!"
- No exclamation marks, no emoji, no "magic", "AI-powered" or "effortless". Promise what happens: "Play it in seconds", "Download a standalone game".
- Numbers are facts and go in mono: `Seed 4471`, `3 / 5`, `~6 min`, `30 / 120`.
- Mission briefs are two short sentences in the imperative: "Activate the control stations. Survive the sentinels."

## Colour

- Build every screen from `surface-100` (page), `surface-200` (raised: cards, nodes, dialogs) and `surface-300` (wells: inputs, tracks, hover). `surface-000` is the cyclorama behind the viewport and the landing hero only.
- Set text in `ink`, secondary text and metadata in `ink-muted`. Both pass 4.5:1 on all three surfaces in Stage and Daylight.
- Use `line` for hairline dividers and `line-strong` for anything you click (inputs, secondary buttons, card and port edges).
- `tungsten` is a fill: the primary button, the output port, the active-tab underline, the cover. Its text is always `on-tungsten`. When tungsten has to be a word, use `tungsten-ink`.
- `peaking` is the focus ring, the viewfinder brackets on the selected thing, flow ports and wires. Tungsten and peaking are warm and cold on purpose: they must never be confused.
- Signals: `tally` (live, damage, destroy), `zebra` (warning), `success` (done), `info` (= peaking). Each one comes with a word or an icon. Success is teal, off the red–green axis, so it is never told from tally by hue alone. Text on a solid signal fill is `on-signal`.
- Stage (dark) is the default theme and the one the landing page, launcher, studio and HUD are designed in. Daylight is for docs, long editing sessions and print; the brand is identical in both.

## Type

- Three families, each with one job. `display` (Bricolage Grotesque, optical sizes) is for names and titles. `sans` (Instrument Sans) is for everything you read or press. `mono` (Martian Mono) is for facts: metadata, seeds, logs, HUD numbers.
- `title-card` appears once, on the landing hero, like the title card of a film. Screens use `display`; landing sections use `headline`; panels, dialogs and world names use `title`.
- UI copy is `body` (15/22); marketing paragraphs are `body-lg`. Button and tab labels are `button`.
- `meta` is always uppercase with its tracking; `hud` is for in-game counters only.
- Display sizes get tight tracking (it is in the style); never track body copy.

## Space, shape, line

- Spacing runs on 4px: `space-1` to `space-9`. Pad cards and nodes by `space-4`, panels by `space-5`; gaps between cards are `space-5`; page gutters `space-7`; landing sections `space-8`.
- `radius-md` (8px) for buttons, cards, nodes and dialogs; `radius-sm` for inputs, chips and kbd hints; `radius-pill` for meters, tallies and round icon buttons. Anything that *is* the world — viewports, key art, the hero — is `radius-0`: the lens has square corners.
- Lines are `stroke-hair` (1px) for edges and `stroke-focus` (2px) for focus rings, viewfinder brackets, the active tab and graph wires.

## Depth, shadow, motion

- Depth is depth of field. Behind a dialog: `scrim` plus a `backdrop-filter: blur(var(--depth-far))`. Behind a popover or docked sheet: `depth-mid`. Siblings of a selected card: `depth-near`. Never dim to black.
- Shadows are small: `shadow-edge` is a rim light on the top edge of raised things; `shadow-float` lifts dialogs and toasts; `shadow-practical` is the tungsten glow on a hovered primary button — nothing else glows.
- Motion is a rack focus: 420ms on `cubic-bezier(.2,.7,.1,1)` for blur, brackets, and state changes; 180ms linear for colour on hover. Nothing bounces. Under `prefers-reduced-motion`, blur and brackets change instantly and the tally stops pulsing.

## Camera grammar

- **Viewfinder** — four `peaking` corner brackets just outside the selected item (`Viewfinder`, used by `WorldCard` and `Node`). Tungsten brackets mark the one featured item on the landing page or launcher.
- **Focus peaking** — the focus ring is 2px solid `peaking`, 2px offset, on every interactive element, in both themes (3:1 or more on every surface).
- **Tally** — a dot and a word (`Tally`): live, ready, warn, idle. Only one live tally per screen.
- **Zebra** — 45° stripes in `zebra` (`.vg-zebra`, the zebra `Meter`) mark over-budget or unsafe states, always with a word.
- **Lens metadata** — `Meta`: a row of short mono facts. It sits above titles as an eyebrow ("Arcade · Sector 01 · Seed 4471") and under world names.

## Imagery

- Show real renders of the worlds — from the engine or from Blender — never illustrations, stock photos, 3D clip art or gradients standing in for art.
- Frame like a cinematographer: a single subject in the middle third, shallow depth of field, a dark cyclorama (`surface-000`) behind, one warm key light. Foreground and background elements are allowed only out of focus.
- Crop key art 16:10 in cards and 21:9 or wider for heroes. Don't round the corners of full-bleed art.
- Don't put text on art except the hero title, and then only over the out-of-focus part of the frame.

## Iconography

- Use the studio's own line icons (`Icon`, the Icons group): 24px grid, `stroke-icon` 1.5, round caps and joins, outline only, drawn in `currentColor`. The asset files are drawn in a neutral `#8d9096` for preview; in the product, inline them so they inherit `ink`, `ink-muted` or a signal colour.
- An icon beside a label is 18px; alone in a square button, 20px with an `aria-label`; in node headers, 16px.
- No emoji anywhere in the product, and no filled or duotone icon styles.

## Layout

- Desktop studio: a 176px navigation rail, a 66px toolbar, a 28px mono status bar; the rest is panels on `surface-100` with `space-5` gutters. Mobile launcher: one column, cards full-width, the primary button fixed to the bottom safe area.
- Everything aligns to a 4px grid; panel edges are `line`, never shadows.
- The landing page is a set, not a brochure: a full-bleed hero on `surface-000` where the world itself is the navigation (a live diorama with the templates orbiting it, the bee asking for your vision), the studio's own screens turning as a deck, then short sections on `surface-100` separated by `space-8`.
