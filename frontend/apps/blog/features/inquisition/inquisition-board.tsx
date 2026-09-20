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

interface CrosspostRow {
  account: string;
  steemPosts: number;
  partial: boolean;
  lastSteem: string;
  lastHive: string;
  hivePosts: number;
}

type BoardId = 'ke' | 'downvoted' | 'muted' | 'inquisitors' | 'crossposting';

/**
 * ★★★ THE BOARDS CARRY THEIR OWN TITLE, KICKER AND SCOPE LINE. Stripping that was a
 * mistake (owner: "you cut all text ... No one even knows what these tabs are"): a tab
 * reading "KE" over a column reading "KE" tells a reader nothing about what the number
 * is, where it came from, or how far back it goes.
 *
 * ★★ NO BLACKLIST BOARD (owner, 2026-09-19: "remove the blacklists from mode and bar.
 * it wont work, we add that later"). Removed outright, not hidden behind a flag.
 */
interface BoardDef {
  id: BoardId;
  tab: string;
  kicker: string;
  title: string;
  meta: string;
  blurb: string;
}

/** Rows revealed per press of SHOW MORE. */
const PAGE = 12;

/** The orderings a reader can pick, per board. The first is that board's default. */
const SORTS: Partial<Record<BoardId, { key: string; label: string; field: string }[]>> = {
  inquisitors: [
    { key: 'removed', label: 'BY VALUE REMOVED', field: 'removedUsd' },
    { key: 'cast', label: 'BY DOWNVOTES CAST', field: 'downvotes' },
    { key: 'targets', label: 'BY TARGETS', field: 'targets' }
  ],
  downvoted: [
    { key: 'downvotes', label: 'BY DOWNVOTES', field: 'downvotes' },
    { key: 'removed', label: 'BY VALUE REMOVED', field: 'removedUsd' }
  ]
};

const BOARDS: BoardDef[] = [
  {
    id: 'ke',
    tab: 'KE INDEX',
    kicker: 'BOARD 01 \u00b7 WHAT WAS TAKEN, OVER WHAT WAS KEPT',
    title: 'The KE index',
    meta: 'worst first \u00b7 min 500 HP\nposted in the last 3 months',
    blurb:
      'Everything taken in rewards, over the stake still held. A high number is a cash-out habit, not a crime: someone quietly living off their payouts and a reward-pool farm read exactly alike here, and the index cannot tell you which is which. Neither can we.'
  },
  {
    id: 'downvoted',
    tab: 'TOP DOWNVOTED',
    kicker: 'BOARD 02 \u00b7 THE PENITENTS',
    title: 'Most downvoted',
    meta: 'whole chain history\nvalue read for the first rows',
    blurb:
      'Ranked by downvotes received. The money column records the punishment duly inflicted.'
  },
  {
    id: 'muted',
    tab: 'MOST MUTED',
    kicker: 'BOARD 03 \u00b7 QUIETLY SHUNNED',
    title: 'Most muted',
    meta: 'on-chain follow ops\nwhat: ignore',
    blurb:
      'Ranked by how many have quietly turned away. A mute costs nothing and asks no permission, so the stake behind them is shown too: being ignored by many is not the same as being ignored by much.'
  },
  {
    id: 'inquisitors',
    tab: 'TOP INQUISITORS',
    kicker: 'BOARD 04 \u00b7 THE FAITHFUL, AT WORK',
    title: 'Top inquisitors',
    meta: 'whole chain, pre-fork included\nvalue and top target for the first rows',
    blurb:
      'The other end of the rod. Who wields it, how widely, what it cost the accused, and who feels it most. Downvoting is a right the chain grants everyone: this board says who exercises it, never whether they should.'
  },
  {
    id: 'crossposting',
    tab: 'CROSSPOSTING',
    kicker: 'BOARD 05 \u00b7 OLD LOYALTIES',
    title: 'Crossposting',
    meta: 'since 2020-09-20\nfrom Steem\u2019s recent authors',
    blurb:
      'Still keeping a foot in the old country. Posts put on Steem since six months after the fork, when the leaving was done and staying became a choice. The candidates are drawn from Steem\u2019s recent authors, so this finds the ones still at it rather than everyone who ever was.'

  }
];

