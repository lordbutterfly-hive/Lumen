'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { MAX_ASK_NOTE_LOOKUP, contractKeyOf } from '@/blog/lib/meritum/ask-note';

/**
 * The buyer's message behind an escrow's `contentHash`, read from Lumen's own
 * store (app/api/creator-tokens/ask-note). The chain carries only the reference;
 * the text lives here, keyed by that reference, and the route hands it only to
 * the two parties. One request per surface, keyed by the sorted reference list
 * so a re-render with the same inbox costs nothing.
 */
export interface AskNote {
  text: string;
  asker: string;
  createdAt: string;
}

export interface AskNotesResult {
  notes: Map<string, AskNote>;
  /** The store could not be read. Different from "no message was attached". */
  unavailable: boolean;
  isLoading: boolean;
}

const EMPTY: Map<string, AskNote> = new Map();

export function useAskNotes(creator: string, hashes: readonly string[], enabled = true): AskNotesResult {
  const wanted = useMemo(
    () => Array.from(new Set(hashes.filter((h) => h.length > 0))).sort().slice(0, MAX_ASK_NOTE_LOOKUP),
    [hashes]
  );
  const key = contractKeyOf(creator);
  const query = useQuery({
    queryKey: ['creatorTokens', 'askNotes', key, wanted],
    queryFn: async (): Promise<{ notes: Map<string, AskNote>; unavailable: boolean }> => {
      const res = await fetch(`/api/creator-tokens/ask-note?creator=${encodeURIComponent(key)}&hashes=${encodeURIComponent(wanted.join(','))}`);
      if (!res.ok) return { notes: EMPTY, unavailable: true };
      const body = (await res.json()) as { notes?: Record<string, AskNote>; unavailable?: boolean };
      return { notes: new Map(Object.entries(body.notes ?? {})), unavailable: body.unavailable === true };
    },
    enabled: enabled && key !== 'hive:' && wanted.length > 0,
    staleTime: 30_000
  });
  return {
    notes: query.data?.notes ?? EMPTY,
    unavailable: query.isError || query.data?.unavailable === true,
    isLoading: query.isLoading && query.fetchStatus !== 'idle'
  };
}

/**
 * Files the buyer's text behind the reference the ask just put on chain. Throws
 * on refusal so the caller can decide what a lost message means for the flow.
 */
export async function postAskNote(input: { creator: string; contentHash: string; asker: string; text: string }): Promise<void> {
  const res = await fetch('/api/creator-tokens/ask-note', {
    method: 'POST',
    // guardWrite refuses a POST without the CSRF header (403 missing_csrf_header); the
    // shared constant, never a hand-written header name, so the two cannot drift.
    headers: { 'content-type': 'application/json', [csrfHeaderName]: '1' },
    body: JSON.stringify({
      creator: contractKeyOf(input.creator),
      contentHash: input.contentHash,
      asker: contractKeyOf(input.asker),
      text: input.text
    })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(`ASK_NOTE_${(body.error ?? `http_${res.status}`).toUpperCase()}: ${body.message ?? 'the message could not be attached to the request.'}`);
  }
}
