'use client';

import type { LucideProps } from 'lucide-react';

/**
 * "Rhombus line" — an original, house-drawn icon set for the Hive blog rebuild.
 *
 * Design language:
 *  - 24×24 grid, ~20px live area, 1.75px stroke, `currentColor`, round caps/joins.
 *  - Refined line geometry that pairs with Open Sans + Lora, reads "modern tech".
 *  - Signature: Hive's brand is built from rhombi, so the block up/down vote
 *    arrows and the wallet chip carry a HARD mitered rhombus facet — their
 *    corners opt out of the round default via `stroke-linejoin="miter"`. The
 *    reblog arrowheads echo it; the $ and every utility icon stay clean/curved
 *    for legibility. Coherence comes from the shared grid + stroke, plus that
 *    recurring facet on the Hive-action set.
 *
 * The raw inner-SVG markup lives in `PATHS` (single source of truth). Each icon
 * is a thin wrapper that spreads props (so `className="h-5 w-5"`, color, etc.
 * all work exactly like the lucide components these replace). The same `PATHS`
 * strings back the standalone icon gallery, so the preview never drifts from
 * what actually ships.
 */
export const PATHS: Record<string, string> = {
  // ── carets & directional ────────────────────────────────────────────────
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  arrowRight: '<path d="M4.5 12h14"/><path d="M13 6.5l6 5.5-6 5.5"/>',
  undo: '<path d="M8 7l-4 4 4 4"/><path d="M4 11h10.5a4.5 4.5 0 0 1 0 9H12"/>',

  // ── primitives ──────────────────────────────────────────────────────────
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  add: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  horizontalRule: '<path d="M4 12h16"/>',
  moreHorizontal: '<path d="M6 12h.01"/><path d="M12 12h.01"/><path d="M18 12h.01"/>',
  moreVertical: '<path d="M12 6h.01"/><path d="M12 12h.01"/><path d="M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.4a2.6 2.6 0 0 1 4.6 1.6c0 1.8-2.6 2.1-2.6 3.6"/><path d="M12 17.5h.01"/>',
  warning: '<path d="M12 5l8.5 14.5H3.5L12 5z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>',

  // ── nav / people ─────────────────────────────────────────────────────────
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8L20 20"/>',
  // The universal "menu" glyph, drawn on this set's grid (three 16-unit rules,
  // 5 units apart, round caps). `sidebarOpen` reads as "expand the panel" next
  // to a panel; on a phone, where there is no visible panel to expand, only the
  // three bars are understood without being taught.
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  bell: '<path d="M18 8.5a6 6 0 0 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z"/><path d="M10.4 18.5a1.9 1.9 0 0 0 3.2 0"/>',
  user: '<circle cx="12" cy="8.5" r="3.75"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>',
  userPlus:
    '<circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19.5a6 6 0 0 1 12 0"/><path d="M18.5 7.5v5"/><path d="M16 10h5"/>',
  atSign:
    '<circle cx="12" cy="12" r="3.75"/><path d="M15.75 8.5v4.75a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.4 7"/>',
  settings:
    '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 17h9"/><path d="M17 17h3"/><circle cx="15" cy="17" r="2"/>',
  doorOpen: '<path d="M4 20h5V4l7 1.6V20h4"/><path d="M11.5 12h.01"/>',
  keyRound:
    '<circle cx="8.5" cy="12" r="4"/><path d="M11.9 9.9l7.6-4.4"/><path d="M17 7.1l2 1.1"/><path d="M15.2 8.1l1.4 2.4"/>',
  wallet:
    '<path d="M4 8a2.5 2.5 0 0 1 2.5-2.5H16A1.5 1.5 0 0 1 17.5 7v2"/><path d="M4 8v9a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5V11a1.5 1.5 0 0 0-1.5-1.5H6.5A2.5 2.5 0 0 1 4 8z"/><path d="M15 12.3l2.2 2.2-2.2 2.2-2.2-2.2z" stroke-linejoin="miter"/>',

  // ── post actions (Hive family — rhombus / angular signature) ──────────────
  arrowBigUp: '<path d="M12 4l7.5 7.5H15V19H9v-7.5H4.5z" stroke-linejoin="miter"/>',
  arrowBigDown: '<path d="M12 20l-7.5-7.5H9V5h6v7.5h4.5z" stroke-linejoin="miter"/>',
  arrowUpCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V8"/><path d="M8.3 11.7L12 8l3.7 3.7"/>',
  arrowDownCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V16"/><path d="M8.3 12.3L12 16l3.7-3.7"/>',
  reblog:
    '<path d="M4 9l3.2-3.2L10.4 9" stroke-linejoin="miter"/><path d="M7.2 6.2V13a3 3 0 0 0 3 3H17"/><path d="M20 15l-3.2 3.2L13.6 15" stroke-linejoin="miter"/><path d="M16.8 17.8V11a3 3 0 0 0-3-3H7"/>',
  forward: '<path d="M13 5.5l6.5 6-6.5 6"/><path d="M19.5 11.5H10a5.5 5.5 0 0 0-5.5 5.5v1"/>',
  comment: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H9l-5 4.5z"/>',
  star: '<path d="M12 3.5l2.6 5.35 5.9.86-4.27 4.16 1.01 5.88L12 17.1l-5.25 2.76 1.01-5.88L3.5 9.71l5.9-.86z"/>',
  dollar:
    '<path d="M12 4v16"/><path d="M15.8 7.4A3.2 3.2 0 0 0 12.7 5.5h-1.4a2.9 2.9 0 0 0-.5 5.75l2.4.5a2.9 2.9 0 0 1-.5 5.75h-1.4A3.2 3.2 0 0 1 8.2 16.6"/>',
  // A rising market that resolves into the house rhombus: a hairline baseline, a
  // trend polyline climbing left→right, and a mitered rhombus node sitting exactly
  // on the line's end point (the settled outcome). Replaces the earlier three-post
  // "ladder", which read as three plain lines at small sizes.
  marketChart:
    '<path d="M4 19.3h16"/><path d="M5 15.4l3.7-4.1 3 2.5 3.5-5.6"/><path d="M17.3 6.1l2.1 2.1-2.1 2.1-2.1-2.1z" stroke-linejoin="miter"/>',
  flag: '<path d="M6 20.5V4"/><path d="M6 5h11l-2.2 3.2L17 11.5H6"/>',
  unflag: '<path d="M6 20.5V4"/><path d="M6 5h11l-2.2 3.2 1.2 1.7"/><path d="M4 4l16 16"/>',
  crossPost:
    '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="13" width="7" height="7" rx="1.5"/><path d="M10.5 7.5h3.5a3 3 0 0 1 3 3v2.5"/><path d="M14.6 10.4L17 12.8l2.4-2.4"/>',
  messagesSquare:
    '<path d="M7.5 15H14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10l4.5-2z"/><path d="M8 15v.5a2 2 0 0 0 2 2h6.5l4.5 2V11a2 2 0 0 0-2-2h-1.5"/>',
  messageSquareText:
    '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H9l-5 4.5z"/><path d="M8 8.5h8"/><path d="M8 11.5h5"/>',

  // ── theme ────────────────────────────────────────────────────────────────
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.5"/><path d="M12 18.5V21"/><path d="M3 12h2.5"/><path d="M18.5 12H21"/><path d="M5.6 5.6l1.8 1.8"/><path d="M16.6 16.6l1.8 1.8"/><path d="M18.4 5.6l-1.8 1.8"/><path d="M7.4 16.6l-1.8 1.8"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4a6.3 6.3 0 0 0 9.5 9.5z"/>',
  laptop: '<rect x="5" y="6" width="14" height="9.5" rx="1.5"/><path d="M3 18.5h18"/>',

  // ── time / calendar / place ──────────────────────────────────────────────
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.6 2.1"/>',
  calendarActive:
    '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16"/><path d="M8 3.5v3"/><path d="M16 3.5v3"/><path d="M12 12.5v2.4l1.8 1"/>',
  calendarHeart:
    '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16"/><path d="M8 3.5v3"/><path d="M16 3.5v3"/><path d="M12 17.2c-2-1.35-3-2.35-3-3.65a1.45 1.45 0 0 1 3-.5 1.45 1.45 0 0 1 3 .5c0 1.3-1 2.3-3 3.65z"/>',
  mapPin:
    '<path d="M12 21s6.5-5.5 6.5-10.5a6.5 6.5 0 0 0-13 0C5.5 15.5 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.4"/>',
  globe2:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.4 3.9 5.4 3.9 8.5S14.5 18.6 12 20.5c-2.5-1.9-3.9-4.9-3.9-8.5S9.5 5.9 12 3.5z"/>',

  // ── files / content ──────────────────────────────────────────────────────
  post: '<path d="M7 3.5h6.5l4 4V19A1.5 1.5 0 0 1 16 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8H18"/><path d="M8.5 13h7"/><path d="M8.5 16h4.5"/>',
  page: '<path d="M7 3.5h6.5l4 4V19A1.5 1.5 0 0 1 16 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8H18"/>',
  image:
    '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 16.5l4-3.5 3.5 2.8L15 12l5 4.5"/>',
  billing: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><path d="M6.5 14.5h3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  copyDone:
    '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9 4.5V4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v.5"/><path d="M9 12.5l2 2 4-4"/>',
  trash:
    '<path d="M5 7h14"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.5 7l1 11.5A1.5 1.5 0 0 0 9 20h6a1.5 1.5 0 0 0 1.5-1.5L17.5 7"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  pizza:
    '<path d="M12 4l8.5 4.2L12 21 3.5 8.2z"/><path d="M9 8.5h.01"/><path d="M12 12.5h.01"/><path d="M14.5 9h.01"/>',

  // ── layout / sidebar ─────────────────────────────────────────────────────
  layoutList:
    '<rect x="4" y="5" width="16" height="6" rx="1.5"/><rect x="4" y="13" width="16" height="6" rx="1.5"/>',
  layoutGrid:
    '<rect x="4" y="5" width="7" height="7" rx="1.5"/><rect x="13" y="5" width="7" height="7" rx="1.5"/><rect x="4" y="14" width="7" height="5.5" rx="1.5"/><rect x="13" y="14" width="7" height="5.5" rx="1.5"/>',
  sidebarOpen:
    '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14"/><path d="M13.5 10l2.5 2-2.5 2"/>',
  sidebarClose:
    '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14"/><path d="M16.5 10L14 12l2.5 2"/>',

  // ── links ────────────────────────────────────────────────────────────────
  externalLink:
    '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M17.5 13.5V18A1.5 1.5 0 0 1 16 19.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
  link: '<path d="M9.5 14.5l5-5"/><path d="M8 12l-2 2a3 3 0 0 0 4.2 4.2l2-2"/><path d="M16 12l2-2a3 3 0 0 0-4.2-4.2l-2 2"/>',
  link2: '<path d="M8 12h8"/><path d="M9 8H7a4 4 0 0 0 0 8h2"/><path d="M15 8h2a4 4 0 0 1 0 8h-2"/>',
  link2Off:
    '<path d="M9 8H7a4 4 0 0 0-2.7 6.95"/><path d="M15 16h2a4 4 0 0 0 3-6.6"/><path d="M8.5 12H11"/><path d="M4 4l16 16"/>',

  // ── visibility ───────────────────────────────────────────────────────────
  eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.75"/>',
  eyeOff:
    '<path d="M4 4l16 16"/><path d="M9.5 9.6a2.75 2.75 0 0 0 4.9 2.4"/><path d="M6.7 6.9C4.2 8.3 2.5 12 2.5 12s3.5 6 9.5 6a9.6 9.6 0 0 0 4-.85"/><path d="M17.4 16.2C20 14.8 21.5 12 21.5 12s-3.5-6-9.5-6a9.7 9.7 0 0 0-2 .2"/>',
  micOff:
    '<path d="M4 4l16 16"/><path d="M9 9v3a3 3 0 0 0 5 2.2"/><path d="M15 11.4V5.5a3 3 0 0 0-5.7-1.3"/><path d="M6 11.5a6 6 0 0 0 9.5 4.85"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/>',

  // ── editor toolbar ───────────────────────────────────────────────────────
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M11 5h6"/><path d="M7 19h6"/><path d="M14 5l-4 14"/>',
  strikethrough:
    '<path d="M5 12h14"/><path d="M8 8.2A3 3 0 0 1 11 6h2.5a3 3 0 0 1 2.7 1.7"/><path d="M8 15.5a3 3 0 0 0 3 2.5h1.5"/>',
  heading:
    '<path d="M6 5v14"/><path d="M13 5v14"/><path d="M6 12h7"/><path d="M15.6 8.6a2.3 2.3 0 1 1 1.7 3.85 2.3 2.3 0 1 1-1.7 3.85"/>',
  code: '<path d="M9 8l-4.5 4L9 16"/><path d="M15 8l4.5 4L15 16"/>',
  codeBlock:
    '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M9.5 10l-2 2 2 2"/><path d="M14.5 10l2 2-2 2"/>',
  table:
    '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10.5h16"/><path d="M4 15.5h16"/><path d="M12 5v14"/>',
  list: '<path d="M8.5 7h11.5"/><path d="M8.5 12h11.5"/><path d="M8.5 17h11.5"/><path d="M4.5 7h.01"/><path d="M4.5 12h.01"/><path d="M4.5 17h.01"/>',
  listOrdered:
    '<path d="M10 7h10"/><path d="M10 12h10"/><path d="M10 17h10"/><path d="M4 6l1.2-.6V9.2"/><path d="M4 14.6a1 1 0 1 1 1.9.5L4 18.6h2.1"/>',
  listChecks:
    '<path d="M11 7h9"/><path d="M11 17h9"/><path d="M4 7.2l1.2 1.2L8 5.6"/><path d="M4 16.2l1.2 1.2L8 14.6"/>',
  paperclip:
    '<path d="M18.5 9.3l-7.6 7.6a3.5 3.5 0 0 1-5-5L12.8 4a2.5 2.5 0 0 1 3.6 3.5l-7.6 7.6a1.25 1.25 0 0 1-1.8-1.8l6.8-6.8"/>',
  quote: '<path d="M6.5 8h3v3c0 2-1 3.4-3 4"/><path d="M14.5 8h3v3c0 2-1 3.4-3 4"/>',

  // ── loading ──────────────────────────────────────────────────────────────
  spinner: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>',

  // ── compose ──────────────────────────────────────────────────────────────
  pencil: '<path d="M16.4 4.4l3.2 3.2L9 18.2l-4.2 1 1-4.2z"/><path d="M14.3 6.5l3.2 3.2"/>',

  // ── home ─────────────────────────────────────────────────────────────────
  house:
    '<path d="M4 11L12 4l8 7"/><path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8"/><path d="M9.75 20v-5a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v5"/>'
};

