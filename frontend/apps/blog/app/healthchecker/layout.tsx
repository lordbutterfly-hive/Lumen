import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import React, { PropsWithChildren } from 'react';

// WHY (2026-08-18): the product name was inconsistent across this page —
// "HealthChecker", "Healthchecker" and "Healthcheckers" all appeared, and this
// title used the plural. "HealthChecker" is the form already used by the
// component/hook names this page renders (`HealthCheckerComponent`,
// `useHealthChecker`), so it is the one kept. Root layout's title template
// (`apps/blog/app/layout.tsx`) appends " - Lumen", giving "HealthChecker - Lumen".
export const metadata: Metadata = {
  title: 'HealthChecker'
};

export default function Layout({ children }: PropsWithChildren) {
  // WHY (2026-08-18): /healthchecker is publicly routable but linked from
  // nowhere in the app (0 of 253 links on the home page point to it). A
  // production visitor who finds the URL directly can pin a broken node with
  // no health indicator anywhere else in the app, then file bugs that look
  // like app defects. Gate the route out of production while leaving it
  // reachable in development, where it is still useful for working on node
  // selection. Read live via `process.env.NODE_ENV` rather than a build-time
  // constant, matching the existing gate shape in
  // `features/prediction-market/lib/market-config.ts` and
  // `features/creator-tokens/lib/creator-tokens-data-source.ts`
  // (`if (process.env.NODE_ENV === 'production') return false;`) — Next.js
  // itself sets this to 'production' for both `next build` and `next start`,
  // and to 'development' for `next dev`, so no separate flag is needed.
  //
  // ★ WITH AN ESCAPE HATCH, BECAUSE `NODE_ENV` ALONE HIDES IT FROM US TOO
  // (2026-08-18). Local QA on this project runs a PRODUCTION build behind
  // `next start` — that is the whole point of it, since a dev build has
  // different timing and a different bundle. So a bare `NODE_ENV` gate does not
  // mean "hidden from end users, visible to us"; it means hidden from everyone
  // including whoever is debugging a node problem on the exact build that has
  // one. `LUMEN_ENABLE_HEALTHCHECKER=yes` re-opens it deliberately, and being a
  // server-side env var it is set by whoever runs the process, never by a
  // visitor. Absent — which is the default everywhere, including the real
  // deployment — the route stays a 404.
  if (process.env.NODE_ENV === 'production' && process.env.LUMEN_ENABLE_HEALTHCHECKER !== 'yes') {
    notFound();
  }

  return <>{children}</>;
}
