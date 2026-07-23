'use client';

import { useMemo, useState } from 'react';
import { TOP_WITNESS_RANK } from '../lib/constants';
import { DEFAULT_WITNESS_FILTERS, WitnessFilterState, WitnessRow } from '../lib/types';

export interface UseWitnessFiltersResult {
  filters: WitnessFilterState;
  setFilter: <K extends keyof WitnessFilterState>(key: K, value: WitnessFilterState[K]) => void;
  toggleFilter: (key: 'active' | 'disabledOrStale' | 'top20' | 'approved') => void;
  filteredRows: WitnessRow[];
  availableVersions: string[];
}

/**
 * Client-side filtering for the witness table: every checkbox, the name
 * search box, and the version dropdown narrow the same in-memory row list
 * — no separate network round trip per filter.
 */
export function useWitnessFilters(rows: WitnessRow[]): UseWitnessFiltersResult {
  const [filters, setFilters] = useState<WitnessFilterState>(DEFAULT_WITNESS_FILTERS);

  const setFilter = <K extends keyof WitnessFilterState>(key: K, value: WitnessFilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const toggleFilter = (key: 'active' | 'disabledOrStale' | 'top20' | 'approved') => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const availableVersions = useMemo(() => {
    const versions = new Set(rows.map((row) => row.running_version).filter(Boolean));
    return Array.from(versions).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.active && (row.isDisabled || row.isStale)) return false;
      if (filters.disabledOrStale && !(row.isDisabled || row.isStale)) return false;
      if (filters.top20 && row.rank > TOP_WITNESS_RANK) return false;
      if (filters.approved && !row.isVoted) return false;
      if (filters.version !== 'any' && row.running_version !== filters.version) return false;
      if (search && !row.owner.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [rows, filters]);

  return { filters, setFilter, toggleFilter, filteredRows, availableVersions };
}
