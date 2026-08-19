import * as React from 'react';

import { cn } from '@ui/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-md border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  )
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  )
);
CardHeader.displayName = 'CardHeader';

/**
 * ★ THE LEVEL IS A PROP NOW (A8, 2026-08-18). `CardTitle` was hard-coded to `h3`, which
 * is right in a card that sits under an h2 and wrong the moment a page puts cards
 * directly under its h1 - `/communities` does exactly that, so its outline read h1 then
 * h3 and skipped a level. A screen reader announcing "heading level 3" straight after
 * "heading level 1" tells the listener a whole section is missing.
 *
 * Default stays `h3`, so every existing caller is byte-identical. Only a page that knows
 * its own nesting passes something else. Level is structure; size is the class list, and
 * the class list does not change with the level.
 */
/**
 * ★★★ `tracking-tight` REPLACED WITH `tracking-title` (2026-08-19, all-Lora).
 *
 * Tailwind's `tracking-tight` is -0.025em, and that value was chosen for Open
 * Sans. Lora has real bracketed serifs and COLLIDES at it — this app has already
 * proved that once, on the wordmark, where the tracking had to go -0.025em ->
 * -0.01em the day the wordmark became Lora (`features/layouts/app-header.tsx`:
 * "a serif with real bracketed serifs collides at that value, and 'Lumen' has an
 * m-n pair that shows it first").
 *
 * `tracking-title` is that same measured -0.01em, now a named token
 * (`packages/tailwindcss/tailwind.config.js`) so the next display face does not
 * need this comment written a third time.
 */
const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' | 'h4' }
>(({ className, as: Tag = 'h3', ...props }, ref) => (
  <Tag ref={ref} className={cn('text-lg font-semibold leading-none tracking-title', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  )
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-1', className)} {...props} />
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(' flex items-center p-1', className)} {...props} />
  )
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