const make = (name: string) => {
  const Icon = (props: LucideProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      // eslint-disable-next-line react/no-danger -- house icon set: inner SVG geometry is a trusted constant from PATHS, never user input
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
  Icon.displayName = `Icon(${name})`;
  return Icon;
};

export const chevronDown = make('chevronDown');
export const chevronUp = make('chevronUp');
export const chevronLeft = make('chevronLeft');
export const chevronRight = make('chevronRight');
export const marketChart = make('marketChart');
export const arrowRight = make('arrowRight');
export const undo = make('undo');
export const x = make('x');
export const add = make('add');
export const check = make('check');
export const circle = make('circle');
export const horizontalRule = make('horizontalRule');
export const moreHorizontal = make('moreHorizontal');
export const moreVertical = make('moreVertical');
export const info = make('info');
export const help = make('help');
export const warning = make('warning');
export const search = make('search');
export const bell = make('bell');
export const user = make('user');
export const userPlus = make('userPlus');
export const atSign = make('atSign');
export const settings = make('settings');
export const doorOpen = make('doorOpen');
export const keyRound = make('keyRound');
export const wallet = make('wallet');
export const arrowBigUp = make('arrowBigUp');
export const arrowBigDown = make('arrowBigDown');
export const arrowUpCircle = make('arrowUpCircle');
export const arrowDownCircle = make('arrowDownCircle');
export const reblog = make('reblog');
export const forward = make('forward');
export const comment = make('comment');
export const star = make('star');
export const dollar = make('dollar');
export const flag = make('flag');
export const unflag = make('unflag');
export const crossPost = make('crossPost');
export const messagesSquare = make('messagesSquare');
export const messageSquareText = make('messageSquareText');
export const sun = make('sun');
export const moon = make('moon');
export const laptop = make('laptop');
export const clock = make('clock');
export const calendarActive = make('calendarActive');
export const calendarHeart = make('calendarHeart');
export const mapPin = make('mapPin');
export const globe2 = make('globe2');
export const post = make('post');
export const page = make('page');
export const image = make('image');
export const billing = make('billing');
export const copy = make('copy');
export const copyDone = make('copyDone');
export const trash = make('trash');
export const pizza = make('pizza');
export const layoutList = make('layoutList');
export const layoutGrid = make('layoutGrid');
export const sidebarOpen = make('sidebarOpen');
export const sidebarClose = make('sidebarClose');
export const menu = make('menu');
export const externalLink = make('externalLink');
export const link = make('link');
export const link2 = make('link2');
export const link2Off = make('link2Off');
export const eye = make('eye');
export const eyeOff = make('eyeOff');
export const micOff = make('micOff');
export const bold = make('bold');
export const italic = make('italic');
export const strikethrough = make('strikethrough');
export const heading = make('heading');
export const code = make('code');
export const codeBlock = make('codeBlock');
export const table = make('table');
export const list = make('list');
export const listOrdered = make('listOrdered');
export const listChecks = make('listChecks');
export const paperclip = make('paperclip');
export const quote = make('quote');
export const spinner = make('spinner');
export const pencil = make('pencil');
export const house = make('house');
