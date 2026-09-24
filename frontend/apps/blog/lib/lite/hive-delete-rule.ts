/**
 * Would Hive accept a `delete_comment` for this comment right now? It refuses once the
 * comment has replies, net-positive votes, or has paid out (hive_evaluator_social.cpp
 * 60-72); the only way left to remove the text is an edit that blanks it. Pure, so the
 * publisher (hive-broadcaster.ts) and the quote service share one reading of the rule.
 */
export function hiveAllowsDelete(comment: { children?: number; net_rshares?: number | string; cashout_time?: string }): boolean {
  const netRshares = Number(comment.net_rshares ?? 0);
  const cashedOut = comment.cashout_time === '1969-12-31T23:59:59';
  return (comment.children ?? 0) === 0 && netRshares <= 0 && !cashedOut;
}
