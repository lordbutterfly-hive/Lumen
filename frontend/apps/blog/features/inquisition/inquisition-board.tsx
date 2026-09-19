'use client';

import { useEffect, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { toggleArm, watchArm } from '@/blog/lib/inquisition/arm';

/**
 * ════ THE DASHBOARD ════
 *
 * ★★★ THIS IS NOT THE MOCK'S DESIGN, ON INSTRUCTION (owner, 2026-09-19: "dont adopt
 * the design claude design used. use our approach for dark theme. no fucking yellows
 * he uses for pills and some cards and the design of pills, thats all shit").
 *
 * So: no brass. `#c89b4a` appears nowhere. The armed accent is the product's existing
 * brand red, the surfaces are the graphite ramp, and the arming control is the same
 * trough-and-seated-pill construction as the theme toggle in the left rail — which is
 * this app's one shape for a two-state choice and now has three call sites.
 *
 * ★★ THE COPY IS CUT TO THE BONE (owner: "if you see any superflous text claude design
 * put in that he does a lot cut it. only what matters with hovers on what it is, as
 * short and to the point as possible. you tend to over do it"). The mock's header
 * carries a title, a tagline and a two-line subtitle; this carries a title and one
 * line. Column headers are nouns. What a metric IS lives in a `title` attribute, one
 * clause, and nowhere else. "Nobody expects the Hive Inquisition" is gone — the owner
 * cut it by name.
 *
 * ★ AND NOTHING HERE CAN CHANGE ANOTHER ACCOUNT'S STATE. There is no mute, no
 * downvote, no flag, no report. That is structural, not a policy: this component
 * renders rows and links and has no mutation to call.
 */

interface Mark {
  publisher: string;
  kind: 'blacklisted' | 'muted';
  appealUrl: string | null;
}

interface BlacklistRow {
  account: string;
  marks: Mark[];
}

interface SteemRow {
  account: string;
  postsSinceFork: number;
  lastPost: string | null;
  partial: boolean;
}

type BoardId = 'blacklists' | 'muted' | 'downvoted' | 'ke' | 'steem';

const BOARDS: { id: BoardId; label: string; hint: string }[] = [
  { id: 'blacklists', label: 'Lists', hint: 'Accounts on a published blacklist, and who published it' },
  { id: 'muted', label: 'Muted', hint: 'Accounts muting this one, and the stake behind them' },
  { id: 'downvoted', label: 'Downvoted', hint: 'Downvotes received in the last three months, and how many accounts cast them' },
  { id: 'ke', label: 'KE', hint: 'Lifetime rewards taken divided by Hive Power held' },
  { id: 'steem', label: 'Steem', hint: 'Posts published to Steem after the 2020 Hive fork' }
];

interface DvRow {
  account: string;
  downvotes: number;
  voters: number;
}

interface KeRow {
  account: string;
  ke: number;
  rewardsHive: number;
  hp: number;
  band: string;
}

interface MutedRow {
  account: string;
  mutedBy: number;
  muterMvests: number;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function InquisitionBoard() {
  const [armed, setArmed] = useState(false);
  const [board, setBoard] = useState<BoardId>('blacklists');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => watchArm(setArmed), []);

  /*
   * ★ ONE FETCH PER BOARD PER VISIT, AND THE RESULT IS KEPT. Switching tabs back and
   * forth must not re-ask the server: the aggregates behind these are shared and
   * cached, but a component that refetches on every tab click still turns one reader
   * into a stream of requests.
   */
  const [cache, setCache] = useState<Partial<Record<BoardId, Record<string, unknown>>>>({});

  /*
   * ★★ A BUILDING BOARD IS POLLED, A FINISHED ONE IS KEPT. The Steem board is assembled
   * off the request path — 45 sequential lookups, measured at 30s cold — so the first
   * response comes back `building: true` with however many rows are ready. Polling every
   * three seconds shows it fill instead of showing an empty panel for half a minute, and
   * the poll stops the moment the server says `done`. Only a finished board is cached,
   * so a half-built one can never be mistaken for the answer.
   */
  useEffect(() => {
    const held = cache[board];
    if (held) {
      setData(held);
      // ★ AND CLEAR THE FLAG. Returning early without this left `loading` true forever
      // if a slower board's fetch had set it and was then cancelled: switching to an
      // already-cached board showed "Reading the chain…" over 45 rows it was holding,
      // recoverable only by completing some other fetch. Reproduced.
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);

    /*
     * ★★★ A POLL MAY NEVER TAKE ROWS AWAY, AND THIS IS NOT A COSMETIC RULE.
     * `cluster.js` runs three worker processes and Node round-robins connections
     * between them, so each poll can land on a different worker with its own copy of a
     * board that is still filling. Observed in testing: 7 rows, then 0, then 17. The
     * server cannot fix that on its own — worker B genuinely has nothing yet — so the
     * client keeps the fullest answer it has seen for this board and lets a thinner one
     * update only the `building` flag.
     *
     * ★★ AND AN EMPTY BOARD IS NEVER CACHED AS FINAL. Caching `rows: []` because one
     * worker answered first is how "Nothing to confess." gets pinned over a board that
     * was about to fill.
     */
    const pull = () => {
      fetch(`/api/inquisition/boards?board=${board}`)
        .then((r) => r.json())
        .then((json) => {
          if (cancelled) return;
          setData((prev) => {
            const prevRows = prev?.board === board ? ((prev.rows as unknown[] | undefined) ?? []) : [];
            const nextRows = (json?.rows as unknown[] | undefined) ?? [];
            if (prevRows.length > nextRows.length) {
              return { ...prev, building: json?.building === true, asOf: prev?.asOf ?? json?.asOf };
            }
            return json;
          });
          setLoading(false);
          const settled = json?.building !== true;
          const worthKeeping = ((json?.rows as unknown[] | undefined) ?? []).length > 0;
          if (!settled) timer = setTimeout(pull, 3000);
          else if (worthKeeping) setCache((c) => ({ ...c, [board]: json }));
        })
        .catch(() => {
          if (cancelled) return;
          // ★ `board` MUST BE ON THE FAILURE PAYLOAD TOO. Without it `matches` is false,
          // `pending` stays true, and the one line written for this case — "The chain
          // did not answer" — could never render. A network failure was an eternal
          // spinner. Reproduced by aborting every board request.
          setData({ board, rows: [], unavailable: true });
          setLoading(false);
        });
    };
    pull();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [board, cache]);

  /*
   * ★★★ THE ROWS MUST BELONG TO THE BOARD THAT IS SHOWING, AND FOR ONE RENDER THEY DID
   * NOT. Clicking a tab changes `board` immediately while `data` still holds the
   * previous board's response, so `MutedTable` was handed blacklist rows and threw
   * `Cannot read properties of undefined (reading 'toLocaleString')` — the error
   * boundary swallowed it into "Something went wrong" and my `pageerror` listener saw
   * nothing, which is why the screenshot was the first sign of it.
   *
   * Every response carries the board it answers for, so the check is one comparison
   * rather than a defensive `?.` on each field: rows that do not belong are simply not
   * rendered, and the panel shows its loading line for that one frame.
   */
  const matches = data?.board === board;
  const rows = matches ? ((data?.rows as unknown[] | undefined) ?? []) : [];
  const unavailable = matches && data?.unavailable === true;
  const pending = loading || !matches;

  return (
    <div className="min-w-0">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-ui text-[28px] leading-[36px] font-semibold text-ink-2">Inquisition mode</h1>
          {/* One line. The mock has three. */}
          <p className="mt-1 font-ui text-[14px] leading-[22px] text-ink-10">
            Public chain data. Nothing here is Lumen&rsquo;s opinion.
          </p>
        </div>

        {/* The arming control: our trough-and-pill, not the mock's brass chip. */}
        <button
          type="button"
          onClick={toggleArm}
          aria-pressed={armed}
          title={armed ? 'Turn the mode off and restore your theme' : 'Turn the mode on; this switches you to dark'}
          className={cn(
            'inline-flex shrink-0 items-center gap-2 rounded-full border border-line-6 px-1 py-1 transition-colors',
            'bg-[var(--amb-1)]'
          )}
          data-testid="inquisition-arm"
        >
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-[13px] leading-[20px] font-medium transition-colors',
              !armed ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10'
            )}
          >
            Off
          </span>
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-[13px] leading-[20px] font-medium transition-colors',
              armed ? 'bg-surface-brand-12 text-ink-27' : 'text-ink-10'
            )}
          >
            On
          </span>
        </button>
      </header>

      <div role="tablist" className="mb-5 flex gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px]">
        {BOARDS.map((b) => (
          <button
            key={b.id}
            role="tab"
            aria-selected={board === b.id}
            title={b.hint}
            onClick={() => setBoard(b.id)}
            className={cn(
              'rounded-lg px-[18px] py-2 font-ui text-[14px] leading-[22px] font-medium transition-colors',
              board === b.id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-4'
            )}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="rounded-panel border border-line-9 bg-surface-1">
        {pending ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">Reading the chain&hellip;</p>
        ) : unavailable ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">
            The chain did not answer. Nothing is wrong with the account.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">
            {matches && data?.building === true
              ? board === 'steem'
                ? 'Asking Steem\u2026'
                : 'Counting\u2026'
              : 'Nothing to confess.'}
          </p>
        ) : board === 'blacklists' ? (
          <BlacklistTable rows={rows as BlacklistRow[]} />
        ) : board === 'muted' ? (
          <MutedTable rows={rows as MutedRow[]} />
        ) : board === 'downvoted' ? (
          <DvTable rows={rows as DvRow[]} />
        ) : board === 'ke' ? (
          <KeTable rows={rows as KeRow[]} />
        ) : (
          <SteemTable rows={rows as SteemRow[]} />
        )}
      </div>

      {matches && data?.asOf ? (
        <p className="mt-3 font-ui text-caption text-ink-14">Indexed {String(data.asOf).slice(0, 16).replace('T', ' ')}</p>
      ) : null}

      {/*
        ★ SAYING WHAT IS NOT HERE IS PART OF THE JOB. Mutes received has no reverse
        index on the public endpoints — measured, see signals.ts — and a board that
        silently omits it reads as "this account has none".
      */}
      {/* ★ INCOMPLETENESS REACHES THE SCREEN. The server computes which publishers it
          could not read and the UI used to discard it, so a short board carried a fresh
          timestamp and no hint anything was missing. */}
      {matches && Array.isArray(data?.missing) && (data.missing as string[]).length > 0 ? (
        <p className="mt-2 font-ui text-caption text-ink-warn-3">
          Could not read: {(data.missing as string[]).map((p) => `@${p}`).join(', ')}. This list is incomplete.
        </p>
      ) : null}
      {matches && board === 'steem' && typeof data?.scope === 'number' ? (
        <p className="mt-2 font-ui text-caption text-ink-14">
          Checked the first {String(data.scope)}
          {typeof data?.listed === 'number' ? ` of ${String(data.listed)}` : ''} listed accounts, alphabetically.
        </p>
      ) : null}

    </div>
  );
}

