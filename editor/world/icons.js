// The icon set. Everything the editor draws as a glyph is here, as inline
// SVG on one 24×24 grid with a 1.6px stroke and square-ish joins — a
// technical-drawing hand, not a UI-kit hand.
//
// Why this file exists at all: the shell used emoji for the 51 block
// thumbnails and for the tool rail. Emoji are a different typeface on every
// platform, they carry their own colour, they sit on their own baseline, and
// nothing else in the interface looks like them — so they read as
// placeholders no matter how good the surrounding work is. These are drawn
// to one spec, inherit currentColor, and sit on the same optical grid as
// the hairlines and tick marks around them.
//
// Blocks are keyed by their catalog LABEL, because a catalog item has no
// stable id until it is placed (fusion mints the uid). Anything unmapped
// falls back to a neutral solid, which is a legible answer rather than a
// tofu box.

// Every glyph below is a literal this file authored, which is the one thing
// `trust()` is for: it hands the markup gate a value it can pass through
// without escaping, so an icon prints as a drawing rather than as its own
// source. Nothing that came from a file, a field or a network response may
// ever be handed to it — see engine/trusted.js.
import { trust, setHTML } from "../../src/genesis/trusted.js";

const S = (body, extra = "") =>
  trust(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`);

/* ── interface icons ── */
export const UI = {
  // tools
  select: S(`<path d="M4 4h4M16 4h4M4 20h4M16 20h4M4 4v4M20 4v4M4 16v4M20 16v4"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>`),
  blocks: S(`<path d="M12 3 4 7.2v9.6L12 21l8-4.2V7.2Z"/><path d="M4 7.2 12 11.5l8-4.3M12 11.5V21"/>`),
  sculpt: S(`<path d="M2.5 18.5 9 9l4 5 2.5-3.2L21.5 18.5Z"/><path d="M14 5.5a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 0 0-4.4 0"/>`),
  grass: S(`<path d="M12 21V11M12 11c0-3.2-1.6-5.6-4.4-6.8C7.1 7.4 8.6 10 12 11ZM12 11c0-3.2 1.6-5.6 4.4-6.8C16.9 7.4 15.4 10 12 11Z"/><path d="M4 21h16"/>`),
  // A course finding its way downhill: one meandering line between banks.
  river: S(`<path d="M14.5 3c-4 2.2-2.5 5.2-5.6 7.1C6 11.8 5 13.8 6.2 16.2 7.6 19 11 19.6 10 21.5"/><path d="M19 6.5c-2.6 1.6-2 3.6-4 5.2-1.8 1.4-2.2 3-1.2 4.9.8 1.5 2.4 2.2 2 4.4"/>`),
  spawn: S(`<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>`),
  world: S(`<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.3 2.4 3.5 5.4 3.5 8.6s-1.2 6.2-3.5 8.6c-2.3-2.4-3.5-5.4-3.5-8.6S9.7 5.8 12 3.4Z"/>`),
  // A town plan seen from above: two streets, three blocks and a square. The
  // globe belongs to WORLD SETTINGS; this belongs to BUILDING one, and two
  // controls a centimetre apart may not share a glyph.
  worlds: S(`<path d="M3.5 9.4h17M3.5 14.6h17M9.4 3.5v17M14.6 3.5v17"/><path d="M3.5 5.1a1.6 1.6 0 0 1 1.6-1.6h13.8a1.6 1.6 0 0 1 1.6 1.6v13.8a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6Z"/><rect x="10.6" y="10.6" width="2.8" height="2.8" rx=".5" fill="currentColor" stroke="none"/>`),
  fire: S(`<path d="M12 21c3.6 0 6-2.4 6-5.6 0-4.2-4-5.6-3.2-10.4-2.6.9-4.6 3.3-4.6 6 0 1.4-.8 2-1.6 1.4-.7-.5-1-1.5-1-2.6C6.5 11.4 6 13.2 6 15.4 6 18.6 8.4 21 12 21Z"/>`),

  // camera modes
  orbit: S(`<circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-24 12 12)"/>`),
  walk: S(`<circle cx="13" cy="4.2" r="1.9"/><path d="M13 7.2 10 12l3 2.4.8 6.4M10 12 6.6 14M13 14.4 9.6 20.8"/>`),
  fly: S(`<path d="M2.5 13.4 21 4.2l-4.6 16.4-3.8-6.6-6.6-2.2Z"/><path d="m12.6 14 8.4-9.8"/>`),

  // history + chrome
  undo: S(`<path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v0A5.5 5.5 0 0 1 14.5 20H8"/><path d="m8 4.5-4 4.5 4 4.5"/>`),
  redo: S(`<path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H16"/><path d="m16 4.5 4 4.5-4 4.5"/>`),
  roll: S(`<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.8 4.4v4.4h-4.4"/>`),
  close: S(`<path d="m6 6 12 12M18 6 6 18"/>`),
  search: S(`<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.6 4.6"/>`),
  plus: S(`<path d="M12 5v14M5 12h14"/>`),
  play: S(`<path d="M7 4.6 20 12 7 19.4Z"/>`),
  export: S(`<path d="M12 3v11"/><path d="m7.6 9.6 4.4 4.4 4.4-4.4"/><path d="M4 16.5v2.2A2.3 2.3 0 0 0 6.3 21h11.4a2.3 2.3 0 0 0 2.3-2.3v-2.2"/>`),
  // The other half of the same tray: the world coming back out of a file.
  open: S(`<path d="M12 14V3"/><path d="m7.6 7.4 4.4-4.4 4.4 4.4"/><path d="M4 16.5v2.2A2.3 2.3 0 0 0 6.3 21h11.4a2.3 2.3 0 0 0 2.3-2.3v-2.2"/>`),
  // A chain link, for the world that is tied to a file on disk. The third
  // member of the file tray: Save takes a copy, Open reads one back, and this
  // is the one that holds the two together while the work carries on.
  keep: S(`<path d="M10.3 13.7a3.7 3.7 0 0 0 5.2 0l3-3a3.7 3.7 0 0 0-5.2-5.2l-1.2 1.2"/><path d="M13.7 10.3a3.7 3.7 0 0 0-5.2 0l-3 3a3.7 3.7 0 0 0 5.2 5.2l1.2-1.2"/>`),
  // Explore is a way OUT to somewhere else, so it is drawn as a door with a
  // path leading off — not as a compass, which would read as navigation
  // inside the world you are already in.
  explore: S(`<path d="M14 3.5h4.4a1.1 1.1 0 0 1 1.1 1.1v14.8a1.1 1.1 0 0 1-1.1 1.1H14"/><path d="M4 12h10"/><path d="m10.4 8.2 3.8 3.8-3.8 3.8"/>`),
  about: S(`<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.5"/><circle cx="12" cy="7.9" r="1.05" fill="currentColor" stroke="none"/>`),
  command: S(`<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9Zm0 0V15m0-8.5H15m0 0a2.5 2.5 0 1 1 2.5 2.5H15Zm0 0V15m0 0v2.5A2.5 2.5 0 1 0 17.5 15H15Zm0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9Z"/>`),

  // selection actions
  focus: S(`<circle cx="12" cy="12" r="3.4"/><path d="M3.5 8V4.6A1.1 1.1 0 0 1 4.6 3.5H8M16 3.5h3.4a1.1 1.1 0 0 1 1.1 1.1V8M20.5 16v3.4a1.1 1.1 0 0 1-1.1 1.1H16M8 20.5H4.6a1.1 1.1 0 0 1-1.1-1.1V16"/>`),
  rotate: S(`<path d="M20 12a8 8 0 1 1-3.1-6.3"/><path d="M20.6 4v4.6H16"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>`),
  copy: S(`<rect x="8.5" y="8.5" width="12" height="12" rx="1.8"/><path d="M15.5 5.2V4.9A1.4 1.4 0 0 0 14.1 3.5H4.9a1.4 1.4 0 0 0-1.4 1.4v9.2a1.4 1.4 0 0 0 1.4 1.4h.3"/>`),
  ground: S(`<path d="M12 3v11"/><path d="m7.6 9.6 4.4 4.4 4.4-4.4"/><path d="M4 20h16"/>`),
  smaller: S(`<path d="M6 12h12"/>`),
  bigger: S(`<path d="M12 6v12M6 12h12"/>`),
  style: S(`<path d="M12 3.5 4 8v8l8 4.5 8-4.5V8Z"/><path d="M12 3.5V20.5"/><path d="M12 12 4 8M12 12l8-4"/>`),
  trash: S(`<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.6 6.5 7.5 20a1.3 1.3 0 0 0 1.3 1.2h6.4a1.3 1.3 0 0 0 1.3-1.2l.9-13.5"/>`),

  // sculpt modes
  raise: S(`<path d="M4 19h16"/><path d="M12 15V5"/><path d="m7.6 9.4 4.4-4.4 4.4 4.4"/>`),
  lower: S(`<path d="M4 19h16"/><path d="M12 5v10"/><path d="m7.6 10.6 4.4 4.4 4.4-4.4"/>`),
  smooth: S(`<path d="M3 15c3.4 0 3.4-6 6.8-6s3.4 6 6.8 6 3.4-3 4.4-3"/>`),
  flatten: S(`<path d="M4 12h16"/><path d="M7 7.5h10M9 3.5h6"/><path d="M4 17h16"/>`),

  // weather
  clear: S(`<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5.2 5.2 7 7M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8"/>`),
  rain: S(`<path d="M7.3 15.4a4.1 4.1 0 0 1 .5-8.2 5.4 5.4 0 0 1 10.3 1.5 3.5 3.5 0 0 1-.7 6.7"/><path d="M9 18.4 8 21M13 18.4 12 21M17 18.4 16 21"/>`),
  snow: S(`<path d="M7.3 14.4a4.1 4.1 0 0 1 .5-8.2 5.4 5.4 0 0 1 10.3 1.5 3.5 3.5 0 0 1-.7 6.7"/><path d="M9 18.6h.01M13 20.4h.01M16.8 18.6h.01" stroke-width="2.4"/>`),

  /* ── the export manifest ──
     Seven marks for the seven things the exporter writes into a .worldpkg.
     They replaced seven painted plaques: those were beautiful and they were
     the only gold-framed objects in a graphite room, which is the one thing a
     single material language cannot have. Each of these is drawn on the same
     24-grid at the same stroke weight as every other glyph here. */
  mfTerrain:  S(`<path d="M2.5 19.5h19"/><path d="m3 16 5.4-7.6 3.4 4.4 2.6-3.4 6.6 6.6"/><path d="m8.4 8.4-2-2.6 2.6-2 2 2.6"/>`),
  mfWater:    S(`<path d="M12 3.2c3.4 4 5.2 6.8 5.2 9.2A5.2 5.2 0 0 1 12 17.6a5.2 5.2 0 0 1-5.2-5.2c0-2.4 1.8-5.2 5.2-9.2Z"/><path d="M2.6 20.4c1.6 0 1.6-1.4 3.2-1.4s1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 2.8 1.4"/>`),
  mfRoads:    S(`<path d="M8.6 21 6 3M15.4 21 18 3"/><path d="M12 4.6v2.8M12 10.6v2.8M12 16.6v2.8"/>`),
  mfTown:     S(`<path d="M3.5 20.5V11l4.6-3.4L12.7 11v9.5"/><path d="M12.7 20.5V8l4.4-3.2 3.4 2.6v13.1"/><path d="M2 20.5h20"/><path d="M6 20.5v-3.2h3.6v3.2"/>`),
  mfPlant:    S(`<path d="M12 21v-8"/><path d="M12 13c-.4-3.6-2.6-5.6-6.2-6 .4 3.6 2.6 5.6 6.2 6ZM12 11.6c.4-4 2.8-6.2 6.6-6.6-.4 4-2.8 6.2-6.6 6.6Z"/><path d="M6.5 21h11"/>`),
  mfRules:    S(`<path d="M12 2.8 3.6 6.4v6c0 4.6 3.4 7.8 8.4 8.8 5-1 8.4-4.2 8.4-8.8v-6Z"/><path d="M12 8.4v7M8.6 11.9h6.8"/>`),
  mfIds:      S(`<path d="M5.5 3.5h9L18.5 7.5v13h-13Z"/><path d="M14 3.5v4.2h4.4"/><path d="M8.4 12.4h7.2M8.4 15.6h7.2M8.4 18.4h4.2"/>`),

  drag: S(`<path d="M9 5.5h.01M15 5.5h.01M9 12h.01M15 12h.01M9 18.5h.01M15 18.5h.01" stroke-width="2.6"/>`),

  /* ── the object manager ──
     The register of what is in the world, and the verbs that apply to a row
     of it. Drawn on the same grid as the tools, because the manager is a
     tool and not a dialogue. */
  /* A framed plate: horizon, a sun over it, and a rule for the caption. The
     gallery is pictures of worlds, so the glyph is a picture of a world. */
  gallery: S(`<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="1.8"/><path d="M3.2 15.2 8.4 10l4.2 4 2.8-2.4 5.4 4.4"/><circle cx="15.8" cy="8.4" r="1.5"/>`),
  objects: S(`<path d="M4 6.5h3M4 12h3M4 17.5h3"/><path d="M10.5 6.5h9.5M10.5 12h9.5M10.5 17.5h9.5"/>`),
  star: S(`<path d="m12 4 2.42 4.9 5.41.79-3.92 3.82.93 5.39L12 16.35 7.16 18.9l.93-5.39-3.92-3.82 5.41-.79Z"/>`),
  eye: S(`<path d="M2.6 12S6.4 5.8 12 5.8 21.4 12 21.4 12 17.6 18.2 12 18.2 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="2.6"/>`),
  eyeOff: S(`<path d="M4.4 8.2C3.2 9.5 2.6 12 2.6 12s3.8 6.2 9.4 6.2c1.6 0 3-.5 4.2-1.2M9.2 6.2A8.6 8.6 0 0 1 12 5.8c5.6 0 9.4 6.2 9.4 6.2s-.9 1.5-2.5 3"/><path d="M10.2 10.2a2.6 2.6 0 0 0 3.6 3.6"/><path d="m3.8 3.8 16.4 16.4"/>`),
  lock: S(`<rect x="4.8" y="10.4" width="14.4" height="9.6" rx="1.8"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>`),
  unlock: S(`<rect x="4.8" y="10.4" width="14.4" height="9.6" rx="1.8"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.3-1.3"/>`),
  pin: S(`<path d="M12 21.2s6.2-6 6.2-10.4a6.2 6.2 0 1 0-12.4 0C5.8 15.2 12 21.2 12 21.2Z"/><circle cx="12" cy="10.6" r="2.3"/>`),
  prev: S(`<path d="m14.4 5.4-6.6 6.6 6.6 6.6"/><path d="M19.6 4.6v14.8"/>`),
  next: S(`<path d="m9.6 5.4 6.6 6.6-6.6 6.6"/><path d="M4.4 4.6v14.8"/>`),
  frameAll: S(`<path d="M3.5 8V4.6A1.1 1.1 0 0 1 4.6 3.5H8M16 3.5h3.4a1.1 1.1 0 0 1 1.1 1.1V8M20.5 16v3.4a1.1 1.1 0 0 1-1.1 1.1H16M8 20.5H4.6a1.1 1.1 0 0 1-1.1-1.1V16"/><circle cx="8.6" cy="9.4" r="1.5"/><circle cx="15.2" cy="14.4" r="1.9"/>`),
  newest: S(`<path d="M12 3.4v10.2"/><path d="m7.8 9.4 4.2 4.2 4.2-4.2"/><circle cx="12" cy="18.6" r="2"/>`),
  back: S(`<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M3.4 3.6V9h5.4"/>`),
  vary: S(`<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.6"/><circle cx="8.6" cy="8.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="8.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="8.6" cy="15.4" r="1.1" fill="currentColor" stroke="none"/>`),
  sound: S(`<path d="M4.6 9.4h3.2L12 5.6v12.8l-4.2-3.8H4.6Z"/><path d="M15.4 9.6a3.4 3.4 0 0 1 0 4.8M18 7a7 7 0 0 1 0 10"/>`),
  soundOff: S(`<path d="M4.6 9.4h3.2L12 5.6v12.8l-4.2-3.8H4.6Z"/><path d="m15.6 9.8 4.8 4.4M20.4 9.8l-4.8 4.4"/>`),
};

