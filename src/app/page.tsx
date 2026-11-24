import { redirect } from 'next/navigation';

// Middleware sends signed-in users to /today. Everyone else lands on /login.
export default function Home() {
  redirect('/login');
}
