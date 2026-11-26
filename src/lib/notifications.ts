import { getApps, initializeApp } from 'firebase/app'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported as isMessagingSupported,
  onMessage,
} from 'firebase/messaging'
import { ASSISTANT_WORKER_URL, FCM_VAPID_KEY } from '../assistantConfig'
import { db, getRawRecord, runApplyingRemote } from '../data/db'
import { getFirebaseAuth, getFirebaseDb } from '../data/sync'
import { firebaseConfig } from '../firebaseConfig'

export interface IfesNoticia {
  id: string
  title: string
  summary: string
  publishedAt: string
  url: string
  campus?: string
  createdAt?: string
}

export interface FcmTokenDoc {
  id: string
  token: string
  uid: string
  createdAt: string
  updatedAt?: string
  userAgent: string
  enabled: boolean
  keywords: string[]
}

export interface PushTestResultItem {
  docId: string
  tokenPreview: string
  ok: boolean
  status: number
  reason: string
  removedInvalidToken: boolean
}

export interface PushTestResponse {
  status: string
  uid: string
  totalTokens: number
  sent: number
  failed: number
  message?: string
  results: PushTestResultItem[]
}

export interface IfesWorkerStatus {
  lastRunAt: string | null
  lastNewestId: string | null
  totalNoticias: number
  consecutiveZeroRuns: number
  lastError: string | null
  alert: string | null
}

export interface PushReminderItem {
  id: string
  uid: string
  title: string
  body: string
  triggerAt: string
  timezone: string
  recurrence: 'none' | 'daily' | 'weekly'
  status: 'pending' | 'sent' | 'cancelled'
  createdAt?: string
  sentAt?: string | null
  url?: string
}

const LS_FCM_TOKEN = 'meu_treino_fcm_token'
const LS_FCM_DOC_ID = 'meu_treino_fcm_token_doc_id'
const MAX_STORED_READ_IDS = 500

function safeGetLs(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetLs(key: string, val: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (val === null) localStorage.removeItem(key)
    else localStorage.setItem(key, val)
  } catch {
    // ignora em ambiente sem localStorage
  }
}

export function getSavedLocalFcmToken(): string | null {
  return safeGetLs(LS_FCM_TOKEN)
}

export function getSavedLocalFcmDocId(): string | null {
  return safeGetLs(LS_FCM_DOC_ID)
}

// ---------- Formatação e utilitários puros ----------

export function parseKeywordsInput(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(',')) {
    const clean = part.trim()
    if (!clean) continue
    const lower = clean.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      out.push(clean)
    }
  }
  return out
}

export function formatKeywordsInput(keywords: readonly string[] | undefined | null): string {
  if (!Array.isArray(keywords) || keywords.length === 0) return ''
  return keywords.join(', ')
}

export function formatIfesPublishedAt(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const day = get('day')
    const month = get('month')
    const year = get('year')
    const hour = get('hour')
    const minute = get('minute')
    if (day && month && year && hour && minute) {
      return `${day}/${month}/${year} · ${hour}h${minute}`
    }
  } catch {
    // fallback abaixo
  }
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export function countUnreadNoticias(
  items: readonly Pick<IfesNoticia, 'id'>[],
  readIds: readonly string[],
): number {
  if (!items || items.length === 0) return 0
  const readSet = new Set(readIds)
  let unread = 0
  for (const item of items) {
    if (item.id && !readSet.has(item.id)) unread += 1
  }
  return unread
}

// ---------- Estado de leitura em Dexie (operações atômicas diretas, SEM transação explícita) ----------

export async function getIfesReadIds(): Promise<string[]> {
  const row = await db.settings.get('ifesReadIds')
  if (!row || !Array.isArray(row.value)) return []
  return (row.value as unknown[]).filter((x): x is string => typeof x === 'string')
}

export async function markIfesNewsRead(newsId: string): Promise<string[]> {
  const id = newsId.trim()
  if (!id) return getIfesReadIds()
  const current = await getIfesReadIds()
  if (current.includes(id)) return current
  const next = [id, ...current].slice(0, MAX_STORED_READ_IDS)
  await db.settings.put({ key: 'ifesReadIds', value: next })
  return next
}

