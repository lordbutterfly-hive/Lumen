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
    ? 'Read, write, and get paid on Hive — the calm way. Start free with Lumen Lite (Google or Bitcoin, no keys), or sign in with your Hive account.'
    : 'Read, write, and get paid on Hive — the calm way. Start free with Lumen Lite using a Bitcoin or Ethereum wallet, or sign in with your Hive account.'
};

export default function LoginPage() {
  return <LumenLogin />;
}