interface InquisitorRow {
  account: string;
  downvotes: number;
  targets: number;
  topTarget: string;
  topTargetVotes: number;
  removedUsd: number | null;
}

interface DvRow {
  account: string;
  downvotes: number;
  voters: number;
  topSource: string;
  topSourceVotes: number;
  removedUsd: number | null;
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
  muterMvests: number | null;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function InquisitionBoard() {
  const [armed, setArmed] = useState(false);
  const [board, setBoard] = useState<BoardId>('ke');
  /*
   * ★★★ SHOW MORE REVEALS, THEN FETCHES (owner, 2026-09-19: "each page needs to be able
   * to be expanded. SHOW MORE. then you pull more").
   *
   * Two stages on purpose. The build already holds 50 rows, so the first presses cost
   * nothing but a re-render; only once those are exhausted does the button ask the server
   * for the deeper tier, which is a genuinely more expensive query against somebody
   * else's database. A reader who never presses it never pays for rows nobody looked at.
   */
  const [shown, setShown] = useState(PAGE);
  /*
   * ★★★ TWO BOARDS ARE SORTABLE, AND IT COSTS NOTHING (owner, 2026-09-19: "the top
   * inquisitiors you need to be able to click rank by number of votes cast and $ value
   * removed ... the primary starting for top inquisitior would be $ value removed", then
   * "same thing for the most downvoted page").
   *
   * Both figures are already in every row, so the toggle re-sorts what the reader is
   * holding. No second query, no second cache entry, no wait. The default differs per
   * board because the owner set it: money first on Inquisitors, raw downvotes first on
   * Downvoted.
   */
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => watchArm(setArmed), []);

  /*
   * ★ ONE FETCH PER BOARD PER VISIT, AND THE RESULT IS KEPT. Switching tabs back and
   * forth must not re-ask the server: the aggregates behind these are shared and
   * cached, but a component that refetches on every tab click still turns one reader
   * into a stream of requests.
   */
  const [cache, setCache] = useState<Record<string, Record<string, unknown>>>({});

