/**
 * Composer copy that is Lumen's, not Condenser's.
 *
 * ★ WHY THESE ARE CONSTANTS AND NOT TRANSLATION KEYS.
 *
 * This is the convention already set inside this feature and beside it —
 * `PostPublishingSection.tsx` (`LITE_REWARDS_NOTE`, `RC_LABEL`, `RC_EXPLAINER`),
 * the draft-save-failed banner in `post-form.tsx`, the preview-size gate in
 * `PostPreviewPanel.tsx`, `LABELS` in `features/layouts/app-header.tsx`: new
 * Lumen wording lives next to its component until the whole Lumen vocabulary is
 * translated in one pass, rather than half-populating nine locale files with
 * English.
 *
 * There is a second, harder reason here. The `locales/<lang>/common_blog.json`
 * files are shared by every surface in the app and are edited concurrently by
 * whoever is working on any of them. During this pass

 * an edit to `locales/en/common_blog.json` was overwritten wholesale by another
 * change to the same file, and the composer silently reverted to the old strings
 * — the wrong ones — with no error anywhere. Copy that belongs to exactly one
 * screen does not need to sit in a nine-way shared file to reach that screen.
 *
 * Everything below replaces a specific measured defect. Keep the rules the
 * strings already follow: no em or en dashes, and none of the banned words.
 */

/* ── C-1 · the restored draft, which used to arrive in silence ───────────── */
export const RESTORED_DRAFT_TITLE = 'Restored draft';
export const RESTORED_DRAFT_DESCRIPTION =
  'This is what you were writing here last time. It was saved in this browser and has not been published.';
export const RESTORED_DRAFT_KEEP = 'Keep writing';
export const RESTORED_DRAFT_DISCARD = 'Discard draft';

/* ── C-2 · "Required when post to My Blog" was not a sentence ────────────── */
export const TAGS_REQUIRED = 'Add at least one tag when you post to My blog';

/* ── C-4 · missing space, and "SEO" is jargon in front of a first-time writer */
// The 140-character limit is NOT repeated here: the live "0/140" counter sits
// inside the same field and says it better. Spelling it out as well pushed the
// placeholder past the width of the input and it truncated mid-word.
export const POST_SUMMARY_PLACEHOLDER = 'Post summary (shown in feeds and search results)';

/* ── C-3 / C-4 · the raw developer field, now inside Advanced settings ───── */
export const ALTERNATIVE_AUTHOR_LABEL = 'Alternative author';
export const ALTERNATIVE_AUTHOR_DESCRIPTION =
  'Credit someone else as the writer. This only records a name on the post. It does not change who signs it or who is paid.';
export const ALTERNATIVE_AUTHOR_PLACEHOLDER = 'Account name (optional)';

/* ── C-5 · persistent settings, moved out of the formatting toolbar ──────── */
export const EDITOR_OPTIONS_LABEL = 'Editor options';

/* ── C-10 · accessible names for the icon-only bar and its spoiler button ── */
export const FORMATTING_TOOLBAR_LABEL = 'Text formatting';
export const SPOILER_LABEL = 'Spoiler';

/* ── C-13 · the unlabelled floating glyph, now a labelled toggle ─────────── */
export const SYNC_SCROLL_ON = 'Scrolling together';
export const SYNC_SCROLL_OFF = 'Scrolling separately';

/* ── C-9 · "Clean" for an unconfirmed destructive action ─────────────────── */
export const DISCARD_DRAFT = 'Discard draft';
export const DISCARD_DRAFT_CONFIRM_TITLE = 'Discard this draft?';
