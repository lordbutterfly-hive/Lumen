/**
 * Only the primitive is left. The compositions that used to live here
 * (`post-list-item-skeleton`, `post-detail-skeleton`, `comment-skeleton`,
 * `user-info-skeleton`) drew ghost post cards and comment threads in a layout the
 * redesign had already moved on from — see `lumen-loader.tsx`, which replaced them
 * everywhere, and the "first light" note in `packages/tailwindcss/globals.css`.
 */
export * from './skeleton';
