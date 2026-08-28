import StaticContent from '@/blog/features/static-pages/content-component';

/**
 * ★ POLICY RESTORED 2026-08-28, after being taken down on 2026-08-27.
 *
 * The removed document was inherited from hive.blog and described collection Lumen
 * does not carry out ("your email address and telephone number"). Taking it down was
 * right: a policy that overstates collection is a representation to users and to
 * regulators about behaviour that does not happen, and it cannot be defended by
 * pointing at the code.
 *
 * What replaced it was written the other way round — from the live database schema and
 * the routes that write to it, not from another site's policy. One claim in the
 * takedown note was itself wrong and is worth recording: IP addresses WERE being
 * stored, in cleartext, in `rate_counter.subject`, by nineteen routes. That is now
 * fixed in the code rather than in the wording (see `lib/lite/http/ip.ts` `ipKey`), so
 * the sentence "we do not store your IP address" is true at the time of writing.
 *
 * The original is preserved at `~/lumen-logs/privacy-policy-ORIGINAL-2026-08-27.tsx`.
 * Do not restore it: it is the document that was wrong.
 */
const PrivacyPage = () => <StaticContent filename="privacy.md" />;

export default PrivacyPage;
