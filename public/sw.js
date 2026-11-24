// Minimal service worker: makes the app installable and receives push messages.
// It deliberately caches nothing, so patient data is never stored by the worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Push (Phase 3 staff notifications). Keep payloads free of patient details.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Smile Passport', {
      body: data.body || 'You have an item that needs attention.',
      data: { url: data.url || '/today' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