/* ── block thumbnails, keyed by catalog label ──
   Grouped by what they ARE, so the dock scans as a kit of parts: openings
   read as openings, vegetation reads as vegetation, and the multi-storey
   family shares one silhouette that simply gets taller. */
const B = {
  /* builder — the primitive kit */
  "Floor":        `<path d="M3 12 12 7.4 21 12 12 16.6Z"/><path d="M3 12v2.2L12 19l9-4.8V12"/>`,
  "Wall":         `<path d="M4.5 6.5h15v11h-15Z"/><path d="M4.5 12h15M9.5 6.5v5.5M14.5 12v5.5"/>`,
  "Doorway":      `<path d="M4.5 20.5V6a1.5 1.5 0 0 1 1.5-1.5h12A1.5 1.5 0 0 1 19.5 6v14.5"/><path d="M9 20.5v-8.2a3 3 0 0 1 6 0v8.2"/>`,
  "Door":         `<path d="M5.5 3.5h13v17h-13Z"/><path d="M8.4 3.5v17"/><circle cx="15.4" cy="12" r="1" fill="currentColor" stroke="none"/>`,
  "Ramp":         `<path d="M3.5 19.5h17L3.5 8.5Z"/>`,
  "Stairs":       `<path d="M3.5 20.5v-4h4.2v-4h4.2v-4h4.2v-4h4.4"/><path d="M3.5 20.5h17"/>`,
  "Pillar":       `<path d="M9 6.5h6v11H9Z"/><path d="M7.4 3.6h9.2v2.9H7.4ZM7.4 17.5h9.2v2.9H7.4Z"/>`,
  "Crate":        `<path d="M4.5 7.4 12 4l7.5 3.4v9.2L12 20l-7.5-3.4Z"/><path d="M4.5 7.4 12 10.8l7.5-3.4M12 10.8V20"/>`,
  "Barrier":      `<path d="M3.5 8.5h17v6h-17Z"/><path d="m6.5 14.5 4-6M12 14.5l4-6"/><path d="M5.5 14.5v5M18.5 14.5v5"/>`,
  "Platform":     `<path d="M3 10 12 5.6 21 10 12 14.4Z"/><path d="M6 12.4v6M18 12.4v6"/>`,
  "Scaffold":     `<path d="M5 3.5v17M19 3.5v17"/><path d="M5 8h14M5 13h14M5 18h14"/><path d="m5 8 14 5M19 8 5 13"/>`,
  "Fence":        `<path d="M6 20V7l2.6-2.4V20M15.4 20V7L18 4.6V20"/><path d="M3.5 10.5h17M3.5 15h17"/>`,
  "Gate":         `<path d="M3.5 20.5V8.5l8.5-5 8.5 5v12"/><path d="M8 20.5v-7h8v7"/>`,
  "Arch":         `<path d="M4 20.5V12a8 8 0 0 1 16 0v8.5"/><path d="M8.5 20.5V12a3.5 3.5 0 0 1 7 0v8.5"/>`,
  "Bridge":       `<path d="M2 15.5h20"/><path d="M2 15.5c4.5 0 6-7 10-7s5.5 7 10 7"/><path d="M7 15.5v4M12 8.5v11M17 15.5v4"/>`,
  "Tunnel":       `<path d="M3.5 20.5V13a8.5 8.5 0 0 1 17 0v7.5"/><path d="M9 20.5V13a3 3 0 0 1 6 0v7.5"/><path d="M2 20.5h20"/>`,
  "Bullet Wall":  `<path d="M3.5 6.5h17v11h-17Z"/><path d="M3.5 11h17M3.5 15.5h17M8 6.5v4.5M15 11v4.5M11 15.5v2"/>`,

  /* street furniture */
  "Road":         `<path d="M5.5 3.5 3 20.5M18.5 3.5 21 20.5"/><path d="M12 4.5v3.2M12 10.4v3.2M12 16.3v3.2" stroke-dasharray="0"/>`,
  "Road (plain)": `<path d="M5.5 3.5 3 20.5M18.5 3.5 21 20.5"/>`,
  "Crossing":     `<path d="M4 4.5 2.5 19.5M20 4.5l1.5 15"/><path d="M4.4 8.5h15.2M4 12h16M3.6 15.5h16.8"/>`,
  "Junction":     `<path d="M9 2.5v19M15 2.5v19"/><path d="M2.5 9h19M2.5 15h19"/>`,
  "Plaza":        `<path d="M3 12 12 6.5 21 12 12 17.5Z"/><path d="M7.5 12 12 9.3l4.5 2.7L12 14.7Z"/>`,
  "Lamp":         `<path d="M12 21V9"/><path d="M8.6 9h6.8l-1.6-3.4H10.2Z"/><path d="M8.5 21h7"/><path d="M9.8 5.6 12 3l2.2 2.6"/>`,
  "Campfire":     `<path d="M12 15.5c1.9 0 3.2-1.3 3.2-3 0-2.3-2.2-3-1.8-5.6-1.4.5-2.5 1.8-2.5 3.3 0 .8-.4 1.1-.9.8-.4-.3-.5-.8-.5-1.4-.9 1-1.2 2-1.2 3.2 0 1.7 1.3 2.7 3.7 2.7Z"/><path d="m4.5 20.5 15-3.4M4.5 17.1l15 3.4"/>`,
  "Stall":        `<path d="M3.5 9.5h17v11h-17Z"/><path d="M2.5 9.5 5 4.5h14l2.5 5"/><path d="M3.5 9.5c1.4 1.6 3.1 1.6 4.5 0 1.4 1.6 3.1 1.6 4.5 0 1.4 1.6 3.1 1.6 4.5 0 1.4 1.6 3.1 1.6 3.5 0"/>`,
  "Well":         `<path d="M6 11.5h12v9H6Z"/><path d="M6 11.5 12 8l6 3.5"/><path d="M12 3.5v4.5M8.5 3.5h7"/>`,
  "Barrel":       `<ellipse cx="12" cy="5.6" rx="5.2" ry="2.1"/><path d="M6.8 5.6v12.8M17.2 5.6v12.8"/><ellipse cx="12" cy="18.4" rx="5.2" ry="2.1"/><path d="M6.5 11.5h11"/>`,
  "Container":    `<path d="M3 7.5h18v9H3Z"/><path d="M6.4 7.5v9M9.8 7.5v9M13.2 7.5v9M16.6 7.5v9"/>`,
  "Chair":        `<path d="M7.5 12.5V4.5h9v8"/><path d="M6 12.5h12v3H6Z"/><path d="M7.5 15.5v4.5M16.5 15.5v4.5"/>`,

  /* the multi-storey family — one silhouette, more floors */
  "House":        `<path d="M4 10.6 12 4l8 6.6v9.9H4Z"/><path d="M9.8 20.5v-5.6h4.4v5.6"/>`,
  "Row House":    `<path d="M2.5 11 7 7l4.5 4v9.5h-9Z"/><path d="M12.5 11 17 7l4.5 4v9.5h-9Z"/><path d="M5.6 20.5v-4h2.8v4M15.6 20.5v-4h2.8v4"/>`,
  "Row Shop":     `<path d="M2.5 11 7 7l4.5 4v9.5h-9Z"/><path d="M12.5 11 17 7l4.5 4v9.5h-9Z"/><path d="M2.5 14h9M12.5 14h9"/>`,
  "Guardhouse":   `<path d="M5.5 10 12 5.5 18.5 10v10.5h-13Z"/><path d="M10 20.5v-4.6h4v4.6"/><path d="M8 12.4h2.2M13.8 12.4H16"/>`,
  "Block · 3":    `<path d="M5.5 20.5V6.5h13v14Z"/><path d="M8.6 9.6h2.2M13.2 9.6h2.2M8.6 13.4h2.2M13.2 13.4h2.2"/><path d="M10.6 20.5v-3.2h2.8v3.2"/>`,
  "Block · 6":    `<path d="M5.5 20.5V3.5h13v17Z"/><path d="M8.6 6.6h2.2M13.2 6.6h2.2M8.6 10.2h2.2M13.2 10.2h2.2M8.6 13.8h2.2M13.2 13.8h2.2"/><path d="M10.6 20.5v-3.2h2.8v3.2"/>`,
  "Stack · 3":    `<path d="M6.5 20.5V12h11v8.5Z"/><path d="M8.5 12V7h7v5"/><path d="M10.4 7V3.2h3.2V7"/>`,
  "Tower":        `<path d="M8.5 20.5V7.5h7v13Z"/><path d="M12 7.5V3.2"/><path d="M10.2 5.4h3.6"/><path d="M10.6 11h2.8M10.6 14.6h2.8"/>`,
  "Tower · 12":   `<path d="M7.5 20.5V4.5h9v16Z"/><path d="M9.6 7.4h1.6M12.8 7.4h1.6M9.6 10.6h1.6M12.8 10.6h1.6M9.6 13.8h1.6M12.8 13.8h1.6M9.6 17h1.6M12.8 17h1.6"/><path d="M12 4.5V2"/>`,
  "Watchtower":   `<path d="M9 20.5 10 9h4l1 11.5Z"/><path d="M7.5 9h9l-1.4-3.4H8.9Z"/><path d="M12 5.6V2.8"/><path d="M9.6 12.6h4.8"/>`,
  "Spire · 4":    `<path d="M8 20.5V9h8v11.5Z"/><path d="M12 9 12 2.5"/><path d="m8 9 4-4.6L16 9"/><path d="M10.2 13h3.6M10.2 16.4h3.6"/>`,
  "Civic":        `<path d="M3 9.5 12 4l9 5.5"/><path d="M5.4 9.5v9M9.4 9.5v9M14.6 9.5v9M18.6 9.5v9"/><path d="M3 18.5h18M3.6 21h16.8"/>`,
  "Garage":       `<path d="M3.5 11 12 5.5 20.5 11v9.5h-17Z"/><path d="M7 20.5v-6h10v6"/><path d="M7 17.2h10"/>`,
  "Lab":          `<path d="M10 3.5v5.8L5.4 18a2 2 0 0 0 1.8 3h9.6a2 2 0 0 0 1.8-3L14 9.3V3.5"/><path d="M8.6 3.5h6.8"/><path d="M7.6 14.6h8.8"/>`,
  "Security":     `<path d="M12 3.2 4.6 6.2v5.6c0 4.4 3 7.6 7.4 9 4.4-1.4 7.4-4.6 7.4-9V6.2Z"/><path d="m9 12 2.2 2.2L15 10.4"/>`,
  "Crimson Bldg": `<path d="M5.5 20.5V5.5h13v15Z"/><path d="M5.5 9.6h13M5.5 13.6h13M5.5 17.2h13"/><path d="M12 5.5v15"/>`,
  "Violet Bldg":  `<path d="M4.5 20.5V8.5l7.5-4.5 7.5 4.5v12Z"/><path d="M8.4 20.5v-7h7.2v7"/><path d="M8.4 17h7.2"/>`,

  /* nature */
  "Tree":         `<path d="M12 21v-5.4"/><path d="M12 3.2a5.6 5.6 0 0 0-3.9 9.6A4.6 4.6 0 0 0 12 16.2a4.6 4.6 0 0 0 3.9-3.4A5.6 5.6 0 0 0 12 3.2Z"/>`,
  "Sapling":      `<path d="M12 21v-7.4"/><path d="M12 14c-.3-2.6-1.9-4-4.4-4.2.3 2.6 1.9 4 4.4 4.2ZM12 13c.3-2.9 1.9-4.4 4.6-4.6-.3 2.9-1.9 4.4-4.6 4.6Z"/>`,
  "Pine":         `<path d="M12 21v-3.6"/><path d="M12 2.5 7.4 9.4h9.2Z"/><path d="M12 7 6 15.2h12Z"/><path d="M5.5 17.4h13"/>`,
  "Hedge":        `<path d="M3.5 17.5v-4a3 3 0 0 1 2.6-3 3.4 3.4 0 0 1 6.4-1.2 3.2 3.2 0 0 1 5.1 1.4 3 3 0 0 1 2.9 3v3.8Z"/><path d="M3.5 20.5h17"/>`,
  "Palm":         `<path d="M12 21c0-5.4.6-9 1.8-10.8"/><path d="M13.8 10.2c-2.4-1.5-5-1.4-7.8.3 2.6 1.6 5.2 1.5 7.8-.3ZM13.8 10.2c1-2.6 3-4.2 6.2-4.8-.8 3-2.8 4.6-6.2 4.8ZM13.8 10.2C13 7.4 13.6 5 15.6 3c1 3 .4 5.4-1.8 7.2Z"/>`,

  /* the world scale — landmarks, enclosures and the ways that are not streets */
  "Spired Castle": `<path d="M4 20.5V9l2-4 2 4v11M16 20.5V9l2-4 2 4v11"/><path d="M9 20.5V7.5l3-5 3 5v13"/><path d="M2.5 20.5h19"/><path d="M10.6 20.5v-4.2h2.8v4.2"/>`,
  "Round Castle":  `<path d="M3.5 20.5v-8l2.4-3.4L8.3 12.5v8"/><path d="M15.7 20.5v-8l2.4-3.4 2.4 3.4v8"/><path d="M8.3 20.5V9.5l3.7-4.8 3.7 4.8v11"/><path d="M2.5 20.5h19"/>`,
  "Citadel":       `<path d="M3.5 20.5V10h3.2V7l2.4 3h5.8l2.4-3v3h3.2v10.5Z"/><path d="M9.6 20.5v-5h4.8v5"/><path d="M2 20.5h20"/><path d="M12 10V4.5"/>`,
  "Rampart":       `<path d="M3 20.5v-9h2.6V9h2.6v2.5h2.6V9h2.6v2.5h2.6V9h2.6v2.5H21v9Z"/><path d="M2 20.5h20"/>`,
  "Ruined Wall":   `<path d="M3 20.5v-6h2.4V12h2.4v3.4h2v-6.2h2.4V15"/><path d="M17 20.5v-4.2h2.6"/><path d="M2 20.5h20"/>`,
  "Dirt Lane":     `<path d="M6.5 21c1.5-6 1.5-12 0-18M17.5 21c-1.5-6-1.5-12 0-18"/><path d="M12 6.5v2M12 11v2M12 15.5v2" stroke-dasharray="0"/>`,
  "Old Road":      `<path d="M6 21c2-6 2-12 0-18M18 21c-2-6-2-12 0-18"/><path d="M8.6 8.5h6.8M8.2 13h7.6M8.6 17.5h6.8"/>`,
  "Avenue":        `<path d="M4 21V3M20 21V3"/><path d="M12 4v3.4M12 10.3v3.4M12 16.6V20"/><path d="M7.4 21V3M16.6 21V3"/>`,
  "Jetty":         `<path d="M3 9.5h18v2.4H3Z"/><path d="M6 11.9V19M18 11.9V19M12 11.9V19"/><path d="M2 21c1.6 0 1.6-1.2 3.2-1.2S6.8 21 8.4 21s1.6-1.2 3.2-1.2S13.2 21 14.8 21s1.6-1.2 3.2-1.2S19.6 21 21.2 21"/>`,
  "Crops":         `<path d="M3 18.5h18"/><path d="M6 18.5V9M10 18.5V9M14 18.5V9M18 18.5V9"/><path d="M6 9c-1.4-1-2-2.2-1.8-3.6 1.4.2 2.4 1.2 2.8 2.8M10 9c-1.4-1-2-2.2-1.8-3.6 1.4.2 2.4 1.2 2.8 2.8M14 9c-1.4-1-2-2.2-1.8-3.6 1.4.2 2.4 1.2 2.8 2.8M18 9c-1.4-1-2-2.2-1.8-3.6 1.4.2 2.4 1.2 2.8 2.8"/>`,
  "Fountain":      `<path d="M4.5 20.5h15"/><path d="M6 20.5v-4.2h12v4.2Z"/><path d="M12 16.3V9"/><path d="M12 9c-2 0-3.4-1.4-3.4-3.4M12 9c2 0 3.4-1.4 3.4-3.4"/><circle cx="12" cy="4.4" r="1.2"/>`,
  "Cottage":       `<path d="M4 11 12 4.6l8 6.4v9.5H4Z"/><path d="M9.8 20.5v-5h4.4v5"/>`,
  "Slate Cottage": `<path d="M4 11 12 4.6l8 6.4v9.5H4Z"/><path d="M9.8 20.5v-5h4.4v5"/><path d="M5.6 12.6h12.8M4.8 9.4l14.4 0"/>`,
  "Villa":         `<path d="M4.5 10.6 12 4.5l7.5 6.1v9.9h-15Z"/><path d="M9.6 20.5v-5.2h4.8v5.2"/><path d="M7.4 12.4h2.2M14.4 12.4h2.2"/>`,
  "Hall":          `<path d="M2.5 11 12 4l9.5 7v9.5h-19Z"/><path d="M9.4 20.5v-6h5.2v6"/><path d="M5.4 12.8h2.4M16.2 12.8h2.4"/>`,
  "Lodge":         `<path d="M5 12.4 12 6.8l7 5.6v8.1H5Z"/><path d="M10.4 20.5v-4.2h3.2v4.2"/>`,
};

const FALLBACK = `<path d="M4.5 7.4 12 4l7.5 3.4v9.2L12 20l-7.5-3.4Z"/><path d="m4.5 7.4 7.5 3.4 7.5-3.4M12 10.8V20"/>`;

/* A block thumbnail for a catalog label.

   OWN PROPERTIES ONLY, because `label` is not this file's to trust and this
   is the one function here that lets an outside string decide what `trust()`
   is handed. A placement's label is the filename of a dropped GLB or a name
   out of a world file, and `B["toString"]` reaches Object.prototype rather
   than this table — a truthy function, which the template then stringifies
   into the icon's place. The visible result was a blank cell where the
   fallback crate belonged; the reason to fix it at the lookup is that the
   codebase's single audited markup hole should not be steerable by a
   caller-chosen key at all. See engine/trusted.js. */
export function blockIcon(label) {
  return S(Object.hasOwn(B, label) ? B[label] : FALLBACK);
}

// Replace an element's contents with an icon, keeping any text node label.
export function setIcon(el, name) {
  if (!el || !UI[name]) return;
  const slot = el.querySelector("[data-icon]") || el;
  setHTML(slot, UI[name]);
}
