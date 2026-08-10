import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { setInterests } from '@/blog/lib/lite/repositories/user-repository';
import { countAuthoredByUser } from '@/blog/lib/lite/repositories/post-repository';
import {
  findHiveReaderPrefs,
  setHiveReaderInterests
} from '@/blog/lib/lite/repositories/hive-reader-prefs-repository';
import { getAccountFull } from '@transaction/lib/hive-api';
import { invalidateViewerFeed } from '@/blog/lib/feed/feed-cache';
import {
  INTERESTS,
  MAX_INTERESTS,
  MIN_INTERESTS,
  sanitizeInterestIds
} from '@/blog/lib/lite/interests/taxonomy';

const logger = getLogger('app');

/**
 * GET  /api/lite/interests — the taxonomy plus this reader's current picks.
 * POST /api/lite/interests — { interests: string[] } save the picks.
 *
 * ★ WHY THIS EXISTS. recsys has accepted `explicit_interest_tags` since it was
 * built and NOTHING ever supplied them, so a fresh reader reached the ranker
 * with no follows, no interests and no history — measured 2026-08-06: every
 * result came back `popular_fallback`. The engine was correct; the product
 * never asked the question.
 *
 * ★★ AND IT ONLY ASKED HALF ITS READERS (fixed 2026-08-08). Eligibility used to
 * be "is there a LITE actor", so a reader signed in with their existing Hive
 * account got `eligible: false`, never saw the picker, and was ranked with no
 * interests at all — the audience with the most to bring, ignored. Both tiers
 * are handled here now, against two different stores for one good reason: a
 * lite reader HAS a Lumen identity row to hang preferences on; a Hive reader
 * does not and should not be given one (see hive-reader-prefs-repository).
 *
 * ★★★ AND THE TWO-STORE SPLIT WAS AN AUTH HOLE (fixed 2026-08-10, live-proven).
 *
 * Both handlers asked `requireActiveLiteUser` whether the caller could act and
 * then, if the answer was NO, carried on into the Hive-reader branch — which is
 * gated on nothing but `session.user.username` being present. So the auth check
 * was decorative. Measured: a cookie that `/api/lite/profile` answered 401 got
 * `{"status":"ok"}` from `POST /api/lite/interests` and wrote a row. Same class as
 * the F-L3 hole closed in `http/actor.ts`, reopened by a fall-through.
 *
 * It also wrote it under the WRONG KEY. `session.user.username` for a lite account
 * is their Lumen display name, so the picks landed in `lumen_hive_reader_prefs` —
 * the table keyed by HIVE account name. Nothing reads a lite user's interests from
 * there (the ranker reads `lumen_user`), so an upgraded user's picks went to a row
 * no one reads, and a real Hive account later registered under that name would
 * inherit a stranger's preferences.
 *
 * The fix is to decide WHICH READER THIS IS FIRST, from the session, and then let
 * exactly one branch run. A lite session that fails its actor check is refused —
 * it never reaches the Hive store. `whichReader` below is that decision, made once
 * and shared by GET and POST so the two cannot drift.
 */

type Reader = { kind: 'lite' } | { kind: 'hive'; hiveAccount: string } | { kind: 'none' };

/**
 * Which of the two stores is this caller's, decided from the SESSION rather than
 * from whether an auth check happened to pass.
 *
 * ★ A session carrying a `userId` or a lite tier IS a lite session, whatever the
 * actor check then says about it. That is the whole point: "the lite check failed"
 * must mean REFUSED, never "try the other store". Judging by session shape and not
 * by check outcome is what makes the fall-through unexpressible.
 */
function whichReader(session: { user?: { username?: string; userId?: string; account_tier?: string } }): Reader {
  const user = session.user;
  if (!user?.username) return { kind: 'none' };
  if (user.userId || user.account_tier === 'lite') return { kind: 'lite' };
  return { kind: 'hive', hiveAccount: user.username };
}

/** The 'when should the picker introduce itself' rule, in one place. */
interface Eligibility {
  /** There is a real signed-in reader whose picks we can store. */
  eligible: boolean;
  /** We have asked before — never nag again, whatever they answered. */
  asked: boolean;
  /** Their current picks. */
  selected: string[];
  /**
   * ★ OWNER RULE, 2026-08-08: the picker fires for a reader with ZERO posts and
   * ZERO comments, and only if it has not fired before. Someone who has already
   * written here has told us what they are into by doing; interrupting them
   * with a questionnaire is noise. Reported separately from `asked` so the
   * client can distinguish "not now" from "never again" — and so an explicit
   * "edit my interests" entry point can ignore it.
   */
  blankSlate: boolean;
}

