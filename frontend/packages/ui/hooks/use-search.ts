import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useNavigationProgress } from '@ui/components/navigation-progress';

export type SearchMode = 'ai' | 'classic' | 'account' | 'userTopic' | 'tag';
export type SearchSort = 'created' | 'relevance';

/**
 * ★ AN APOSTROPHE IS LEGAL IN A URL AND ILLEGAL IN A HIVE NAME.
 *
 * Account and tag search navigate to a PATH (`/@name`, `/trending/tag`) rather
 * than a query string, and `encodeURIComponent` leaves `'` untouched — so
 * searching for `o'brien` asked for `/@o'brien`, a well-formed request for an
 * account that cannot exist, and the reader got the generic "404 Page Not
 * Found" with no hint that their search was the problem.
 *
 * Found by an adversarial regression pass 2026-08-06 looking for exactly this:
 * general search was taught to survive an apostrophe that morning, and these
 * two neighbouring modes were not, because they build a path instead of a query.
 *
 * Hive names are `[a-z0-9.-]` and tags `[a-z0-9-]`, so anything else the reader
 * typed cannot be part of the thing they are looking for. Strip it and search
 * for the plausible name rather than guaranteeing a 404.
 */
const toHiveName = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');

const toTag = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

const getMode = (
  query: string | undefined,
  aiQuery: string | undefined,
  userTopicQuery: string | undefined
) => {
  if (!!aiQuery) return 'ai';
  if (!!query) return 'classic';
  if (!!userTopicQuery) return 'userTopic';
};

export function useSearch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { startNavigation } = useNavigationProgress();

  const query = searchParams?.get('q') ?? undefined;
  const aiQuery = searchParams?.get('ai') ?? undefined;
  const userTopicQuery = searchParams?.get('a') ?? undefined;
  const topicQuery = searchParams?.get('p') ?? undefined;
  const sortQuery = searchParams?.get('s') ?? undefined;

  const currentMode = getMode(query, aiQuery, userTopicQuery);
  const [inputValue, setInputValue] = useState(query ?? aiQuery ?? topicQuery ?? '');
  const [mode, setMode] = useState<SearchMode>(currentMode ?? 'classic');
  const [secondInputValue, setSecondInputValue] = useState(userTopicQuery ?? '');

  // Sync state with URL params (e.g., when navigating back)
  useEffect(() => {
    const newMode = getMode(query, aiQuery, userTopicQuery);
    if (newMode) {
      setMode(newMode);
    }
    // Always sync with URL - use empty string as fallback for reset
    setInputValue(aiQuery ?? query ?? topicQuery ?? '');
    setSecondInputValue(userTopicQuery ?? '');
  }, [query, aiQuery, userTopicQuery, topicQuery]);

  useEffect(() => {
    if (inputValue.startsWith('/')) {
      setMode('userTopic');
      setInputValue(inputValue.slice(1));
    }
    if (inputValue.startsWith('%')) {
      setMode('ai');
      setInputValue(inputValue.slice(1));
    }
    if (inputValue.startsWith('$')) {
      setMode('classic');
      setInputValue(inputValue.slice(1));
    }
    if (inputValue.startsWith('@')) {
      setMode('account');
      setInputValue(inputValue.slice(1));
    }
    if (inputValue.startsWith('#')) {
      setMode('tag');
      setInputValue(inputValue.slice(1));
    }
  }, [inputValue]);

  const handleSearch = (
    value: string,
    currentMode: SearchMode,
    secondValue?: string,
    currenySort?: SearchSort
  ) => {
    if (!value) return;
    startNavigation();
    switch (currentMode) {
      case 'account': {
        const name = toHiveName(value);
        // Nothing usable left (the reader typed only punctuation): navigating
        // to `/@` is a guaranteed 404 and tells them nothing.
        if (!name) break;
        router.push(`/@${encodeURIComponent(name)}`);
        break;
      }
      case 'ai':
        router.push(`/search?ai=${encodeURIComponent(value)}`);
        break;
      case 'tag': {
        const tag = toTag(value);
        if (!tag) break;
        router.push(`/trending/${encodeURIComponent(tag)}`);
        break;
      }
      case 'userTopic':
        router.push(
          `/search?a=${encodeURIComponent(value)}&p=${encodeURIComponent(secondValue ?? '')}&s=${currenySort ?? sortQuery ?? 'relevance'}`
        );
        break;
      case 'classic':
        router.push(`/search?q=${encodeURIComponent(value)}&s=${currenySort ?? sortQuery ?? 'relevance'}`);
        break;
    }
  };

  return {
    inputValue,
    setInputValue,
    mode,
    setMode,
    secondInputValue,
    setSecondInputValue,
    handleSearch,
    sortQuery
  };
}
