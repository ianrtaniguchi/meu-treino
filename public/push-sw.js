/* Service Worker auxiliar para Web Push (FCM HTTP v1 / iOS 16.4+ PWA) */
/* Importado pelo Service Worker principal do Workbox via importScripts('push-sw.js') */

self.addEventListener('push', (event) => {
  let payload = {}
  if (event.data) {
    try {
      payload = event.data.json() || {}
    } catch {
      try {
        payload = { notification: { title: 'Notícias do Ifes', body: event.data.text() } }
      } catch {
        payload = {}
      }
    }
  }

  const notif = payload.notification || {}
  const data = payload.data || {}
  const title = notif.title || data.title || 'Notícias do Ifes – Campus Vitória'
  const body = notif.body || data.body || 'Nova notícia disponível no app.'
  const url = data.url || (payload.fcmOptions && payload.fcmOptions.link) || './?tab=noticias'
  const route = data.route || 'noticias'
  const newsId = data.newsId || 'ifes-noticias'
  const receivedAt = Date.now()

  const work = (async () => {
    try {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of windowClients) {
        client.postMessage({
          type: 'IFES_PUSH_RECEIVED',
          title,
          body,
          url,
          route,
          newsId,
          receivedAt,
        })
      }
    } catch {
      // ignora falha ao notificar clientes abertos
    }

    await self.registration.showNotification(title, {
      body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: newsId,
      data: {
        url,
        route,
        newsId,
        receivedAt,
      },
    })
  })()

  event.waitUntil(work)
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification && event.notification.data) || {}
  const route = data.route || 'noticias'
  const articleUrl = data.url || ''

  const handleClick = (async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })

    for (const client of windowClients) {
      if ('focus' in client) {
        try {
          await client.focus()
        } catch {
          // prossegue mesmo se focus falhar
        }
        client.postMessage({
          type: 'IFES_OPEN_TAB',
          tab: route,
          url: articleUrl,
        })
        return
      }
    }

    const scopeUrl = (self.registration && self.registration.scope) || self.location.origin + '/'
    const targetUrl = new URL(scopeUrl)
    targetUrl.searchParams.set('tab', route)
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl.toString())
    }
  })()

  event.waitUntil(handleClick)
})
