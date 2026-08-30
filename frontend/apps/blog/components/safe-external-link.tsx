import { ReactNode } from 'react';
import { sanitizeUrl } from '@ui/lib/sanitize-url';

/**
 * SafeExternalLink — the one place a fetched/user-supplied URL becomes a
 * clickable link on the page (WORK-LINK spec B1, 2026-08-30).
 *
 * ★★ WHY THIS EXISTS. A Hive chain account's `website` field
 * (`posting_json_metadata.profile.website`) is guarded on the WRITE path by
 * only a client-side `/^https?:\/\//` regex
 * (`features/account-settings/lib/utils.ts:55-60`) — there is no
 * server-side re-validation, and any Hive client (not just this one) can
 * broadcast anything into an account's own `posting_json_metadata`. Worse,
 * `getAccountFull`'s chain-read normalisation
 * (`packages/transaction/lib/hive-api.ts:277-289`) strips invisible/bidi
 * characters from `name`/`about`/`location`/the `*_description` fields but
 * NEVER TOUCHES `website` — it comes back completely raw. So a `website`
 * value read off chain is ATTACKER-CONTROLLED, full stop, and this
 * component is the render-time gate every surface that shows one must go
 * through. `javascript:`, `data:`, credential-embedded URLs and the rest
 * must be structurally impossible to render, not merely unlikely.
 *
 * A lite account's `website` is already validated at write time by
 * `safeUrl()` (`lib/lite/profile/profile-service.ts:73-83`, http/https
 * only) — but this component runs the SAME gate on it anyway. Two
 * independently-written sanitisers that must never be allowed to drift is
 * strictly worse than one gate every caller is forced through regardless of
 * source.
 *
 * TWO INDEPENDENT CHECKS, deliberately redundant:
 *  1. `new URL()` — must parse; protocol must be exactly `http:`/`https:`;
 *     `username`/`password` must both be empty (rejects
 *     `http://user:pass@host`, the credential-embedding trick
 *     `toSafeExternalUrl` was written to block —
 *     `features/witnesses/lib/safe-external-url.ts:7-12`, the closest
 *     existing precedent for this component).
 *  2. `sanitizeUrl` from `@ui/lib/sanitize-url` — the house
 *     `javascript:`/`data:`/`vbscript:`/etc. denylist, including its
 *     decode-and-recheck pass for percent-encoded obfuscation. `new URL()`
 *     alone already refuses a bare `javascript:` href (wrong protocol), so
 *     this is belt-and-braces: if check 1 is ever loosened by a future
 *     edit, check 2 still stands between a hostile string and the DOM. See
 *     the self-test for the obfuscated cases this is meant to catch.
 *
 * FAIL CLOSED. Any parse failure or any failed check renders `null` — there
 * is no "render the raw href anyway" branch anywhere in this file.
 *
 * ★ A PLAIN `<a>`, DELIBERATELY NOT `@hive/ui`'s `Link`. `Link` there is a
 * thin wrapper around `next/link`, which is right for INTERNAL navigation
 * but buys nothing for a link this component has just proven is an
 * external `http(s):` URL — `next/link` renders a bare `<a>` for an
 * external href anyway. More important: `@hive/ui`'s package entrypoint
 * (`components/index.tsx:1`) does `import '@hive/tailwindcss-config/
 * globals.css'` at module scope, so importing ANYTHING from `@hive/ui` —
 * including just `Link` — pulls a CSS import into every consumer of THIS
 * file. `/api/creator-profile/route.ts` (B2) imports `isSafeExternalHref`
 * from this exact module to sanitise server-side; a global CSS import
 * reaching a server route handler breaks it. Confirmed live: importing
 * `Link` here made this file's own self-test throw
 * `SyntaxError: Invalid or unexpected token` on `@tailwind base;` the
 * moment `tsx` tried to load it. Same four `rel` tokens as the strictest
 * existing external-link precedent in this codebase
 * (`features/post-rendering/leave-page-dialog.tsx:27`), just without the
 * wrapper.
 */
export interface SafeExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/**
 * The gate itself, exported so a caller can decide WHETHER to render
 * something (e.g. an "add a link" prompt only when there truly is none) —
 * and so the self-test can assert on the gate directly instead of trying to
 * render a React tree.
 */
export function isSafeExternalHref(href: string): boolean {
  if (!href || typeof href !== 'string') return false;
  if (!URL.canParse(href)) return false;

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  // Second, independent gate — see the file header. `sanitizeUrl` returns
  // `undefined` for anything it considers dangerous.
  if (sanitizeUrl(href) === undefined) return false;

  return true;
}

/**
 * The HOSTNAME to show instead of the raw URL — a long link wrecks a
 * header row or a meta line (B3/B5, both need this). Runs the SAME gate
 * first: a caller never has to remember to check `isSafeExternalHref`
 * separately before asking for display text. Returns `null` rather than
 * falling back to the raw string — "don't show anything" is the only
 * degrade path an unsafe or unparsable href gets here, same as the link
 * itself.
 */
export function safeHostname(href: string): string | null {
  if (!isSafeExternalHref(href)) return null;
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

export function SafeExternalLink({ href, children, className }: SafeExternalLinkProps) {
  if (!isSafeExternalHref(href)) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow external" className={className}>
      {children}
    </a>
  );
}

export default SafeExternalLink;
