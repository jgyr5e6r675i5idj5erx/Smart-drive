const CACHE_NAME = 'smart-ride-static-v2';
const STATIC_ASSETS = ['/style.css', '/pwa.js', '/push.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/offline.html'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache authenticated pages, API responses, ride/customer data, or payment flows.
  if (url.pathname === '/health' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/payments/') || url.pathname === '/dashboard' || url.pathname.startsWith('/driver/') || url.pathname.startsWith('/admin') || url.pathname === '/login' || url.pathname === '/register' || url.pathname === '/book') return;
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});

self.addEventListener('push', event => {
  let data={};
  try { data=event.data ? event.data.json() : {}; } catch(e) { data={body:event.data ? event.data.text() : 'You have a SMART RIDE update.'}; }
  const title=data.title || 'SMART RIDE update';
  const options={body:data.body || 'Open SMART RIDE to view the update.',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:data.tag || 'smart-ride-update',renotify:false,data:{url:data.url || '/dashboard',...(data.data||{})}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target=new URL(event.notification.data?.url || '/dashboard',self.location.origin).href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){if(new URL(client.url).origin===self.location.origin){client.navigate(target);return client.focus();}}
    return clients.openWindow(target);
  }));
});
