import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { routePattern } from '@/lib/usage';

const EVENTS = new Set(['page_view']);

// Signed-in staff only (the database function ignores anyone who is not a clinic member).
export async function POST(request: NextRequest) {
  let body: { event?: unknown; path?: unknown };
  try { body = await request.json(); } catch { return new NextResponse(null, { status: 400 }); }
  const event = typeof body.event === 'string' && EVENTS.has(body.event) ? body.event : null;
  const path = typeof body.path === 'string' ? routePattern(body.path) : null;
  if (!event) return new NextResponse(null, { status: 400 });
  await createClient().rpc('track_usage', { p_event: event, p_path: path });
  return new NextResponse(null, { status: 204 });
}
