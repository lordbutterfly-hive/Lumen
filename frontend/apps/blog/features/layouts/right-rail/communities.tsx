import { Link, Skeleton } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';

const MAX_ROWS = 6;

// Per-row badge colors from the redesign palette (index-based, wraps at 6).
const BADGE_COLORS = ['#c0392b', '#2f7d4f', '#805ad5', '#3182ce', '#dd6b20', '#0d9488'] as const;

const ROW_CLASS =
  'flex items-center gap-[11px] rounded-[11px] p-2 text-sm text-[#2a2822] transition-colors hover:bg-[#f6f7f8]';

// Shown to a logged-out visitor, or a logged-in user with zero subscriptions,
// as a generic "popular on Lumen" suggestion list — never labeled as if it
// were the viewer's own communities.
const SUGGESTED_COMMUNITIES: ReadonlyArray<readonly [string, string]> = [
  ['photography', 'Photography'],
  ['leofinance', 'LeoFinance'],
  ['hive-gaming', 'Hive Gaming'],
  ['hive-writers', 'Hive Writers'],
  ['foodies-bee-hive', 'Foodies Bee Hive'],
  ['travel-hive', 'Travel Hive']
];

interface CommunityRow {
  name: string;
  title: string;
}

// `subscriptions` mirrors denser's `getSubscriptions` shape: string[][] tuples of
// [community_name, community_title, role_title, role]. Only name (index 0) and
// title (index 1) are used here, matching communities-my-bar.tsx.
function buildRows(subscriptions: string[][]): CommunityRow[] {
  // Remote data (getSubscriptions) can be malformed — guard each tuple so a bad
  // entry (null/short tuple, or an empty name) can't crash the render.
  const valid = subscriptions.filter(
    (s): s is string[] => Array.isArray(s) && typeof s[0] === 'string' && s[0].length > 0
  );
  return valid.slice(0, MAX_ROWS).map((subscription) => {
    const [name, title] = subscription;
    const safeTitle = typeof title === 'string' && title.length > 0 ? title : name;
    return { name, title: safeTitle };
  });
}

function CommunityIcon({ title, color }: { title: string; color: string }) {
  const initial = title.charAt(0).toUpperCase() || '?';
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[13px] font-bold text-white"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

function CommunityList({ rows, linked }: { rows: CommunityRow[]; linked: boolean }) {
  return (
    <ul className="flex flex-col gap-[3px]">
      {rows.map((row, index) => {
        const color = BADGE_COLORS[index % BADGE_COLORS.length];
        const content = (
          <>
            <CommunityIcon title={row.title} color={color} />
            {row.title}
          </>
        );
        return (
          <li key={row.name}>
            {linked ? (
              <Link href={`/trending/${row.name}`} className={ROW_CLASS}>
                {content}
              </Link>
            ) : (
              <span className={ROW_CLASS}>{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CommunitiesLoading() {
  return (
    <ul className="flex flex-col gap-[3px]" data-testid="right-rail-communities-loading">
      {Array.from({ length: 4 }).map((_, index) => (
        <li key={index} className="flex items-center gap-[11px] p-2">
          <Skeleton className="h-7 w-7 shrink-0 rounded-[9px]" />
          <Skeleton className="h-4 w-32" />
        </li>
      ))}
    </ul>
  );
}

export interface CommunitiesProps {
  /** Real `getSubscriptions` result for the logged-in viewer. `undefined` while loading, `null`/omitted when there is no viewer. */
  subscriptions?: string[][] | null;
  isLoggedIn: boolean;
  isLoading: boolean;
}

const Communities = ({ subscriptions, isLoggedIn, isLoading }: CommunitiesProps) => {
  const { t } = useTranslation('common_blog');
  const rows = buildRows(subscriptions ?? []);
  const hasOwnRows = isLoggedIn && rows.length > 0;

  return (
    <section data-testid="right-rail-communities">
      <h3 className="mb-[14px] text-[14.5px] font-bold text-[#161511]">
        {hasOwnRows ? t('right_rail.communities.heading') : t('right_rail.communities.suggested_heading')}
      </h3>
      {isLoading ? (
        <CommunitiesLoading />
      ) : hasOwnRows ? (
        <CommunityList rows={rows} linked />
      ) : (
        <>
          {isLoggedIn && (
            <p className="mb-2 text-xs text-[#8a8a8a]" data-testid="right-rail-communities-empty">
              {t('right_rail.communities.empty')}
            </p>
          )}
          <CommunityList rows={SUGGESTED_COMMUNITIES.map(([name, title]) => ({ name, title }))} linked />
        </>
      )}
    </section>
  );
};

export default Communities;
