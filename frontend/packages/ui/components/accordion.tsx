'use client';

import * as React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';

import { cn } from '@ui/lib/utils';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn('border-b', className)} {...props} />
));
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      data-testid="comment-close-open"
      className={cn(
        'flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180',
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

/**
 * ════ THE OPEN ANIMATION DOES NOT RUN ON FIRST PAINT ════
 *
 * ★★★ THIS WAS THE POST PAGE'S LAYOUT SHIFT, AND IT WAS NOT THE IMAGES.
 *
 * The audit blamed post-page jump on images shipping without intrinsic dimensions, and
 * for three passes that was the #1 roadmap item. Measured, it does not hold: the feed has
 * zero unreserved image boxes, and post-body embeds already reserve 16:9 via
 * `.videoWrapper`. Attributing the shifts to actual DOM nodes found this instead.
 *
 * Every comment on a post renders inside an Accordion that is ALREADY OPEN
 * (`openState` starts at `item-1`). But `animate-accordion-down` keyframes height from
 * `0` to the content height, and a CSS animation runs when the element MOUNTS, not only
 * when the state changes. So on every post page load, every comment body inflated from
 * zero height at once:
 *
 *     ul[data-testid=comment-list]   189px -> 621px
 *     div.overflow-hidden.text-sm      0px -> 158px   (per comment)
 *
 * pushing everything below it down mid-read. Measured CLS 0.34 and 0.16 on two real
 * posts, both above Google's 0.1 threshold, and the shift entries named the article
 * container and the post footer as what moved, with an iframe carried along for the ride.
 * Nobody asked for the comments to unfurl on arrival; the animation exists for a reader
 * who CLICKS.
 *
 * ★ WHY A FRAME, AND WHY THAT IS ENOUGH. The animation classes are withheld until one
 * animation frame after mount. An item that starts open therefore never animates, because
 * its state never changed. Any later toggle - the case the animation is actually for -
 * happens long after that frame and animates exactly as before. Nothing about the
 * interaction changes; only the free unfurl on arrival is gone.
 *
 * ★ IT IS DELIBERATELY IN THE PRIMITIVE, NOT IN comment-list-item. Animating from zero on
 * mount is never what anyone wants, on any accordion. Fixing it at the one call site that
 * was measured would leave the same trap armed for the next one.
 */
const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const [interactive, setInteractive] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setInteractive(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <AccordionPrimitive.Content
      ref={ref}
      className={cn(
        'overflow-hidden text-sm',
        interactive &&
          'transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
        className
      )}
      {...props}
    >
      <div>{children}</div>
    </AccordionPrimitive.Content>
  );
});
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
