'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { routePattern } from '@/lib/usage';

// One page-view event per navigation, with the route pattern only (no ids, no patient data).
export default function UsageBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    const path = routePattern(pathname ?? '/');
    if (!path) return;
    const body = JSON.stringify({ event: 'page_view', path });
    if (!navigator.sendBeacon?.('/api/usage', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/usage', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  }, [pathname]);
  return null;
}