export async function markAllIfesNewsRead(newsIds: readonly string[]): Promise<string[]> {
  const current = await getIfesReadIds()
  const set = new Set(current)
  let changed = false
  for (const rawId of newsIds) {
    const id = rawId.trim()
    if (id && !set.has(id)) {
      set.add(id)
      changed = true
    }
  }
  if (!changed) return current
  const next = Array.from(set).slice(0, MAX_STORED_READ_IDS)
  await db.settings.put({ key: 'ifesReadIds', value: next })
  return next
}

// ---------- Diagnóstico local (não sincronizado com nuvem / backup) ----------

export async function recordLastNotificationReceived(now = Date.now()): Promise<void> {
  await runApplyingRemote(async () => {
    await db.settings.put({
      key: 'fcmLastNotificationAt',
      value: now,
      updatedAt: now,
      deleted: false,
    })
  })
}

export async function recordLastNotificationError(errMsg: string | null): Promise<void> {
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.put({
      key: 'fcmLastError',
      value: errMsg,
      updatedAt: now,
      deleted: false,
    })
  })
}

export async function getNotificationDiagnosticsLocal(): Promise<{
  lastNotificationAt: number | null
  lastError: string | null
}> {
  const [lastNotifRow, lastErrRow] = await Promise.all([
    getRawRecord('settings', 'fcmLastNotificationAt'),
    getRawRecord('settings', 'fcmLastError'),
  ])
  const lastNotificationAt =
    lastNotifRow && !lastNotifRow.deleted && typeof lastNotifRow.value === 'number'
      ? lastNotifRow.value
      : null
  const lastError =
    lastErrRow && !lastErrRow.deleted && typeof lastErrRow.value === 'string' && lastErrRow.value
      ? lastErrRow.value
      : null
  return { lastNotificationAt, lastError }
}

// ---------- Detecção de PWA / iOS / Permissão ----------

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  const matchStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  const iosStandalone = Boolean((window.navigator as any)?.standalone === true)
  return Boolean(matchStandalone || iosStandalone)
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/i.test(ua)) return true
  if (/Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1) {
    return true
  }
  return false
}

export function isIosSafariNotInstalled(): boolean {
  return isIosDevice() && !isStandalonePwa()
}

export function getNotificationPermissionLabel(): 'concedida' | 'negada' | 'não pedida' | 'indisponível' {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'indisponível'
  }
  if (Notification.permission === 'granted') return 'concedida'
  if (Notification.permission === 'denied') return 'negada'
  return 'não pedida'
}

// ---------- Leitura das notícias no Firestore (ifesNoticias) ----------

function mapFirestoreNoticiaDoc(id: string, data: Record<string, any>): IfesNoticia {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '(sem título)',
    summary: typeof data.summary === 'string' ? data.summary : '',
    publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : '',
    url: typeof data.url === 'string' ? data.url : 'https://vitoria.ifes.edu.br/noticias',
    campus: typeof data.campus === 'string' ? data.campus : 'vitória',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  }
}

export async function fetchIfesNoticiasOnce(maxItems = 50): Promise<IfesNoticia[]> {
  const fs = getFirebaseDb()
  const q = query(collection(fs, 'ifesNoticias'), orderBy('publishedAt', 'desc'), limit(maxItems))
  const snap = await getDocs(q)
  const items: IfesNoticia[] = []
  snap.forEach((docSnap) => {
    items.push(mapFirestoreNoticiaDoc(docSnap.id, docSnap.data()))
  })
  return items
}

export function subscribeIfesNoticias(
  onItems: (items: IfesNoticia[]) => void,
  onError?: (err: Error) => void,
  maxItems = 50,
): Unsubscribe {
  try {
    const fs = getFirebaseDb()
    const q = query(collection(fs, 'ifesNoticias'), orderBy('publishedAt', 'desc'), limit(maxItems))
    return onSnapshot(
      q,
      (snap) => {
        const items: IfesNoticia[] = []
        snap.forEach((docSnap) => {
          items.push(mapFirestoreNoticiaDoc(docSnap.id, docSnap.data()))
        })
        onItems(items)
      },
      (err) => {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      },
    )
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error(String(e)))
    return () => {}
  }
}

// ---------- Registro e gerenciamento de token FCM (fcmTokens) ----------

