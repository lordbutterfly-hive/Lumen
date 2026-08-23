/**
 * Display-text safety for strings written by someone else.
 *
 * ★ THIS IS A READ-SIDE DEFENCE, AND THAT IS DELIBERATE (2026-08-23).
 *
 * Hive profile fields are chain data. Any client — PeakD, Ecency, `hive-cli` — can write
 * a display name containing U+202E RIGHT-TO-LEFT OVERRIDE, and Lumen never sees that
 * transaction. So sanitising OUR write path defends nobody; the only place the defence
 * can work is where the value is rendered.
 *
 * ★★★ U+200C AND U+200D ARE DELIBERATELY KEPT, AND THE PREVIOUS SET GOT THIS WRONG.
 *
 * The lite profile sanitiser used `[​-‏...]`, a range that swallows both:
 *
 *   - **U+200C ZERO WIDTH NON-JOINER** is orthographically REQUIRED in Persian/Farsi
 *     compounds (`می‌خواهم`, `کتاب‌ها`) and controls conjunct forms in Devanagari,
 *     Bengali, Tamil and Malayalam. Stripping it corrupts ordinary names.
 *   - **U+200D ZERO WIDTH JOINER** builds emoji sequences. `👩‍💻` is
 *     `👩 + ZWJ + 💻`; strip the joiner and one glyph becomes two. Verified by running
 *     the old expression: `👩‍💻` came out as `👩💻`.
 *
 * Neither can reorder text, so neither is a spoofing tool. They are removed from the set.
 *
 * Two characters the old set MISSED are added: U+061C ARABIC LETTER MARK (a real bidi
 * control) and U+2060 WORD JOINER (a real invisible).
 *
 * What remains is exactly the class that can hide or reverse text:
 *   U+200B zero width space
 *   U+200E / U+200F left-to-right / right-to-left mark
 *   U+061C arabic letter mark
 *   U+202A-U+202E the bidi embedding/override block
 *   U+2060 word joiner
 *   U+2066-U+2069 the bidi isolate block
 *   U+FEFF zero width no-break space
 */
export const INVISIBLE_OR_BIDI = /[​‎‏؜‪-‮⁠⁦-⁩﻿]/g;

/**
 * Remove invisible and direction-controlling characters from a display string.
 *
 * Deliberately does NOT truncate and does NOT touch C0/C1 controls — those are write-side
 * field policy (see `lib/lite/profile/profile-service.ts`), and applying them on read would
 * silently shorten a legitimate chain bio.
 */
export function stripInvisibleAndBidi(value: unknown): string {
  // ★ TYPE-GUARD, NOT JUST A FALSY CHECK (corrected 2026-08-23). The callers feed this
  // `JSON.parse(posting_json_metadata).profile.name`, which is attacker-controlled: any
  // Hive client can publish `{"profile":{"name":123}}`. A `!value` guard lets a number,
  // an object or `true` straight through to `.replace`, which throws. `getAccounts` is the
  // single funnel for every profile read, and `/api/witnesses-page` calls it with the
  // top-100 witness owners in ONE batch — so one witness with a non-string profile field
  // would have taken down the witnesses page for every reader.
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(INVISIBLE_OR_BIDI, '');
}
