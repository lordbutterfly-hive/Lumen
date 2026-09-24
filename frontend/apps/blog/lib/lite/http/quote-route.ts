import { NextRequest, NextResponse } from 'next/server';
import { getLiteSession } from './session';
import { guardWrite, readBoundedJson, payloadTooLarge } from './guard';
import { sessionActor, type FollowActor } from '../social/follow-actor';
import type { QuoteRefusal } from '../content/quote-service';

/**
 * Shared by the quote reblog write routes (`/api/quotes/*`, spec v2 7.2): a Hive login
 * (the signer on chain) plus the identity Lumen keys social edges on, and one status
 * per refusal so every route answers the same way.
 */
export type HiveQuoteRequest =
  | { ok: true; quoter: FollowActor; hiveName: string; author: string; permlink: string }
  | { ok: false; response: NextResponse };

export async function readHiveQuoteRequest(req: NextRequest): Promise<HiveQuoteRequest> {
  const blocked = guardWrite(req);
  if (blocked) return { ok: false, response: blocked };
  const session = await getLiteSession();
  const user = session.user;
  if (!user?.isLoggedIn || user.account_tier === 'lite' || !user.username) {
    return { ok: false, response: NextResponse.json({ error: 'hive_login_required' }, { status: 401 }) };
  }
  const parsed = await readBoundedJson(req);
  if (parsed === null) return { ok: false, response: payloadTooLarge() };
  const author = parsed.body?.author;
  const permlink = parsed.body?.permlink;
  if (typeof author !== 'string' || typeof permlink !== 'string' || !author || !permlink) {
    return { ok: false, response: NextResponse.json({ error: 'invalid_request' }, { status: 400 }) };
  }
  const quoter = await sessionActor(user);
  if (!quoter) return { ok: false, response: NextResponse.json({ error: 'hive_login_required' }, { status: 401 }) };
  return { ok: true, quoter, hiveName: user.username.toLowerCase(), author: author.toLowerCase(), permlink };
}

const STATUS: Record<QuoteRefusal, number> = {
  disabled: 404,
  not_found: 404,
  not_a_post: 422,
  is_a_quote: 422,
  too_long: 422,
  blocked: 403,
  rate_limited: 429,
  no_container: 503,
  not_on_chain: 409,
  still_on_chain: 409,
  wrong_author: 422,
  wrong_parent: 422,
  wrong_target: 422
};

export function refusal(reason: QuoteRefusal): NextResponse {
  return NextResponse.json({ error: reason }, { status: STATUS[reason] ?? 400 });
}
