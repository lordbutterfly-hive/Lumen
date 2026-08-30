import type { Metadata } from 'next';
import LumenLogin from '@/blog/features/lite-auth/login/lumen-login';

// ★ Named Google as an available way in while the page below says it "is being
// set up" (2026-08-09). This is server-rendered metadata, so it cannot use the
// client-side `googleConfigured()` the page itself uses — it reads the same
// client id straight from the environment instead, so the two cannot drift.
const googleReady = (() => {
  const id = process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID ?? '';
  return id.length > 0 && !/placeholder/i.test(id) && id.endsWith('.apps.googleusercontent.com');
})();

export const metadata: Metadata = {
  title: 'Sign in',
  description: googleReady
    ? 'A calmer place to read and write. Start free with Lumen Lite (Google or Bitcoin, no keys), or sign in with your Hive account.'
    : 'A calmer place to read and write. Start free with Lumen Lite using a Bitcoin or Ethereum wallet, or sign in with your Hive account.'
};

export default function LoginPage() {
  // ★ NO SHELL ON THIS ROUTE — see app/security/page.tsx for why the landmark
  // lives here rather than in the root layout.
  //
  // ★★★ THE SAME `googleReady` THE METADATA ABOVE ALREADY COMPUTES, HANDED TO THE
  // BODY TOO (2026-08-28, flicker root-cause fix).
  //
  // `lumen-login.tsx` used to start its OWN `googleReady` state at a hardcoded
  // `false` and only correct it in a `useEffect` after mount — on the theory that
  // "the server render cannot see the client id". That theory is disproven by the
  // ten lines above: this Server Component reads `process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID`
  // directly and gets the right answer, proven live by the served
  // `<meta name="description">` already reading the "Google or Bitcoin" copy on
  // production. The server COULD see it the whole time; the client component
  // just never asked.
  //
  // So every single visitor, on every load, saw a false "Google sign-in is being
  // set up" pill for however long the mount effect took to run and correct
  // itself — measured live on lumensocial.net at 100-1500ms across repeated
  // clean loads. That is the flash the owner reported. Passing the already-known
  // answer down as a plain serialized prop means the FIRST client render (the one
  // hydration diffs against) already matches this true value — no mismatch risk,
  // because nothing calls `env()` during render to disagree with it.
  return (
    <main>
      <LumenLogin googleConfiguredInitially={googleReady} />
    </main>
  );
}
