/**
 * The live-preview size gate, as a decision rather than a flag.
 *
 * ★★★ WHY THIS IS NOT A BOOLEAN (2026-08-10). The preview stops rendering above
 * `LIVE_PREVIEW_MAX_CHARS` because a single multi-MB paste hands the whole
 * document to the markdown renderer in one synchronous pass and the tab never
 * comes back. "Render preview anyway" is the escape hatch — and it used to set a
 * plain `renderHugePreview` boolean that nothing ever reset. One click, at any
 * size over the limit, disabled the guard for the rest of the session, so the
 * next paste — at 5 MB — went straight through and froze the tab the feature
 * exists to protect.
 *
 * The opt-in is therefore a SIZE: the number of characters the writer accepted
 * the wait for. It keeps holding while the document stays within one further
 * gate's worth of that budget, which is the property that matters — render cost
 * is proportional to length. Ordinary typing never adds 200,000 characters, so
 * the gate never re-arms mid-sentence; a pathological paste blows past it at
 * once and the gate closes again.
 */

/**
 * Above this many characters the live preview stops rendering automatically.
 * A long-form Hive post is a few tens of thousands of characters, so this sits
 * far above any real article and only catches the pathological paste that
 * freezes the tab. It is a character count rather than bytes because that is
 * what the renderer actually walks.
 */
export const LIVE_PREVIEW_MAX_CHARS = 200_000;

/**
 * Should the preview stay paused?
 *
 * @param previewChars  length of the content the preview would render
 * @param approvedChars length the writer clicked "render anyway" for, or null if
 *                      they never have
 */
export function previewGateHolds(
  previewChars: number,
  approvedChars: number | null,
  limit: number = LIVE_PREVIEW_MAX_CHARS
): boolean {
  if (previewChars <= limit) return false;
  if (approvedChars === null) return true;
  return previewChars > approvedChars + limit;
}
