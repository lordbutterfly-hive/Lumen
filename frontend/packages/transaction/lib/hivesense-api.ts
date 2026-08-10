import { logger } from '@ui/lib/logger';
import { Entry, MixedPostsResponse, PostStub } from '@hive/common-hiveio-packages/wax';
import { getChain } from './chain';
import { isBannedAuthor, withoutBannedAuthors } from '@ui/config/lists/banned-authors';

const logStandarizedError = (methodName: string, error: unknown): null => {
  logger.error(error, `Error in ${methodName}`);
  throw new Error(`Error in ${methodName}`);
};

/**
 * Is AI ("Hivesense") search available on the configured node?
 *
 * ★ ANSWERS THE QUESTION. DOES NOT THROW IT BACK.
 *
 * This is an availability probe, and "unavailable" is a perfectly good answer —
 * it is the whole point of asking. It used to rethrow, which meant that on any
 * node without the hivesense extension (api.hive.blog among them: the request is
 * cross-origin-blocked before it even 404s) EVERY visit to /search fired the
 * failing request three times over — React Query retries a rejection — and left
 * a CORS error in the console each time. Measured 2026-08-06 on the production
 * build. The page behaved correctly throughout, which is exactly why nobody
 * chased it; it just looked broken to anyone who opened dev tools.
 *
 * Kept at `debug`: on a node that simply lacks the extension this is expected,
 * not an error, and logging it as one buries real failures.
 */
export const getHiveSenseStatus = async (): Promise<boolean> => {
  try {
    const response = await (await getChain()).restApi['hivesense-api']();
    return response.info.title === 'Hivesense';
  } catch (error) {
    logger.debug(error, 'hivesense-api not available on this node — AI search stays off');
    return false;
  }
};

// New API functions using the updated endpoints

export const searchPosts = async ({
  query,
  truncate = 100,
  result_limit = 100,
  full_posts = 10,
  observer
}: {
  query: string;
  truncate?: number;
  result_limit?: number;
  full_posts?: number;
  observer: string;
}): Promise<MixedPostsResponse | null> => {
  try {
    const chain = await getChain();
    const response = await chain.restApi['hivesense-api'].posts.search({
      q: query,
      truncate,
      result_limit,
      full_posts,
      observer
    });
    // AI search is a SEPARATE upstream from `search-api.find_text`, so the ban
    // applied there does not reach it. `/search?ai=…` is a real, linked surface —
    // it needs its own application of the same predicate.
    return withoutBannedAuthors(response, (post) => (post as { author?: string })?.author);
  } catch (error) {
    return logStandarizedError('searchPosts', error);
  }
};

export const getSimilarPostsByPost = async ({
  author,
  permlink,
  truncate = 100,
  result_limit = 100,
  full_posts = 10,
  observer
}: {
  author: string;
  permlink: string;
  truncate?: number;
  result_limit?: number;
  full_posts?: number;
  observer: string;
}): Promise<MixedPostsResponse | null> => {
  try {
        const chain = await getChain();
    if (isBannedAuthor(author)) return [];
    const response = await chain.restApi['hivesense-api'].posts.author.permlink.similar({author, permlink, truncate, result_limit, full_posts, observer})
    // "More like this" is a recommendation rail — precisely a place a banned
    // author must not be surfaced from someone else's post.
    return withoutBannedAuthors(response, (post) => (post as { author?: string })?.author);
  } catch (error) {
    return logStandarizedError('getSimilarPostsByPost', error);
  }
};

export const getPostsByIds = async ({
  posts,
  truncate = 100,
  observer
}: {
  posts: Array<{ author: string; permlink: string }>;
  truncate?: number;
  observer: string;
}): Promise<Entry[] | null> => {
  try {
    const chain = await getChain();
    const response = await chain.restApi['hivesense-api'].posts.byIds({
      posts,
      truncate,
      observer
    })

    if (Array.isArray(response)) {
      return withoutBannedAuthors(
        response.filter(post => post && (post as Entry).post_id),
        (post) => (post as Entry)?.author
      );
    }
    return response;
  } catch (error) {
    return logStandarizedError('getPostsByIds', error);
  }
};

// Helper function to check if a post is a stub (only has author/permlink)
export const isPostStub = (post: Entry | PostStub): post is PostStub => {
  return !('title' in post) && !('body' in post) && 'author' in post && 'permlink' in post;
};
