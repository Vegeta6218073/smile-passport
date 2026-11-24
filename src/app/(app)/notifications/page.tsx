import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn, timeIn } from '@/lib/dates';
import { markAllRead } from './actions';
import PushToggle from './PushToggle';

export const dynamic = 'force-dynamic';

// Roadmap #39: alerts for items assigned to you and for urgent concerns, in the app and as push.
export default async function NotificationsPage({ searchParams }: { searchParams: { ok?: string } }) {
  const member = await requireMember();
  const { data: items } = await createClient().from('notifications')
    .select('id, kind, title, link, urgent, created_at, read_at').order('created_at', { ascending: false }).limit(100);
  const tz = member.timezone;
  return (
    <>
      {searchParams.ok && <p>{searchParams.ok}</p>}
      <div className="card">
        <h2>Notifications</h2>
        <form action={markAllRead}><button type="submit" className="link">Mark all as read</button></form>
        {(items?.length ?? 0) === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="list">
          {items?.map((n) => (
            <li key={n.id}>
              {n.read_at ? '' : '● '}
              <strong className={n.urgent ? 'error' : undefined}>{n.title}</strong>{' '}
              {n.link && <Link href={n.link}>Open</Link>}
              <div className="muted">{dateIn(n.created_at, tz)} {timeIn(n.created_at, tz)}</div>
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h2>On this device</h2>
        <p className="muted">Push notifications say only that something needs you. Patient details stay in the app.</p>
        <PushToggle publicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} />
      </div>
    </>
  );
}
