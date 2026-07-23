/**
 * Ops entrypoint for applying lite-account DB migrations.
 *
 * Usage (from apps/blog, with LITE_DATABASE_URL set):
 *   pnpm --filter @hive/blog exec tsx lib/lite/db/run-migrations.ts
 *
 * Run this once against a freshly-provisioned Postgres, and again after any new
 * migration file is added. It is intentionally NOT wired into the request path.
 */
import { runMigrations } from './migrate';

runMigrations()
  .then((ran) => {
    if (ran.length === 0) {
      // eslint-disable-next-line no-console -- standalone CLI script, not app code
      console.log('Lite DB is up to date — no migrations applied.');
    } else {
      // eslint-disable-next-line no-console -- standalone CLI script, not app code
      console.log(`Applied ${ran.length} lite migration(s): ${ran.join(', ')}`);
    }
    process.exit(0);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console -- standalone CLI script, not app code
    console.error('Lite DB migration failed:', error);
    process.exit(1);
  });
