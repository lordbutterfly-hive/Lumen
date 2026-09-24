/**
 * Does this `condenser_api.get_content` error mean "that comment is not there"? Current
 * nodes answer a missing comment with an error instead of an empty result, in two
 * shapes (both seen on the Hive testnet, hived 1.28.3, 2026-09-24):
 *   never existed: data.extension.assertion_expression = "Post a/p does not exist"
 *   deleted:       code -31999, data = "Post a/p was deleted 1 time(s)"
 * Anything else is a real failure and must not be read as absent. Pure: shared by the
 * publisher (`postExists`) and the quote service.
 */
export function isMissingPostError(error: unknown, author: string, permlink: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: unknown }).data;
  const post = `Post ${author}/${permlink}`;
  if (typeof data === 'string') return data.startsWith(`${post} was deleted`) || data === `${post} does not exist`;
  const assertion = (data as { extension?: { assertion_expression?: unknown } } | undefined)?.extension?.assertion_expression;
  return assertion === `${post} does not exist`;
}
