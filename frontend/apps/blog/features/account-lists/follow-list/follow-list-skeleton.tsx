import { LIST_CARD, LIST_ROW, SKELETON_FILL } from './tokens';

/**
 * The loading state for `/@user/followers` and `/@user/following`.
 *
 * ★ EIGHT REAL ROWS, NOT A SPINNER (redesign spec, "Empty and loading states").
 * Both routes previously rendered a centred `<LumenLoader>` at the route level
 * and a second, different `<Loading>` spinner inside the client component, so
 * the page changed shape twice on its way in. Eight 60px skeleton rows inside
 * the real list card means the card, its radius, its border and its row rhythm
 * are all already in their final position when the data lands.
 *
 * ONE bar per row, not the two the spec's sketch shows: the two-bar sketch
 * assumes a display name above the `@username`, and `condenser_api.get_followers`
 * returns `{follower, following, what}` and no display name at all (verified
 * against api.hive.blog, 2026-08-13). The row therefore renders a single
 * username line — see `follow-list-row.tsx` — and a skeleton that promises two
 * lines would resolve into one and jump.
 *
 * No `'use client'`: this is plain markup with no state, so both the route-level
 * `loading.tsx` (a server component) and the client view can render it.
 */
export default function FollowListSkeleton({ rows = 8, label }: { rows?: number; label?: string }) {
  return (
    <div className={LIST_CARD} data-testid="follow-list-skeleton" role="status" aria-busy="true">
      {/* The `<LumenLoader>` this replaced carried an accessible label; a purely
          visual skeleton would silently drop that announcement. */}
      {label ? <span className="sr-only">{label}</span> : null}
      <ul>
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className={LIST_ROW} aria-hidden>
            <div className={`h-10 w-10 shrink-0 rounded-[12px] ${SKELETON_FILL}`} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {/* Staggered widths so eight identical rows do not read as a
                  rendering artefact. */}
              <div
                className={`h-3 rounded-[10px] ${SKELETON_FILL}`}
                style={{ width: `${110 + ((index * 37) % 90)}px` }}
              />
            </div>
            <div className={`h-9 w-[92px] shrink-0 rounded-[12px] ${SKELETON_FILL}`} />
            <div className={`h-8 w-8 shrink-0 rounded-[10px] ${SKELETON_FILL}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
