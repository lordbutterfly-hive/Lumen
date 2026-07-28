import { cache } from 'react';
import { liteEntryForPermlink } from './lite-entry';

/**
 * Request-level cached `liteEntryForPermlink`, matching `lib/cached-api.ts`.
 *
 * A post page resolves the same post TWICE per request — once in the layout's
 * `generateMetadata` (for the title and share preview) and once in the page body.
 * For an ordinary Hive post that costs nothing, because `getPostCached` is already
 * wrapped in React's `cache()`. But `getPostCached` always returns null for a lite
 * post (the URL's author is a Lumen handle Hivemind has never heard of), so BOTH
 * call sites fall through to the lite path — and everything it does ran twice: the
 * post lookup, the author-name lookup, and the remote chain fetch.
 *
 * Kept in its own module rather than added to `lite-entry.ts` so that ops scripts,
 * tests and the migration runner can keep importing the plain function without
 * pulling React into a non-React runtime.
 */
export const liteEntryForPermlinkCached = cache(liteEntryForPermlink);