function BlacklistTable({ rows }: { rows: BlacklistRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 font-medium" title="The account that published the list">
            Listed by
          </th>
          <th className="px-6 py-3 font-medium" title="A blacklist warns on transfers; it does not mute anyone">
            List
          </th>
          <th className="px-6 py-3 font-medium">Appeal</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.marks.map((mark, i) => (
            <tr key={`${row.account}-${mark.publisher}-${mark.kind}`} className="border-b border-line-9 last:border-0">
              <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
                {i === 0 ? (
                  <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                    @{row.account}
                  </a>
                ) : null}
              </td>
              <td className="px-6 py-3 font-ui text-[14px] text-ink-10">
                <a href={`/@${mark.publisher}`} className="hover:text-ink-brand-6">
                  @{mark.publisher}
                </a>
              </td>
              <td className="px-6 py-3 font-ui text-[14px] text-ink-10">{mark.kind}</td>
              <td className="px-6 py-3 font-ui text-[14px]">
                {mark.appealUrl ? (
                  <a
                    href={mark.appealUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-ink-brand-6 hover:underline"
                  >
                    appeal
                  </a>
                ) : (
                  <span className="text-ink-14">—</span>
                )}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function MutedTable({ rows }: { rows: MutedRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 text-right font-medium" title="Accounts that have muted this one">
            Muted by
          </th>
          {/* ★ STAKE IS THE CORRECTIVE. A mute is free, so a raw count rewards whoever
              annoyed the most small accounts. */}
          <th className="px-6 py-3 text-right font-medium" title="VESTS held by those accounts, in millions">
            Muter stake
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">{row.mutedBy}</td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.muterMvests.toLocaleString()}M
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DvTable({ rows }: { rows: DvRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          {/* ★ VOTERS IS THE SORT, AND THE REASON IS IN THE QUERY: 903 downvotes from 12
              accounts is a dispute, 212 from 29 is a consensus. */}
          <th className="px-6 py-3 text-right font-medium" title="Accounts that cast them">
            Voters
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Downvotes received in the last three months">
            Downvotes
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">{row.voters}</td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">{row.downvotes}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KeTable({ rows }: { rows: KeRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 text-right font-medium" title="Lifetime rewards taken divided by Hive Power held">
            KE
          </th>
          {/* ★ NO DEFINITION OF THE BAND WORDS ON SCREEN — owner's instruction. The
              thresholds and the caveat live in types.ts. */}
          <th className="px-6 py-3 font-medium">Band</th>
          <th className="px-6 py-3 text-right font-medium" title="Author and curation rewards over the account's whole life">
            Rewards
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Hive Power held now">
            HP
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">{row.ke.toFixed(2)}</td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-10">{row.band}</td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.rewardsHive.toLocaleString()}
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.hp.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SteemTable({ rows }: { rows: SteemRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 text-right font-medium" title="Posts published to Steem after 2020-03-20">
            Posts
          </th>
          <th className="px-6 py-3 font-medium">Last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">
              {row.partial ? `${row.postsSinceFork}+` : row.postsSinceFork}
            </td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-10">{day(row.lastPost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
