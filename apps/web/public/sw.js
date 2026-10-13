/* global self, clients */
// Bedo Chat service worker: shows push notifications (login alerts and account notices, D-13, D-21; messages,
// mentions, replies and being added to a group or channel, D-41) and opens the right chat when one is clicked. It
// does not cache pages or data.
//
// D-25: the student app and the Admin Dashboard share https://bedochat.com, and this worker's scope ("/")
// also covers /admin pages. It must therefore never get a fetch handler or any caching: that would let
// the student app's code sit between the Admin Dashboard and the network.

/** Only paths of the student app are opened from a notification (never another site, never /admin). */
function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  const url = new URL(value, self.location.origin);
  if (url.origin !== self.location.origin || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return '/';
  return url.pathname + url.search;
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title : 'Bedo Chat';
  const tag = typeof data.tag === 'string' ? data.tag : undefined;
  const work = [
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      // D-54: the Bedo Chat icon beside the notification, and its one-colour shape in Android's status bar.
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag,
      // A new message in the same chat replaces the previous notification and still plays the sound.
      renotify: Boolean(tag),
      silent: false,
      data: { url: safePath(data.url) },
    }),
  ];
  // D-41: the badge count computed by the server, the same on every device.
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    work.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Bedo Chat windows only: the Admin Dashboard shares this origin under /admin (D-25).
      const open = windows.find((client) => {
        const address = new URL(client.url);
        return address.origin === self.location.origin && address.pathname !== '/admin' && !address.pathname.startsWith('/admin/');
      });
      if (open) {
        // The open app switches to the chat itself (no reload).
        open.postMessage({ type: 'bedo-open', url });
        return open.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
