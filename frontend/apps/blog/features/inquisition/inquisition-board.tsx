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

interface CrosspostRow {
  account: string;
  lastSteem: string;
  lastHive: string;
  hivePosts: number;
}

type BoardId = 'ke' | 'downvoted' | 'muted' | 'blacklists' | 'inquisitors' | 'crossposting';

/**
 * ★★★ THE BOARDS CARRY THEIR OWN TITLE, KICKER AND SCOPE LINE, AND STRIPPING THAT WAS
 * A MISTAKE (owner, 2026-09-19: "you cut all text ... No one even knows what these tabs
 * are").
 *
 * The instruction before it was to cut Claude Design's *superfluous* copy, and I cut
 * the load-bearing copy with it: a tab reading "KE" over a column reading "KE" tells a
 * reader nothing about what the number is, where it came from, or how far back it goes.
 * The mock puts three things above every board — BOARD 0n · WHAT IT MEASURES, the
 * title, and the scope — and every one of them answers a question a reader actually
 * has. They come back.
 *
 * What stays cut is the theatre in the rows: no "abuser", no "farmer", no verdict
 * words. Theatre lives in the header band and the empty states; the boards stay flat.
 */
interface BoardDef {
  id: BoardId;
  tab: string;
  kicker: string;
  title: string;
  meta: string;
  blurb: string;
}

const BOARDS: BoardDef[] = [
  {
    id: 'ke',
    tab: 'KE INDEX',
    kicker: 'BOARD 01 · REWARDS ÷ STAKE',
    title: 'The KE index',
    meta: 'top 50 · min 6,211 HP · 90 days old',
    blurb:
      'Everything an account has ever taken in rewards, divided by the Hive Power it still holds. It reads someone living off their payouts and a reward-pool farm as the same number, so it is evidence of cash-out behaviour and never of abuse.'
  },
  {
    id: 'downvoted',
    tab: 'TOP DOWNVOTED',
    kicker: 'BOARD 02 · RECEIVED',
    title: 'Most downvoted',
    meta: 'rolling 3 months · sorted by voters',
    blurb:
      'Sorted by how many distinct accounts downvoted, not by how many downvotes landed: 903 downvotes from 12 accounts is a dispute, 212 from 29 is a consensus. Sorting by volume would let one large downvoter manufacture the top of the board.'
  },
  {
    id: 'muted',
    tab: 'MOST MUTED',
    kicker: 'BOARD 03 · MUTES RECEIVED',
    title: 'Most muted',
    meta: 'on-chain follow ops · what: ignore',
    blurb:
      'A mute is free, personal and one-sided — it hides an account from one reader and costs nothing to cast. The stake behind the muters is shown beside the count because a raw count flatters whoever annoyed the largest number of small accounts.'
  },
  {
    id: 'blacklists',
    tab: 'BLACKLISTED',
    kicker: 'BOARD 04 · PUBLISHED LISTS',
    title: 'Blacklisted',
    meta: 'four publishers · both list types',
    blurb:
      'A blacklist does not mute anyone. It attaches information to a name and warns on transfers — most readers assume the opposite. The lists are never merged into one verdict: they have different scopes and different appeal routes, and each row names its own.'
  },
  {
    id: 'inquisitors',
    tab: 'TOP INQUISITORS',
    kicker: 'BOARD 05 · DOWNVOTES CAST',
    title: 'Top inquisitors',
    meta: 'rolling 3 months · sorted by targets',
    blurb:
      'The other end of board 02: who is casting the downvotes, how many separate accounts they land on, and which account takes the most. Casting downvotes is a normal, intended part of Hive — this board says who does it, not whether they should.'
  },
  {
    id: 'crossposting',
    tab: 'CROSSPOSTING',
    kicker: 'BOARD 06 · HIVE AND STEEM',
    title: 'Crossposting',
    meta: 'active on both chains · sorted by recency',
    blurb:
      'Accounts still publishing to Steem as well as Hive since the 2020 fork, ranked by how recently they posted to Steem. Reshares are excluded, so the count is what this account published under its own name.'
  }
];

interface InquisitorRow {
  account: string;
  downvotes: number;
  targets: number;
  topTarget: string;
  topTargetVotes: number;
}

