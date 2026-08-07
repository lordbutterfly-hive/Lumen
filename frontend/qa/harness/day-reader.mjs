/**
 * HARNESS 2 — "I read here most days."
 *
 * Someone who already has an account and treats Lumen as a reading app. They
 * skim, they open things, they reply, they vote, they look for a topic, they
 * check what they missed. They are not trying to break anything; they are
 * trying to have a nice half hour.
 *
 * This person notices SMALL wrongness — a number that changed, a thing that
 * didn't stick, a page that felt slow — more than a crash.
 */
import { openProd, openDev, land, toasts, journal, PROD, DEV } from './_day.mjs';

export const STORY = [
  'Land on the feed. Is there anything worth reading? How long did it take?',
  'Open three posts. Read one properly, including its comments.',
  'Reply to one. Vote on one. Reblog one. Do all three stick after a reload?',
  'Use the Following tab. Does it reflect who you actually follow?',
  'Search for something you like, then try a topic from the rail.',
  'Look at another person\'s profile. Their posts, their comments, their numbers.',
  'Check the bell, the wallet, and your own settings.',
  'Go to /creators and look at one creator as a curious reader, not a buyer.'
];

/** The three "did it stick?" checks this person cares about most. */
export async function didItStick(page, origin, path, before, settleMs = 6000) {
  const after = await land(page, origin, path, settleMs);
  return { before, after: after.text, changed: before !== after.text };
}

export async function reader(privateKey, label = 'reader') {
  return { j: journal(), PROD, DEV, openProd, openDev, land, toasts, didItStick, privateKey, label };
}
export { openProd, openDev, land, toasts, journal, PROD, DEV };
