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

/* ── 2026-08-14 · image upload failures all said "try again", even when that
   is wrong advice ──────────────────────────────────────────────────────── */
// ★ WHY. `uploadImg` (this file's sibling `utils.ts`) is the ONE image
// pipeline (see `components/hooks/use-image-upload.ts`'s own header comment)
// shared by this editor, the short-form composer and account settings, and
// its catch block used to fold every failure into the SAME generic toast,
// "try again" included. That is wrong for a Keychain user: retrying a signing
// request Keychain just failed will fail the exact same way again until the
// user unlocks Keychain (or installs it), not because our upload code hit a
// blip.
//
// What `uploadImg`'s catch can actually tell apart, read from
// `@hiveio/wax-signers-keychain`'s `KeychainProvider.encryptData` (only a
// dependency of `packages/smart-signer`, not of this app — so `utils.ts`
// matches these two exact strings rather than importing the class and doing
// an `instanceof` check):
//   - `Keychain is not installed` — thrown synchronously by
//     `ensureKeychainInstalled()` before any request reaches the extension.
//     Certain: the extension is not there at all.
//   - `Keychain error: ` + whatever the extension's own response said —
//     thrown for every OTHER way Keychain can fail a request: locked and the
//     unlock prompt was cancelled, unlocked and the user declined to sign,
//     the wrong account loaded, or an internal Keychain error. The extension
//     is confirmed present and reachable; WHICH of those it was is not
//     something this code can further divide without parsing undocumented
//     text Keychain itself writes into that message. So this copy names the
//     single most common, most actionable cause (locked) without claiming
//     it is the only one — honest for all of them, not a guess dressed as a
//     diagnosis.
// Everything else that reaches this catch — a network failure reaching the
// imagehoster, a bad response body, `signer` still `null` because
// `SignerProvider`'s async setup has not finished yet (see that file: the
// signer starts `null` and is built from a dynamic import) — is genuinely
// worth retrying, so that copy still says so.
export const IMAGE_UPLOAD_KEYCHAIN_MISSING =
  'Hive Keychain is not installed, so this image could not be signed. Install the extension and try again.';
export const IMAGE_UPLOAD_KEYCHAIN_DECLINED =
  'Hive Keychain could not sign this image. If it is locked, unlock it and try again.';
export const IMAGE_UPLOAD_ACCOUNT_NOT_READY =
  'Your account was not ready to sign this image yet. Wait a moment and try again.';
export const IMAGE_UPLOAD_FAILED_RETRY = 'Could not upload that image. Try again in a moment.';

/* ── the live "draft saved" cue (owner, 2026-09-02: "the posting area lacks a
   draft save ... people ... lose the post") ──────────────────────────────────

   The composer HAS auto-saved to localStorage every 500 ms for weeks, and the
   masthead even promises "Saved as you type" — but nothing on screen ever
   CONFIRMED a save had happened, so the owner (and every writer) read the
   silence as "there is no draft save". PeakD shows a small, live "draft saved"
   cue; this is Lumen's, in the app's quiet muted-caption voice. Shared by the
   long-form composer and the reply box so the two can never word it
   differently — the same reason `RC_LABEL`/`RC_EXPLAINER` are shared.

   "Saving…" uses the ellipsis character the rest of the app already uses
   ("Posting…", "Publishing…"), not three dots; no em or en dashes, per the
   rules at the top of this file. */
export const DRAFT_STATUS_SAVING = 'Saving…';
export const DRAFT_STATUS_SAVED = 'Draft saved';
