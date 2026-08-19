import { Entry } from '@hive/common-hiveio-packages/wax';
import { useState } from 'react';
import SuggestionsCard from './card';
import { Button } from '@ui/components';

export type SuggestionsVariant = 'rail' | 'horizontal';

interface SuggestionsListProps {
  suggestions: Entry[];
  /**
   * `rail` — the compact stacked rows that live in the right column of a post
   * page. `horizontal` — the swipeable strip that renders below the article at
   * widths where the right column does not exist.
   */
  variant?: SuggestionsVariant;
  /** Cap the number of rows rendered. Only the rail caps; the strip shows all. */
  limit?: number;
}

const SuggestionsList = ({ suggestions, variant = 'rail', limit }: SuggestionsListProps) => {
  const filteredPosts = suggestions.filter((e) => e.author_reputation >= 50 && !e.stats?.gray);
  const [filteredSuggestions, setFilteredSuggestions] = useState<Entry[]>(
    Array.isArray(suggestions) ? filteredPosts : []
  );

  if (!Array.isArray(suggestions)) {
    return null;
  }

  // ★ THE CAP IS APPLIED AFTER THE LOW-RATING FILTER, ON PURPOSE (2026-08-13).
  // Capping first would let five gray posts consume the whole rail and render an
  // empty panel while good suggestions sat unshown behind the cap.
  const shown = typeof limit === 'number' ? filteredSuggestions.slice(0, limit) : filteredSuggestions;

  return (
    <div
      className={
        variant === 'horizontal'
          ? 'flex gap-3 overflow-x-auto px-4 pb-3 snap-x snap-mandatory [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          : 'mt-1 flex flex-col'
      }
    >
      {shown.length > 0 ? (
        shown.map((suggestion, i) => (
          <SuggestionsCard entry={suggestion} key={i} variant={variant} />
        ))
      ) : (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-caption text-ink-10">
          <p>Sorry</p>
          <p>All suggested posts were hidden due to low ratings.</p>
        </div>
      )}
      {filteredPosts.length === 0 ? (
        <Button
          className="mt-2 self-center"
          onClick={() =>
            filteredSuggestions.length === suggestions.length
              ? setFilteredSuggestions(suggestions.filter((e) => e.author_reputation >= 50 && !e.stats?.gray))
              : setFilteredSuggestions(suggestions)
          }
          variant="outlineRed"
        >
          {filteredSuggestions.length === suggestions.length ? 'Hide' : 'Show All'}
        </Button>
      ) : null}
    </div>
  );
};

export default SuggestionsList;
