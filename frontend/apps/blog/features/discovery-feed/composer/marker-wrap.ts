/**
 * Shared composer internals, extracted from `short-form-composer.tsx` so the
 * quick-reply composer (`quick-reply-composer.tsx`) REUSES them rather than
 * copying — the mirror is enforced by sharing code, not by transcription
 * (QUICK-REPLY-SPEC §3.1 / §7.1). Moving these out of the quick-post component
 * is behaviour-neutral: the definitions are byte-identical to what lived there.
 */

/**
 * A note is short by definition; the counter states the limit it enforces. The
 * SAME 1000-char limit, counter, and over-limit gate the quick-post uses now
 * governs the quick-reply — one constant, so the two cannot drift.
 */
export const MAX_NOTE_LENGTH = 1000;

/**
 * True when `text` has exactly `marker` ending at `index` — i.e.
 * `text.slice(index - marker.length, index) === marker` — AND it is not part
 * of a LONGER run of the same character. Without that second check, selecting
 * the word inside an existing **bold** span and pressing Italic (marker `*`)
 * would read the second `*` of `**` as a lone italic marker and strip it,
 * quietly weakening the bold instead of nesting italic inside it.
 */
export function markerEndsAt(text: string, index: number, marker: string): boolean {
  const start = index - marker.length;
  if (start < 0 || text.slice(start, index) !== marker) return false;
  return text[start - 1] !== marker[0];
}

/** Mirror of `markerEndsAt`, checked forward from `index`. */
export function markerStartsAt(text: string, index: number, marker: string): boolean {
  const end = index + marker.length;
  if (end > text.length || text.slice(index, end) !== marker) return false;
  return text[end] !== marker[0];
}

/**
 * Wraps `text[start, end)` in `marker` (`**` for bold, `*` for italic) for the
 * bold/italic toolbar buttons — or UNWRAPS it if it is already wrapped, so
 * pressing the same button twice toggles rather than double-wrapping
 * (`**bold**` -> `**bold**bold**`). "Already wrapped" covers both shapes: the
 * selection itself includes the markers (`**bold**` selected whole), or the
 * markers sit immediately outside a selection that excludes them (`bold`
 * selected inside `**bold**`). With no selection, the markers are inserted
 * with the caret left between them, ready to type.
 */
export function toggleMarkerWrap(
  text: string,
  start: number,
  end: number,
  marker: string
): { text: string; selectionStart: number; selectionEnd: number } {
  const markerLen = marker.length;
  const selected = text.slice(start, end);

  const wrappedInside =
    selected.length >= markerLen * 2 &&
    markerStartsAt(selected, 0, marker) &&
    markerEndsAt(selected, selected.length, marker);
  if (wrappedInside) {
    const inner = selected.slice(markerLen, selected.length - markerLen);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length
    };
  }

  const wrappedOutside = markerEndsAt(text, start, marker) && markerStartsAt(text, end, marker);
  if (wrappedOutside) {
    return {
      text: text.slice(0, start - markerLen) + selected + text.slice(end + markerLen),
      selectionStart: start - markerLen,
      selectionEnd: start - markerLen + selected.length
    };
  }

  const nextText = text.slice(0, start) + marker + selected + marker + text.slice(end);
  // No selection: land the caret BETWEEN the markers rather than after them.
  return selected.length === 0
    ? { text: nextText, selectionStart: start + markerLen, selectionEnd: start + markerLen }
    : { text: nextText, selectionStart: start + markerLen, selectionEnd: end + markerLen };
}
