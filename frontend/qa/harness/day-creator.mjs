/**
 * HARNESS 3 — "Could I make money here?"
 *
 * Someone who writes elsewhere and is evaluating Lumen as a place to sell their
 * time. They care about the money surfaces: what a token is, what it costs,
 * what they'd owe, what they'd earn, and whether they trust the numbers.
 *
 * ★ CREATOR TOKENS ARE ON THE **DEV** ORIGIN TODAY (see _day.mjs for why).
 *   Judge flows and copy there, not speed. Everything else stays on PROD.
 */
import { openProd, openDev, land, toasts, journal, PROD, DEV } from './_day.mjs';

export const STORY = [
  'Read /creators as a stranger. Do you understand what is being sold?',
  'Open @mock-active. What is this token worth, and how do you know?',
  'Try to BUY some. Then try to SELL some. Do the numbers agree before/after?',
  'Look at @mock-frozen and @mock-closed. Is a wind-down explained honestly?',
  'Ask the creator for something (a service/offering). What are you promised?',
  'Open the Creator Studio and the launch wizard. Could you launch a token?',
  'Now do it as a WRITER instead: post something on PROD, check your profile.',
  'Finally: is there anywhere the app tells you something about money you doubt?'
];

/** Every number on screen, so two figures that disagree are easy to catch. */
export async function moneyOnPage(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((el) => !el.children.length && /[$€£]|\d/.test(el.textContent || ''))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 60)
  );
}

export async function creatorCurious(privateKey, label = 'creator') {
  return { j: journal(), PROD, DEV, openProd, openDev, land, toasts, moneyOnPage, privateKey, label };
}
export { openProd, openDev, land, toasts, journal, PROD, DEV };
