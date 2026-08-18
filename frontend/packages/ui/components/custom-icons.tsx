'use client';

import { forwardRef } from 'react';
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
  // ★★ REDRAWN TO SIT ON THE SAME OPTICAL LINE AS ITS NEIGHBOURS (owner, 2026-08-18:
  // "fix the bell so its in line").
  //
  // The button boxes were never the problem — measured in the live header, the pencil,
  // bell and avatar controls all centre on exactly the same Y. The misalignment was
  // INSIDE the artwork: the old bell's ink ran y=2.5..19.4, putting its optical centre
  // at 10.94 — a full 1.06 units above the grid centre, while `pencil` sat at -0.20 and
  // `search` at +0.25. It also stood 16.9 units tall against their ~15, so it read as
  // both higher AND bigger than everything beside it.
  //
  // Body radius 6 -> 5.6, arc centre dropped 8.5 -> 9.5, skirt and clapper followed.
  // Ink is now y=3.9..19.5: centre -0.32, height 15.6. That puts all three header glyphs
  // inside a 0.6-unit band instead of a 1.3-unit one.
  bell: '<path d="M17.6 9.5a5.6 5.6 0 0 0-11.2 0c0 4.7-1.9 6.1-1.9 6.1h15s-1.9-1.4-1.9-6.1z"/><path d="M10.5 18.7a1.85 1.85 0 0 0 3 0"/>',
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
  // A coin (plain circle, same weight as `circle`) carrying the product's own
  // ◈ token glyph as a mitered facet at its centre — the same "rhombus chip"
  // idiom `wallet` already uses for its card slot, just centred in a coin
  // instead of tucked into a wallet body. Replaces a lucide `Users` icon that
  // was never on this set's grid at all (left-rail.tsx used it directly,
  // unstyled by this file), and deliberately is NOT a $-glyph-in-a-circle —
  // owner ruling 2026-08-11: the previous glyph read as a dollar sign, and a
  // creator TOKEN should not look like currency. Reusing ◈'s own diamond shape
  // ties the nav icon to the one glyph every other creator-token surface in
  // the product already uses, rather than inventing a second symbol for the
  // same idea.
  creatorTokens: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8l4.2 4.2-4.2 4.2-4.2-4.2z" stroke-linejoin="miter"/>',

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
  // ★ A PEN THAT IS WRITING, NOT A PENCIL THAT IS SITTING THERE (owner, 2026-08-18:
  // "recreate the icon for writing a post to actually look like a pen writing").
  //
  // The old glyph was the universal EDIT pencil — a body, a tip, a rubber. It is the
  // right icon for "change this thing" and the wrong one for "write something new",
  // which is what the header control actually does (it links to /submit.html). Three
  // subpaths now: the barrel, the nib facet, and — the part that carries the meaning —
  // a stroke of writing left behind underneath it. Without that stroke it is still just
  // a pen; with it, the pen is mid-sentence.
  //
  // ★ MEASURED, NOT EYEBALLED. Ink centre sits at 12.2 on the 24 grid (offset +0.23)
  // against `search` at +0.25 and the redrawn `bell` at -0.32, so the three header
  // glyphs share an optical baseline. Ink height 16.2 against search's 15.5. Checked
  // rendered at BOTH 44px and the real shipped 20px, because this set's own doc warns
  // that fine detail fuses below 20px — a glyph only checked large is not checked.
  // Only consumer is the header write button (`Icons.pencil` in app-header.tsx); every
  // other hit for "pencil" in the repo is a test id or a comment.
  pencil:
    '<path d="M16.8 4.1l2.9 2.9L11 15.7l-3.8.9.9-3.8z"/><path d="M14.9 6l2.9 2.9"/><path d="M4.9 19.6q3.3-1.5 6.6 0t6.6 0"/>',

  // ── home ─────────────────────────────────────────────────────────────────
  house:
    '<path d="M4 11L12 4l8 7"/><path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8"/><path d="M9.75 20v-5a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v5"/>'
};

