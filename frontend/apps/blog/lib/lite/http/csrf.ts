import { NextRequest } from 'next/server';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';

/**
 * App Router equivalent of the repo's Pages-API `checkCsrfHeader`. The defense
 * is the presence of a custom request header (`x-csrf-token`): browsers cannot
 * set custom headers on cross-origin form/simple requests without a CORS
 * preflight, so its presence proves same-origin XHR/fetch.
 */
export function hasCsrfHeader(req: NextRequest): boolean {
  return req.headers.has(csrfHeaderName);
}
