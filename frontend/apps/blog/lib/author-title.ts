/**
 * ★ THE ONE REMAINING READER OF `author_title` (2026-08-16, spec "Remove the
 * author_title community badge").
 *
 * The badge is gone from every render path: it printed raw free text that any
 * community's moderators can set on a member with the `set_label` op, in a slot
 * that looked authoritative, arbitrary in length and trivially spoofable
 * ("Verified", "Admin"). Lumen carries two author-identity signals and wants no
 * third: a reputation score for Hive accounts, a quill mark for lite accounts.
 *
 * The field was therefore dropped from the shared `Entry` type so nothing can
 * quietly render it again. But `ChangeTitleDialog` survives on purpose: it is
 * the moderator's `set_label` WRITE control, a real on-chain feature, and the
 * label it sets is still visible on other Hive front ends even though Lumen no
 * longer shows it. That dialog needs the current value to prefill its input.
 *
 * So exactly one reader remains, and it lives here rather than at three call
 * sites. A type GUARD, not an `as` assertion: this repo's CLAUDE.md asks for
 * guards precisely so a shape change surfaces as a `false` at runtime instead of
 * a silent lie to the compiler.
 */
function hasAuthorTitle(value: unknown): value is { author_title?: unknown } {
  return typeof value === 'object' && value !== null && 'author_title' in value;
}

/**
 * The current community label for an entry, or '' when there is none. Prefill
 * only. Never render this: that is the thing the spec removed.
 */
export function authorTitleOf(entry: unknown): string {
  if (!hasAuthorTitle(entry)) return '';
  return typeof entry.author_title === 'string' ? entry.author_title : '';
}
