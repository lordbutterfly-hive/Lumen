import StaticContent from '@/blog/features/static-pages/content-component';

/**
 * Lumen's own help page.
 *
 * ★ WHY IT EXISTS (2026-08-08, UX tester on the new-user path). The "Help" link on
 * the sign-in screen went to /faq.html — the inherited Hive.blog FAQ, which opens
 * on master passwords, owner keys, Resource Credits and MVESTs, and sends the
 * reader to a third-party account-creation service. That is the exact opposite of
 * the promise the same screen had just made ("without keys, wallets or setup"),
 * aimed at the one person least equipped to deal with it.
 *
 * The Hive FAQ is still right for someone running their own Hive account, so it
 * stays where it is and this page links to it at the bottom. What changed is which
 * of the two a newcomer meets first.
 */
const HelpPage = () => <StaticContent filename="lumen-help.md" />;

export default HelpPage;
