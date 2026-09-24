/**
 * ★ KEEP WHAT A COMMENT ALREADY SAYS ABOUT ITSELF WHEN IT IS EDITED (2026-09-24, quote
 * reblog spec v2 6.2). An edit used to replace the whole `json_metadata` with `{app}`,
 * wiping tags, format and any marker another feature relies on: a reblog comment's
 * `type: 'lumen_quote'` / `quote_of` would vanish on its first edit.
 *
 * `existing` is the comment's current metadata as the reader has it: an object (the
 * bridge API) or the chain's JSON string (condenser). Its keys are kept and `app` is
 * refreshed. Anything unreadable (bad JSON, an array, null) yields just `{app}`, which
 * is exactly the previous behaviour.
 */
export function mergeEditJsonMetadata(existing: unknown, app: string): Record<string, unknown> {
  let kept: Record<string, unknown> = {};
  try {
    const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) kept = parsed as Record<string, unknown>;
  } catch {
    kept = {};
  }
  return { ...kept, app };
}
