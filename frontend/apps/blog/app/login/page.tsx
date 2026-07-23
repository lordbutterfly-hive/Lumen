import type { Metadata } from 'next';
import LumenLogin from '@/blog/features/lite-auth/login/lumen-login';

export const metadata: Metadata = {
  title: 'Sign in',
  description:
    'Read, write, and get paid on Hive — the calm way. Start free with Lumen Lite (Google or Bitcoin, no keys), or sign in with your Hive account.'
};

export default function LoginPage() {
  return <LumenLogin />;
}