export async function computeFcmTokenDocId(uid: string, token: string): Promise<string> {
  const data = new TextEncoder().encode(`${uid}:${token.trim()}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return `fcm_${hex}`
}

async function getReadyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('error: Service Worker não suportado neste navegador.')
  }
  const baseUrl = ((import.meta as any).env?.BASE_URL as string | undefined) || '/'

  // Remove eventuais Service Workers órfãos de firebase-messaging-sw.js para evitar conflito de escopo em /meu-treino/
  if (typeof navigator.serviceWorker.getRegistrations === 'function') {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => [])
    for (const r of regs) {
      const scriptUrl =
        r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || ''
      if (scriptUrl.includes('firebase-messaging-sw.js')) {
        await r.unregister().catch(() => {})
      }
    }
  }

  let reg = await navigator.serviceWorker.getRegistration(baseUrl).catch(() => undefined)
  if (!reg) {
    reg = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  }
  if (!reg) {
    const swUrl = `${baseUrl.replace(/\/?$/, '/')}sw.js`
    reg = await navigator.serviceWorker.register(swUrl, { scope: baseUrl })
  }
  if (reg.active) return reg
  return await navigator.serviceWorker.ready
}

export function getActiveVapidKeyPreview(): string {
  const key = (FCM_VAPID_KEY ?? '').trim()
  if (!key || key === 'COLE_SUA_CHAVE_PUBLICA_VAPID_AQUI') return 'não configurada'
  if (key.length <= 16) return key
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

export async function enablePushNotifications(
  keywordsInput = '',
): Promise<FcmTokenDoc> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    throw new Error('error: notificações Web Push não são suportadas neste navegador.')
  }
  if (isIosSafariNotInstalled()) {
    throw new Error('error: no iPhone, instale o app na tela de início para receber notificações.')
  }

  const auth = getFirebaseAuth()
  const user = auth.currentUser
  if (!user) {
    throw new Error('error: faça login na seção "sincronização em nuvem" antes de ativar notificações.')
  }

  // Deve ser chamado diretamente do gesto do usuário (exigência do iOS 16.4+)
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('error: permissão de notificação negada ou não concedida no aparelho.')
  }

  const vapidKey = (FCM_VAPID_KEY ?? '').trim()
  if (!vapidKey || vapidKey === 'COLE_SUA_CHAVE_PUBLICA_VAPID_AQUI') {
    throw new Error(
      'error: chave pública VAPID não configurada em src/assistantConfig.ts (FCM_VAPID_KEY).',
    )
  }

  const supported = await isMessagingSupported().catch(() => false)
  if (!supported) {
    throw new Error('error: Firebase Cloud Messaging não suportado neste contexto/navegador.')
  }

  const app = getApps()[0] ?? initializeApp(firebaseConfig)
  const messaging = getMessaging(app)
  const swReg = await getReadyServiceWorkerRegistration()

  // Limpa qualquer PushSubscription/token anterior (ex.: gerado com chave VAPID antiga)
  // para forçar uma nova inscrição Web Push autenticada com a FCM_VAPID_KEY atual.
  try {
    await deleteToken(messaging)
  } catch {
    // ignora caso não exista token prévio no IndexedDB
  }
  try {
    const existingSub = await swReg.pushManager?.getSubscription?.()
    if (existingSub) {
      await existingSub.unsubscribe()
    }
  } catch {
    // ignora falha ao desinscrever subscription antiga
  }

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: swReg,
  })
  if (!token) {
    throw new Error('error: não foi possível obter o token FCM do navegador.')
  }

  const docId = await computeFcmTokenDocId(user.uid, token)
  const nowIso = new Date().toISOString()
  const keywords = parseKeywordsInput(keywordsInput)
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'

  const fs = getFirebaseDb()
  const ref = doc(fs, 'fcmTokens', docId)
  const existingSnap = await getDoc(ref).catch(() => null)
  const createdAt =
    existingSnap && existingSnap.exists() && typeof existingSnap.data()?.createdAt === 'string'
      ? (existingSnap.data()!.createdAt as string)
      : nowIso

  const payload = {
    token,
    uid: user.uid,
    createdAt,
    updatedAt: nowIso,
    userAgent,
    enabled: true,
    keywords,
  }

  await setDoc(ref, payload)

  // Remove tokens antigos do mesmo usuário no Firestore para evitar que o Worker tente
  // enviar push para tokens órfãos criados com chaves VAPID anteriores (HTTP 401 Third party auth error).
  try {
    const oldTokensQuery = query(collection(fs, 'fcmTokens'), where('uid', '==', user.uid), limit(25))
    const oldSnap = await getDocs(oldTokensQuery)
    const deletions: Promise<void>[] = []
    oldSnap.forEach((dSnap) => {
      if (dSnap.id !== docId) {
        deletions.push(deleteDoc(doc(fs, 'fcmTokens', dSnap.id)).catch(() => {}))
      }
    })
    if (deletions.length > 0) {
      await Promise.all(deletions)
    }
  } catch {
    // ignora se a limpeza de tokens antigos falhar
  }

  safeSetLs(LS_FCM_TOKEN, token)
  safeSetLs(LS_FCM_DOC_ID, docId)
  await recordLastNotificationError(null)

  return {
    id: docId,
    ...payload,
  }
}

export async function loadUserFcmTokenDoc(uid: string): Promise<FcmTokenDoc | null> {
  if (!uid) return null
  const fs = getFirebaseDb()
  const savedDocId = getSavedLocalFcmDocId()
  if (savedDocId) {
    try {
      const snap = await getDoc(doc(fs, 'fcmTokens', savedDocId))
      if (snap.exists()) {
        const d = snap.data()
        if (d && d.uid === uid && typeof d.token === 'string') {
          safeSetLs(LS_FCM_TOKEN, d.token)
          return {
            id: snap.id,
            token: d.token,
            uid: d.uid,
            createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
            updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
            userAgent: typeof d.userAgent === 'string' ? d.userAgent : '',
            enabled: d.enabled !== false,
            keywords: Array.isArray(d.keywords)
              ? d.keywords.filter((x: unknown): x is string => typeof x === 'string')
              : [],
          }
        }
      }
    } catch {
      // fallback para query por uid abaixo
    }
  }

  try {
    const q = query(collection(fs, 'fcmTokens'), where('uid', '==', uid), limit(5))
    const snap = await getDocs(q)
    let first: FcmTokenDoc | null = null
    snap.forEach((docSnap) => {
      if (first) return
      const d = docSnap.data()
      if (d && typeof d.token === 'string') {
        first = {
          id: docSnap.id,
          token: d.token,
          uid: String(d.uid ?? uid),
          createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
          updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
          userAgent: typeof d.userAgent === 'string' ? d.userAgent : '',
          enabled: d.enabled !== false,
          keywords: Array.isArray(d.keywords)
            ? d.keywords.filter((x: unknown): x is string => typeof x === 'string')
            : [],
        }
      }
    })
    if (first) {
      safeSetLs(LS_FCM_DOC_ID, (first as FcmTokenDoc).id)
      safeSetLs(LS_FCM_TOKEN, (first as FcmTokenDoc).token)
    }
    return first
  } catch {
    return null
  }
}

export async function updateUserFcmSettings(
  uid: string,
  patch: { enabled?: boolean; keywords?: string[] },
): Promise<FcmTokenDoc | null> {
  const current = await loadUserFcmTokenDoc(uid)
  if (!current) {
    throw new Error('error: nenhum token registrado ainda. Toque em "$ ativar notificações" primeiro.')
  }
  const fs = getFirebaseDb()
  const nowIso = new Date().toISOString()
  const updateData: Record<string, unknown> = { updatedAt: nowIso }
  if (typeof patch.enabled === 'boolean') updateData.enabled = patch.enabled
  if (Array.isArray(patch.keywords)) updateData.keywords = patch.keywords

  await updateDoc(doc(fs, 'fcmTokens', current.id), updateData)
  return {
    ...current,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    keywords: Array.isArray(patch.keywords) ? patch.keywords : current.keywords,
    updatedAt: nowIso,
  }
}

// ---------- Chamadas autenticadas ao Worker (/push-test e /ifes/status) ----------

async function getAuthBearerToken(): Promise<string> {
  const user = getFirebaseAuth().currentUser
  if (!user) {
    throw new Error('error: faça login na seção "sincronização em nuvem" primeiro.')
  }
  return await user.getIdToken()
}

export async function triggerPushTest(): Promise<PushTestResponse> {
  const idToken = await getAuthBearerToken()
  const baseUrl = ASSISTANT_WORKER_URL.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/push-test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok) {
    const errMsg = typeof data.error === 'string' ? data.error : `error: falha no teste de push (HTTP ${res.status}).`
    await recordLastNotificationError(errMsg)
    throw new Error(errMsg)
  }
  if (typeof data.sent === 'number' && data.sent > 0) {
    await recordLastNotificationError(null)
  } else if (Array.isArray(data.results) && data.results.length > 0) {
    const firstErr = data.results.find((r: any) => !r.ok)
    if (firstErr?.reason) {
      await recordLastNotificationError(`FCM: ${firstErr.reason}`)
    }
  }
  return data as PushTestResponse
}

export async function fetchIfesWorkerStatus(): Promise<IfesWorkerStatus> {
  const idToken = await getAuthBearerToken()
  const baseUrl = ASSISTANT_WORKER_URL.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/ifes/status`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : `error: falha ao consultar status (HTTP ${res.status}).`,
    )
  }
  return {
    lastRunAt: typeof data.lastRunAt === 'string' ? data.lastRunAt : null,
    lastNewestId: typeof data.lastNewestId === 'string' ? data.lastNewestId : null,
    totalNoticias: typeof data.totalNoticias === 'number' ? data.totalNoticias : 0,
    consecutiveZeroRuns: typeof data.consecutiveZeroRuns === 'number' ? data.consecutiveZeroRuns : 0,
    lastError: typeof data.lastError === 'string' ? data.lastError : null,
    alert: typeof data.alert === 'string' ? data.alert : null,
  }
}

