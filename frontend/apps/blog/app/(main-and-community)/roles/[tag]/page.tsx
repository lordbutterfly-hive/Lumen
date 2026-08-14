import Content from './content';

/**
 * ★★★ THE SERVER PREFETCH HERE WAS DEAD WEIGHT ON TTFB (2026-08-13).
 *
 * This page used to `await queryClient.prefetchQuery({ queryKey: ['community',
 * params.tag], queryFn: () => getListCommunityRoles(params.tag) })` before
 * returning `<Content />`. Two independent reasons that was pure cost:
 *
 * 1. The QueryClient it filled was never dehydrated into the tree — there is no
 *    `<Hydrate>` on this route — so nothing on the client could ever read it.
 * 2. Even if it had been, the key did not match: `content.tsx` asks under
 *    `['rolesList', community]`, this asked under `['community', tag]`. Both
 *    this file's own history and `app/api/community-roles/route.ts` already
 *    record that mismatch as a known fact.
 *
 * So the route blocked its own first byte on a full `bridge.list_community_roles`
 * round trip whose result was thrown away, and then the browser fetched the same
 * data again through `/api/community-roles`. Deleting it changes nothing a reader
 * sees (the client query, its `Loading` state and its data are untouched) and
 * removes one upstream round trip from every server render of this page.
 *
 * The remaining server work on this route is the community lookup in
 * `layout.tsx`'s `PrefetchComponent` and in `generateMetadata` — measured at
 * ~250ms each and both DO feed the rendered output, so neither is removable
 * here. They live in `features/layouts/community/**`, which is shared with every
 * topic and community feed route and is deliberately left alone by this pass.
 */
const Page = ({ params }: { params: { tag: string } }) => <Content community={params.tag} />;

export default Page;
