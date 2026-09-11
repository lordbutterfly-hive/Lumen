import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * ★★★ THE PER-POST LINK PREVIEW (2026-08-18).
 *
 * Every Lumen link pasted into X, Discord, Slack or iMessage used to render
 * hive.blog's artwork and hive.blog's copy — the product's main introduction to
 * people who have never used it was an advert for a different product. The
 * static default card fixed that for the site; this fixes it per POST, which is
 * the one that actually recruits: a shared post shows its own headline, set in
 * the product's own typeface, on the product's own paper.
 *
 * Built to the delivered LP8 spec, values verbatim from the asset README so the
 * generated card and the drawn one cannot drift:
 *
 *   Canvas    1200 x 630, rgb(252 250 247), 88px margin on all four sides
 *   Imprint   Lora 700, 23px, 0.22em tracking, uppercase (was Open Sans 700
 *             until the all-Lora migration, 2026-08-19; the px value and the
 *             tracking are unchanged because caps do not need compensating)
 *             LUMEN · COMMUNITY · @HANDLE — community segment AND its separator
 *             drop entirely when there is no community
 *   Title     Lora 700, max 3 lines, line-height 1.06, tracking -0.035em
 *             <=45 chars 92px · 46-82 78px · 83-124 66px · past that truncate
 *             on a word at 66. Never smaller than 66.
 *   Floor     4px rule
 *   No buttons, no counts, no payout — the card cannot be clicked, so anything
 *   that looks interactive is a lie.
 *
 * ★ WHY THE FONTS ARE VENDORED, AND WHY THEY ARE STATIC CUTS. `next/font/google`
 * self-hosts only `.woff2`, and Satori (what renders this) cannot read woff2 —
 * it needs ttf/otf. Google Fonts now publishes Lora ONLY as a variable
 * font, and Satori cannot read those either: it dies in `parseFvarAxis` with
 * "Cannot read properties of undefined" the moment it meets an `fvar` table.
 * So the face is instantiated down to a static wght=700 cut with fontTools and
 * committed to `public/fonts` beside its OFL licence. If this ever renders in
 * the wrong face, check that file still has no `fvar` table. Do NOT replace it
 * with a fresh Google download — that download is variable and will crash the
 * route. (The Open Sans cut that used to sit beside it was deleted with the
 * all-Lora migration, 2026-08-19.)
 */
export const runtime = 'nodejs';

const PAPER = 'rgb(252, 250, 247)';
const INK = 'rgb(26, 22, 18)';
const INK_SOFT = 'rgb(110, 100, 90)';

/** The tight editorial leading the card is designed around. */
const TITLE_LINE = 1.06;
/**
 * How far Lora's descenders fall below a 1.06em line box, in em. Lora's natural
 * line height is about 1.3em; with the box set tighter than that, the overflow
 * splits above and below, so roughly (1.3 - 1.06) / 2 hangs under the last line.
 * Rounded up, because a clipped tail is worse than a few unused pixels on a card
 * with 240px of vertical slack.
 */
const DESCENDER_EM = 0.16;

/** Verbatim from the spec: the size ladder, and the floor it never goes below. */
function titleSize(length: number): number {
  if (length <= 45) return 92;
  if (length <= 82) return 78;
  return 66;
}

