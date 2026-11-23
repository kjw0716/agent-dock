'use strict';
// Service worker of the phone page: it only receives pushes from the dock and shows them. It never fetches anything.
// Every push must show a notification (iOS withdraws the permission otherwise).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {}
  const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 80) : 'Agent Dock';
  const body = typeof d.body === 'string' ? d.body.slice(0, 160) : '';
  const open = typeof d.open === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(d.open) ? d.open : '';
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/icon.png', badge: '/icon.png', tag: open || 'dock', data: { open } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = (event.notification.data && event.notification.data.open) || '';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) {
          await c.focus();
          if (open) c.postMessage({ open });
          return;
        }
      }
      await self.clients.openWindow('/' + (open ? '#open=' + encodeURIComponent(open) : ''));
    })()
  );
});
