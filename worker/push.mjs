// Staff push notifications (roadmap #39). Payloads never contain patient details: a generic title,
// and the in-app link. The notification itself (with names) is only visible after signing in.
import webpush from 'web-push';

const TITLES = {
  task: 'New task for you',
  concern: 'Patient concern',
  concern_urgent: 'URGENT patient concern',
};

export function pushPayload(n) {
  const key = n.kind === 'concern' && n.urgent ? 'concern_urgent' : n.kind;
  const url = typeof n.link === 'string' && n.link.startsWith('/') ? n.link : '/today';
  return JSON.stringify({ title: TITLES[key] ?? 'S-One', body: 'Open S-One to see it.', url });
}

export function pushConfigured(env = process.env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

// Sends each unpushed notification from the last day to every device the user subscribed.
// Subscriptions the push service reports as gone (404/410) are removed.
export async function sendPushes({ admin, env = process.env, client = webpush, log = console.log }) {
  if (!pushConfigured(env)) return { pushed: 0, skipped: 'no VAPID keys' };
  client.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: items, error } = await admin.from('notifications')
    .select('id, user_id, kind, link, urgent').is('pushed_at', null).gte('created_at', since).limit(100);
  if (error) throw new Error(`notifications: ${error.message}`);
  let pushed = 0;
  for (const n of items ?? []) {
    const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', n.user_id);
    for (const s of subs ?? []) {
      try {
        await client.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, pushPayload(n),
          { TTL: n.urgent ? 3600 : 86400, urgency: n.urgent ? 'high' : 'normal' });
        pushed += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', s.id);
        else log(`[push] failed: ${err?.statusCode ?? ''} ${err?.message ?? err}`);
      }
    }
    await admin.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
  }
  return { pushed };
}
