import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// Invite and password-reset emails link here (see supabase/templates and docs/automation.md).
// The one-time token is exchanged for a session, then the person chooses a password.
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type') as EmailOtpType | null;

  if (tokenHash && type && ['invite', 'recovery', 'email'].includes(type)) {
    const { error } = await createClient().auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const next = type === 'email' ? '/today' : '/set-password';
      return NextResponse.redirect(new URL(next, request.url));
    }
  }
  return NextResponse.redirect(new URL('/login?error=invalid-link', request.url));
}
