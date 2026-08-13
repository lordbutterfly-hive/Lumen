/**
 * The oversized watermark mark that sits in the corner of every Lumen masthead.
 *
 * ★★★ WHY THIS IS A COMPONENT AND NOT A CLASSNAME (2026-08-10).
 *
 * The topic header's `#` was copied onto the home hero as `¶` with the same
 * `-right-2 -top-9`, and the pilcrow came out cropped: its bowl, the half that
 * makes it a pilcrow rather than two bars, sat above the card's `overflow-hidden`
 * edge, and its tail dropped into the row below.
 *
 * Nothing was wrong with the offsets. They were tuned to ONE glyph's ink box, and
 * ink boxes differ. Measured in the browser at 146px Lora:
 *
 *   glyph   ascent   descent   advance   ink-right
 *   #       106      0         122.3     112
 *   ¶       107      14        92.9      84
 *
 * The pilcrow's ink is 15px taller and hangs 14px BELOW the baseline where the hash
 * sits flat on it, and it is 28px narrower. A shared offset therefore cannot put
 * both marks in the same visual place, which is exactly what a house style needs.
 *
 * So the offsets are computed per glyph from those measurements, and the caller
 * names a mark instead of positioning one. Adding a mark for a new surface means
 * measuring its ink box once and adding a row here. Do NOT hand-place another one.
 *
 * The arithmetic, verified on both live cards: for a span with `leading-none` at
 * 146px Lora the baseline lands 126px below the span's top edge, on every glyph.
 * Therefore
 *      inkTop   = top + 126 - ascent
 *      inkRight = right + (advance - inkRightMetric)     [from the card's right edge]
 * and we solve both for the house position below.
 *
 * ★★★ MEASURE THE FONT THAT IS ACTUALLY LOADED, NOT THE ONE YOU THINK IS (2026-08-10).
 *
 * The first version of this table was wrong, and it was wrong in a way that looked
 * right. It came from `canvas.measureText` with the font set to `"146px Lora, serif"`
 * — but `next/font` does not register the family under the name `Lora`. It generates
 * a hashed one, and the real computed stack here is
 *
 *      __Lora_a0ef65, __Lora_Fallback_a0ef65, Georgia, Cambria, serif
 *
 * so the canvas silently fell through to GEORGIA and I measured that instead. Georgia's
 * pilcrow descends 14px below the baseline at 146px. Lora's descends **38px**. Every
 * offset derived from those numbers put the mark roughly 24px too high, which is
 * exactly the "it is still cropped" that three rounds of arithmetic could not explain:
 * the maths was right and the inputs were from the wrong typeface.
 *
 * The numbers below are measured with `getComputedStyle(el).fontFamily` fed straight
 * back into the canvas. If this table is ever regenerated, do it the same way.
 */
import type { FC } from 'react';

/**
 * ★ SIZE, AND WHY IT CAME DOWN FROM 146 (2026-08-10). At 146px the pilcrow's ink is
 * 121px tall inside a 154px card: it fills 79% of the height, touches the air at
 * both ends, and reads as a mark that got cut off even when it is provably inside
 * the box. Measurement said "not cropped", eyes said "cropped", and the eyes were
 * describing something real. 104px lands the ink at roughly 56% of the card, which
 * reads as placed rather than clipped, and it stays the dominant graphic on the
 * card. All the metrics below are per 146px and scale linearly from it.
 */
const FONT_SIZE = 120;
const SCALE = FONT_SIZE / 146;

/** Where the ink goes, in px from the card's top and right edges. */
const INK_TOP = 22;
const INK_RIGHT = 30;

/**
 * Measured ink metrics at 146px in the REAL loaded face (see the note above).
 * `italic` is per glyph: Lora's italic pilcrow is a drawn, calligraphic form with a
 * proper swelling stem, where the upright one is a plain slab. The hash gains
 * nothing from the slope and looks like a mistake in it, so it stays upright.
 */
const GLYPHS = {
  pilcrow: { char: '¶', ascent: 103, advance: 72, inkRight: 61, italic: true },
  hash: { char: '#', ascent: 104, advance: 121, inkRight: 117, italic: false }
} as const;

const BASELINE_FROM_SPAN_TOP = 126;

export type MastheadMark = keyof typeof GLYPHS;

/**
 * ★ FULLY VISIBLE, NOT BLED OFF THE CORNER (owner call, 2026-08-10, after three
 * rounds of "it is still cropped"). The mark is decoration, and decoration that is
 * half outside the card reads as a rendering fault rather than a flourish. It sits
 * inside the card with air around it, and every masthead places it identically.
 */
const MastheadGlyph: FC<{ mark: MastheadMark }> = ({ mark }) => {
  const g = GLYPHS[mark];
  // Math.round (2026-08-13, typography audit item 1): both offsets are measured
  // ink metrics scaled by SCALE (120/146), which lands on a fraction of a pixel
  // and was the LAST fractional-Y text node left on Home and Trending. Rounding
  // moves the mark by at most half a pixel, well inside the optical tolerance
  // the numbers above were tuned to, and puts it on the device pixel grid.
  const top = Math.round(INK_TOP - (BASELINE_FROM_SPAN_TOP - g.ascent) * SCALE);
  const right = Math.round(INK_RIGHT - (g.advance - g.inkRight) * SCALE);
  return (
    // z-0 with the content on z-10: an absolutely positioned element paints ABOVE
    // its static siblings, so without this the mark would sit ON the words at
    // narrow widths instead of behind them.
    <span
      aria-hidden="true"
      style={{
        top: `${top}px`,
        right: `${right}px`,
        fontSize: `${FONT_SIZE}px`,
        fontStyle: g.italic ? 'italic' : 'normal'
      }}
      className="pointer-events-none absolute z-0 select-none font-serif leading-none text-[#c0392b]/[0.22]"
    >
      {g.char}
    </span>
  );
};

export default MastheadGlyph;
