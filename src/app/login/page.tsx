import { login } from './actions';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; reason?: string };
}) {
  return (
    <main className="shell">
      <div className="card" style={{ maxWidth: 420, margin: '48px auto' }}>
        <h1>Smile Passport</h1>
        <p className="muted">Staff sign-in</p>
        {searchParams.error && <p className="error">Email or password is incorrect.</p>}
        {searchParams.reason === 'idle' && (
          <p className="muted">You were signed out after a period of inactivity.</p>
        )}
        <form action={login}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