const SIGNED_OUT: Eligibility = { eligible: false, asked: false, selected: [], blankSlate: false };

async function resolveReader(): Promise<Eligibility> {
  let session;
  try {
    session = await getLiteSession();
  } catch {
    return SIGNED_OUT;
  }
  const reader = whichReader(session);
  if (reader.kind === 'none') return SIGNED_OUT;

  // ---- Lite reader: identity and preferences both live on `lumen_user`.
  if (reader.kind === 'lite') {
    const actor = await requireActiveLiteUser(session.user, session);
    // Revoked, suspended, banned or upgraded. Report "no picker" and STOP — the
    // Hive branch below is not a fallback for a lite session that may not act, and
    // treating it as one both bypassed the check and read the wrong table.
    if (!actor.ok) return SIGNED_OUT;
    // Counts EVERYTHING they authored, visible or not — see countAuthoredByUser.
    const authored = await countAuthoredByUser(actor.user.userId).catch(() => 1);
    return {
      eligible: true,
      asked: actor.user.interestsSetAt !== null,
      selected: actor.user.interests ?? [],
      blankSlate: authored === 0
    };
  }

  // ---- Hive reader: preferences only, keyed by their Hive name.
  const hiveAccount = reader.hiveAccount;
  const prefs = await findHiveReaderPrefs(hiveAccount).catch(() => null);

  // Hive's own `post_count` is posts AND comments combined, which is exactly
  // the rule's "zero posts and zero comments". If the chain call fails we assume
  // NOT a blank slate: the cost of wrongly staying quiet is a reader who can
  // still set interests from settings; the cost of wrongly interrupting is a
  // modal in the face of an established author every time Hive rate-limits us.
  let blankSlate = false;
  try {
    const account = await getAccountFull(hiveAccount);
    blankSlate = (account?.post_count ?? 1) === 0;
  } catch (error) {
    logger.warn('interests: could not read Hive post_count for %s, assuming not a new reader: %o', hiveAccount, error);
  }

  return {
    eligible: true,
    asked: prefs?.interestsSetAt != null,
    selected: prefs?.interests ?? [],
    blankSlate
  };
}

export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  let reader = SIGNED_OUT;
  try {
    reader = await resolveReader();
  } catch (error) {
    // The picker is an enhancement to onboarding and must never be a blocker:
    // still serve the taxonomy so an explicit "edit interests" screen renders.
    logger.warn('interests: could not resolve reader: %o', error);
  }

  return NextResponse.json({
    interests: INTERESTS,
    selected: reader.selected,
    asked: reader.asked,
    eligible: reader.eligible,
    blankSlate: reader.blankSlate,
    max: MAX_INTERESTS,
    min: MIN_INTERESTS
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const reader = whichReader(session);
  if (reader.kind === 'none') {
    return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  // Sanitized against the taxonomy, capped, de-duplicated: picks are
  // client-supplied and a tag the taxonomy does not define has no business
  // reaching the ranker.
  const picks = sanitizeInterestIds(body?.interests);

  try {
    if (reader.kind === 'lite') {
      const actor = await requireActiveLiteUser(session.user, session);
      // ★ RETURN THE REFUSAL. This is the line the bug was missing: the failure
      // used to fall through to the Hive store below, so a revoked/suspended/banned
      // session wrote a row anyway — under its LITE handle, in the HIVE-keyed table.
      // No `.catch(() => null)` either: a database failure here is a 500, not a
      // reason to write somewhere else.
      if (!actor.ok) return actor.response;
      const updated = await setInterests(actor.user.userId, picks);
      if (!updated) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
      // ★ The preference changed, so the feed built from the OLD one must go —
      // see below.
      invalidateViewerFeed(actor.user.displayName);
      return NextResponse.json({ status: 'ok', selected: updated.interests });
    }

    const saved = await setHiveReaderInterests(reader.hiveAccount, picks);
    // ★ DROP THE CACHED FEED HERE, NOT IN THE BROWSER (2026-08-08).
    //
    // The picker also re-requests the feed with `?refresh=1`, but that is a
    // client-side courtesy and it is not reliable: it can race the page reload
    // that follows it, or warm a different `limit` than the page then asks for.
    // A tester walked the real "Tune your feed" flow, watched the save land in
    // the database, and was served the pre-change feed back marked
    // `cache: fresh` — from their chair the picker did nothing at all.
    //
    // The server is what changed the preference, so the server drops the cache.
    // The next read rebuilds, and a reader can no longer be shown a feed built
    // from interests they have already replaced.
    invalidateViewerFeed(reader.hiveAccount);
    return NextResponse.json({ status: 'ok', selected: saved.interests });
  } catch (error) {
    logger.error(error, 'Saving reader interests failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
