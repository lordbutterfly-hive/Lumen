'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import VotesComponent from './votes-component';
import { Entry } from '@hive/common-hiveio-packages/wax';
import type { VoteSize } from './blade';

const VotesComponentWrapper = ({
  post,
  type,
  size = 'sm'
}: {
  post: Entry;
  type: 'comment' | 'post';
  size?: VoteSize;
}) => {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    /**
     * ★ THE PLACEHOLDER NOW RESERVES THE REAL BOX (2026-08-14, Blade rebuild).
     * It used to be two 18px squares, while the control that replaces them is
     * 38x38 (or 53x53) per side plus its tallies — so every card shifted its
     * whole action row the moment this mounted. The handoff's animation budget
     * is "transform and opacity only, nothing that triggers layout"; a
     * placeholder that is the wrong size violates that before a single frame of
     * animation runs. These match the button box exactly.
     */
    const box = size === 'sm' ? 'h-[38px] w-[38px]' : 'h-[53px] w-[53px]';
    return (
      <div className={clsx('flex items-center', size === 'sm' ? 'gap-[10px]' : 'gap-4')}>
        <div className={clsx(box, 'rounded-full bg-background-secondary opacity-50')} />
        <div className={clsx(box, 'rounded-full bg-background-secondary opacity-50')} />
      </div>
    );
  }

  return <VotesComponent post={post} type={type} size={size} />;
};

export default VotesComponentWrapper;

