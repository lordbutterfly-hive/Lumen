import { permanentRedirect } from 'next/navigation';

/**
 * ★ `/wallet/tokens` IS NOW THE WALLET'S MERITUM TAB (owner ruling 2026-09-08).
 *
 * The portfolio it rendered (`YourTokensView`) lives on `/wallet?tab=meritum`,
 * one of three in-page tabs, so nobody has to click through to a second page.
 * Every inbound link in the app was retargeted; this redirect keeps old
 * bookmarks, the wallet's own untouched "Your Meritum tokens" links
 * (wallet-content.tsx) and any external link working. Signed-out readers get
 * the login door from `/wallet` itself, with the tab carried in `?next=`.
 */
export default function YourTokensPage() {
  permanentRedirect('/wallet?tab=meritum');
}
