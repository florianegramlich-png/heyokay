'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { session } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace(session.getToken() ? '/now' : '/onboarding'); }, [router]);
  return null;
}
