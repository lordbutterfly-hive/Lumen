import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { getProposalVoters } from '@/blog/features/proposals/lib/proposals-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account` and `/api/vests-to-hp`: `getProposalVoters`
 * reaches `getChain()` (list_proposal_votes, find_accounts, and the wax
 * vests->HP math), which instantiates `@hiveio/wax` and downloads
 * `wax.common.wasm` the moment it runs. This is the one server-side caller —
 * see the doc block on `getProposalVoters` (proposals-api.ts) for why the
 * whole roster has to be fetched and sorted here before any cap can be
 * applied: `list_proposal_votes` only supports alphabetical seek order, never
 * vote-weight order.
 *
 * Rows are capped AFTER sorting on the full roster, so the rows actually sent
 * are genuinely the top `MAX_VOTERS_RETURNED` by HP, not an alphabetical
 * prefix. `total` always reports the real, uncapped voter count — the dialog
 * needs that for its title regardless of how many rows it goes on to render.
 * Real measured worst case (2026-08-28, proposal #373 "Hive Keychain
 * Development Proposal 2026"): 1,831 direct voters, far past what belongs in
 * one dialog's DOM.
 */
const MAX_VOTERS_RETURNED = 200;

// Matches `/api/vests-to-hp`'s TTL: proposal votes move when someone broadcasts
// update_proposal_votes, not every block, and the underlying read here (up to
// dozens of chained list_proposal_votes pages plus a chunked find_accounts) is
// far more expensive than that route's, so collapsing repeat opens of the same
// proposal's dialog within a short window is worth more here, not less.
const CACHE_TTL_MS = 30_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = (req.nextUrl.searchParams.get('proposalId') ?? '').trim();
  // Shape check only: proposal ids are small non-negative integers on Hive,
  // and this is handed straight to a JSON-RPC parameter, nothing to inject into.
  if (!/^\d+$/.test(raw)) {
    return NextResponse.json({ error: 'proposal_id_required' }, { status: 400 });
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    return NextResponse.json({ error: 'proposal_id_required' }, { status: 400 });
  }

  try {
    const voters = await cachedRead(`proposal-votes:${id}`, CACHE_TTL_MS, () => getProposalVoters(id));
    return NextResponse.json(
      { total: voters.length, voters: voters.slice(0, MAX_VOTERS_RETURNED) },
      { headers: { 'cache-control': 'private, no-store' } }
    );
  } catch (error) {
    logger.error(error, 'proposal votes lookup failed for proposal %s', id);
    return NextResponse.json({ error: 'proposal_votes_unavailable' }, { status: 502 });
  }
}
