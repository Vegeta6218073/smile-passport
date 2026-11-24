'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MIN_PASSWORD_LENGTH } from '@/lib/settings';

// Reached from an invite or reset email. The person is signed in by /auth/confirm already.
export default function SetPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get('password') ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password !== data.get('confirm')) return setError('The two passwords do not match.');

    setBusy(true);
    setError(null);
    const { error: err } = await createClient().auth.updateUser({ password });
    if (err) {
      setBusy(false);
      return setError('Could not save that password. Try a longer or different one.');
    }
    window.location.href = '/today';
  }

  return (
    <main className="shell">
      <div className="card">
        <h1>Choose your password</h1>
        <form onSubmit={onSubmit}>
          <label htmlFor="password">New password (at least {MIN_PASSWORD_LENGTH} characters)</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required />
          <label htmlFor="confirm">Repeat password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      </div>
    </main>
  );
}
