import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { assertLiteEnabled } from '@/blog/lib/lite/config';
import { captchaEnabled, verifyCaptcha } from '@/blog/lib/lite/antispam/captcha';
import { enforceSignupRate, enforceSignupAttemptRate } from '@/blog/lib/lite/antispam/rate-limit';
import { completeSignup } from '@/blog/lib/lite/auth/auth-service';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/name  — { displayName }
 * Completes a provisional signup (from the session) with a vetted chosen name.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  // F-L8: assertLiteEnabled had ZERO callers — the real bug. It refuses to run signup in
  // production without the Turnstile secret (captcha must not fail open). Wrapped so a
  // misconfig is a clean 503, not an uncaught 500.
  try {
    assertLiteEnabled();
  } catch {
    return NextResponse.json({ error: 'lite_accounts_disabled' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const displayName = body?.displayName;
  if (typeof displayName !== 'string') {
    return NextResponse.json({ error: 'displayName_required' }, { status: 400 });
  }

  // Signup abuse controls (spec §H): CAPTCHA + per-IP cap + global velocity cap.
  const ip = getClientIp(req);
  if (captchaEnabled()) {
    const token = typeof body?.captchaToken === 'string' ? body.captchaToken : '';
    if (!(await verifyCaptcha(token, ip))) {
      return NextResponse.json({ error: 'captcha_failed' }, { status: 403 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    // LS-2 (PRUNED 2026-07-22): captcha fails OPEN when unconfigured — never open
    // public signup without it in production.
    logger.error('LITE_TURNSTILE_SECRET unset in production — refusing signup (captcha would fail open)');
    return NextResponse.json({ error: 'signup_unavailable' }, { status: 503 });
  }

  try {
    // ★ A caller with no pending sign-up spends NOTHING. The global cap is a
    // platform-wide daily budget (one counter for everyone), so consuming it before
    // establishing that this request could possibly succeed let an unauthenticated
    // caller — no wallet, no OAuth, no challenge — drain it and deny signup to every
    // real user for the rest of the UTC day. `completeSignup` refuses without this
    // session state anyway; checking it here is one cookie read.
    const session = await getLiteSession();
    if (!session.liteSignup) {
      return NextResponse.json(
        { status: 'error', code: 'no_pending_signup', message: 'Sign in again to choose a name.' },
        { status: 400 }
      );
    }
    // F-L30: the every-ATTEMPT global ceiling (bounds Hive-API amplification from
    // doomed-name retries, incl. IP-rotation) + the per-IP cap. The SCARCE
    // success-velocity budget is no longer consumed here — it moved into completeSignup
    // and is charged only when an account is actually created, so a flood of failing
    // names can no longer deny real users their signup.
    if (!(await enforceSignupAttemptRate()) || !(await enforceSignupRate(ip))) {
      return NextResponse.json({ error: 'signup_rate_limited' }, { status: 429 });
    }
    const result = await completeSignup(displayName);
    if (result.status === 'error') {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite name signup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
