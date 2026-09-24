/**
 * The client side of a quote reblog (lib/quote-reblog/quote-flow.ts): the retry rules of
 * spec v2 section 4, with every effect faked. Plain assertions, no test runner (same
 * style as feed-cache-memory-vs-store.test.ts). Exits 0 when every check passes.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/quote-flow.test.ts
 */
import {
  publishQuote,
  removeQuote,
  QuoteFlowError,
  type ApiResult,
  type QuoteFlowDeps,
  type QuotePlan,
  type RemovalPlan
} from '../quote-reblog/quote-flow';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const target = { author: 'bob', permlink: 'how-rc-works' };
const plan: QuotePlan = {
  parentAuthor: 'pub',
  parentPermlink: 'lumen-q-01abc',
  permlink: 'lumen-rq-0123456789abcdef',
  jsonMetadata: { type: 'lumen_quote' },
  edit: false,
  existing: null
};
const removal: RemovalPlan = { permlink: plan.permlink, parentAuthor: 'pub', parentPermlink: 'lumen-q-01abc', jsonMetadata: {}, mode: 'delete' };

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const no = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

type Script = {
  prepare?: ApiResult<QuotePlan>;
  confirms?: ApiResult<{ bodyCache: string; state: string }>[];
  removePlans?: ApiResult<{ plan: RemovalPlan | null }>[];
  removeds?: ApiResult<{ removed: boolean }>[];
  signQuoteErrors?: (Error | null)[];
  signRemoveErrors?: (Error | null)[];
};

function fake(script: Script) {
  const calls = {
    signQuote: [] as Parameters<QuoteFlowDeps['signQuote']>[0][],
    signRemove: [] as Parameters<QuoteFlowDeps['signRemove']>[0][],
    signUnreblog: 0,
    sleeps: [] as number[],
    confirms: 0
  };
  const next = <T>(list: T[] | undefined, fallback: T): T => (list && list.length ? (list.length > 1 ? list.shift()! : list[0]) : fallback);
  const deps: QuoteFlowDeps = {
    prepare: async () => script.prepare ?? ok(plan),
    confirm: async () => {
      calls.confirms++;
      return next(script.confirms, ok({ bodyCache: 'Great read.', state: 'live' }));
    },
    removePlan: async () => next(script.removePlans, ok({ plan: removal })),
    removed: async () => next(script.removeds, ok({ removed: true })),
    signQuote: async (input) => {
      calls.signQuote.push(input);
      const e = script.signQuoteErrors?.shift();
      if (e) throw e;
    },
    signRemove: async (input) => {
      calls.signRemove.push(input);
      const e = script.signRemoveErrors?.shift();
      if (e) throw e;
    },
    signUnreblog: async () => {
      calls.signUnreblog++;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    }
  };
  return { deps, calls };
}

