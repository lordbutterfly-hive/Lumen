/**
 * HARNESS — the /api surface.
 *
 * Every round so far drove the UI. Nobody has asked the API directly, and a
 * route does not stop existing because no button points at it: auth, ownership,
 * CSRF, rate limits and input validation are all enforced (or not) HERE, and
 * anyone can curl them.
 *
 * You get two real identities so you can test whether A can act as B, and an
 * anonymous caller so you can test whether a stranger can act at all.
 */
import { liteSession, BASE } from '../../qa-harness.mjs';

export const ORIGIN = BASE;

/** Every route in the app, so nothing is skipped by accident. */
export const ROUTES = {
  public: ['/api/health', '/api/avatar', '/api/avatar/default', '/api/users/me', '/api/csp-report', '/api/streak/[user]', '/api/resolve-post/[user]/[permlink]'],
  liteAuth: ['/api/lite/auth/evm/challenge', '/api/lite/auth/evm/verify', '/api/lite/auth/btc/challenge', '/api/lite/auth/btc/verify', '/api/lite/auth/google', '/api/lite/auth/google/challenge', '/api/lite/auth/name', '/api/lite/auth/bind', '/api/lite/auth/stepup', '/api/lite/auth/methods', '/api/lite/auth/logout', '/api/lite/auth/logout-all'],
  liteWrite: ['/api/lite/posts', '/api/lite/posts/[id]', '/api/lite/vote', '/api/lite/reblog', '/api/lite/follow', '/api/lite/unfollow', '/api/lite/interests', '/api/lite/upload', '/api/lite/profile'],
  liteRead: ['/api/lite/engagement', '/api/lite/feed/following', '/api/lite/follow/state', '/api/lite/follow/list', '/api/lite/name/check', '/api/lite/name/suggest', '/api/lite/wallet/dids'],
  privileged: ['/api/lite/moderation/user', '/api/lite/moderation/post', '/api/lite/moderation/actions', '/api/lite/publisher/drain', '/api/lite/publisher/health', '/api/lite/recsys/follow-edges', '/api/lite/recsys/resolve', '/api/lite/account-creator/claim', '/api/debug/mem'],
  other: ['/api/feed/for-you', '/api/auth/login', '/api/auth/logout', '/api/auth/consent', '/api/auth/chat-token', '/api/account/upgrade', '/api/google-drive/auth', '/api/google-drive/callback', '/api/google-drive/client', '/api/google-drive/refresh', '/api/oidc/[[...slug]]']
};

/** A caller with its own cookie jar. `anon()` has none. */
export async function caller(privateKey, label) {
  const s = privateKey ? await liteSession(privateKey, label) : { cookies: [], username: null };
  const jar = new Map(s.cookies.map((c) => [c.name, c.value]));
  const call = async (path, { method = 'GET', body, headers = {}, csrf = true } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/json';
    if (csrf) h['x-csrf-token'] = '1';
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    const res = await fetch(ORIGIN + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const text = await res.text();
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, headers: res.headers };
  };
  return { username: s.username, call, jar };
}

export const anon = () => caller(undefined, 'anon');

/** Record a probe with its evidence so the report writes itself. */
export function recorder() {
  const rows = [];
  return {
    probe(name, res, expectation) {
      rows.push({ name, status: res.status, body: (res.text || '').slice(0, 120), expectation });
      console.log(`  ${String(res.status).padEnd(4)} ${name}\n        ${(res.text || '').slice(0, 110)}`);
      return res;
    },
    all: () => rows
  };
}
