import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { enforceProfileWriteRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { setInterests } from '@/blog/lib/lite/repositories/user-repository';
import { countAuthoredByUser } from '@/blog/lib/lite/repositories/post-repository';
import {
  findHiveReaderPrefs,
  setHiveReaderInterests
} from '@/blog/lib/lite/repositories/hive-reader-prefs-repository';
import { getAccount } from '@transaction/lib/hive-api';
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

/**
 * ★★★★ THE HIVE BRANCH PAID FOR TWO SEQUENTIAL CHAIN CALLS TO ANSWER ONE
 * BOOLEAN, ON EVERY HOME-PAGE LOAD (fixed 2026-08-11, measured).
 *
 * `getAccountFull` runs `database_api.find_accounts` and, only after that
 * resolves, awaits `bridge.get_profile` for follow-stats and reputation —
 * two round trips to api.hive.blog, one blocking the other, and this branch
 * reads neither field. `post_count` and `created` (all this needs) are
 * already on the `find_accounts` response, so `getAccount` (one call) is the
 * whole answer. Measured against the running dev server: this route alone
 * ranged 0.3s-46s depending on contention, and the outbound
 * `POST https://api.hive.blog/` calls it makes were independently measured
 * elsewhere on the same page render at 3.6-4.1s — cutting the second
 * sequential call removes roughly half of that, unconditionally.
 *
 * It is also cached per Hive account for a few minutes. This branch runs on
 * the HOME PAGE — every reload, for every full-Hive reader, most of whom are
 * years past their first week and will answer `eligible:false` forever. The
 * client already dedupes concurrent mounts (see interest-picker.tsx) and
 * holds the response for 5 minutes in `react-query`, but that cache lives in
 * the tab and is gone on the next hard reload; this one survives across
 * reloads and tabs for the same signed-in reader, which is the case that was
 * actually re-paying the chain round trip. Small and TTL'd, not indefinite:
 * a reader who crosses the first-week boundary or writes their first post
 * should not be stuck behind a stale answer for long.
 */
const HIVE_ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const HIVE_ACCOUNT_CACHE_MAX_ENTRIES = 1000;
const hiveAccountCache = new Map<string, { post_count: number; created?: string; expiresAt: number }>();

async function getHiveAccountBasics(
  hiveAccount: string
): Promise<{ post_count: number; created?: string } | null> {
  const cached = hiveAccountCache.get(hiveAccount);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // Errors are NOT cached — a transient chain failure should not be pinned in
  // place for the TTL. Let it propagate; the caller already treats a failed
  // lookup as "established" (see the try/catch around this in resolveReader).
  const account = await getAccount(hiveAccount);
  if (!account) return null;

  if (hiveAccountCache.size >= HIVE_ACCOUNT_CACHE_MAX_ENTRIES) {
    // Insertion-ordered Map: the oldest entry is whatever was set first.
    // Not LRU, just a bound, so a long-running server can't grow this
    // unboundedly across every distinct Hive account it has ever served.
    const oldestKey = hiveAccountCache.keys().next().value;
    if (oldestKey !== undefined) hiveAccountCache.delete(oldestKey);
  }

  const entry = { post_count: account.post_count ?? 0, created: account.created, expiresAt: Date.now() + HIVE_ACCOUNT_CACHE_TTL_MS };
  hiveAccountCache.set(hiveAccount, entry);
  return entry;
}

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

  /**
   * ★★★ AN ESTABLISHED ACCOUNT IS NOT ELIGIBLE, FULL STOP (owner ruling 2026-08-10).
   *
   * This returned `eligible: true` for EVERY Hive reader and leaned entirely on
   * `asked` and `blankSlate` downstream to decide whether to show anything. That is
   * the wrong shape: eligibility is a property of the ACCOUNT, and a fourteen-year
   * Hive account with thousands of posts is never a candidate for an onboarding
   * interests picker, whatever those two flags happen to say on the day.
   *
   * It bit exactly as you would expect. The owner opened the picker on his own
   * account, set five interests, and his feed was re-tuned around them, because
   * nothing in this function had an opinion about who he was.
   *
   * The rule now matches the product: the picker is a COLD-START seed, so it is
   * offered to accounts that are actually cold. Lite accounts (Google, BTC, EVM)
   * are new by construction. A Hive account qualifies only inside its first week.
   * After that the feed learns from what the reader actually does, which is the
   * mechanism that should own this job anyway.
   *
   * On a failed chain read we return NOT eligible. The old comment below argued the
   * opposite for `blankSlate`, and it was right about the cost of interrupting an
   * established author; that argument is stronger here, because this flag decides
   * whether the question exists at all.
   */
  const NEW_ACCOUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  // Hive's own `post_count` is posts AND comments combined, which is exactly
  // the rule's "zero posts and zero comments". If the chain call fails we assume
  // NOT a blank slate: the cost of wrongly staying quiet is a reader who can
  // still set interests from settings; the cost of wrongly interrupting is a
  // modal in the face of an established author every time Hive rate-limits us.
  let blankSlate = false;
  let withinFirstWeek = false;
  try {
    const account = await getHiveAccountBasics(hiveAccount);
    blankSlate = (account?.post_count ?? 1) === 0;
    // `created` is the chain's account-creation timestamp, UTC and without a zone
    // marker, so it is read as UTC explicitly rather than as local time.
    const createdRaw = account?.created;
    if (createdRaw) {
      const created = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(createdRaw) ? createdRaw : `${createdRaw}Z`);
      const age = Date.now() - created.getTime();
      withinFirstWeek = Number.isFinite(age) && age >= 0 && age < NEW_ACCOUNT_MAX_AGE_MS;
    }
  } catch (error) {
    logger.warn('interests: could not read the Hive account for %s, treating as established: %o', hiveAccount, error);
  }

  return {
    eligible: withinFirstWeek,
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

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;



  const session = await getLiteSession();
  const reader = whichReader(session);
  if (reader.kind === 'none') {
    return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });
  }

  // ★ KEYED ON THE WRITER, NOT THE IP, and in its own bucket. This route serves
  // BOTH a lite user and a Hive reader, so the key is whichever identity is
  // actually writing. An IP key would let one person on a shared connection
  // exhaust everyone else's edits, and the first version of this limit borrowed
  // the signup-funnel `lookup` budget, which this repo already documents as the
  // way to deny real signups. Each call writes a row and invalidates the
  // viewer's feed cache, so it is cheap for the caller and not for us.
  // `whichReader`'s lite arm carries no userId — the lite actor is resolved
  // further down — so the key comes from the session, which holds `userId` for a
  // lite account and `username` for a Hive reader. `reader.kind !== 'none'`
  // already guarantees a username exists, so this is never empty.
  const writerKey = session.user?.userId ?? session.user?.username ?? '';
  if (!(await enforceProfileWriteRate(writerKey))) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
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