  /*
   * ★★ A BUILDING BOARD IS POLLED, A FINISHED ONE IS KEPT. The Steem board is assembled
   * off the request path — 45 sequential lookups, measured at 30s cold — so the first
   * response comes back `building: true` with however many rows are ready. Polling every
   * three seconds shows it fill instead of showing an empty panel for half a minute, and
   * the poll stops the moment the server says `done`. Only a finished board is cached,
   * so a half-built one can never be mistaken for the answer.
   */
  // A new board starts at the first page again.
  useEffect(() => {
    setShown(PAGE);
    setSortKey(null);
  }, [board]);

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
  const sorts = SORTS[board];
  const activeSort = sortKey ?? sorts?.[0]?.key ?? null;
  const rawRows = matches ? ((data?.rows as unknown[] | undefined) ?? []) : [];
  /*
   * ★ A NULL MONEY FIGURE SORTS LAST, NOT AS ZERO. "not computed" is not "took nothing",
   * so those rows sink rather than competing with real zeros at the bottom of the money
   * ordering.
   */
  const allRows = (() => {
    const field = sorts?.find((x) => x.key === activeSort)?.field;
    if (!field) return rawRows;
    return [...rawRows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[field];
      const bv = (b as Record<string, unknown>)[field];
      const an = typeof av === 'number' ? av : null;
      const bn = typeof bv === 'number' ? bv : null;
      if (an === null && bn === null) return 0;
      if (an === null) return 1;
      if (bn === null) return -1;
      return bn - an;
    });
  })();
  const rows = allRows.slice(0, shown);
  // ★ SHOW MORE now only ever reveals rows already in hand: the build is 100 deep.
  const more = shown < allRows.length;
  const unavailable = matches && data?.unavailable === true;
  const pending = loading || !matches;

  const def = BOARDS.find((b) => b.id === board) ?? BOARDS[0];

  return (
    <div className="min-w-0">
      {/*
        ★★★ THE HEADER BAND. The art is the whole costume, and the boards below stay
        flat because of it. Three things the owner cut by name and which are NOT here:
        the "INQUISITION MODE / ON" kicker above the title, the line "Nobody expects the
        Hive Inquisition.", and every em dash in the copy.

        ★★★ THIS IS THE MOCK'S OWN ASSET, AND I HAD SHIPPED THE WRONG FILE. The handoff
        contains two images with the same name: `dark-handoff/assets/inquisition-header.png`
        (1400x420, a hood in the dark) and the Inquisition mock's own
        `inquisition/assets/inquisition-header.png` (1400x560, md5 abb4a923) — the one with
        the lit magnifying glass, which is the whole visual argument for the feature. I
        copied the first. A visual review caught it: "the one image element that told users
        this is an investigation tool was cropped away". It was never in the file.

        The real asset is composed for a centre crop with a dark left third for the scrim,
        so `object-center` is correct here and `object-right` was me compensating for the
        wrong picture.

        ★★ AND THE BAND HAS TO BE TALL ENOUGH TO HOLD IT, which the mock's 238px is not
        for this file. The art is 1400x560 (2.5:1). At roughly 1090px of column width
        `object-cover` scales it to 437px tall, so a 238px band discards **45% of the
        image height** — and what it discards is the top of the hood and the bottom of the
        magnifying glass, which is to say the subject. 340px keeps about 78% of the frame
        and both of them stay in it. Shorter on small screens, where the column is
        narrower and the crop is correspondingly gentler.
      */}
      <div
        className={cn(
          'relative mb-4 flex min-h-[248px] items-center overflow-hidden rounded-panel border sm:min-h-[340px]',
          'bg-surface-1 transition-[border-color] duration-700',
          armed ? 'border-line-brand-10' : 'border-line-9'
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/inquisition/header.png"
          alt=""
          aria-hidden="true"
          className={cn(
            'absolute inset-0 h-full w-full object-cover object-center',
            'transition-[opacity,transform] duration-[900ms] ease-out'
          )}
          style={{ opacity: armed ? 1 : 0.24, transform: armed ? 'scale(1)' : 'scale(1.04)' }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgb(var(--surface-1)) 0%, rgb(var(--surface-1) / 0.92) 34%, rgb(var(--surface-1) / 0.35) 52%, rgb(var(--surface-1) / 0) 68%)'
          }}
        />

        {/* ★ THE MEASUREMENTS ARE THE MOCK'S: 30/32px padding, the title capped at 16ch
            and the body at 33ch, with no cap on the wrapper. Capping the wrapper instead
            squeezed the title onto two lines and ran the body down a narrow column. */}
        <div className="relative z-[2] px-8 py-[30px]">
          <h1 className="max-w-[16ch] font-text text-display font-semibold tracking-display text-ink-2">
            Inquisition mode
          </h1>
          {/*
            ★★★ THEATRICAL IN THE CHROME, LITERAL IN THE ROWS. That is the spec's own tone
            rule and I had written neither half: the old line read like a privacy policy.
            The costume carries the joke so the boards underneath can stay flat, and the
            disclaimer still lands, just in character.
          */}
          <p className="mt-3 max-w-[36ch] font-ui text-body-sm leading-[1.6] text-ink-10">
            Everything here is already on the chain. We keep no list, name no heretic and
            pass no sentence: we simply read the ledger back to you, with receipts and the
            dates attached. What you make of it is on your conscience.
          </p>
        </div>

        {/*
          ★★ THE ARMING PILL. The black rectangle on click was the browser's default focus
          ring boxing a round control; `focus-visible` only.
        */}
        <button
          type="button"
          onClick={toggleArm}
          aria-pressed={armed}
          title={armed ? 'Turn the mode off and restore your theme' : 'Turn the mode on; this switches you to dark'}
          className={cn(
            'absolute right-6 top-5 z-[5] inline-flex shrink-0 items-center gap-2 rounded-full border p-1',
            'transition-[background-color,border-color,box-shadow] duration-500',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10',
            armed ? 'border-line-brand-10 bg-[var(--amb-1)]' : 'border-line-6 bg-[var(--amb-1)]'
          )}
          data-testid="inquisition-arm"
        >
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-caption font-medium leading-[20px] transition-colors duration-300',
              !armed ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-14'
            )}
          >
            Off
          </span>
          <span
            className={cn(
              'rounded-full px-3 py-1 font-ui text-caption font-medium leading-[20px] transition-colors duration-300',
              armed ? 'bg-surface-brand-12 text-ink-27' : 'text-ink-14'
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
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10',
              board === b.id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-4'
            )}
          >
            {b.tab}
          </button>
        ))}
      </div>

      {/*
        ★★★ THE BOARD HEADER LIVES INSIDE THE CARD, AND THAT IS WHY THE TEXT NOW LINES UP
        (owner, 2026-09-19: "the text in places is outside the line with the cards. the
        explanation text is not allinged with card edges").

        I had the kicker, title, scope and blurb as a block ABOVE the bordered card, so
        every one of them started at the page gutter while the table started at the card's
        inner padding. The mock puts all of it in ONE card and gives the header block, the
        column header row and the body rows the same horizontal padding, so the title, the
        blurb and the first column all begin on the same vertical line. It is a repeated
        number, not a computed alignment, which is exactly why it has to be repeated
        faithfully: 26px on all three.
      */}
      <div className="overflow-hidden rounded-panel border border-line-9 bg-surface-1">
        <div className="border-b border-line-9 px-[26px] pb-5 pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
            <div className="min-w-0">
              <p
                className={cn(
                  'font-num text-[10px] uppercase tracking-[0.16em] transition-colors',
                  armed ? 'text-ink-brand-6' : 'text-ink-14'
                )}
              >
                {def.kicker}
              </p>
              {/* ★ `stat` (22px) from the scale, not a hand-written 25: the ladder skips 25,
                  and inventing a size is exactly what tailwind.config.js forbids. */}
              <h2 className="mt-2 font-text text-stat font-semibold text-ink-2">{def.title}</h2>
            </div>
            <p className="shrink-0 whitespace-pre-line text-right font-num text-[11px] leading-[1.6] text-ink-14">
              {def.meta}
            </p>
          </div>
          {/* ★ The KE paragraph is a build requirement, not decoration: the spec says KE
              "must say so on its face, not in a tooltip". */}
          <p className="mt-3 max-w-[78ch] font-ui text-caption leading-[21px] text-ink-10">{def.blurb}</p>

          {sorts ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {sorts.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setSortKey(o.key)}
                  aria-pressed={activeSort === o.key}
                  className={cn(
                    'rounded-md px-[13px] py-2 font-num text-[10px] uppercase tracking-[0.09em] transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10',
                    activeSort === o.key
                      ? 'bg-surface-brand-12 text-ink-27'
                      : 'text-ink-14 ring-1 ring-inset ring-line-9 hover:text-ink-4'
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          {pending ? (
            <p className="px-[26px] py-8 font-ui text-body-sm text-ink-10">Reading the chain&hellip;</p>
          ) : unavailable ? (
            <p className="px-[26px] py-8 font-ui text-body-sm text-ink-10">
              The chain declines to testify. Nothing is implied about anyone.
            </p>
          ) : rows.length === 0 ? (
            <p className="px-[26px] py-8 font-ui text-body-sm text-ink-10">
              {matches && data?.building === true
                ? board === 'crossposting'
                  ? 'Asking Steem\u2026'
                  : 'Counting\u2026'
                : 'Nothing to confess.'}
            </p>
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

          {rows.length > 0 && more ? (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className={cn(
                'w-full border-t border-line-9 px-[26px] py-3.5 font-num text-[10px] uppercase tracking-[0.13em]',
                'text-ink-14 transition-colors hover:bg-[var(--lum-1)] hover:text-ink-brand-6',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10'
              )}
            >
              Show more &middot; {allRows.length - shown} left
            </button>
          ) : null}
        </div>
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
      {matches && board === 'crossposting' && typeof data?.scope === 'number' ? (
        <p className="mt-2 font-ui text-caption text-ink-14">
          {typeof data?.matched === 'number' ? String(data.matched) : String(data.scope)} of{' '}
          {typeof data?.listed === 'number' ? String(data.listed) : '?'} accounts on Steem&rsquo;s most
          recent posts also publish to Hive.
        </p>
      ) : null}

    </div>
  );
}



function MutedTable({ rows }: { rows: MutedRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-num text-[10px] uppercase tracking-[0.13em] text-ink-14">
          <th className="w-[52px] px-[26px] py-3 font-normal">#</th>
          <th className="px-[26px] py-3 font-normal">Account</th>
          <th className="px-[26px] py-3 text-right font-normal" title="Accounts that have muted this one">
            Muted by
          </th>
          {/* ★ STAKE IS THE CORRECTIVE. A mute is free, so a raw count rewards whoever
              annoyed the most small accounts. In HP, matching the profile record: this
              column used to print raw VESTS under an HP label, 1,610x off. */}
          <th className="px-[26px] py-3 text-right font-normal" title="Combined Hive Power of those accounts, in millions">
            Muter stake
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0 hover:bg-[var(--lum-1)]">
            <td className="px-[26px] py-[15px] font-num text-caption tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-[26px] py-[15px] font-num text-body-sm text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td
              className={cn(
                'px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums',
                row.mutedBy >= 50 ? 'text-ink-warn-3' : 'text-ink-2'
              )}
            >
              {row.mutedBy.toLocaleString()}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
              {/* ★ A dash, not "0M HP". The stake pass is separate from the count and can
                     fail on its own; 0 would claim the muters hold nothing. */}
              {row.muterMvests === null ? (
                <span className="text-ink-14">&mdash;</span>
              ) : (
                <>{row.muterMvests.toLocaleString(undefined, { maximumFractionDigits: 1 })}M HP</>
              )}
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
        <tr className="border-b border-line-9 text-left font-num text-[10px] uppercase tracking-[0.13em] text-ink-14">
          <th className="w-[52px] px-[26px] py-3 font-normal">#</th>
          <th className="px-[26px] py-3 font-normal">Account</th>
          {/*
            ★ REMOVED IS GREEN HERE AND ONLY HERE (owner: "Wheres on that page in green $
            amount they took off posts"). On board 02 the same money is a loss to the
            account listed, so it carries the brand accent; on this board it is value the
            inquisitor took OUT of the reward pool, which is the job working. Same figure,
            opposite sign, and the colour is the only thing that says so.
          */}
          <th
            className="px-[26px] py-3 text-right font-normal"
            title="What this account's downvotes took off every post they landed on, across the whole chain. HBD as the chain declared it: for posts before mid-2018 the SBD of the day traded above peg, so realised value was higher. A dash means not computed, never nothing."
          >
            Removed (HBD)
          </th>
          <th
            className="px-[26px] py-3 text-right font-normal"
            title="Separate accounts this one downvoted. Spread and volume say different things; use the pills above to reorder."
          >
            Targets
          </th>
          <th className="px-[26px] py-3 text-right font-normal" title="Downvotes cast over the account's whole history">
            Downvotes cast
          </th>
          <th className="px-[26px] py-3 font-normal" title="The account that received the most of them, over the whole chain. Read for the first 25 rows only.">
            Top target
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0 hover:bg-[var(--lum-1)]">
            <td className="px-[26px] py-[15px] font-num text-caption tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-[26px] py-[15px] font-num text-body-sm text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums">
              {/* ★ A SUB-CENT TOTAL IS NOTHING, AND IT RENDERED THREE DIFFERENT WAYS:
                  "$0", "-$0.00" and a dash, in one column. One rule now. */}
              {/* ★ A DASH MEANS NOT COMPUTED. A real sub-cent total is "<$0.01", which is
                  a finding of its own: @prowler cast 91,569 downvotes for two-thousandths
                  of a cent. Rendering both as the same dash hid that. */}
              {row.removedUsd === null ? (
                <span className="text-ink-14">&mdash;</span>
              ) : row.removedUsd < 0.005 ? (
                <span className="text-ink-14">&lt;$0.01</span>
              ) : (
                <span className="text-ink-ok-2">
                  {'$' +
                    row.removedUsd.toLocaleString(undefined, {
                      maximumFractionDigits: row.removedUsd < 100 ? 2 : 0
                    })}
                </span>
              )}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-2">
              {row.targets.toLocaleString()}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
              {row.downvotes.toLocaleString()}
            </td>
            {/*
              ★ THE COUNT IS SEPARATED FROM THE NAME. It used to sit flush after the
              handle, so "@askrafiki 871" read as part of the account name rather than as
              how many downvotes that account took.
            */}
            <td className="px-[26px] py-[15px] font-num text-caption text-ink-10">
              {row.topTarget ? (
                <span className="inline-flex items-baseline gap-1.5">
                  <a href={`/@${row.topTarget}`} className="text-ink-2 hover:text-ink-brand-6">
                    @{row.topTarget}
                  </a>
                  <span className="text-ink-14">&middot;</span>
                  <span className="tabular-nums text-ink-14">{row.topTargetVotes.toLocaleString()}</span>
                </span>
              ) : (
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
        <tr className="border-b border-line-9 text-left font-num text-[10px] uppercase tracking-[0.13em] text-ink-14">
          <th className="w-[52px] px-[26px] py-3 font-normal">#</th>
          <th className="px-[26px] py-3 font-normal">Account</th>
          {/* ★ DOWNVOTES IS THE RANK, not distinct voters — the board is called MOST
              DOWNVOTED and now means it. Downvoters stays beside it because the two say
              different things: many downvotes from few accounts is a dispute, a smaller
              number from many is a consensus. */}
          <th className="px-[26px] py-3 text-right font-normal" title="Downvotes received over the account's whole history">
            Downvotes
          </th>
          {/* ★ "Downvoters", not "Voters": on a board about downvotes the short word is
              ambiguous and reads as everyone who voted. */}
          <th className="px-[26px] py-3 text-right font-normal" title="Distinct accounts that cast those downvotes">
            Downvoters
          </th>
          <th
            className="px-[26px] py-3 text-right font-medium"
            title="Payout this account's posts lost to downvotes, across the whole chain. Exact where the post still paid; modelled only where it was flattened to nothing. A dash means not computed, never zero."
          >
            Removed (HBD)
          </th>
          <th className="px-[26px] py-3 font-medium" title="The account that cast the most of them">
            Top source
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0 hover:bg-[var(--lum-1)]">
            <td className="px-[26px] py-[15px] font-num text-caption tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-[26px] py-[15px] font-num text-body-sm text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            {/* Downvotes first: it is the rank. */}
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-2">
              {row.downvotes.toLocaleString()}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
              {row.voters.toLocaleString()}
            </td>
            {/* ★ A DASH IS "NOT COMPUTED", NEVER "NOTHING WAS TAKEN" — the enrichment
                query runs against a time budget and stops when it is spent. */}
            <td
              className={cn(
                'px-6 py-3 text-right font-num text-body-sm tabular-nums',
                row.removedUsd === null ? 'text-ink-14' : row.removedUsd >= 10 ? 'text-ink-brand-6' : 'text-ink-10'
              )}
              title={
                row.removedUsd === null
                  ? 'Not computed for this row'
                  : 'Payout these downvotes took off the posts, each valued at that post\u2019s own rate when it paid'
              }
            >
              {row.removedUsd === null
                ? '\u2014'
                : row.removedUsd < 0.005
                  ? '\u2212<$0.01'
                  : '\u2212$' + (row.removedUsd >= 100 ? Math.round(row.removedUsd).toLocaleString() : row.removedUsd.toFixed(2))}
            </td>
            <td className="px-[26px] py-[15px] font-ui text-caption text-ink-10">
              {row.topSource ? (
                <>
                  <a href={`/@${row.topSource}`} className="hover:text-ink-brand-6">
                    @{row.topSource}
                  </a>{' '}
                  <span className="font-num tabular-nums text-ink-14">{row.topSourceVotes.toLocaleString()}</span>
                </>
              ) : (
                /* ★★ "not read", NEVER "mixed". An empty `topSource` means the lookup was
                   not reached — and it is not reached for rows 26-100, because the pass
                   only covers `TOP_TARGET_ROWS`. "mixed" is a claim that this account's
                   downvotes came from no dominant source, which is a finding about the
                   account rather than an admission about us. The Inquisitors table beside
                   it already said "not read" for exactly the same state. */
                <span className="text-ink-14">not read</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KeTable({ rows }: { rows: KeRow[] }) {
  /*
   * ★★★ THE BAND IS COLOURED, AND IT WAS THE BIGGEST REASON THE BOARD LOOKED DEAD (found
   * by visual review, 2026-09-19: every band from KE 51 to KE 124 rendered flat grey).
   * The ramp already existed and worked on the profile; it simply was not wired to the
   * one table the design built it for. Colour carries the reading here, which is why the
   * band word sits next to it and says the same thing in English.
   */
  const tone = (ke: number) =>
    ke >= 10 ? 'text-ink-brand-6' : ke >= 3 ? 'text-ink-warn-3' : ke >= 1 ? 'text-ink-2' : 'text-ink-ok-2';
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-9 text-left font-num text-[10px] uppercase tracking-[0.13em] text-ink-14">
          <th className="w-[52px] px-[26px] py-3 font-normal">#</th>
          <th className="px-[26px] py-3 font-normal">Account</th>
          <th
            className="px-[26px] py-3 text-right font-normal"
            title="Lifetime rewards taken (HIVE) divided by Hive Power held. Both sides are HIVE, so the ratio has no unit."
          >
            KE
          </th>
          <th className="px-[26px] py-3 font-normal">Band</th>
          {/* ★★ THE UNIT IS IN THE HEADER (owner: "rewards in places miss what it is. is
              it USD on KE or Hive"). KE's numerator is HIVE, not dollars: author plus
              curation rewards as HIVE, over HP held. Both sides of the ratio are the same
              unit, which is exactly why KE is a bare number with no currency on it. */}
          <th
            className="px-[26px] py-3 text-right font-normal"
            title="Author and curation rewards over the account's whole life, in HIVE"
          >
            Rewards (HIVE)
          </th>
          <th className="px-[26px] py-3 text-right font-normal" title="Hive Power held now">
            HP held
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0 hover:bg-[var(--lum-1)]">
            <td className="px-[26px] py-[15px] font-num text-caption tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-[26px] py-[15px] font-num text-body-sm text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            <td className={cn('px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums', tone(row.ke))}>
              {row.ke.toFixed(2)}
            </td>
            <td className={cn('px-[26px] py-[15px] font-ui text-caption', tone(row.ke))}>{row.band}</td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
              {row.rewardsHive.toLocaleString()}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
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
        <tr className="border-b border-line-9 text-left font-num text-[10px] uppercase tracking-[0.13em] text-ink-14">
          <th className="w-[52px] px-[26px] py-3 font-normal">#</th>
          <th className="px-[26px] py-3 font-normal">Account</th>
          <th
            className="px-[26px] py-3 text-right font-normal"
            title="Posts published to Steem since six months after the fork. This is the ranking."
          >
            Steem posts
          </th>
          <th className="px-[26px] py-3 text-right font-normal" title="Most recent post published to Steem">
            Last Steem
          </th>
          <th className="px-[26px] py-3 text-right font-normal" title="Most recent post published to Hive">
            Last Hive
          </th>
          <th className="px-[26px] py-3 text-right font-normal" title="Posts published to Hive since the 2020 fork">
            Hive posts
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.account} className="border-b border-line-9 last:border-0 hover:bg-[var(--lum-1)]">
            <td className="px-[26px] py-[15px] font-num text-caption tabular-nums text-ink-14">{i + 1}</td>
            <td className="px-[26px] py-[15px] font-num text-body-sm text-ink-2">
              <a href={`/@${row.account}`} className="hover:text-ink-brand-6">
                @{row.account}
              </a>
            </td>
            {/* ★ -1 means the counting pass ran out of budget before reaching this row.
                "not counted" is the truth; 0 would be a claim. */}
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-brand-6">
              {row.steemPosts < 0 ? (
                <span className="text-ink-14">not counted</span>
              ) : (
                <>
                  {row.steemPosts.toLocaleString()}
                  {row.partial ? '+' : ''}
                </>
              )}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-caption tabular-nums text-ink-2">
              {day(row.lastSteem)}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-caption tabular-nums text-ink-10">
              {day(row.lastHive)}
            </td>
            <td className="px-[26px] py-[15px] text-right font-num text-body-sm tabular-nums text-ink-10">
              {row.hivePosts.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