// ---------- Listener de notificações em primeiro plano (foreground) ----------

export function initForegroundPushListener(
  onForegroundNotification: (info: { title: string; body: string; url?: string }) => void,
): () => void {
  let unsubMessaging: (() => void) | null = null
  let cancelled = false

  ;(async () => {
    try {
      const supported = await isMessagingSupported().catch(() => false)
      if (!supported || cancelled) return
      const app = getApps()[0] ?? initializeApp(firebaseConfig)
      const messaging = getMessaging(app)
      unsubMessaging = onMessage(messaging, (payload) => {
        const title =
          payload.notification?.title ??
          payload.data?.title ??
          'Notícias do Ifes – Campus Vitória'
        const body = payload.notification?.body ?? payload.data?.body ?? ''
        const url = payload.data?.url
        void recordLastNotificationReceived(Date.now())
        onForegroundNotification({ title, body, url })
      })
    } catch {
      // ignora se FCM não estiver disponível no ambiente atual
    }
  })()

  return () => {
    cancelled = true
    unsubMessaging?.()
  }
}

// ---------- Gerenciamento de Lembretes Push (pushReminders) na UI ----------

export function formatPushReminderDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const day = get('day')
    const month = get('month')
    const hour = get('hour')
    const minute = get('minute')
    if (day && month && hour && minute) {
      return `${day}/${month} às ${hour}:${minute}`
    }
  } catch {
    // fallback abaixo
  }
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export function subscribeUserPendingPushReminders(
  uid: string,
  onItems: (items: PushReminderItem[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  if (!uid) {
    onItems([])
    return () => {}
  }
  try {
    const fs = getFirebaseDb()
    const q = query(collection(fs, 'pushReminders'), where('uid', '==', uid), limit(50))
    return onSnapshot(
      q,
      (snap) => {
        const list: PushReminderItem[] = []
        snap.forEach((docSnap) => {
          const d = docSnap.data()
          if (d && d.status === 'pending' && typeof d.title === 'string' && typeof d.triggerAt === 'string') {
            list.push({
              id: docSnap.id,
              uid: String(d.uid ?? uid),
              title: d.title,
              body: typeof d.body === 'string' ? d.body : '',
              triggerAt: d.triggerAt,
              timezone: typeof d.timezone === 'string' ? d.timezone : 'America/Sao_Paulo',
              recurrence:
                d.recurrence === 'daily' || d.recurrence === 'weekly' ? d.recurrence : 'none',
              status: 'pending',
              createdAt: typeof d.createdAt === 'string' ? d.createdAt : undefined,
              sentAt: typeof d.sentAt === 'string' ? d.sentAt : null,
              url: typeof d.url === 'string' ? d.url : undefined,
            })
          }
        })
        list.sort((a, b) => a.triggerAt.localeCompare(b.triggerAt))
        onItems(list)
      },
      (err) => {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      },
    )
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error(String(e)))
    return () => {}
  }
}

export async function cancelUserPushReminder(reminderId: string): Promise<void> {
  const id = reminderId.trim()
  if (!id) return
  const fs = getFirebaseDb()
  await updateDoc(doc(fs, 'pushReminders', id), {
    status: 'cancelled',
  })
}