interface DvRow {
  account: string;
  downvotes: number;
  voters: number;
  topSource: string;
  topSourceVotes: number;
  removedUsd: number | null;
  postsHit: number;
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
    /*
     * ★★ THE POLL BACKS OFF, because a fixed 3s against an 80-second build is 27
     * requests to say "not yet". The Downvoted board is the honest test case: 3s is
     * right for the first few seconds, when the answer might already be there, and
     * silly for the next minute. Ramping to 10s costs a second of perceived latency at
     * the end and cuts the request count by about two thirds.
     */
    let waitMs = 3000;
    const nextWait = () => {
      waitMs = Math.min(Math.round(waitMs * 1.6), 10000);
      return waitMs;
    };

    /*
     * ★★★ A TRANSPORT FAILURE IS NOT AN ANSWER ABOUT THE CHAIN, AND TREATING IT AS ONE
     * WAS A REAL BUG (2026-09-19). This used to `.then(r => r.json())` with no status
     * check and a catch that painted "The chain did not answer" and stopped polling.
     * Two ways that lied:
     *
     *  - A 429 from the request budget is a PLAIN TEXT body, so `r.json()` threw. A
     *    reader who was merely asking a little too fast — or sharing an office IP — got
     *    a permanent, confident "the chain did not answer" over a board that was
     *    building perfectly well, and the poll never resumed.
     *  - Any one dropped request did the same. A board three seconds from finishing
     *    died on a single blip.
     *
     * So: a non-OK status or an unparseable body is a RETRY, not a verdict, bounded by
     * `MAX_TRANSPORT_RETRIES` so it cannot spin forever. Only running out of retries
     * says "the chain did not answer", and by then that is true.
     */
    const MAX_TRANSPORT_RETRIES = 4;
    let transportFails = 0;

    const retryOrGiveUp = () => {
      if (cancelled) return;
      transportFails += 1;
      if (transportFails > MAX_TRANSPORT_RETRIES) {
        // ★ `board` MUST BE ON THE FAILURE PAYLOAD TOO. Without it `matches` is false,
        // `pending` stays true, and the one line written for this case — "The chain
        // did not answer" — could never render. A network failure was an eternal
        // spinner. Reproduced by aborting every board request.
        setData({ board, rows: [], unavailable: true });
        setLoading(false);
        return;
      }
      timer = setTimeout(pull, nextWait());
    };