/**
 * ★ forwardRef (2026-08-11, F7). Every icon here used to be a plain function
 * component, so any Radix `asChild` slot whose CHILD resolves to one of these
 * — not wrapped in an intervening real DOM element like a `<button>` or
 * `<span>` — got "Function components cannot be given refs" and Radix's
 * `SlotClone` silently dropped the ref instead of attaching it. Hit in
 * production on the post page: `reblog-trigger.tsx`'s icon-only variant (no
 * `showLabel`) hands `Icons.forward` straight to `ReblogDialog`, whose
 * `AlertDialogTrigger asChild` clones its `children` directly (see
 * `reblog-dialog.tsx`, which forwards its OWN ref correctly and is not the
 * bug). Every other call site in the app happens to wrap its icon in a real
 * element first, so this was invisible everywhere except that one spot — but
 * the failure mode is generic to the whole set, not specific to `forward`.
 * Fixing it once here, at the factory, means every icon this module makes
 * (~80 of them) can now sit directly inside any `asChild` slot, anywhere,
 * without a caller having to remember to wrap it.
 */
const make = (name: string) => {
  const Icon = forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>((props, ref) => (
    <svg
      ref={ref}
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
  ));
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
export const creatorTokens = make('creatorTokens');
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

/**
 * ★★★ THE PRESS SET (2026-08-18) — 40 icons delivered against the design brief.
 *
 * These are FILLED, not stroked, and that is the whole point of the cut: the
 * house set above is 1.75px line work, and the brief asked for icons that look
 * ENGRAVED or STAMPED rather than drawn with a modern rounded pen — higher
 * contrast, solid where a stamp would ink, flat terminals. So they cannot share
 * `make()`, which sets `fill="none" stroke="currentColor"`; a filled path
 * rendered through it disappears. `makeFilled` is the same wrapper with the
 * fill/stroke relationship inverted.
 *
 * Everything else is deliberately identical to the line set — 24 grid, 20 live
 * area, `currentColor`, same props passthrough — so a caller swapping one for the
 * other changes nothing but the drawing.
 *
 * ★ The vote blade and the quill are NOT here and must not be redrawn: the blade
 * already carries the rhombus facet this product is built from, and the quill
 * means "lite account" in a byline. Both were delivered as-is on purpose.
 */
export const FILLED_PATHS: Record<string, string> = {
  account: '<circle cx="12" cy="7.4" r="3.8"></circle> <path d="M4 21.4c0-4.2 3.6-6.8 8-6.8s8 2.6 8 6.8Z"></path>',
  add: '<path d="M10.6 3.4h2.8v7.2h7.2v2.8h-7.2v7.2h-2.8v-7.2H3.4v-2.8h7.2Z"></path>',
  chart: '<path d="M3 20.4h18v2H3Z"></path> <path d="M5.4 10h3.2v9.2H5.4Zm5-5.6h3.2v14.8h-3.2Zm5 7.6h3.2v7.2h-3.2Z"></path>',
  check: '<path d="M9.4 18.6 3 12.2l2.4-2.4 4 4L18.6 4.4 21 6.8Z"></path>',
  chevron: '<path d="M12 16.8 4.2 8.6h15.6Z"></path>',
  close: '<path d="M4.6 6.4 6.4 4.6 19.4 17.6 17.6 19.4Z"></path> <path d="M17.6 4.6 19.4 6.4 6.4 19.4 4.6 17.6Z"></path>',
  comment: '<path fill-rule="evenodd" d="M2.6 3.2h18.8v13.6H9.4L4.4 21.4v-4.6H2.6ZM4.8 5.4H19.2V14.6H4.8Z"></path>',
  communities: '<path d="M7.4 3.4a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z"></path> <path d="M1.8 20.6c0-3.4 2.5-5.6 5.6-5.6s5.6 2.2 5.6 5.6Z"></path> <path d="M16.8 5.6a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Z"></path> <path d="M14.6 20.6h7.6c0-3-1.8-4.8-4.4-4.8-1.2 0-2.2.3-3 .9Z"></path>',
  compose: '<path d="M15.6 2.6 21.4 8.4 10.4 19.4H4.6v-5.8Z"></path> <path d="M4.6 19.4h5.8l-2.9 2.2H2.4Z"></path>',
  downvoteCast: '<path d="M12 3.1c3 3.8 5.4 7.4 7.2 10.8-2.3-1.4-4.7-2.1-7.2-2.1s-4.9.7-7.2 2.1C6.6 10.5 9 6.9 12 3.1z"></path>',
  downvote: '<path d="M12 3.1c3 3.8 5.4 7.4 7.2 10.8-2.3-1.4-4.7-2.1-7.2-2.1s-4.9.7-7.2 2.1C6.6 10.5 9 6.9 12 3.1z"></path>',
  explore: '<path fill-rule="evenodd" d="M12 1.6a10.4 10.4 0 1 0 0 20.8 10.4 10.4 0 0 0 0-20.8Zm0 2.8a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2Z"></path> <path d="M15.6 8.4 13.4 13.4 8.4 15.6 10.6 10.6Z"></path>',
  external: '<path d="M4.4 6.4h7v2.8H7.2v7.6h7.6v-4.2h2.8v7H4.4Z"></path> <path d="M13.6 2.6h7.8v7.8h-2.8V7.4l-4.8 4.8-2-2 4.8-4.8h-3Z"></path>',
  flag: '<path d="M4.4 2.6h2.8v18.8H4.4Z"></path> <path d="M7.2 3.4h12.4l-2.6 4.4 2.6 4.4H7.2Z"></path>',
  home: '<path d="M12 2.6 21.8 11.4h-2.8v10H14.6v-6.2H9.4v6.2H5V11.4H2.2Z"></path>',
  // ★ FILLED TWINS FOR THE LEFT RAIL, ADDED 2026-08-18 (uniformity audit).
  //
  // The rail was running two icon systems in one seven-item list: Home, Profile, Wallet
  // and Settings render through `press*` (filled, 1px), while Witnesses, Proposals and
  // Meritum render outline at 1.75/1.9px. Measured in the live DOM, not inferred. Four
  // solid and three outline reads as if the bottom group is disabled.
  //
  // ★★ THE SHARED OUTLINE GLYPHS ARE DELIBERATELY NOT TOUCHED. `arrowBigUp` is the VOTE
  // BLADE — this file's own header calls it out as carrying the Hive rhombus signature
  // and says it was not swapped on purpose — and `listChecks` has consumers beyond the
  // rail. Changing either would silently restyle post actions across the app. These are
  // new, additive, rail-only entries with the SAME geometry as their outline twins, so
  // the glyph still reads identically; only the fill changes.
  witnessVote: '<path d="M12 3.4 20.6 12H15.4v7.8H8.6V12H3.4Z"></path>',
  proposals:
    '<path d="M10.6 5.8h9.8v2.4h-9.8Zm0 10h9.8v2.4h-9.8Z"></path> <path d="M5.2 5.9 6.4 7.1 8.9 4.6l1.7 1.7-4.2 4.2L3.5 7.6Zm0 9 1.2 1.2 2.5-2.5 1.7 1.7-4.2 4.2-2.9-2.9Z"></path>',
  image: '<path fill-rule="evenodd" d="M2.4 4.6h19.2v14.8H2.4Zm2.6 2.6v9.6h14v-9.6Z"></path> <path d="M5.4 16.8 9.6 11l3 3.6 2.6-2.2 3.8 4.4Z"></path> <circle cx="15.6" cy="9.8" r="1.5"></circle>',
  keys: '<path d="M5.4 10.6h13.2v10.8H5.4Z"></path> <path d="M8.2 10.6V7.4a3.8 3.8 0 0 1 7.6 0v3.2h-2.8V7.4a1 1 0 0 0-2 0v3.2Z"></path>',
  link: '<path d="M4.4 12a4.6 4.6 0 0 1 4.6-4.6h2.6v2.8H9A1.8 1.8 0 0 0 9 14h2.6v2.6H9A4.6 4.6 0 0 1 4.4 12Z"></path> <path d="M19.6 12a4.6 4.6 0 0 0-4.6-4.6h-2.6v2.8H15A1.8 1.8 0 0 1 15 14h-2.6v2.6H15A4.6 4.6 0 0 0 19.6 12Z"></path> <path d="M8.4 10.8h7.2v2.4H8.4Z"></path>',
  menu: '<path d="M2.4 5h19.2v3.2H2.4Zm0 5.4h19.2v3.2H2.4Zm0 5.4h19.2v3.2H2.4Z"></path>',
  meritum: '<path d="M12 1.8 19.2 12 12 22.2 4.8 12Z"></path>',
  more: '<path d="M2.8 10.2h3.6v3.6H2.8Zm7.4 0h3.6v3.6h-3.6Zm7.4 0h3.6v3.6h-3.6Z"></path>',
  mute: '<path d="M10.8 1.6h2.4v2.2h-2.4Z"></path> <path d="M12 4.2c4 0 5.4 3.4 5.4 7.4 0 3 .6 4.6 1.8 5.8H4.8c1.2-1.2 1.8-2.8 1.8-5.8 0-4 1.4-7.4 5.4-7.4Z"></path> <path d="M3.4 4.6 5.2 2.8 21.2 18.8 19.4 20.6Z"></path>',
  notifications: '<path d="M10.8 1.6h2.4v2.2h-2.4Z"></path> <path d="M12 4.2c4 0 5.4 3.4 5.4 7.4 0 3 .6 4.6 1.8 5.8H4.8c1.2-1.2 1.8-2.8 1.8-5.8 0-4 1.4-7.4 5.4-7.4Z"></path> <path d="M9.6 18.6h4.8v1.4a2.4 2.4 0 0 1-4.8 0Z"></path>',
  post: '<path fill-rule="evenodd" d="M4.6 2.6h14.8v18.8H4.6Zm1.8 1.8v15.2h11.2V4.4Z"></path> <path d="M7.4 6.4h9.2v1.8H7.4Zm0 4.2h9.2v1.8H7.4Zm0 4.2h5.6v1.8H7.4Z"></path>',
  refresh: '<path d="M12 5.2a6.8 6.8 0 1 1-6.8 6.8H2.2a9.8 9.8 0 1 0 9.8-9.8Z"></path> <path d="M12 1.2v8L7.4 5.2Z"></path>',
  reply: '<path d="M2.6 9 9.6 3.4v3.4h4.8a7 7 0 0 1 7 7v5.8h-3.6v-5a3.8 3.8 0 0 0-3.8-3.8H9.6v3.4Z"></path>',
  saveOutline: '<path fill-rule="evenodd" d="M6 2.4h12v19.2l-6-4.8-6 4.8Zm2.8 2.8v10.6l3.2-2.6 3.2 2.6V5.2Z"></path>',
  save: '<path d="M6 2.4h12v19.2l-6-4.8-6 4.8Z"></path>',
  search: '<path fill-rule="evenodd" d="M10 1.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm0 3a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z"></path> <path d="M15.9 17.9 17.9 15.9 22.6 20.6 20.6 22.6Z"></path>',
  settings: '<path d="M2.4 6.4h19.2v2.4H2.4Zm0 8.4h19.2v2.4H2.4Z"></path> <path d="M13.4 4.6h3.6v6h-3.6ZM7 12.6h3.6v6.8H7Z"></path>',
  share: '<path d="M6.4 7.6 12 1.4l5.6 6.2h-3.9v7.8h-3.4V7.6Z"></path> <path d="M3.4 12.6h3.4v6.2h10.4v-6.2h3.4v9.6H3.4Z"></path>',
  stack: '<path d="M4 17.6h16v3.4H4Zm2-4.8h12v3.4H6Zm2-4.8h8v3.4H8Zm2-4.8h4v3.4h-4Z"></path>',
  stake: '<path d="M12 2.2 18.4 9H5.6Z"></path> <path d="M10.6 8h2.8v9.6h-2.8Z"></path> <path d="M3 19.4h18v2.6H3Z"></path>',
  swap: '<path d="M3.4 7.4h13.2V4.4L21.8 9l-5.2 4.6v-3H3.4Z"></path> <path d="M20.6 16.6H7.4v3L2.2 15l5.2-4.6v3h13.2Z"></path>',
  time: '<path fill-rule="evenodd" d="M12 1.6a10.4 10.4 0 1 0 0 20.8 10.4 10.4 0 0 0 0-20.8Zm0 2.8a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2Z"></path> <path d="M11 6h2.2v6.4l4.4 2.6-1.1 1.9-5.5-3.3Z"></path>',
  upvoteCast: '<path d="M12 3.1c3 3.8 5.4 7.4 7.2 10.8-2.3-1.4-4.7-2.1-7.2-2.1s-4.9.7-7.2 2.1C6.6 10.5 9 6.9 12 3.1z"></path>',
  upvote: '<path d="M12 3.1c3 3.8 5.4 7.4 7.2 10.8-2.3-1.4-4.7-2.1-7.2-2.1s-4.9.7-7.2 2.1C6.6 10.5 9 6.9 12 3.1z"></path>',
  views: '<path fill-rule="evenodd" d="M12 4.6c5.2 0 9.4 4.2 11 7.4-1.6 3.2-5.8 7.4-11 7.4S2.6 15.2 1 12c1.6-3.2 5.8-7.4 11-7.4Zm0 4a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"></path>',
  voteValue: '<path d="M3.6 3.4h16.8v2.4H3.6Z"></path> <path d="M10.8 5.8h2.4v4h-2.4Z"></path> <path d="M4.6 14.4a7.4 7.4 0 0 1 14.8 0Z"></path> <path d="M4.6 14.4h14.8v2.2H4.6Z"></path>',
  wallet: '<path fill-rule="evenodd" d="M2.2 5.4h19.6v13.2H2.2Zm0 3.8h19.6v1.8H2.2Zm13.8 4.2a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 0 0-3.2 0Z"></path>',
};

const makeFilled = (name: string) => {
  const Icon = forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>((props, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="currentColor"
      stroke="none"
      {...props}
      // eslint-disable-next-line react/no-danger -- house icon set: inner SVG geometry is a trusted constant from FILLED_PATHS, never user input
      dangerouslySetInnerHTML={{ __html: FILLED_PATHS[name] }}
    />
  ));
  Icon.displayName = `FilledIcon(${name})`;
  return Icon;
};

/* The press cut, exported under `press*` names so a call site opts in explicitly
   and the line set stays available for anything mid-migration. */
export const pressSearch = makeFilled('search');
export const pressMenu = makeFilled('menu');
export const pressComment = makeFilled('comment');
export const pressNotifications = makeFilled('notifications');
export const pressClose = makeFilled('close');
export const pressCheck = makeFilled('check');
export const pressAdd = makeFilled('add');
export const pressMore = makeFilled('more');
export const pressExternal = makeFilled('external');
export const pressLink = makeFilled('link');
export const pressImage = makeFilled('image');
export const pressFlag = makeFilled('flag');
export const pressSettings = makeFilled('settings');
export const pressWallet = makeFilled('wallet');
export const pressMeritum = makeFilled('meritum');
export const pressAccount = makeFilled('account');
export const pressHome = makeFilled('home');
export const pressCompose = makeFilled('compose');
export const pressPost = makeFilled('post');
export const pressChart = makeFilled('chart');
export const pressTime = makeFilled('time');
export const pressKeys = makeFilled('keys');
export const pressMute = makeFilled('mute');
export const pressShare = makeFilled('share');
export const pressReply = makeFilled('reply');
export const pressSave = makeFilled('save');
export const pressSaveOutline = makeFilled('saveOutline');
export const pressVoteValue = makeFilled('voteValue');
export const pressCommunities = makeFilled('communities');
export const pressExplore = makeFilled('explore');
// Rail-only filled twins — see FILLED_PATHS above for why the shared outline glyphs stay.
export const pressWitnessVote = makeFilled('witnessVote');
export const pressProposals = makeFilled('proposals');
export const pressRefresh = makeFilled('refresh');
export const pressViews = makeFilled('views');
export const pressStack = makeFilled('stack');
export const pressStake = makeFilled('stake');
export const pressSwap = makeFilled('swap');
export const pressChevron = makeFilled('chevron');
