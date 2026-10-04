/* global self, clients */
// Bedo Chat service worker: shows push notifications (login alerts and account notices, D-13, D-21)
// and focuses the app when one is clicked. It does not cache pages or data.
//
// D-25: the student app and the Admin Dashboard share https://bedochat.com, and this worker's scope ("/")
// also covers /admin pages. It must therefore never get a fetch handler or any caching: that would let
// the student app's code sit between the Admin Dashboard and the network.

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title : 'Bedo Chat';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Bedo Chat windows only: the Admin Dashboard shares this origin under /admin (D-25).
      const open = windows.find((client) => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname !== '/admin' && !url.pathname.startsWith('/admin/');
      });
      return open ? open.focus() : clients.openWindow('/');
    }),
  );
});