const input = { target, caption: '  Great read.  ', bodyFor: (c: string) => `${c}\n\nReblogged from @bob`, alreadyReblogged: false };

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  console.log('publish');
  {
    const { deps, calls } = fake({});
    const empty = await rejects(publishQuote(deps, { ...input, caption: '   ' }));
    const long = await rejects(publishQuote(deps, { ...input, caption: 'x'.repeat(281) }));
    check('an empty caption is refused (a plain reblog), nothing signed', empty instanceof QuoteFlowError && empty.code === 'empty' && calls.signQuote.length === 0);
    check('281 characters is refused before anything is signed', long instanceof QuoteFlowError && long.code === 'too_long' && calls.signQuote.length === 0);
  }
  {
    const { deps, calls } = fake({});
    const r = await publishQuote(deps, input);
    const s = calls.signQuote[0];
    check('happy path: ONE signature with the reblog and the comment', calls.signQuote.length === 1 && s.reblog?.author === 'bob' && s.comment.permlink === plan.permlink && s.comment.parentPermlink === plan.parentPermlink);
    check('...the body is built from the TRIMMED caption', s.comment.body === 'Great read.\n\nReblogged from @bob', JSON.stringify(s.comment.body));
    check('...and the verified record comes back', r.state === 'live' && r.bodyCache === 'Great read.');
  }
  {
    const { deps, calls } = fake({});
    await publishQuote(deps, { ...input, alreadyReblogged: true });
    check('already reblogged: the comment alone is signed', calls.signQuote[0].reblog === null);
  }
  {
    const { deps, calls } = fake({ prepare: ok({ ...plan, edit: true }) });
    await publishQuote(deps, input);
    check("the server's edit flag reaches the signer (no reward options on an edit)", calls.signQuote[0].comment.edit === true);
  }
  {
    const { deps, calls } = fake({ prepare: no(403, 'blocked') });
    const e = await rejects(publishQuote(deps, input));
    check("a refusal (blocked) surfaces with its code, nothing signed", e instanceof QuoteFlowError && e.code === 'blocked' && calls.signQuote.length === 0);
  }
  {
    const { deps, calls } = fake({ signQuoteErrors: [new Error('Assert Exception: You may only comment once every 3 seconds.')] });
    await publishQuote(deps, input);
    check("Hive's 3-second rule: wait once, sign again, succeed", calls.signQuote.length === 2 && calls.sleeps[0] === 3500);
  }
  {
    const { deps, calls } = fake({ signQuoteErrors: [new Error('timeout waiting for the transaction')] });
    const r = await publishQuote(deps, input);
    check('unknown outcome, and our text IS on chain: success, no second signature', r.state === 'live' && calls.signQuote.length === 1);
  }
  {
    const cancel = new Error('user rejected the request');
    const { deps, calls } = fake({ signQuoteErrors: [cancel], confirms: [no(409, 'not_on_chain')] });
    const e = await rejects(publishQuote(deps, input));
    check('a cancelled approval: the original error comes back, the wallet is not reopened', e === cancel && calls.signQuote.length === 1);
  }
  {
    const err = new Error('RC too low');
    const { deps } = fake({ signQuoteErrors: [err], confirms: [ok({ bodyCache: 'the OLD caption', state: 'live' })] });
    const e = await rejects(publishQuote(deps, input));
    check('an edit that failed while the OLD text is on chain is a failure, not a success', e === err);
  }
  {
    const { deps, calls } = fake({ confirms: [no(409, 'not_on_chain'), no(409, 'not_on_chain'), ok({ bodyCache: 'Great read.', state: 'live' })] });
    const r = await publishQuote(deps, input);
    check('a node a block behind: asked again until it sees it', r.state === 'live' && calls.confirms === 3 && calls.sleeps.length === 2);
  }
  {
    const { deps } = fake({ confirms: [no(409, 'not_on_chain')] });
    const e = await rejects(publishQuote(deps, input));
    check('never seen on chain after the retries: a refusal, not a silent success', e instanceof QuoteFlowError && e.code === 'not_on_chain');
  }

  {
    // Found on the testnet: an edit confirmed while the node still had the OLD text.
    const { deps, calls } = fake({ confirms: [ok({ bodyCache: 'the OLD caption', state: 'live' }), ok({ bodyCache: 'the OLD caption', state: 'live' }), ok({ bodyCache: 'Great read.', state: 'live' })] });
    const r = await publishQuote(deps, { ...input, alreadyReblogged: true });
    check('an edit: the OLD text on chain is not "saved"; asked again until the new text shows', r.bodyCache === 'Great read.' && calls.confirms === 3 && calls.sleeps.length === 2, `${calls.confirms} ${r.bodyCache}`);
  }
  {
    const { deps } = fake({ confirms: [ok({ bodyCache: 'the OLD caption', state: 'live' })] });
    const e = await rejects(publishQuote(deps, { ...input, alreadyReblogged: true }));
    check('an edit that never shows up: a refusal, not "saved" with the old text', e instanceof QuoteFlowError && e.code === 'not_on_chain');
  }
  {
    // The caption itself holds the cut line: the server caches the text BEFORE it.
    const tricky = 'Line one\n\nReblogged from somewhere I liked';
    const { deps } = fake({ confirms: [ok({ bodyCache: 'Line one', state: 'live' })] });
    const r = await publishQuote(deps, { ...input, caption: tricky });
    check("a caption the server's rule shortens still matches (same rule on both sides)", r.bodyCache === 'Line one');
  }

  console.log('remove');
  {
    const { deps, calls } = fake({});
    await removeQuote(deps, { target, undoReblog: true });
    check('delete, with the reblog undone in the SAME signature', calls.signRemove.length === 1 && calls.signRemove[0].mode === 'delete' && calls.signRemove[0].undoReblog?.permlink === 'how-rc-works');
  }
  {
    const { deps, calls } = fake({ signRemoveErrors: [new Error('Cannot delete a comment with net positive votes.')], removePlans: [ok({ plan: removal }), ok({ plan: { ...removal, mode: 'blank' } })] });
    await removeQuote(deps, { target, undoReblog: false });
    check('a vote landed between plan and delete: re-planned and blanked', calls.signRemove.length === 2 && calls.signRemove[1].mode === 'blank' && calls.signRemove[1].undoReblog === null);
  }
  {
    const cancel = new Error('user cancelled');
    const { deps, calls } = fake({ signRemoveErrors: [cancel] });
    const e = await rejects(removeQuote(deps, { target, undoReblog: false }));
    check('a cancelled delete is not retried (the plan still says delete)', e === cancel && calls.signRemove.length === 1);
  }
  {
    const cancel = new Error('user cancelled');
    const { deps, calls } = fake({ signRemoveErrors: [cancel], removePlans: [ok({ plan: { ...removal, mode: 'blank' } })] });
    const e = await rejects(removeQuote(deps, { target, undoReblog: false }));
    check('a cancelled BLANK is not retried either', e === cancel && calls.signRemove.length === 1);
  }
  {
    const { deps, calls } = fake({ removePlans: [ok({ plan: null })] });
    await removeQuote(deps, { target, undoReblog: true });
    check('no comment on chain: only the reblog is undone', calls.signUnreblog === 1 && calls.signRemove.length === 0);
  }
  {
    const { deps, calls } = fake({ removeds: [no(409, 'still_on_chain'), ok({ removed: true })] });
    await removeQuote(deps, { target, undoReblog: false });
    check('a node a block behind on the removal: asked again', calls.sleeps.length === 1);
  }

  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL — the test threw:', error);
  process.exit(1);
});
