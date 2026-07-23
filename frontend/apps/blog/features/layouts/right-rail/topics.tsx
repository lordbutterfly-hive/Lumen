import { Link } from '@hive/ui';
import { cn } from '@ui/lib/utils';

// TODO: move to i18n
const LABELS = {
  heading: 'Topics'
};

// TODO: wire real trending tags
const TOPICS = ['photography', 'hive', 'life', 'art', 'gaming', 'travel', 'food', 'technology', 'music'] as const;

const Topics = () => {
  return (
    <section data-testid="right-rail-topics">
      <h3 className="mb-[14px] text-[14.5px] font-bold text-[#161511]">{LABELS.heading}</h3>
      <ul className="flex flex-wrap gap-2">
        {TOPICS.map((topic) => (
          <li key={topic}>
            <Link
              href={`/trending/${topic}`}
              className={cn(
                'inline-flex items-center rounded-full border border-[#e4e6e9] px-3 py-1 text-xs capitalize text-[#4b5563] transition-colors hover:border-[#c0392b] hover:text-[#c0392b]'
              )}
            >
              {topic}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default Topics;
