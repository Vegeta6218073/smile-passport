import { createClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS. Server-only. Use it ONLY for the public Smile Passport
// intake (visitors have no account) and never pass its results to the browser unfiltered.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase service role is not configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