    const pull = () => {
      fetch(`/api/inquisition/boards?board=${board}`)
        .then((r) => {
          // ★ A 429 carries `Retry-After`; honour it rather than guessing.
          if (!r.ok) {
            const after = Number(r.headers.get('retry-after'));
            if (Number.isFinite(after) && after > 0) waitMs = Math.min(after * 1000, 30000);
            throw new Error(`board ${r.status}`);
          }
          return r.json();
        })
        .then((json) => {
          if (cancelled) return;
          transportFails = 0;
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
          if (!settled) timer = setTimeout(pull, nextWait());
          else if (worthKeeping) setCache((c) => ({ ...c, [board]: json }));
        })
        .catch(retryOrGiveUp);
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

  const def = BOARDS.find((b) => b.id === board) ?? BOARDS[0];

  return (
    <div className="min-w-0">
      {/*
        ★★★ THE HEADER BAND, WITH THE ART (owner, 2026-09-19: "wheres teh header i gave
        you? the image with the guy in the hood?"). I shipped a bare <h1> and a one-line
        subtitle, which is why the page read as a spreadsheet with no reason to exist.

        The band is the whole joke and the whole warning at once: the costume carries the
        theatre so the boards below can stay flat. The art sits under a left-to-right
        scrim so the title is on solid ink at every width, and it is dimmed to 28% when
        the mode is off — present, but clearly not switched on.
      */}
      <div
        className={cn(
          'relative mb-5 flex min-h-[238px] items-center overflow-hidden rounded-panel border',
          'bg-[#16181b] transition-[border-color] duration-500',
          armed ? 'border-[#3a3226]' : 'border-line-9'
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/inquisition/header.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-700"
          style={{ opacity: armed ? 1 : 0.28 }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(14,15,17,.95) 0%, rgba(14,15,17,.9) 34%, rgba(14,15,17,.35) 52%, rgba(14,15,17,0) 66%)'
          }}
        />

        <div className="relative z-[2] max-w-[560px] px-7 py-8">
          <p className="font-ui text-caption uppercase tracking-label text-ink-brand-6">
            Inquisition mode &middot; {armed ? 'ON' : 'OFF'}
          </p>
          <h1 className="mt-2 font-text text-[30px] font-semibold leading-[38px] text-[#f2f4f6]">
            Nobody expects the Hive Inquisition.
          </h1>
          {/*
            ★ THE SUBTITLE NAMES THE SIGNALS. It is the one place a reader finds out what
            the six tabs below actually contain before clicking any of them.
          */}
          <p className="mt-3 font-ui text-[14px] leading-[22px] text-[#aeb4bc]">
            Public chain data on any account. Downvotes, value removed, mutes, rewards
            against stake, crossposting, and every published blacklist. Lumen authors no
            list and scores nobody &mdash; it reads what is already on chain and names the
            source.
          </p>
        </div>

        {/*
          ★★ THE ARMING PILL, AND THE BLACK RECTANGLE IS GONE (owner: "when i click off
          on i can see teh black rectangle around the pill"). That was the browser's
          default focus ring painting a square box around a round control on click.
          `focus:outline-none` with a real `focus-visible` ring keeps it invisible to a
          mouse and visible to a keyboard, which is the behaviour the rest of the app
          already has.
        */}
        <button
          type="button"
          onClick={toggleArm}
          aria-pressed={armed}
          title={armed ? 'Turn the mode off and restore your theme' : 'Turn the mode on; this switches you to dark'}
          className={cn(
            'absolute right-6 top-5 z-[5] inline-flex shrink-0 items-center gap-2 rounded-full border p-1',
            'transition-[background-color,border-color,box-shadow] duration-500',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-brand)] focus-visible:ring-offset-0',
            armed ? 'border-line-brand-10 bg-[rgba(14,15,17,.82)]' : 'border-line-6 bg-[rgba(14,15,17,.72)]'
          )}
          style={armed ? { boxShadow: '0 0 22px -6px rgba(198,58,58,.55)' } : undefined}
          data-testid="inquisition-arm"
        >
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-[13px] font-medium leading-[20px] transition-colors duration-300',
              !armed ? 'bg-[var(--lum-1)] text-ink-2' : 'text-[#8a929c]'
            )}
          >
            Off
          </span>
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-[13px] font-medium leading-[20px] transition-colors duration-300',
              armed ? 'bg-surface-brand-12 text-ink-27' : 'text-[#8a929c]'
            )}
          >
            On
          </span>
        </button>
      </div>

      {/*
        ★ THE TAB STRIP WRAPS. Six tabs at their real names do not fit one line on a
        phone, and a horizontally scrolling tab strip hides the boards nobody scrolls to.
      */}
      <div role="tablist" className="mb-4 flex flex-wrap gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px]">
        {BOARDS.map((b) => (
          <button
            key={b.id}
            role="tab"
            aria-selected={board === b.id}
            title={b.blurb}
            onClick={() => setBoard(b.id)}
            className={cn(
              'rounded-lg px-[14px] py-2 font-ui text-caption font-medium uppercase tracking-label transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-brand)]',
              board === b.id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-4'
            )}
          >
            {b.tab}
          </button>
        ))}
      </div>

      {/*
        ★★★ EVERY BOARD SAYS WHAT IT IS BEFORE IT SAYS WHO IS ON IT. Kicker, title,
        scope, and one paragraph of what the number means and does not mean. The KE
        paragraph in particular is a build requirement, not decoration: the spec's own
        instruction is that KE "must say so on its face — not in a tooltip".
      */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 max-w-[620px]">
          <p className="font-ui text-caption uppercase tracking-label text-ink-brand-6">{def.kicker}</p>
          <h2 className="mt-1 font-text text-[22px] font-semibold leading-[30px] text-ink-2">{def.title}</h2>
          <p className="mt-2 font-ui text-[13.5px] leading-[21px] text-ink-10">{def.blurb}</p>
        </div>
        <p className="shrink-0 whitespace-pre-line text-right font-ui text-caption leading-[18px] text-ink-14">
          {def.meta}
        </p>
      </div>

      <div className="overflow-x-auto rounded-panel border border-line-9 bg-surface-1">
        {pending ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">Reading the chain&hellip;</p>
        ) : unavailable ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">
            The chain did not answer. Nothing is wrong with the account.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 font-ui text-[14px] text-ink-10">
            {matches && data?.building === true
              ? board === 'crossposting'
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
        ) : board === 'inquisitors' ? (
          <InquisitorTable rows={rows as InquisitorRow[]} />
        ) : board === 'ke' ? (
          <KeTable rows={rows as KeRow[]} />
        ) : (
          <CrosspostTable rows={rows as CrosspostRow[]} />
        )}
      </div>

      {matches && data?.asOf ? (
        <p className="mt-3 font-ui text-caption text-ink-14">
          Indexed {String(data.asOf).slice(0, 16).replace('T', ' ')}
        </p>
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
          Could not read: {(data.missing as string[]).map((p) => `@${p}`).join(', ')}. This list is
          incomplete.
        </p>
      ) : null}
      {matches && board === 'crossposting' && typeof data?.scope === 'number' ? (
        <p className="mt-2 font-ui text-caption text-ink-14">
          {String(data.scope)} of {typeof data?.listed === 'number' ? String(data.listed) : '?'} accounts
          on Steem&rsquo;s most recent posts also publish to Hive.
        </p>
      ) : null}

      {/*
        ★★ THE LEGEND AND THE APPEAL ROUTES CAME BACK TOO. A band word on a row
        ("extractive") is meaningless without its threshold, and the spec makes an appeal
        route a hard requirement — "Always an appeal ... Every blacklist mark links to
        that list's published appeal route".
      */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-panel border border-line-9 bg-surface-1 px-5 py-4">
          <p className="font-ui text-caption uppercase tracking-label text-ink-14">How to read it</p>
          <dl className="mt-3 space-y-1.5">
            {LEGEND.map((l) => (
              <div key={l.k} className="flex gap-3">
                <dt className="w-[76px] shrink-0 font-num text-[12.5px] tabular-nums text-ink-4">{l.k}</dt>
                <dd className="font-ui text-[13px] leading-[20px] text-ink-10">{l.v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-panel border border-line-9 bg-surface-1 px-5 py-4">
          <p className="font-ui text-caption uppercase tracking-label text-ink-14">Appeal a listing</p>
          <ul className="mt-3 space-y-1.5">
            {APPEALS.map((a) => (
              <li key={a.name} className="flex items-baseline justify-between gap-3">
                <span className="font-ui text-[13px] text-ink-4">{a.name}</span>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="font-ui text-[13px] text-ink-brand-6 hover:underline"
                >
                  appeal guide &rarr;
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 font-ui text-caption leading-[18px] text-ink-14">
            Lumen publishes no list and cannot remove a name from one. Appeals go to the
            publisher.
          </p>
        </div>
      </div>
    </div>
  );
}

const LEGEND: { k: string; v: string }[] = [
  { k: 'KE < 1', v: 'Net holder — kept more than it took' },
  { k: 'KE 1–3', v: 'Ordinary for an active author' },
  { k: 'KE 3–10', v: 'Extractive cash-out pattern' },
  { k: 'KE > 10', v: 'Cashing out, at scale' },
  { k: 'VOTERS', v: 'Distinct downvoters — beats raw volume' },
  { k: 'MUTED BY', v: 'Personal and free; stake is the corrective' }
];

const APPEALS: { name: string; url: string }[] = [
  { name: 'HiveWatchers', url: 'https://hivewatchers.com' },
  { name: 'Spaminator', url: 'https://spaminator.me' },
  { name: 'Steemcleaners', url: 'https://steemcleaners.org' }
];

function BlacklistTable({ rows }: { rows: BlacklistRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 font-medium" title="The account that published the list">
            Listed by
          </th>
          <th
            className="px-6 py-3 font-medium"
            title="A blacklist warns on transfers; it does not mute anyone"
          >
            List
          </th>
          <th className="px-6 py-3 font-medium">Appeal</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          row.marks.map((mark, i) => (
            <tr
              key={`${row.account}-${mark.publisher}-${mark.kind}`}
              className="border-b border-line-9 last:border-0"
            >
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
            <td className="font-num px-6 py-3 text-right text-[14px] tabular-nums text-ink-2">
              {row.mutedBy}
            </td>
            <td className="font-num px-6 py-3 text-right text-[14px] tabular-nums text-ink-10">
              {row.muterMvests.toLocaleString()}M
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InquisitorTable({ rows }: { rows: InquisitorRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="w-[46px] px-6 py-3 font-medium">#</th>
          <th className="px-6 py-3 font-medium">Account</th>
          <th
            className="px-6 py-3 text-right font-medium"
            title="Separate accounts this one downvoted. Spread, not volume, is the sort."
          >
            Targets
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Downvotes cast in the last three months">
            Dvs cast
          </th>
          <th className="px-6 py-3 font-medium" title="The account that received the most of them">
            Top target
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-num text-[13px] tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">{row.targets}</td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.downvotes.toLocaleString()}
            </td>
            <td className="px-6 py-3 font-ui text-[13.5px] text-ink-10">
              {row.topTarget ? (
                <>
                  <a href={`/@${row.topTarget}`} className="hover:text-ink-brand-6">
                    @{row.topTarget}
                  </a>{' '}
                  <span className="font-num tabular-nums text-ink-14">{row.topTargetVotes.toLocaleString()}</span>
                </>
              ) : (
                /* ★ Phase B can fail on its own; the counts are still real. */
                <span className="text-ink-14">not read</span>
              )}
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
          <th className="w-[46px] px-6 py-3 font-medium">#</th>
          <th className="px-6 py-3 font-medium">Account</th>
          {/* ★ VOTERS IS THE SORT, AND THE REASON IS IN THE QUERY: 903 downvotes from 12
              accounts is a dispute, 212 from 29 is a consensus. */}
          <th className="px-6 py-3 text-right font-medium" title="Distinct accounts that downvoted this one">
            Voters
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Downvotes received in the last three months">
            Downvotes
          </th>
          <th
            className="px-6 py-3 text-right font-medium"
            title="Payout removed from this account's posts by downvotes, at today's reward rate"
          >
            Removed
          </th>
          <th className="px-6 py-3 font-medium" title="The account that cast the most of them">
            Top source
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-num text-[13px] tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-2">{row.voters}</td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.downvotes.toLocaleString()}
            </td>
            {/* ★ A DASH IS "NOT COMPUTED", NEVER "NOTHING WAS TAKEN" — the enrichment
                query runs against a time budget and stops when it is spent. */}
            <td
              className={cn(
                'px-6 py-3 text-right font-num text-[14px] tabular-nums',
                row.removedUsd === null ? 'text-ink-14' : row.removedUsd >= 10 ? 'text-ink-brand-6' : 'text-ink-10'
              )}
              title={row.removedUsd === null ? 'Not computed for this row' : `${row.postsHit} posts affected`}
            >
              {row.removedUsd === null
                ? '\u2014'
                : '\u2212$' + (row.removedUsd >= 100 ? Math.round(row.removedUsd).toLocaleString() : row.removedUsd.toFixed(2))}
            </td>
            <td className="px-6 py-3 font-ui text-[13.5px] text-ink-10">
              {row.topSource ? (
                <>
                  <a href={`/@${row.topSource}`} className="hover:text-ink-brand-6">
                    @{row.topSource}
                  </a>{' '}
                  <span className="font-num tabular-nums text-ink-14">{row.topSourceVotes.toLocaleString()}</span>
                </>
              ) : (
                <span className="text-ink-14">mixed</span>
              )}
            </td>
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
          <th
            className="px-6 py-3 text-right font-medium"
            title="Lifetime rewards taken divided by Hive Power held"
          >
            KE
          </th>
          {/* ★ NO DEFINITION OF THE BAND WORDS ON SCREEN — owner's instruction. The
              thresholds and the caveat live in types.ts. */}
          <th className="px-6 py-3 font-medium">Band</th>
          <th
            className="px-6 py-3 text-right font-medium"
            title="Author and curation rewards over the account's whole life"
          >
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
            <td className="font-num px-6 py-3 text-right text-[14px] tabular-nums text-ink-2">
              {row.ke.toFixed(2)}
            </td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-10">{row.band}</td>
            <td className="font-num px-6 py-3 text-right text-[14px] tabular-nums text-ink-10">
              {row.rewardsHive.toLocaleString()}
            </td>
            <td className="font-num px-6 py-3 text-right text-[14px] tabular-nums text-ink-10">
              {row.hp.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CrosspostTable({ rows }: { rows: CrosspostRow[] }) {
  const day = (iso: string) => (iso ? iso.slice(0, 10) : '\u2014');
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-ui text-caption uppercase tracking-label text-ink-14">
          <th className="w-[46px] px-6 py-3 font-medium">#</th>
          <th className="px-6 py-3 font-medium">Account</th>
          <th className="px-6 py-3 text-right font-medium" title="Most recent post published to Steem">
            Last Steem
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Most recent post published to Hive">
            Last Hive
          </th>
          <th className="px-6 py-3 text-right font-medium" title="Posts published to Hive since the 2020 fork">
            Hive posts
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0">
            <td className="px-6 py-3 font-num text-[13px] tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-6 py-3 font-ui text-[14px] text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-6 py-3 text-right font-num text-[13.5px] tabular-nums text-ink-2">
              {day(row.lastSteem)}
            </td>
            <td className="px-6 py-3 text-right font-num text-[13.5px] tabular-nums text-ink-10">
              {day(row.lastHive)}
            </td>
            <td className="px-6 py-3 text-right font-num text-[14px] tabular-nums text-ink-10">
              {row.hivePosts.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