/** Truncate on a WORD, never mid-word, and only past the last size step. */
function fitTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  // ★ 96, NOT 124 (2026-09-11). At the 66px floor a line holds roughly 31
  // characters across the 1024px of content width, so three lines is about 93.
  // A 124-character title was therefore a FOUR line title that the maxHeight
  // below then guillotined, which is not truncation, it is damage: the reader
  // got a fragment with no ellipsis to tell them it was cut. Truncating on a
  // word with a visible "…" says what happened.
  if (title.length <= 96) return title;
  const cut = title.slice(0, 96);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:—-]+$/, '')}…`;
}

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(process.cwd(), 'public', 'fonts', file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function GET(req: NextRequest): Promise<Response> {
  const params = req.nextUrl.searchParams;
  const rawTitle = params.get('title') ?? '';
  const author = params.get('author') ?? '';
  const community = params.get('community') ?? '';

  const lora = await font('Lora-Bold.ttf');

  const title = fitTitle(rawTitle);
  const size = titleSize(title.length);

  // Everything after the wordmark, so a missing community takes its separator
  // with it rather than leaving a stranded middot.
  const imprintRest = [community ? community.toUpperCase() : '', author ? `@${author.toUpperCase()}` : '']
    .filter(Boolean)
    .join('  ·  ');

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: PAPER,
          padding: '88px'
        }}
      >
        {/*
          ★ THE WHOLE IMPRINT IS LORA NOW (2026-08-19, all-Lora migration).
          This used to be Lora wordmark + Open Sans caps, and the note here
          argued that setting the whole line in one family would lose the piece
          that is brand rather than metadata. It would have, when the other
          family was a sans. It does not now: the wordmark still separates from
          the metadata on three axes it always had anyway — 30px against 23px,
          zero tracking against 0.22em, and INK against INK_SOFT. What it no
          longer does is contradict the product, where nothing is set in a sans.

          ★ THIS FILE DOES NOT FOLLOW THE CSS TOKEN. Satori renders it from the
          vendored `.ttf` below, so `--font-lora` means nothing here and the
          family name is whatever the `fonts` array registers. Changing the app
          font does NOT change this card; changing this card is a separate edit,
          which is exactly why the old pairing survived every previous swap.
        */}
        <div style={{ display: 'flex', alignItems: 'baseline', color: INK_SOFT }}>
          <div style={{ display: 'flex', fontFamily: 'Lora', fontWeight: 700, fontSize: '30px', color: INK }}>
            Lumen
          </div>
          {imprintRest ? (
            <div
              style={{
                display: 'flex',
                fontFamily: 'Lora',
                fontWeight: 700,
                fontSize: '23px',
                // Kept at 23px and 0.22em, NOT scaled up with the rest of the
                // migration: Lora's cap-height is only 2.8% below Open Sans's
                // (against 8% on the x-height), so uppercase does not need the
                // compensation lowercase does. Growing it would make the
                // metadata louder than the wordmark it sits beside.
                letterSpacing: '0.22em',
                marginLeft: '18px'
              }}
            >
              {`·  ${imprintRest}`}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            fontFamily: 'Lora',
            fontWeight: 700,
            fontSize: `${size}px`,
            lineHeight: TITLE_LINE,
            letterSpacing: '-0.035em',
            color: INK,
            /**
             * ★★★ THREE LINES, WITH ROOM FOR THEIR TAILS (2026-09-11, owner:
             * "the post card clips the bottom of the title... it bites the lower
             * part of text").
             *
             * This was `size * 1.06 * 3` exactly, and 1.06 is TIGHTER than Lora's
             * natural line height. A glyph is drawn from its own baseline, not
             * inside the line box, so every descender (g, y, p, j) hangs below
             * that box by roughly half the difference. Clipping at exactly three
             * boxes therefore cut through the tails on the THIRD line every time,
             * which is why it only showed up on long titles. Reproduced at 66px
             * with "…Programming Gigs" and fixed against the same render.
             *
             * The extra allowance is descender room ONLY. It is deliberately
             * smaller than a line, so a fourth line can never peek above the cut
             * as a sliver of letter-tops, and `fitTitle` above now truncates
             * before four lines are reachable anyway.
             */
            maxHeight: `${Math.round(size * (TITLE_LINE * 3 + DESCENDER_EM))}px`,
            overflow: 'hidden'
          }}
        >
          {title || 'Lumen'}
        </div>

        <div style={{ display: 'flex', width: '100%', height: '4px', backgroundColor: INK }} />
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [{ name: 'Lora', data: lora, weight: 700, style: 'normal' }]
    }
  );
}
