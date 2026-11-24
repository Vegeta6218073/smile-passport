'use client';
import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

const MINUTES = Number(process.env.NEXT_PUBLIC_IDLE_MINUTES ?? 30);

// Signs the user out after a period without activity (shared clinic computers).
export default function IdleSignOut() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await createClient().auth.signOut();
        window.location.href = '/login?reason=idle';
      }, MINUTES * 60 * 1000);
    };
    const events = ['click', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);
  return null;
}
