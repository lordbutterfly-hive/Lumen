import { isLumenProxiedEntry } from '@/blog/lib/lite/render/lite-post-id';

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
  /** The post or comment being rendered. Nothing renders when it is not ours. */
  entry: Parameters<typeof isLumenProxiedEntry>[0];
  className?: string;
}) {
  if (!isLumenProxiedEntry(entry)) return null;

  return (
    <p
      className={`font-sans text-caption italic text-ink-14 ${className ?? ''}`}
      data-testid="posted-via-lumen"
    >
      posted via lumen
    </p>
  );
}
