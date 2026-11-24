import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireMember } from '@/lib/auth';
import { navFor } from '@/lib/roles';
import { createClient } from '@/lib/supabase/server';
import IdleSignOut from '@/components/IdleSignOut';

async function signOut() {
  'use server';
  await createClient().auth.signOut();
  redirect('/login');
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Pages and actions call requireMember() themselves and enforce 2FA; this call only needs
  // identity, so the enrolment gate is skipped here and /security stays reachable.
  const member = await requireMember({ allowUnenrolled: true });
  const { data: aal } = await createClient().auth.mfa.getAuthenticatorAssuranceLevel();
  const needsEnrol = process.env.REQUIRE_2FA === 'true' && aal?.nextLevel === 'aal1';

  return (
    <div className="shell">
      <IdleSignOut />
      <div className="topbar">
        <div>
          <strong>{member.clinicName}</strong>
          <div className="muted">{member.email} · {member.role.replace('_', ' ')}</div>
        </div>
        <form action={signOut}>
          <button className="link" type="submit">Sign out</button>
        </form>
      </div>
      <nav className="nav">
        {navFor(member.role).map((item) => (
          <Link key={item.href} href={item.href}>{item.label}</Link>
        ))}
      </nav>
      {needsEnrol && (
        <div className="card">
          <strong>Two-factor sign-in is required.</strong>{' '}
          <Link href="/security">Set it up now</Link>
        </div>
      )}
      {children}
    </div>
  );
}
