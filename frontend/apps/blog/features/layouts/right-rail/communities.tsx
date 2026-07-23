import { Link } from '@hive/ui';

// TODO: move to i18n
const LABELS = {
  heading: 'Communities'
};

const MAX_ROWS = 6;

// Per-row badge colors from the redesign palette (index-based, wraps at 6).
const BADGE_COLORS = ['#c0392b', '#2f7d4f', '#805ad5', '#3182ce', '#dd6b20', '#0d9488'] as const;

const ROW_CLASS =
  'flex items-center gap-[11px] rounded-[11px] p-2 text-sm text-[#2a2822] transition-colors hover:bg-[#f6f7f8]';

// Shown when no subscriptions are available (logged-out visitor, or data still loading).
const PLACEHOLDER_COMMUNITIES: ReadonlyArray<readonly [string, string]> = [
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
  isPlaceholder: boolean;
}

// `subscriptions` mirrors denser's `getSubscriptions` shape: string[][] tuples of
// [community_name, community_title, role_title, role]. Only name (index 0) and
// title (index 1) are used here, matching communities-my-bar.tsx.
function buildRows(subscriptions?: string[][]): CommunityRow[] {
  // Remote data (getSubscriptions) can be malformed — guard each tuple so a bad
  // entry (null/short tuple, or an empty name) can't crash the render.
  const valid = (subscriptions ?? []).filter(
    (s): s is string[] => Array.isArray(s) && typeof s[0] === 'string' && s[0].length > 0
  );
  if (valid.length > 0) {
    return valid.slice(0, MAX_ROWS).map((subscription) => {
      const [name, title] = subscription;
      const safeTitle = typeof title === 'string' && title.length > 0 ? title : name;
      return { name, title: safeTitle, isPlaceholder: false };
    });
  }
  return PLACEHOLDER_COMMUNITIES.map(([name, title]) => ({ name, title, isPlaceholder: true }));
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

const Communities = ({ subscriptions }: { subscriptions?: string[][] }) => {
  const rows = buildRows(subscriptions);

  return (
    <section data-testid="right-rail-communities">
      <h3 className="mb-[14px] text-[14.5px] font-bold text-[#161511]">{LABELS.heading}</h3>
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
              {row.isPlaceholder ? (
                <span className={ROW_CLASS}>{content}</span>
              ) : (
                <Link href={`/trending/${row.name}`} className={ROW_CLASS}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default Communities;
