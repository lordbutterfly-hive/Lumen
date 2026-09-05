import { z } from 'zod';

/**
 * Schema for validating search page URL parameters.
 * Ensures parameters are within reasonable bounds before making API calls.
 *
 * ★ TWO PARAMETERS, NOT FIVE (2026-08-10). `ai`, `a` and `p` backed the AI,
 * account-topic and user-topic search MODES, all removed with the scope
 * dropdown — no control in the product can produce them any more, and a
 * parameter no UI writes and no page reads is a dead branch that still has to
 * be validated, tested and reasoned about. Search is posts (`q`) plus a sort
 * (`s`).
 */
export const searchParamsSchema = z.object({
  q: z.string().max(500, 'Search query too long').optional(),
  s: z.enum(['relevance', 'created']).optional(),
  /**
   * ★ THE SCOPE CAME BACK AS ONE PARAMETER, NOT FIVE MODES (2026-09-05). `t`
   * says WHAT is listed (`posts`, the default, or `people`); `s` still says
   * how posts are sorted. Unlike the removed `ai`/`a`/`p`, both values are
   * produced by visible controls (the scope tabs on /search and the typeahead's
   * "Search people for..." row) and read by one page.
   */
  t: z.enum(['posts', 'people']).optional()
});

export type SearchParams = z.infer<typeof searchParamsSchema>;

/**
 * Parses and validates search parameters from URL.
 * Returns validated params or null values for invalid fields.
 */
export function parseSearchParams(params: Record<string, string | string[] | undefined>): SearchParams {
  const normalized = {
    q: typeof params.q === 'string' ? params.q : undefined,
    s: typeof params.s === 'string' ? params.s : undefined,
    t: typeof params.t === 'string' ? params.t : undefined
  };

  const result = searchParamsSchema.safeParse(normalized);

  if (result.success) {
    return result.data;
  }

  // Return only valid fields, omit invalid ones
  const validParams: SearchParams = {};
  const errors = result.error.flatten().fieldErrors;

  if (!errors.q && normalized.q) validParams.q = normalized.q;
  if (!errors.s && (normalized.s === 'relevance' || normalized.s === 'created')) {
    validParams.s = normalized.s;
  }
  if (!errors.t && (normalized.t === 'posts' || normalized.t === 'people')) {
    validParams.t = normalized.t;
  }

  return validParams;
}
