/**
 * The builder's line icons, in the studio's style: a 24 px grid, 1.5 stroke, round caps and
 * joins, outline only, drawn in currentColor so they take ink, muted ink or a signal colour.
 * `icon(name)` returns the SVG markup; decorative by default (aria-hidden).
 */
const P = {
  select: '<path d="M5 3.5 18.5 11l-6 1.6L9.8 19Z"/><path d="m12.6 12.7 5 5"/>',
  brush: '<path d="M14.5 4.5 19.5 9.5 11 18l-5 1 1-5Z"/><path d="m13 6 5 5"/>',
  rect: '<rect x="4.5" y="5.5" width="15" height="13" rx="1.5"/><path d="M8 5.5v13M4.5 12h15" opacity=".45"/>',
  fill: '<path d="m11 3.5 7.5 7.5-6.5 6.5a2 2 0 0 1-2.8 0L4.5 12.8a2 2 0 0 1 0-2.8Z"/><path d="M4.8 11.5h13.4"/><path d="M20 15.5s1.8 2.1 1.8 3.2a1.8 1.8 0 0 1-3.6 0c0-1.1 1.8-3.2 1.8-3.2Z"/>',
  erase: '<path d="m7.5 19.5-3-3a1.8 1.8 0 0 1 0-2.6L14 4.5a1.8 1.8 0 0 1 2.6 0l3 3a1.8 1.8 0 0 1 0 2.6L10.1 19.5Z"/><path d="M7.5 19.5H20M9 9.6l5.4 5.4"/>',
  pick: '<path d="m14 4 6 6-2 2-6-6Z"/><path d="m13 7-8.5 8.5L4 20l4.5-.5L17 11"/>',
  link: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 7c6 0 1 10 7 10"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5.5V4.5a1.5 1.5 0 0 1 3 0v7V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.3-2Z"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.5M6.2 6.9C3.8 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.4-1.1"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/>',
  play: '<path d="m7 4.5 12 7.5-12 7.5Z"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.8 6.6-4M8.7 13.2l6.6 4"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M4.5 17.5v2h15v-2"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 17.5v2h15v-2"/>',
  undo: '<path d="M9 5 4.5 9.5 9 14"/><path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 5 4.5 4.5L15 14"/><path d="M19.5 9.5H9a5 5 0 0 0 0 10h3"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  wire: '<circle cx="5.5" cy="12" r="2"/><circle cx="18.5" cy="12" r="2"/><path d="M7.5 12c2.5-5 6.5-5 9 0"/>',
  reach: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  trace: '<path d="M4 18c3-1 3-5 6-6s5 2 8-4"/><circle cx="4" cy="18" r="1.4"/><path d="m16 5 3 .5-.6 3"/>',
  issue: '<path d="M12 3.5 21 19.5H3Z"/><path d="M12 9.5v4.5M12 16.8v.2"/>',
  minimap: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><rect x="11" y="9" width="6.5" height="6" rx="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3M12 16.8v.2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  flip: '<path d="M12 4v16"/><path d="M9 7 4 12l5 5ZM15 7l5 5-5 5Z"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5" opacity=".5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 1.8-1 1.4-2-.5-1.2.3-2.5 1.6-2.5H17a3.5 3.5 0 0 0 3.5-3.5C20.5 7.4 16.7 3.5 12 3.5Z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7.3" r="1.2"/><circle cx="15" cy="7.8" r="1.2"/>',
  sliders: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  cube: '<path d="m12 3.5 8 4.5v8L12 20.5 4 16V8Z"/><path d="m4 8 8 4.5L20 8M12 12.5v8"/>',
  bolt: '<path d="m13.5 3-8 11h6l-1 7 8-11h-6Z"/>',
  star: '<path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.2l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7.5 14h9"/>',
  expand: '<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15"/>',
  save: '<path d="M5.5 4.5h10l3.5 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M8 4.5v5h7v-5M7.5 19.5v-6h9v6"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  wand: '<path d="m4 20 11-11"/><path d="m14 5 1-2 1 2 2 1-2 1-1 2-1-2-2-1ZM19 11l.6-1.2L21 9.2l-1.4-.6L19 7.4l-.6 1.2-1.4.6 1.4.6Z"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}
export const ICON_NAMES = Object.keys(P);
