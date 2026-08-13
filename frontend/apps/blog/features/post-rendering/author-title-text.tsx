/**
 * Renders a community's `author_title` — free text a community's moderators set
 * on a member (e.g. "ASEAN Hive VIP 🥈 SILVER").
 *
 * ★ WHY THIS EXISTS (2026-08-13, reported). The field is arbitrary user text and
 * frequently contains emoji. An emoji glyph comes from the system's colour-emoji
 * font, not from Open Sans, so it ignores the surrounding font-size relationship
 * and sits on its own baseline — inside a small outlined badge that makes the
 * badge grow and the text ride high next to it.
 *
 * Each pictographic run is wrapped and pinned to exactly `1em` with a small
 * negative `vertical-align`, so it can never be taller than the line it sits on
 * and sits on the text's own baseline. The text itself is untouched — this is
 * presentation only, and the title still reads exactly as the moderators wrote
 * it, which matters because it is not a Lumen badge or any kind of verification.
 */
const PICTOGRAPHIC = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/gu;

export function AuthorTitleText({ title }: { title: string }) {
  const parts = title.split(PICTOGRAPHIC).filter((p) => p !== '');
  return (
    <>
      {parts.map((part, i) =>
        PICTOGRAPHIC.test(part) ? (
          // eslint-disable-next-line react/no-array-index-key -- the parts of one short string, order-stable
          <span key={i} className="inline-block align-[-0.1em] text-[1em] leading-none">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

export default AuthorTitleText;
