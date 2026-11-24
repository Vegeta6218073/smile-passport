'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function VerifyPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const supabase = createClient();
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.[0];
    if (listError || !factor) return setError('No authenticator is set up for this account.');
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code,
    });
    if (verifyError) return setError('That code did not work. Try again.');
    router.push('/today');
    router.refresh();
  }

  return (
    <main className="shell">
      <div className="card" style={{ maxWidth: 420, margin: '48px auto' }}>
        <h1>Enter your code</h1>
        <p className="muted">Open your authenticator app and enter the 6-digit code.</p>
        {error && <p className="error">{error}</p>}
        <form onSubmit={submit}>
          <label htmlFor="code">Code</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code}
            onChange={(e) => setCode(e.target.value)} required />
          <button type="submit">Verify</button>
        </form>
      </div>
    </main>
  );
}
