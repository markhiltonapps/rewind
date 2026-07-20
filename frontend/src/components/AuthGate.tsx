'use client';

import { useEffect, useState } from 'react';
import { isCloud } from '@/lib/cloudConfig';
import { onAuth } from '@/lib/authClient';
import SignIn from '@/components/SignIn';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    if (!isCloud) {
      setToken(null); // passthrough in local mode — skip auth entirely
      return;
    }
    const unsubscribe = onAuth((t) => setToken(t));
    return unsubscribe;
  }, []);

  // Still waiting for the initial session check — render nothing to
  // avoid a flash of the sign-in screen on page load when already authed.
  if (token === undefined) return null;

  if (isCloud && !token) return <SignIn />;

  return <>{children}</>;
}
