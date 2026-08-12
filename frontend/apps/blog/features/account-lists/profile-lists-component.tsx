'use client';
import { IFollowList } from '@hive/common-hiveio-packages/wax';
import { useMemo, useState } from 'react';
import { fetchAccount } from '@/blog/lib/chain-fetch';
import { useQuery } from '@tanstack/react-query';
import ListVariant from './list-variant';

const CHUNK_SIZE = 10;

export default function ProfileLists({
  username,
  variant,
  data
}: {
  username: string;
  variant: 'blacklisted' | 'muted' | 'follow_blacklist' | 'follow_muted';
  data: IFollowList[] | undefined;
}) {
  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `enabled` gate), on the blacklist/muted/followed-blacklist/followed-
  // muted list pages. See `apps/blog/app/api/account/route.ts`.
  const { data: profilData } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => fetchAccount(username)
  });
  const [filter, setFilter] = useState('');

  const splitArrays = useMemo(() => {
    const filteredNames =
      data?.filter((e) => e.name !== 'null' && e.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
    if (!filteredNames.length) return [];

    return Array.from({ length: Math.ceil(filteredNames.length / CHUNK_SIZE) }, (_, i) =>
      filteredNames.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    );
  }, [data, filter]);

  return profilData ? (
    <ListVariant
      variant={variant}
      username={username}
      profileData={profilData}
      data={data}
      splitArrays={splitArrays}
      onSearchChange={setFilter}
    />
  ) : null;
}
