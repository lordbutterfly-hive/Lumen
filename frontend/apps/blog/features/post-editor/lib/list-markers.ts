/**
 * ★ MARKER SHAPES, KEPT FREE OF `@codemirror/*` ON PURPOSE (2026-08-16).
 *
 * These regexes started out private to `list-continuation.ts`, which needs
 * them to recognise a bullet/ordered/task/blockquote marker Enter just
 * auto-inserted and nobody has typed into yet. LOW 12 needed the exact same
 * shape check for the live PREVIEW — `PostPreviewPanel.tsx` must not render
 * the same untouched marker as a genuine empty list item — but
 * `list-continuation.ts` imports `@codemirror/view`, `@codemirror/state` and
 * `@codemirror/lang-markdown` at module scope to build its CodeMirror
 * extensions, and those run at import time, not inside a function a bundler
 * could tree-shake away.
 *
 * That matters here specifically because `md-editor.tsx` — the only other
 * consumer of `list-continuation.ts` — is loaded via
 * `dynamic(() => import(...), { ssr: false })` in `post-form.tsx`, precisely
 * to keep CodeMirror out of the bundle until the editor actually mounts.
 * `PostPreviewPanel.tsx` is imported statically into that same `post-form.tsx`.
 * Importing `stripUnfilledTrailingMarker` from `list-continuation.ts` directly
 * would drag CodeMirror into the static bundle right along with it and
 * silently undo that split. This file has no such import, so it can't.
 */

/** One markdown block marker: bullet, ordered, either with a task-list box, or a blockquote. */
export const MARKER = String.raw`(?:[-*+](?:[ \t]+\[[ xX]\])?|\d+[.)](?:[ \t]+\[[ xX]\])?|>)`;

/** A line carrying nothing but indentation and one marker — i.e. a bullet nobody has written into yet. */
export const MARKER_ONLY_RE = new RegExp(`^[ \\t]*${MARKER}[ \\t]*$`);

/** Exactly "indent + marker + one space" — the shape of a marker somebody has just finished typing. */
export const TYPED_MARKER_RE = new RegExp(`^[ \\t]*${MARKER}[ \\t]$`);

/**
 * ★ LOW 12 (2026-08-16) — THE PREVIEW MUST NOT RENDER THE MARKER
 * `dropUnusedTrailingMarker` (in `list-continuation.ts`) HASN'T GOTTEN TO YET.
 *
 * That handler only runs on blur — by design, so a bullet mid-thought is
 * never yanked out from under someone still typing (see its own comment).
 * But the live preview re-renders on every debounced keystroke WHILE focus is
 * still in the editor, so the exact same untouched `"- "` (or `"1. "`,
 * `"> "`, `"- [ ] "`) line renders as a genuine empty `<li>` / blockquote in
 * the preview pane before the author has written anything into it — a stray
 * bullet that has nothing to do with what they are actually composing.
 *
 * This can't reuse `list-continuation.ts`'s own `provisionalMarker` state:
 * that field lives on the `EditorView` the editor tracks, and the preview
 * only ever sees the plain markdown string, 300ms after a change and with no
 * view to read state from (`use-post-form-actions.ts`'s
 * `handlePostAreaChange`). So it re-derives the same narrow shape check —
 * marker, nothing else, on the document's LAST line only — straight from the
 * text. Restricting to the last line matters: it is the one line Enter could
 * just have opened, so it is the only line safe to assume is still
 * provisional. A marker-only line earlier in the document is either an
 * intentional empty item the author left there on purpose, or one they have
 * not reached yet on this editing pass — either way, not this function's
 * call to make.
 *
 * Preview-only, by construction: this returns a new string. The editor's own
 * document, the draft in `localStorage`, and whatever eventually gets posted
 * are never touched here — only the copy handed to the renderer for display.
 */
export function stripUnfilledTrailingMarker(markdown: string): string {
  const lastNewline = markdown.lastIndexOf('\n');
  const lastLine = markdown.slice(lastNewline + 1);
  if (!MARKER_ONLY_RE.test(lastLine)) return markdown;
  return lastNewline === -1 ? '' : markdown.slice(0, lastNewline);
}
