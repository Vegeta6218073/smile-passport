'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function EnrolForm() {
  const [qr, setQr] = useState('');
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  async function start() {
    setMessage('');
    const { data, error } = await createClient().auth.mfa.enroll({ factorType: 'totp' });
    if (error || !data) return setMessage('Could not start setup. Is TOTP enabled in the auth config?');
    setFactorId(data.id);
    setQr(data.totp.qr_code);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return setMessage('That code did not work. Try again.');
    setQr('');
    setCode('');
    setMessage('Two-factor sign-in is on for your account.');
  }

  return (
    <div className="card">
      <h2>Two-factor sign-in</h2>
      <p className="muted">Scan the QR code with an authenticator app, then enter the code it shows.</p>
      {message && <p>{message}</p>}
      {!qr && <button onClick={start}>Set up authenticator</button>}
      {qr && (
        <>
          {/* qr is an SVG data URI returned by the auth server */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="QR code to scan with your authenticator app" width={200} height={200} />
          <form onSubmit={confirm}>
            <label htmlFor="code">6-digit code</label>
            <input id="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button type="submit">Confirm</button>
          </form>
        </>
      )}
    </div>
  );
}
