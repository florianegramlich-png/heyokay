'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { session } from './session';

/** Pages that need the device token send first-time visitors to onboarding. */
export function useDevice() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!session.getToken()) router.replace('/onboarding');
    else setReady(true);
  }, [router]);
  return ready;
}
