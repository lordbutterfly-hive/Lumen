/**
 * HARNESS 1 — "I heard about this today and I'm trying it."
 *
 * A person who has never used Hive. They sign up, say what they like, read for
 * a bit, follow someone, write something, and come back later. Somewhere in
 * there they notice "Creators" in the sidebar and go and look.
 *
 * Drive these steps in order and judge each one as that person would. The
 * helpers return evidence, never a verdict — the verdict is yours.
 */
import { openProd, openDev, land, toasts, journal, PROD, DEV } from './_day.mjs';

export const STORY = [
  'Arrive logged out. Would you understand what this is, and would you sign up?',
  'Sign up. How long, how many decisions, anything confusing or scary?',
  'Pick interests. Does the feed you get afterwards look like your picks?',
  'Read: open two posts from the feed, follow one author, come back.',
  'Write your first short post. Do you believe it worked?',
  'Check your own profile. Is your post there, are the numbers sensible?',
  'Leave and come back (new tab, same browser). Is it fast, are you still you?',
  'Notice "Creators", go to /creators, open a creator, and try to buy their token.'
];

export async function newcomer(privateKey, label = 'newcomer') {
  const j = journal();
  const anon = await openProd(undefined, label + '-anon').catch(() => null);
  return { j, PROD, DEV, openProd, openDev, land, toasts, anon, privateKey, label };
}
export { openProd, openDev, land, toasts, journal, PROD, DEV };
