import { liteConfig } from '@/blog/lib/lite/config';
import { query } from '@/blog/lib/lite/db/pool';

/**
 * Health check endpoint for container orchestration (Docker, Kubernetes).
 *
 * This endpoint is specifically designed to avoid the TransformStream corruption
 * issue that occurs when health checkers close connections early on streaming pages.
 * See: https://github.com/vercel/next.js/discussions/75995
 *
 * Usage: Configure container health checks to use /api/health instead of /
 *
 * ★★★ B12 (2026-08-06 QA) — THIS USED TO BE A STATIC `{status:'ok'}`.
 *
 * It was `export const dynamic = 'force-static'` returning a literal, so it was
 * prerendered at build time and answered 200 without the process ever touching
 * anything. During QA an instance was found serving happily against a database
 * port with NOTHING LISTENING while this reported clean. A probe that cannot
 * fail is not a probe — it is a green light wired to the wall.
 *
 * This is the SAME defect the recsys service already fixed on its own `/health`
 * (which returned 200 by design even during a total serving outage, so the
 * container healthcheck had to be taught to read the BODY). Fixed here at the
 * source instead: when the instance cannot serve, the STATUS CODE says so, so a
 * stock orchestrator probe that only reads the status line still notices.
 *
 * Scope is deliberately narrow — the lite datastore, and only when lite is
 * actually enabled. A deployment running without lite accounts must not be
 * marked unhealthy for a database it never uses, and this must not grow into a
 * fan-out that probes Hive nodes on every 15s healthcheck (a health endpoint
 * that hammers a third party is its own outage).
 */

/** Bound the probe so a hanging database cannot hold the healthcheck open. */
const PROBE_TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

type Check = { name: string; ok: boolean; error?: string };

export async function GET() {
  const checks: Check[] = [];

  if (liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      await withTimeout(query('select 1'), PROBE_TIMEOUT_MS);
      checks.push({ name: 'lite_db', ok: true });
    } catch (error) {
      // The MESSAGE only — never the DSN, which carries the password.
      checks.push({
        name: 'lite_db',
        ok: false,
        error: error instanceof Error ? error.message : 'unknown error'
      });
    }
  }

  const healthy = checks.every((c) => c.ok);
  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks
    },
    { status: healthy ? 200 : 503 }
  );
}

// Must run per-request: the whole point is to observe the CURRENT state of a
// dependency. `force-static` is what made this endpoint incapable of failing.
export const dynamic = 'force-dynamic';
