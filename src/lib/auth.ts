import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isRole, type Permission, type Role, can } from '@/lib/roles';

export type Member = {
  userId: string;
  email: string | null;
  clinicId: string;
  clinicName: string;
  timezone: string;
  role: Role;
};

type Options = {
  // Only the /security page sets this, so a user who must enrol 2FA can reach the enrolment screen.
  allowUnenrolled?: boolean;
};

// Phase 1 still assumes one clinic per user. Multi-branch and clinic switching come later.
// Every page and every server action calls this, because server actions can be invoked
// directly and never pass through a layout.
export async function requireMember(options: Options = {}): Promise<Member> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') redirect('/login/verify');
  // nextLevel 'aal1' means no factor is enrolled yet.
  if (!options.allowUnenrolled && process.env.REQUIRE_2FA === 'true' && aal?.nextLevel === 'aal1') {
    redirect('/security');
  }

  const { data: row } = await supabase
    .from('clinic_members')
    .select('clinic_id, role, clinics(name, timezone)')
    .eq('user_id', user.id)
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (!row || !isRole(row.role)) redirect('/no-access');

  const clinic = Array.isArray(row.clinics) ? row.clinics[0] : row.clinics;
  return {
    userId: user.id,
    email: user.email ?? null,
    clinicId: row.clinic_id as string,
    clinicName: (clinic?.name as string | undefined) ?? 'Clinic',
    timezone: (clinic?.timezone as string | undefined) ?? 'Asia/Kolkata',
    role: row.role,
  };
}

export async function requireRole(allowed: Role[]): Promise<Member> {
  const member = await requireMember();
  if (!allowed.includes(member.role)) redirect('/today');
  return member;
}

export async function requirePermission(permission: Permission): Promise<Member> {
  const member = await requireMember();
  if (!can(member.role, permission)) redirect('/today');
  return member;
}
