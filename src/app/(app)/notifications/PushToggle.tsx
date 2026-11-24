'use client';
import { useState } from 'react';
import { savePushSubscription } from './actions';

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Asks this browser for permission and registers it for push (roadmap #39).
export default function PushToggle({ publicKey }: { publicKey: string | null }) {
  const [message, setMessage] = useState<string | null>(null);
  if (!publicKey) return <p className="muted">Push notifications are not set up on the server yet (VAPID keys).</p>;

  async function enable() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setMessage('This browser does not support push notifications. On iPhone, add the app to the home screen first.');
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') {
        setMessage('Notifications were not allowed. You can change this in the browser settings.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey!) }));
      const r = await savePushSubscription(JSON.stringify(sub));
      setMessage(r.message);
    } catch {
      setMessage('Could not turn on notifications on this device.');
    }
  }

  return (
    <>
      <button type="button" onClick={enable}>Get notifications on this device</button>
      {message && <p className="muted">{message}</p>}
    </>
  );
}
