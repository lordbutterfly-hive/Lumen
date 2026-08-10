/**
 * ════ THE DAY BOUNDARY, IN THE READER'S OWN CLOCK ════
 *
 * The streak day is a UTC day, and it has to stay one: `actDaysUTC` is a set of UTC
 * date strings derived from chain timestamps, the freeze ledger records UTC days, and
 * the whole thing is compared against `todayUTC`. Moving the boundary per-reader would
 * mean the same account had a different streak depending on where it opened the app.
 *
 * ★ SO THE BOUNDARY STAYS UTC AND THE *WORDING* STOPS SAYING SO. The card read
 * "Day 2 holds until midnight UTC", and a tester's note was blunt: "'UTC' is
 * developer-speak. I don't know what UTC I'm in." The two obvious fixes are both wrong —
 * dropping the suffix to say plain "midnight" is a LIE to anybody not on UTC (in Lisbon
 * in summer the deadline is 01:00, in Tokyo it is 09:00 the next morning), and keeping
 * "UTC" leaves the reader doing arithmetic they cannot do. So translate it: state the
 * same instant as a time on the clock the reader is actually looking at.
 *
 * Nothing here feeds a measurement. It is presentation over a boundary computed
 * elsewhere, which is why it can safely depend on the browser's timezone while the
 * streak cannot.
 */

/** The next UTC midnight strictly after `nowMs`, as epoch ms. */
export function nextUtcMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export interface DeadlineLabel {
  /**
   * The deadline as a clock time in the given zone, e.g. "01:00" or "1:00 AM" — locale's
   * own convention, because a 12-hour reader should not be handed a 24-hour string.
   */
  time: string;
  /**
   * True when the deadline IS local midnight, i.e. the reader is effectively on UTC.
   * A time of "00:00" is technically correct and reads worse than the word, so callers
   * use the word instead. This is the one case where the old copy was already right.
   */
  isMidnight: boolean;
}

/**
 * When today's UTC day ends, said in local time.
 *
 * `locale`/`timeZone` are injectable ONLY so this can be tested at a fixed instant in a
 * fixed zone; production passes neither and gets the browser's own. Returns null when
 * `Intl` cannot answer, so a caller renders no time rather than a wrong one.
 */
export function localDeadlineLabel(nowMs: number, locale?: string, timeZone?: string): DeadlineLabel | null {
  const at = new Date(nextUtcMidnightMs(nowMs));
  try {
    // A separate 24-hour pass decides the midnight case, so the check never depends on
    // whether the display locale happens to use AM/PM.
    const h23 = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {})
    }).format(at);
    // `2-digit` on the hour as well, so a 24-hour locale reads "01:00" rather than "1:00"
    // — a bare "1:00" in a sentence about tonight invites a reader to see one in the
    // afternoon. A 12-hour locale still gets its own marker ("01:00 AM").
    const display = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {})
    }).format(at);
    return { time: display, isMidnight: h23 === '00:00' || h23 === '24:00' };
  } catch {
    return null;
  }
}
