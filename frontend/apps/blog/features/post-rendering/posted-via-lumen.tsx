import { isLumenProxiedEntry } from '@/blog/lib/lite/render/lite-post-id';
import { hasAttributionFooter } from '@transaction/lib/attribution';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "posted via lumen" — the attribution line under everything Lumen published.
 * Owner, 2026-08-21: "i need you to add in italic 'posted via lumen' in every
 * comment, and every post ever made via lumen ... it always need to go out in
 * bottom of every comment, and every post." It is how the product promotes
 * itself, so it ships wherever Lumen's own writing is rendered.
 *
 * ★★★ IT RENDERS ONLY FOR LUMEN'S OWN ENTRIES, and that is the whole contract.
 * These posts live on Hive and are read by other Hive front ends, alongside
 * posts written on peakd, ecency and hive.blog. Printing this line under a post
 * Lumen did not publish would be a false claim of authorship-by-tooling on
 * somebody else's writing. `isLumenProxiedEntry` is the app's single answer to
 * "did this come from us" — it matches Lumen's own permlink namespace or the
 * `app: "lumen/1.0"` / `lumen_post_id` markers `publisher/footer.ts` stamps at
 * publish time. Do not loosen it to "the author is a lite account": an account
 * can be Lumen-native and still have written the post somewhere else.
 *
 * ★★ ONE COMPONENT, TWO SURFACES, ON PURPOSE. The line goes under posts AND
 * under comments, which are rendered by two unrelated files. Two copies would
 * drift the moment either the wording or the detection changed — and the
 * detection is the half that matters, because a wrong answer there attributes
 * our brand to a stranger's words.
 *
 * ★★ IT NEVER DOUBLES UP WITH THE ON-CHAIN FOOTER. Posts and comments broadcast
 * through Lumen carry `*Posted via Lumen*` in the BODY itself, so the text
 * travels to peakd, ecency and hive.blog, which render it as ordinary post
 * content. Those frontends therefore show attribution exactly once. Lumen showed
 * it TWICE — the body footer, then this byline underneath. Owner, 2026-08-28:
 * "only make it show up once ... dont make it show twice." So when the body
 * already carries the footer, this renders nothing and the footer is the single
 * copy; when it does not (a lite entry rendered from our own DB, where the
 * footer is only added at broadcast time), this byline is the single copy.
 * Exactly one, on every surface, either way.
 *
 * ★ IT IS NOT A BADGE. No border, no chip, no background: it is a byline, set
 * in the same italic the product uses for asides, at the quietest ink that still
 * clears AA. The lite quill in the byline already says "this account is Lumen";
 * this says "this text was written here", which is a different claim.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function PostedViaLumen({
  entry,
  className
}: {
  /**
   * The post or comment being rendered. Nothing renders when it is not ours,
   * and nothing renders when its body already carries the attribution footer.
   * `body` is optional so the absent case fails SAFE: an entry shape without a
   * body falls through to rendering the byline, which is one attribution — the
   * opposite mistake (suppressing on a missing field) would show none at all.
   */
  entry: Parameters<typeof isLumenProxiedEntry>[0] & { body?: string };
  className?: string;
}) {
  if (!isLumenProxiedEntry(entry)) return null;
  if (hasAttributionFooter(entry?.body)) return null;

  return (
    <p
      className={`font-sans text-caption italic text-ink-14 ${className ?? ''}`}
      data-testid="posted-via-lumen"
    >
      posted via lumen
    </p>
  );
}
