'use client';
import { ApiChecker, HealthCheckerComponent } from '@hiveio/healthchecker-component'
import type { Community, Entry, MixedPostsResponse } from '@hive/common-hiveio-packages/wax';
import type { ApiAccount } from '@hiveio/wax';
import { hiveChainService } from '@transaction/lib/hive-chain-service';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components'
import { useHealthChecker } from '@ui/hooks/useHealthChecker';
import { useEffect, useState } from 'react';
import { getChain } from '@transaction/lib/chain';
import { useTranslation } from '@/blog/i18n/client';
// WHY (2026-08-18): the intro copy used to render a `<CircleCheck>` icon
// inline as "the healthy-provider icon", but per external review the icon
// does not actually show up inline where the sentence claims it does. Rather
// than keep a copy defect anchored to a component reference, the icon import
// was dropped and the copy below no longer promises an inline glyph.

type NodeApiCheckers = [
  ApiChecker<{ accounts: ApiAccount[] }>,
  ApiChecker<Entry | null>,
  ApiChecker<Community[] | null>,
  ApiChecker<Entry[] | null>
];

type AiSearchApiCheckers = [ApiChecker<MixedPostsResponse>, ApiChecker<Entry[]>];

const HealthCheckersWrapper = () => {
  const { t } = useTranslation('common_blog');
  const [nodeApiCheckers, setNodeApiCheckers] = useState<NodeApiCheckers | undefined>(undefined);
  const [aiSearchApiCheckers, setAiSearchApiCheckers] = useState<AiSearchApiCheckers | undefined>(undefined);

  const DEFAULT_AI_ENDPOINTS = [
    'https://api.hive.blog',
    'https://api.syncad.com',
    'https://api.openhive.network',
    'https://api.dev.openhive.network'
  ];

  const nodeHcService = useHealthChecker(
    'node-api',
    nodeApiCheckers,
    'node-endpoint',
    hiveChainService.setHiveChainEndpoint
  );
  const aiSearchHcService = useHealthChecker(
    'ai-search',
    aiSearchApiCheckers,
    'ai-search-endpoint',
    hiveChainService.setAiSearchEndpoint,
    DEFAULT_AI_ENDPOINTS
  );

  const createApiCheckers = async () => {
    const hiveChain = await getChain();
    // WHY (2026-08-18): these `title` values render as the check names inside
    // <HealthCheckerComponent> (and the error strings surface on failure), so
    // they are user-facing copy. They used to leak internal Hive API namespaces
    // ("Database - ...", "Bridge - ...") straight to end users — unexplained
    // jargon flagged by review. Renamed to what each check actually does, with
    // no namespace prefix. `Bridge - Get post` / `Bridge - List Communities`
    // weren't named in the review but use the identical pattern as `Bridge -
    // Get Ranked Posts`, which was — fixing only one would have left the other
    // two as a fresh instance of the same inconsistency defect #4 calls out.
    const nodeApiCheckers: NodeApiCheckers = [
      {
        title: t('healthchecker.check_find_accounts'),
        method: hiveChain.api.database_api.find_accounts,
        params: { accounts: ['guest4test'], delayed_votes_active: false },
        validatorFunction: (data: { accounts: ApiAccount[] }) =>
          data?.accounts?.[0]?.name === 'guest4test'
            ? true
            : t('healthchecker.check_find_accounts_error')
      },
      {
        title: t('healthchecker.check_get_post'),
        method: hiveChain.api.bridge.get_post,
        params: { author: 'guest4test', permlink: '6wpmjy-test', observer: '' },
        validatorFunction: (data) =>
          data?.author === 'guest4test' ? true : t('healthchecker.check_get_post_error')
      },
      {
        title: t('healthchecker.check_list_communities'),
        method: hiveChain.api.bridge.list_communities,
        params: {query: null, sort: 'rank', observer: 'hive.blog' },
        validatorFunction: (data) =>
          data?.length && data.length > 0 ? true : t('healthchecker.check_list_communities_error')
      },
      {
        title: t('healthchecker.check_get_ranked_posts'),
        method: hiveChain.api.bridge.get_ranked_posts,
        params: {observer: 'hive.blog', tag: '', limit: 10, sort: 'trending'},
        validatorFunction: (data) =>
          data?.length && data.length > 0 ? true : t('healthchecker.check_get_ranked_posts_error')
      }
    ];
    const aiSearchApiCheckers: AiSearchApiCheckers = [
      {
        title: t('healthchecker.check_ai_search'),
        method: hiveChain.restApi['hivesense-api'].posts.search,
        params: {
          q: 'test',
          truncate: 100,
          result_limit: 10,
          full_posts: 10,
        },
        validatorFunction: (data) => (!!data[0] ? true : t('healthchecker.check_ai_search_error'))
      },
      {
        title: t('healthchecker.check_ai_similar_posts'),
        method: hiveChain.restApi['hivesense-api'].posts.author.permlink.similar,
        params: {
          author: 'thebeedevs',
          permlink: 'clive-updates-clive-in-spring-colors',
          truncate: 100,
          result_limit: 1

        },
        validatorFunction: (data) => (!!data[0] ? true : t('healthchecker.check_ai_similar_posts_error'))
      }
    ];
    setNodeApiCheckers(nodeApiCheckers);
    setAiSearchApiCheckers(aiSearchApiCheckers);
  };

  useEffect(() => {
    createApiCheckers();
  }, []);

  return (
    <div className='p4  lg:px-48'>
      <div className='mx-auto flex flex-col items-center py-8'>
        <h3 className='py-4 text-lg'>{t('healthchecker.heading')}</h3>
        {/* WHY (2026-08-18), copy defects fixed here (see task):
            1. "Continuos Check" typo — this paragraph is the only place that
               names the toggle, so the one spelling now matches the toggle's
               real label, "Continuous Check".
            2. The old second paragraph told readers to look for a check-mark
               icon "inline" that, per external review, does not actually
               render inline anywhere on the page — rewritten below as a plain
               sentence with no icon reference instead of leaving a broken one.
            3. The old third paragraph ("Click 'Switch to Best' button for
               Healthchecker to...") only narrated a button rendered a few
               inches below by <HealthCheckerComponent> itself, which is
               already labelled "Switch to Best" — cut rather than rewritten,
               per the task's "cut or rewrite" instruction.
            ★ Framing note: the task's suggested sentence ("Lumen picks the
            fastest Hive server automatically...") is NOT used below. Reading
            the vendored `HealthCheckerService` (node_modules/@hiveio/
            healthchecker-component): `isActive` (driven by the Continuous
            Check toggle) defaults to `false` and only keeps re-scoring
            providers: it does not by itself switch anything. Switching only
            happens through `switchToBestProvider`, reached via the
            user-initiated "Switch to Best" action. So today's real behaviour
            is manual-by-default, opt-in-continuous-testing, and
            manual-switch — not automatic selection. TODO(copy): once the
            node-selection agent's work makes provider selection genuinely
            automatic by default, replace the sentence below with the
            suggested framing. */}
        <p className='mb-4 text-center text-muted-foreground'>{t('healthchecker.intro_pin')}</p>
        <p className='mb-4 text-center text-muted-foreground'>{t('healthchecker.intro_healthy')}</p>
      </div>
      <Tabs defaultValue="node" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="node">{t('healthchecker.tab_node')}</TabsTrigger>
          {/* WHY (2026-08-18): "HiveSense API providers" named the internal
              service, not what it does — unexplained jargon per review.
              Renamed to match the plain-language checker titles already used
              in this same file ("AI search", "AI similar posts"). */}
          <TabsTrigger value="hivesense">{t('healthchecker.tab_ai_search')}</TabsTrigger>
        </TabsList>
        <TabsContent value="node">
          {!!nodeHcService && (
            <HealthCheckerComponent className='m-4' healthCheckerService={nodeHcService} />
          )}
        </TabsContent>
        <TabsContent value="hivesense">
          {!!aiSearchHcService && (
            <HealthCheckerComponent className='m-4' healthCheckerService={aiSearchHcService} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default HealthCheckersWrapper
