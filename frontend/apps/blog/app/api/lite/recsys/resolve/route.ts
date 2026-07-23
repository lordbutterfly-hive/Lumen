import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRecsys } from '@/blog/lib/lite/http/guard';
import { resolveAuthors, resolveHiveAccounts } from '@/blog/lib/lite/recsys/resolver';

const logger = getLogger('app');
const MAX_BATCH = 1000;

interface AuthorPair {
  author: string;
  permlink: string;
}

function parsePairs(v: unknown): AuthorPair[] {
  if (!Array.isArray(v)) return [];
  const out: AuthorPair[] = [];
  for (const item of v.slice(0, MAX_BATCH)) {
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      if (typeof o.author === 'string' && typeof o.permlink === 'string') {
        out.push({ author: o.author, permlink: o.permlink });
      }
    }
  }
  return out;
}

function parseNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_BATCH).filter((n): n is string => typeof n === 'string');
}

/**
 * POST /api/lite/recsys/resolve — { posts?: [{author,permlink}], accounts?: [name] }
 * Returns the user_id mappings recsys substitutes at ingestion. Token-guarded.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRecsys(req);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const pairs = parsePairs(body?.posts);
  const names = parseNames(body?.accounts);

  try {
    const [postMappings, accountMappings] = await Promise.all([
      pairs.length ? resolveAuthors(pairs) : Promise.resolve([]),
      names.length ? resolveHiveAccounts(names) : Promise.resolve([])
    ]);
    return NextResponse.json({ posts: postMappings, accounts: accountMappings });
  } catch (error) {
    logger.error(error, 'recsys resolve failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
