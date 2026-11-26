/* Service Worker auxiliar para Web Push (FCM HTTP v1 / iOS 16.4+ PWA) */
/* Importado pelo Service Worker principal do Workbox via importScripts('push-sw.js') */

// Configuração idêntica a src/firebaseConfig.ts para garantir consistência no Service Worker
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBjEDSa778wMBEEpWeiEZLQPngJu_RFuDI',
  authDomain: 'meu-treino-2007.firebaseapp.com',
  projectId: 'meu-treino-2007',
  storageBucket: 'meu-treino-2007.firebasestorage.app',
  messagingSenderId: '604959128508',
  appId: '1:604959128508:web:8232667f3eda747dc3c9b9',
}
self.__FIREBASE_CONFIG__ = FIREBASE_CONFIG

function getScopeBaseUrl() {
  return (self.registration && self.registration.scope) || self.location.origin + '/'
}

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
  const data = payload.data || (notif && notif.data) || {}
  const title = notif.title || data.title || 'Notícias do Ifes – Campus Vitória'
  const body = notif.body || data.body || 'Nova notícia disponível no app.'
  const scopeBase = getScopeBaseUrl()
  const defaultTabUrl = new URL('?tab=noticias', scopeBase).toString()
  const url =
    data.url ||
    (payload.fcmOptions && payload.fcmOptions.link) ||
    defaultTabUrl
  const route = data.route || 'noticias'
  const newsId = data.newsId || 'ifes-noticias'
  const receivedAt = Date.now()
  const iconUrl = new URL('icon-192.png', scopeBase).toString()

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

    try {
      await self.registration.showNotification(title, {
        body,
        icon: iconUrl,
        badge: iconUrl,
        tag: newsId,
        data: {
          url,
          route,
          newsId,
          receivedAt,
        },
      })
    } catch {
      await self.registration.showNotification(title, { body })
    }
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

    const scopeUrl = getScopeBaseUrl()
    const targetUrl = new URL(scopeUrl)
    targetUrl.searchParams.set('tab', route)
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl.toString())
    }
  })()

  event.waitUntil(handleClick)
})
