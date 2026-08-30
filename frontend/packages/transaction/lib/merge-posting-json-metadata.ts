/**
 * ★★★ WHY THIS IS ITS OWN FILE: SO THE FIX CAN BE PROVEN WITHOUT DESTROYING
 * SOMEBODY'S PROFILE TO PROVE IT (2026-08-30).
 *
 * THE DEFECT. `TransactionService.updateProfile` built a FRESH object of exactly
 * eleven keys and broadcast it as the account's WHOLE `posting_json_metadata` in an
 * `account_update2_operation`. It never read the existing document. So every other
 * key was destroyed on chain, irreversibly, under a success toast — both unknown
 * keys inside `profile` AND any top-level key besides `profile`, because the entire
 * document was replaced with `{profile}`.
 *
 * HOW MUCH OF THE WORLD THAT HITS, measured across 108 real Hive accounts drawn from
 * recent posts: 66 of them, SIXTY-ONE PERCENT, carry at least one profile key
 * outside the enumerated set — `pinned` (somebody's pinned post), `tokens`, `badges`,
 * `reputation`, `collections`, `dtube_pub`, `portfolio`, `trail`, `maps`, `birthday`,
 * and plain social links like `twitter` and `instagram`. Other apps' state and the
 * user's own links.
 *
 * ★ THE DEFECT IS OLDER THAN THE FEATURE THAT FOUND IT. It is shared with the
 * account settings page and predates the creator-token work. What changed is WHO
 * reaches it: a creator saving a link to their work from the Meritum launch card,
 * who has no reason to think they are rewriting their Hive profile.
 *
 * ★★ AND WHY IT IS EXTRACTED. The only way to prove the ORIGINAL behaviour end to
 * end is to broadcast a profile update and watch the keys vanish — which means
 * permanently destroying a real account's metadata in order to demonstrate that it
 * destroys a real account's metadata. Nobody should do that. Pulling the merge out
 * as a pure function makes the fix provable by assertion instead: the selftest next
 * to this file drives the exact inputs and asserts the exact output string, with a
 * negative control reproducing the old destructive behaviour so the test cannot pass
 * vacuously.
 */
export function mergePostingJsonMetadata(
  existing: string | undefined,
  profileFields: Record<string, unknown>
): string {
  let preserved: Record<string, unknown> = {};
  let preservedProfile: Record<string, unknown> = {};

  /*
   * Parse defensively. This is chain data: it can be absent, empty, malformed, an
   * array, or a bare string. A parse failure must fall back to "preserve nothing",
   * which is exactly the old behaviour — never to throwing, because that would turn
   * a cosmetic profile save into a hard failure for the user.
   */
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        preserved = parsed as Record<string, unknown>;
        const p = (parsed as Record<string, unknown>).profile;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          preservedProfile = p as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed metadata on chain. Keep nothing extra, change nothing else.
    }
  }

  /*
   * ★★★ `undefined` MEANS KEEP. `''` MEANS CLEAR. (2026-08-31, found by clauderfly-59
   * re-verifying this fix against real account documents rather than accepting it.)
   *
   * The first version of this merge spread `preservedProfile` and then wrote every
   * named field UNCONDITIONALLY. A caller that passes `undefined` for a field it is
   * not editing therefore OVERWROTE the preserved value with undefined, and
   * JSON.stringify drops undefined — so the key vanished anyway. Measured against
   * real documents pulled from api.hive.blog: a website-only save erased
   * `profile_image` and `about` on @blocktrades, five fields on @gtg, four on @peakd.
   *
   * The fix "worked" only because both of today's callers happen to re-send every
   * known field from the loaded profile and both gate Save on that profile having
   * loaded. That made caller discipline load-bearing for a data-loss defect, which is
   * one new caller away from being wrong again — and the whole reason this function
   * exists is that the previous design put that burden in the wrong place.
   *
   * So: an ABSENT field is "I am not editing this, keep what is there". An EMPTY
   * STRING is an explicit "clear it", which is what the settings form sends when a
   * user empties a box. Those are different intentions and the type could not tell
   * them apart before.
   */
  const edits: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profileFields)) {
    if (v !== undefined) edits[k] = v;
  }

  return JSON.stringify({
    ...preserved,
    profile: { ...preservedProfile, ...edits }
  });
}
