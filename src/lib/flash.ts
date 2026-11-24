import { redirect } from 'next/navigation';

// Server actions report back through the URL: ?error=... or ?ok=...
export function go(path: string, kind: 'error' | 'ok', message: string): never {
  const sep = path.includes('?') ? '&' : '?';
  redirect(`${path}${sep}${kind}=${encodeURIComponent(message)}`);
}

type DbError = { code?: string; message?: string };

// Turns database errors into messages staff can act on. Anything unknown stays generic,
// so internals never leak into the UI.
export function dbMessage(error: DbError): string {
  switch (error.code) {
    case '23P01':
      return 'That doctor or chair is already booked at that time.';
    case '23503':
      return 'That record points at something that does not exist in this clinic.';
    case '23505':
      return 'That already exists.';
    case '42501':
      return 'Your role is not allowed to do that.';
    case 'P0001':
      return error.message ?? 'That is not allowed right now.';
    default:
      return 'Something went wrong. Nothing was saved.';
  }
}
