export const IFES_VITORIA_NEWS_URL = 'https://vitoria.ifes.edu.br/noticias'
export const IFES_VITORIA_RSS_URL = 'https://vitoria.ifes.edu.br/noticias?format=feed&type=rss'
export const IFES_VITORIA_ORIGIN = 'https://vitoria.ifes.edu.br'
export const PWA_APP_BASE_URL = 'https://ianrtaniguchi.github.io/meu-treino/'
export const PWA_APP_NOTICIAS_URL = 'https://ianrtaniguchi.github.io/meu-treino/?tab=noticias'
export const PWA_APP_ICON_URL = 'https://ianrtaniguchi.github.io/meu-treino/icon-192.png'
export const MAX_PUSHES_PER_RUN = 5
export const MAX_PUSH_BODY_CHARS = 120

export type PushReminderRecurrence = 'none' | 'daily' | 'weekly'
export type PushReminderStatus = 'pending' | 'sent' | 'cancelled'

export interface PushReminderDoc {
  id: string
  uid: string
  title: string
  body: string
  triggerAt: string
  timezone: string
  recurrence: PushReminderRecurrence
  status: PushReminderStatus
  createdAt: string
  sentAt: string | null
  lastSentAt?: string | null
  url: string
}

export interface IfesNewsItem {
  id: string
  title: string
  summary: string
  publishedAt: string
  url: string
}

export interface IfesMetaDoc {
  lastRunAt: string | null
  lastNewestId: string | null
  totalCount: number
  consecutiveZeroRuns: number
  lastError: string | null
  alert: string | null
}

export interface FcmTokenDoc {
  docId: string
  token: string
  uid: string
  createdAt: number
  userAgent: string
  enabled: boolean
  keywords: string[]
}

export interface ServiceAccountCredentials {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

// ---------- Utilitários de texto, HTML e URL ----------

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&quot;': '"',
  '&#039;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&ndash;': '–',
  '&mdash;': '—',
  '&aacute;': 'á',
  '&Aacute;': 'Á',
  '&agrave;': 'à',
  '&Agrave;': 'À',
  '&atilde;': 'ã',
  '&Atilde;': 'Ã',
  '&acirc;': 'â',
  '&Acirc;': 'Â',
  '&eacute;': 'é',
  '&Eacute;': 'É',
  '&ecirc;': 'ê',
  '&Ecirc;': 'Ê',
  '&iacute;': 'í',
  '&Iacute;': 'Í',
  '&oacute;': 'ó',
  '&Oacute;': 'Ó',
  '&otilde;': 'õ',
  '&Otilde;': 'Õ',
  '&ocirc;': 'ô',
  '&Ocirc;': 'Ô',
  '&uacute;': 'ú',
  '&Uacute;': 'Ú',
  '&ccedil;': 'ç',
  '&Ccedil;': 'Ç',
  '&ordf;': 'ª',
  '&ordm;': 'º',
}

export function decodeHtmlEntities(input: string): string {
  if (!input) return ''
  let s = input.replace(/&[a-zA-Z0-9#]+;/g, (entity) => {
    if (HTML_ENTITIES[entity]) return HTML_ENTITIES[entity]
    const dec = entity.match(/^&#(\d+);$/)
    if (dec) return String.fromCharCode(Number.parseInt(dec[1], 10))
    const hex = entity.match(/^&#x([0-9a-fA-F]+);$/)
    if (hex) return String.fromCharCode(Number.parseInt(hex[1], 16))
    return entity
  })
  return s
}

export function stripHtmlTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncateSummary(text: string, maxChars = MAX_PUSH_BODY_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/**
 * Garante que a URL pertence exclusivamente às notícias do Campus Vitória (`vitoria.ifes.edu.br/noticias/...`).
 */
export function isCampusVitoriaNewsUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl, IFES_VITORIA_ORIGIN)
    if (u.hostname !== 'vitoria.ifes.edu.br') return false
    return /^\/noticias\/\d+-[a-z0-9-]+/i.test(u.pathname)
  } catch {
    return false
  }
}

export function canonicalizeVitoriaUrl(rawUrl: string): string {
  const u = new URL(rawUrl, IFES_VITORIA_ORIGIN)
  u.protocol = 'https:'
  u.search = ''
  u.hash = ''
  return u.toString()
}

/**
 * Gera um ID estável para o documento a partir da URL canônica da notícia (SHA-256 hex de 20 caracteres).
 */
export async function computeNewsId(canonicalUrl: string): Promise<string> {
  const data = new TextEncoder().encode(canonicalUrl.trim())
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 10; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return `vix-${hex}`
}

/**
 * Converte data "dd/mm/aa" (ou "dd/mm/aaaa") e hora "15h16" (ou "15:16") para ISO 8601 em America/Sao_Paulo (-03:00).
 */
export function parseIfesDateTimeToIso(dateStr: string, timeStr?: string): string {
  const dm = dateStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/)
  if (!dm) {
    throw new Error(`Data inválida no Ifes: "${dateStr}"`)
  }
  const day = dm[1]
  const month = dm[2]
  const yearRaw = dm[3]
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw

  let hh = '00'
  let mm = '00'
  if (timeStr && timeStr.trim()) {
    const tm = timeStr.trim().match(/(\d{1,2})\s*[h:]\s*(\d{2})/i)
    if (tm) {
      hh = tm[1].padStart(2, '0')
      mm = tm[2].padStart(2, '0')
    }
  }
  return `${year}-${month}-${day}T${hh}:${mm}:00-03:00`
}

// ---------- Parser de HTML e RSS do Ifes Campus Vitória ----------

/**
 * Extrai notícias da listagem HTML de `https://vitoria.ifes.edu.br/noticias`
 * (blocos `<div class="tileItem">`), filtrando apenas URLs válidas do Campus Vitória.
 */
export async function parseIfesVitoriaHtml(html: string): Promise<IfesNewsItem[]> {
  if (!html || typeof html !== 'string') return []

  const items: IfesNewsItem[] = []
  const seenUrls = new Set<string>()
  const tileBlocks = html.split(/<div\s+class=["'][^"']*\btileItem\b[^"']*["'][^>]*>/i).slice(1)

  for (const rawBlock of tileBlocks) {
    const block = rawBlock.split(/<!--\s*div\.tileItem\s*-->/i)[0] ?? rawBlock

    const linkMatch = block.match(
      /<h2\s+class=["'][^"']*\btileHeadline\b[^"']*["'][^>]*>[\s\S]*?<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    )
    if (!linkMatch) continue

    const rawHref = decodeHtmlEntities(linkMatch[1].trim())
    const title = stripHtmlTags(linkMatch[2])
    if (!title || !isCampusVitoriaNewsUrl(rawHref)) continue

    const url = canonicalizeVitoriaUrl(rawHref)
    if (seenUrls.has(url)) continue

    const descMatch = block.match(
      /<span\s+class=["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    )
    const summary = descMatch ? stripHtmlTags(descMatch[1]) : ''

    const dateMatch =
      block.match(/icon-calendar[^>]*><\/i>\s*(\d{2}\/\d{2}\/\d{2,4})/i) ??
      block.match(/\b(\d{2}\/\d{2}\/\d{2,4})\b/)
    const timeMatch =
      block.match(/icon-time[^>]*><\/i>\s*(\d{1,2}h\d{2})/i) ??
      block.match(/\b(\d{1,2}h\d{2})\b/i)

    if (!dateMatch) continue
    const publishedAt = parseIfesDateTimeToIso(dateMatch[1], timeMatch?.[1])
    const id = await computeNewsId(url)

    seenUrls.add(url)
    items.push({
      id,
      title,
      summary,
      publishedAt,
      url,
    })
  }

  return items
}

/**
 * Fallback: extrai notícias do feed RSS 2.0 (`https://vitoria.ifes.edu.br/noticias?format=feed&type=rss`),
 * filtrando apenas URLs do Campus Vitória.
 */
export async function parseIfesVitoriaRss(xml: string): Promise<IfesNewsItem[]> {
  if (!xml || typeof xml !== 'string') return []
  const items: IfesNewsItem[] = []
  const seenUrls = new Set<string>()
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []

  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i)
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i)
    const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i)
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)
    if (!titleMatch || !linkMatch) continue

    const rawLink = stripHtmlTags(linkMatch[1])
    if (!isCampusVitoriaNewsUrl(rawLink)) continue

    const url = canonicalizeVitoriaUrl(rawLink)
    if (seenUrls.has(url)) continue

    const title = stripHtmlTags(titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    const rawDesc = (descMatch?.[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    const summary = stripHtmlTags(rawDesc)

    let publishedAt = new Date().toISOString()
    if (pubDateMatch) {
      const d = new Date(pubDateMatch[1].trim())
      if (!Number.isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0')
        publishedAt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00-03:00`
      }
    }

    const id = await computeNewsId(url)
    seenUrls.add(url)
    items.push({ id, title, summary, publishedAt, url })
  }

  return items
}

// ---------- Deduplicação, Filtro de Palavras-Chave e Agrupamento de Push ----------

export function selectNewNewsItems(
  extracted: IfesNewsItem[],
  existingIds: Set<string>,
): IfesNewsItem[] {
  const out: IfesNewsItem[] = []
  const seen = new Set<string>()
  for (const item of extracted) {
    if (!existingIds.has(item.id) && !seen.has(item.id)) {
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}

export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Se `keywords` estiver vazia (ou só tiver espaços), retorna `true` (usuário recebe tudo).
 * Caso contrário, retorna `true` se o título ou o resumo contiver qualquer palavra-chave (sem acento e case-insensitive).
 */
export function matchesKeywords(
  item: Pick<IfesNewsItem, 'title' | 'summary'>,
  keywords?: string[] | null,
): boolean {
  if (!keywords || keywords.length === 0) return true
  const validKeywords = keywords.map(normalizeForMatch).filter(Boolean)
  if (validKeywords.length === 0) return true
  const haystack = normalizeForMatch(`${item.title} ${item.summary}`)
  return validKeywords.some((kw) => haystack.includes(kw))
}

export interface PushNotificationPayload {
  title: string
  body: string
  url: string
  route: 'noticias' | 'assistente' | 'treino' | 'dieta' | 'corpo' | 'config'
  newsId: string
  groupedCount?: number
}

/**
 * Aplica a regra de envio:
 * - Na primeira execução (coleção vazia, `isFirstSeed === true`), retorna `[]` (não envia push para evitar spam).
 * - Filtra as novas notícias pelas `keywords` do destinatário.
 * - Se sobrarem de 1 a 5 notícias, gera 1 push por notícia (em ordem cronológica).
 * - Se sobrarem mais de 5 notícias (`N > 5`), gera 1 único push agrupado `"N novas notícias do Ifes"`.
 */
export function buildPushNotificationsForItems(
  newItems: IfesNewsItem[],
  keywords: string[] = [],
  isFirstSeed = false,
): PushNotificationPayload[] {
  if (isFirstSeed || newItems.length === 0) return []
  const matched = newItems.filter((it) => matchesKeywords(it, keywords))
  if (matched.length === 0) return []

  if (matched.length > MAX_PUSHES_PER_RUN) {
    const newest = matched[0]
    const previewTitles = matched
      .slice(0, 3)
      .map((i) => i.title)
      .join(' · ')
    return [
      {
        title: `${matched.length} novas notícias do Ifes`,
        body: truncateSummary(previewTitles || newest.title, MAX_PUSH_BODY_CHARS),
        url: newest.url,
        route: 'noticias',
        newsId: newest.id,
        groupedCount: matched.length,
      },
    ]
  }

  return matched.map((it) => ({
    title: it.title,
    body: truncateSummary(it.summary || it.title, MAX_PUSH_BODY_CHARS),
    url: it.url,
    route: 'noticias',
    newsId: it.id,
  }))
}

export function buildFcmHttpV1Message(
  fcmToken: string,
  notif: PushNotificationPayload,
): Record<string, unknown> {
  const title = String(notif.title || 'Notícias do Ifes – Campus Vitória').trim()
  const body = truncateSummary(String(notif.body || title), MAX_PUSH_BODY_CHARS)
  const httpsLink = /^https:\/\//i.test(String(notif.url || '').trim())
    ? String(notif.url).trim()
    : PWA_APP_NOTICIAS_URL
  const route = String(notif.route || 'noticias')
  const newsId = String(notif.newsId || 'ifes-noticias')

  return {
    message: {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: {
        url: httpsLink,
        route,
        newsId,
      },
      webpush: {
        headers: {
          TTL: '86400',
          Urgency: 'high',
        },
        notification: {
          title,
          body,
          icon: PWA_APP_ICON_URL,
          badge: PWA_APP_ICON_URL,
          data: {
            url: httpsLink,
            route,
            newsId,
          },
        },
        fcm_options: {
          link: httpsLink,
        },
      },
    },
  }
}

/**
 * Identifica se a resposta de erro do FCM HTTP v1 indica token inválido ou expirado:
 * SOMENTE `404 UNREGISTERED` ou `400 INVALID_ARGUMENT` (token malformado/inválido).
 */
export function isFcmTokenInvalidResponse(status: number, responseBody: unknown): boolean {
  const raw = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody ?? {})
  if (status === 404 && raw.includes('UNREGISTERED')) {
    return true
  }
  if (
    status === 400 &&
    (raw.includes('INVALID_ARGUMENT') ||
      raw.toLowerCase().includes('not a valid fcm registration token'))
  ) {
    return true
  }
  return false
}

// ---------- Assinatura JWT / OAuth2 da Service Account do Firebase via WebCrypto ----------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function strToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str))
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '')
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

export async function importServiceAccountPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToArrayBuffer(pem)
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export async function signServiceAccountJwt(
  sa: ServiceAccountCredentials,
  scopes: string[] = [
    'https://www.googleapis.com/auth/firebase.messaging',
    'https://www.googleapis.com/auth/datastore',
  ],
  nowMs = Date.now(),
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000)
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
    scope: scopes.join(' '),
  }
  const unsigned = `${strToBase64Url(JSON.stringify(header))}.${strToBase64Url(JSON.stringify(payload))}`
  const key = await importServiceAccountPrivateKey(sa.private_key)
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned) as BufferSource,
  )
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`
}

let serviceAccountTokenCache: { token: string; expiresAt: number } | null = null

export function resetIfesCachesForTest() {
  serviceAccountTokenCache = null
}

export function parseServiceAccountSecret(
  rawSecret?: string,
  expectedProjectId?: string,
): ServiceAccountCredentials {
  if (!rawSecret || !rawSecret.trim()) {
    throw new Error('Secret FCM_SERVICE_ACCOUNT não configurado no Worker.')
  }
  let parsed: any
  try {
    parsed = JSON.parse(rawSecret)
  } catch {
    throw new Error('Secret FCM_SERVICE_ACCOUNT não é um JSON válido.')
  }
  if (!parsed?.project_id || !parsed?.client_email || !parsed?.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT incompleto (exige project_id, client_email e private_key).')
  }
  const targetProject = (expectedProjectId ?? 'meu-treino-2007').trim()
  if (targetProject && String(parsed.project_id).trim() !== targetProject) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT pertence ao projeto "${parsed.project_id}", mas o projeto esperado é "${targetProject}". Gere a Service Account no projeto Firebase "${targetProject}".`,
    )
  }
  return parsed as ServiceAccountCredentials
}

export async function getServiceAccountAccessToken(
  sa: ServiceAccountCredentials,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<string> {
  if (serviceAccountTokenCache && nowMs < serviceAccountTokenCache.expiresAt) {
    return serviceAccountTokenCache.token
  }

  const assertion = await signServiceAccountJwt(
    sa,
    [
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/datastore',
    ],
    nowMs,
  )
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })

  const res = await fetcher(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    throw new Error(`Falha ao obter token OAuth2 da service account (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data?.access_token) {
    throw new Error('Resposta OAuth2 da service account sem access_token.')
  }
  const ttlSec = Math.max(60, (Number(data.expires_in) || 3600) - 60)
  serviceAccountTokenCache = {
    token: data.access_token,
    expiresAt: nowMs + ttlSec * 1000,
  }
  return data.access_token
}

// ---------- Operações REST no Firestore e FCM HTTP v1 ----------

function firestoreBaseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`
}

function encodeFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null }
    } else if (typeof v === 'string') {
      fields[k] = { stringValue: v }
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v }
    } else if (typeof v === 'number') {
      fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
    } else if (Array.isArray(v)) {
      fields[k] = {
        arrayValue: {
          values: v.map((item) => ({ stringValue: String(item) })),
        },
      }
    }
  }
  return { fields }
}

function decodeFirestoreDoc(doc: any): Record<string, any> {
  const out: Record<string, any> = {}
  const fields = doc?.fields ?? {}
  for (const [k, raw] of Object.entries<any>(fields)) {
    if (!raw || typeof raw !== 'object') continue
    if ('stringValue' in raw) out[k] = raw.stringValue
    else if ('booleanValue' in raw) out[k] = Boolean(raw.booleanValue)
    else if ('integerValue' in raw) out[k] = Number(raw.integerValue)
    else if ('doubleValue' in raw) out[k] = Number(raw.doubleValue)
    else if ('nullValue' in raw) out[k] = null
    else if ('arrayValue' in raw) {
      const vals = raw.arrayValue?.values
      out[k] = Array.isArray(vals) ? vals.map((x: any) => x?.stringValue ?? '').filter(Boolean) : []
    }
  }
  return out
}

async function readIfesMeta(
  projectId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<IfesMetaDoc> {
  const url = `${firestoreBaseUrl(projectId)}/meta/ifesNoticias`
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404 || !res.ok) {
    return {
      lastRunAt: null,
      lastNewestId: null,
      totalCount: 0,
      consecutiveZeroRuns: 0,
      lastError: null,
      alert: null,
    }
  }
  const d = decodeFirestoreDoc(await res.json())
  return {
    lastRunAt: typeof d.lastRunAt === 'string' ? d.lastRunAt : null,
    lastNewestId: typeof d.lastNewestId === 'string' ? d.lastNewestId : null,
    totalCount: typeof d.totalCount === 'number' ? d.totalCount : 0,
    consecutiveZeroRuns: typeof d.consecutiveZeroRuns === 'number' ? d.consecutiveZeroRuns : 0,
    lastError: typeof d.lastError === 'string' ? d.lastError : null,
    alert: typeof d.alert === 'string' ? d.alert : null,
  }
}

async function writeIfesMeta(
  projectId: string,
  accessToken: string,
  meta: IfesMetaDoc,
  fetcher: typeof fetch,
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}/meta/ifesNoticias`
  await fetcher(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(encodeFirestoreFields(meta as unknown as Record<string, unknown>)),
  })
}

async function listExistingNewsIds(
  projectId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<Set<string>> {
  const url = `${firestoreBaseUrl(projectId)}/ifesNoticias?pageSize=200&mask.fieldPaths=url`
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const ids = new Set<string>()
  if (!res.ok) return ids
  const data = (await res.json()) as { documents?: Array<{ name?: string }> }
  for (const doc of data.documents ?? []) {
    const parts = (doc.name ?? '').split('/')
    const id = parts[parts.length - 1]
    if (id) ids.add(id)
  }
  return ids
}

async function saveNewsItemToFirestore(
  projectId: string,
  accessToken: string,
  item: IfesNewsItem,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}/ifesNoticias/${encodeURIComponent(item.id)}`
  await fetcher(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      encodeFirestoreFields({
        id: item.id,
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        url: item.url,
        createdAt: nowMs,
      }),
    ),
  })
}

async function listFcmTokens(
  projectId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<FcmTokenDoc[]> {
  const url = `${firestoreBaseUrl(projectId)}/fcmTokens?pageSize=100`
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return []
  const data = (await res.json()) as { documents?: any[] }
  const out: FcmTokenDoc[] = []
  for (const raw of data.documents ?? []) {
    const parts = String(raw.name ?? '').split('/')
    const docId = parts[parts.length - 1]
    const d = decodeFirestoreDoc(raw)
    if (typeof d.token === 'string' && d.token) {
      out.push({
        docId,
        token: d.token,
        uid: String(d.uid ?? ''),
        createdAt: Number(d.createdAt ?? 0),
        userAgent: String(d.userAgent ?? ''),
        enabled: d.enabled !== false,
        keywords: Array.isArray(d.keywords) ? d.keywords : [],
      })
    }
  }
  return out
}

async function deleteFcmTokenDoc(
  projectId: string,
  accessToken: string,
  docId: string,
  fetcher: typeof fetch,
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}/fcmTokens/${encodeURIComponent(docId)}`
  await fetcher(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export interface FcmSendResult {
  docId: string
  tokenPreview: string
  ok: boolean
  status: number
  reason?: string
  removedInvalidToken?: boolean
}

export async function sendFcmNotificationToToken(
  projectId: string,
  accessToken: string,
  tokenDoc: FcmTokenDoc,
  notif: PushNotificationPayload,
  fetcher: typeof fetch,
): Promise<FcmSendResult> {
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
  const payload = buildFcmHttpV1Message(tokenDoc.token, notif)
  const preview = `${tokenDoc.token.slice(0, 12)}…`

  try {
    const res = await fetcher(fcmUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      return { docId: tokenDoc.docId, tokenPreview: preview, ok: true, status: res.status }
    }

    const errText = await res.text()
    console.error(
      `[fcm-error] status=${res.status} docId=${tokenDoc.docId} token=${preview} body=${errText}`,
    )
    const invalid = isFcmTokenInvalidResponse(res.status, errText)
    if (invalid && tokenDoc.docId) {
      console.warn(
        `[fcm-token-delete] Removendo token inválido docId=${tokenDoc.docId} (${preview}). Body completo: ${errText}`,
      )
      await deleteFcmTokenDoc(projectId, accessToken, tokenDoc.docId, fetcher)
    }

    let detailedReason = `HTTP ${res.status}: ${errText.slice(0, 240)}`
    try {
      const parsedErr = JSON.parse(errText) as {
        error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> }
      }
      const msg = parsedErr?.error?.message ?? ''
      const statusStr = parsedErr?.error?.status ?? ''
      const fcmCode = parsedErr?.error?.details?.find((d) => d?.errorCode)?.errorCode ?? ''
      if (res.status === 401 || fcmCode === 'THIRD_PARTY_AUTH_ERROR' || msg.includes('Third party auth error')) {
        detailedReason =
          `HTTP ${res.status}: ${msg || 'Third party auth error.'} (${statusStr || 'UNAUTHENTICATED'}) — ` +
          'Token Web Push vinculado a outra chave VAPID ou certificado VAPID divergente no Firebase Console. Toque em "$ ativar notificações" para recriar a inscrição.'
      } else if (msg) {
        detailedReason = `HTTP ${res.status}: ${msg}${statusStr ? ` (${statusStr})` : ''}`
      }
    } catch {
      // mantém detailedReason bruto
    }

    return {
      docId: tokenDoc.docId,
      tokenPreview: preview,
      ok: false,
      status: res.status,
      reason: invalid ? `Token inválido/expirado removido (${detailedReason})` : detailedReason,
      removedInvalidToken: invalid,
    }
  } catch (e) {
    return {
      docId: tokenDoc.docId,
      tokenPreview: preview,
      ok: false,
      status: 0,
      reason: (e as Error)?.message || 'Falha de rede ao chamar FCM',
    }
  }
}

// ---------- Execução do Cron (scheduled) de coleta e envio de push ----------

export interface CronRunReport {
  ok: boolean
  isFirstSeed: boolean
  extractedCount: number
  newItemsCount: number
  pushesSent: number
  invalidTokensRemoved: number
  meta: IfesMetaDoc
}

export async function runIfesCron(
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<CronRunReport> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
  const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)

  const prevMeta = await readIfesMeta(projectId, accessToken, fetcher)
  const existingIds = await listExistingNewsIds(projectId, accessToken, fetcher)
  const hadItemsBefore = existingIds.size > 0 || prevMeta.totalCount > 0

  let extracted: IfesNewsItem[] = []
  let fetchError: string | null = null

  try {
    const htmlRes = await fetcher(IFES_VITORIA_NEWS_URL, {
      headers: { 'User-Agent': 'MeuTreino-IfesBot/1.0 (+https://ianrtaniguchi.github.io)' },
    })
    if (htmlRes.ok) {
      const html = await htmlRes.text()
      extracted = await parseIfesVitoriaHtml(html)
    } else {
      fetchError = `HTTP ${htmlRes.status} ao buscar HTML do Ifes`
    }
  } catch (e) {
    fetchError = `Erro ao buscar HTML do Ifes: ${(e as Error).message}`
  }

  // Fallback automático para o feed RSS do Campus Vitória se o HTML retornar 0 itens
  if (extracted.length === 0) {
    try {
      const rssRes = await fetcher(IFES_VITORIA_RSS_URL, {
        headers: { 'User-Agent': 'MeuTreino-IfesBot/1.0 (+https://ianrtaniguchi.github.io)' },
      })
      if (rssRes.ok) {
        const xml = await rssRes.text()
        extracted = await parseIfesVitoriaRss(xml)
        if (extracted.length > 0) fetchError = null
      }
    } catch (e) {
      if (!fetchError) fetchError = `Erro ao buscar RSS do Ifes: ${(e as Error).message}`
    }
  }

  // Tolerância a falhas: se retornou 0 itens (ou erro de rede/HTML alterado) quando antes havia itens
  if (extracted.length === 0) {
    const nextZeroRuns = prevMeta.consecutiveZeroRuns + 1
    const errMsg = fetchError || (hadItemsBefore ? 'Parser retornou 0 itens da página do Ifes.' : 'Nenhum item extraído.')
    const alertMsg =
      nextZeroRuns >= 3
        ? `Alerta: coletor do Ifes retornou 0 itens por ${nextZeroRuns} execuções seguidas. Verifique se o HTML de vitoria.ifes.edu.br/noticias mudou.`
        : prevMeta.alert
    const nextMeta: IfesMetaDoc = {
      ...prevMeta,
      lastRunAt: nowIso,
      consecutiveZeroRuns: nextZeroRuns,
      lastError: errMsg,
      alert: alertMsg,
    }
    await writeIfesMeta(projectId, accessToken, nextMeta, fetcher)
    return {
      ok: false,
      isFirstSeed: false,
      extractedCount: 0,
      newItemsCount: 0,
      pushesSent: 0,
      invalidTokensRemoved: 0,
      meta: nextMeta,
    }
  }

  const isFirstSeed = existingIds.size === 0 && prevMeta.lastRunAt === null
  const newItems = selectNewNewsItems(extracted, existingIds)

  // Grava apenas as notícias que ainda não existiam na coleção ifesNoticias
  for (const item of newItems) {
    await saveNewsItemToFirestore(projectId, accessToken, item, nowMs, fetcher)
  }

  let pushesSent = 0
  let invalidTokensRemoved = 0

  // Envia push apenas se NÃO for a primeira execução (seed inicial) e houver notícias novas
  if (!isFirstSeed && newItems.length > 0) {
    const tokens = (await listFcmTokens(projectId, accessToken, fetcher)).filter((t) => t.enabled)
    for (const tokenDoc of tokens) {
      const payloads = buildPushNotificationsForItems(newItems, tokenDoc.keywords, false)
      for (const notif of payloads) {
        const sendRes = await sendFcmNotificationToToken(projectId, accessToken, tokenDoc, notif, fetcher)
        if (sendRes.ok) pushesSent++
        if (sendRes.removedInvalidToken) {
          invalidTokensRemoved++
          break
        }
      }
    }
  }

  const nextMeta: IfesMetaDoc = {
    lastRunAt: nowIso,
    lastNewestId: extracted[0]?.id ?? prevMeta.lastNewestId,
    totalCount: existingIds.size + newItems.length,
    consecutiveZeroRuns: 0,
    lastError: null,
    alert: null,
  }
  await writeIfesMeta(projectId, accessToken, nextMeta, fetcher)

  return {
    ok: true,
    isFirstSeed,
    extractedCount: extracted.length,
    newItemsCount: newItems.length,
    pushesSent,
    invalidTokensRemoved,
    meta: nextMeta,
  }
}

export async function getIfesStatusReport(
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
  const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)
  const meta = await readIfesMeta(projectId, accessToken, fetcher)
  const existingIds = await listExistingNewsIds(projectId, accessToken, fetcher)
  return {
    lastRunAt: meta.lastRunAt,
    lastNewestId: meta.lastNewestId,
    totalNoticias: Math.max(meta.totalCount, existingIds.size),
    consecutiveZeroRuns: meta.consecutiveZeroRuns,
    lastError: meta.lastError,
    alert: meta.alert,
  }
}

export async function sendTestPushToUserTokens(
  uid: string,
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<{
  status: string
  uid: string
  totalTokens: number
  sent: number
  failed: number
  results: FcmSendResult[]
}> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
  const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)

  const allTokens = await listFcmTokens(projectId, accessToken, fetcher)
  const userTokens = allTokens.filter((t) => t.uid === uid)

  const testPayload: PushNotificationPayload = {
    title: 'Teste de notificação do app',
    body: 'Notificações das notícias do Ifes Campus Vitória estão ativas neste aparelho.',
    url: PWA_APP_NOTICIAS_URL,
    route: 'noticias',
    newsId: 'test-push',
  }

  const results: FcmSendResult[] = []
  let sent = 0
  let failed = 0
  for (const tokenDoc of userTokens) {
    const r = await sendFcmNotificationToToken(projectId, accessToken, tokenDoc, testPayload, fetcher)
    if (r.ok) sent++
    else failed++
    results.push(r)
  }

  return {
    status: 'ok',
    uid,
    totalTokens: userTokens.length,
    sent,
    failed,
    results,
  }
}

// ---------- Lembretes Push (pushReminders): normalização de datas, CRUD e disparo no Cron ----------

const VALID_RECURRENCES = new Set<PushReminderRecurrence>(['none', 'daily', 'weekly'])

export function normalizeReminderRecurrence(raw?: unknown): PushReminderRecurrence {
  const s = typeof raw === 'string' ? (raw.trim().toLowerCase() as PushReminderRecurrence) : 'none'
  return VALID_RECURRENCES.has(s) ? s : 'none'
}

/**
 * Converte data/hora (ISO 8601 com ou sem offset, ou "AAAA-MM-DD HH:MM") interpretada em
 * America/Sao_Paulo (UTC-3) para string ISO 8601 em UTC (ex.: "2026-11-26T21:00:00.000Z").
 */
export function normalizeReminderTriggerAtUtc(rawDateTime: string): string {
  const s = String(rawDateTime ?? '').trim()
  if (!s) {
    throw new Error('Data/hora do lembrete ausente.')
  }
  let normalized = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '$1T$2')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T09:00:00-03:00`
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    normalized = `${normalized}:00-03:00`
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalized)) {
    normalized = `${normalized}-03:00`
  }
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Data/hora inválida para o lembrete: "${rawDateTime}"`)
  }
  return d.toISOString()
}

/**
 * Avança o `triggerAt` de um lembrete recorrente ("daily" = +1 dia, "weekly" = +7 dias),
 * mantendo o mesmo horário em America/Sao_Paulo (UTC-3 fixo) e garantindo que o próximo
 * disparo fique no futuro em relação a `nowMs`.
 */
export function computeNextReminderTriggerAtUtc(
  currentTriggerAtIso: string,
  recurrence: PushReminderRecurrence,
  nowMs = Date.now(),
): string {
  const baseMs = Date.parse(currentTriggerAtIso)
  if (Number.isNaN(baseMs)) {
    throw new Error(`triggerAt inválido: "${currentTriggerAtIso}"`)
  }
  const stepMs =
    recurrence === 'weekly'
      ? 7 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000
  let nextMs = baseMs + stepMs
  while (nextMs <= nowMs) {
    nextMs += stepMs
  }
  return new Date(nextMs).toISOString()
}

function generateReminderId(nowMs = Date.now()): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rem_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  }
  return `rem_${nowMs.toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function mapRawToPushReminderDoc(docId: string, d: Record<string, any>): PushReminderDoc {
  return {
    id: docId,
    uid: String(d.uid ?? ''),
    title: String(d.title ?? '(sem título)'),
    body: typeof d.body === 'string' ? d.body : '',
    triggerAt: String(d.triggerAt ?? ''),
    timezone: typeof d.timezone === 'string' && d.timezone ? d.timezone : 'America/Sao_Paulo',
    recurrence: normalizeReminderRecurrence(d.recurrence),
    status:
      d.status === 'sent' || d.status === 'cancelled' || d.status === 'pending'
        ? d.status
        : 'pending',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
    sentAt: typeof d.sentAt === 'string' ? d.sentAt : null,
    lastSentAt: typeof d.lastSentAt === 'string' ? d.lastSentAt : null,
    url: typeof d.url === 'string' && /^https:\/\//i.test(d.url) ? d.url : PWA_APP_BASE_URL,
  }
}

async function resolveFirestoreAuthBearer(
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  userIdToken: string | undefined,
  fetcher: typeof fetch,
  nowMs: number,
): Promise<{ projectId: string; bearerToken: string }> {
  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  if (userIdToken && userIdToken.trim()) {
    return { projectId, bearerToken: userIdToken.trim() }
  }
  const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
  const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)
  return { projectId, bearerToken: accessToken }
}

async function listPushRemindersFromFirestore(
  projectId: string,
  bearerToken: string,
  fetcher: typeof fetch,
): Promise<PushReminderDoc[]> {
  const url = `${firestoreBaseUrl(projectId)}/pushReminders?pageSize=200`
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
  if (!res.ok) return []
  const data = (await res.json()) as { documents?: any[] }
  const out: PushReminderDoc[] = []
  for (const raw of data.documents ?? []) {
    const parts = String(raw.name ?? '').split('/')
    const docId = parts[parts.length - 1]
    const d = decodeFirestoreDoc(raw)
    if (docId && d.uid && d.title && d.triggerAt) {
      out.push(mapRawToPushReminderDoc(docId, d))
    }
  }
  return out
}

async function writePushReminderToFirestore(
  projectId: string,
  bearerToken: string,
  reminder: PushReminderDoc,
  fetcher: typeof fetch,
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}/pushReminders/${encodeURIComponent(reminder.id)}`
  const res = await fetcher(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      encodeFirestoreFields({
        uid: reminder.uid,
        title: reminder.title,
        body: reminder.body,
        triggerAt: reminder.triggerAt,
        timezone: reminder.timezone,
        recurrence: reminder.recurrence,
        status: reminder.status,
        createdAt: reminder.createdAt,
        sentAt: reminder.sentAt,
        lastSentAt: reminder.lastSentAt ?? null,
        url: reminder.url,
      }),
    ),
  })
  if (!res.ok) {
    throw new Error(`Erro ao salvar lembrete no Firestore (HTTP ${res.status}).`)
  }
}

export async function create_push_reminder(
  params: {
    title?: string
    titulo?: string
    body?: string
    descricao?: string
    dateTime?: string
    triggerAt?: string
    inicio?: string
    recurrence?: string
    timezone?: string
    url?: string
  },
  uid: string,
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number; userIdToken?: string } = {},
): Promise<Record<string, unknown>> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const title = String(params.title ?? params.titulo ?? '').trim()
  const rawDt = String(params.dateTime ?? params.triggerAt ?? params.inicio ?? '').trim()
  if (!title || !rawDt) {
    throw new Error('Título (title) e data/hora (dateTime) são obrigatórios para create_push_reminder.')
  }

  const triggerAt = normalizeReminderTriggerAtUtc(rawDt)
  const recurrence = normalizeReminderRecurrence(params.recurrence)
  const body = String(params.body ?? params.descricao ?? '').trim()
  const timezone =
    typeof params.timezone === 'string' && params.timezone.trim()
      ? params.timezone.trim()
      : 'America/Sao_Paulo'
  const url =
    typeof params.url === 'string' && /^https:\/\//i.test(params.url.trim())
      ? params.url.trim()
      : PWA_APP_BASE_URL

  const { projectId, bearerToken } = await resolveFirestoreAuthBearer(
    env,
    deps.userIdToken,
    fetcher,
    nowMs,
  )

  const reminder: PushReminderDoc = {
    id: generateReminderId(nowMs),
    uid,
    title: title.slice(0, 200),
    body: body.slice(0, 1000),
    triggerAt,
    timezone,
    recurrence,
    status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    sentAt: null,
    lastSentAt: null,
    url,
  }

  await writePushReminderToFirestore(projectId, bearerToken, reminder, fetcher)

  return {
    status: 'created',
    reminder,
  }
}

export async function list_push_reminders(
  _params: Record<string, unknown>,
  uid: string,
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number; userIdToken?: string } = {},
): Promise<Record<string, unknown>> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const { projectId, bearerToken } = await resolveFirestoreAuthBearer(
    env,
    deps.userIdToken,
    fetcher,
    nowMs,
  )

  const all = await listPushRemindersFromFirestore(projectId, bearerToken, fetcher)
  const pending = all
    .filter((r) => r.uid === uid && r.status === 'pending')
    .sort((a, b) => a.triggerAt.localeCompare(b.triggerAt))

  return {
    status: 'listed',
    reminders: pending,
  }
}

export async function cancel_push_reminder(
  params: { id?: string; title?: string; titulo?: string },
  uid: string,
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number; userIdToken?: string } = {},
): Promise<Record<string, unknown>> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const targetId = String(params.id ?? '').trim()
  const targetTitle = String(params.title ?? params.titulo ?? '').trim()
  if (!targetId && !targetTitle) {
    throw new Error('Informe o "id" ou o "title" do lembrete para cancel_push_reminder.')
  }

  const { projectId, bearerToken } = await resolveFirestoreAuthBearer(
    env,
    deps.userIdToken,
    fetcher,
    nowMs,
  )

  const all = await listPushRemindersFromFirestore(projectId, bearerToken, fetcher)
  const userPending = all.filter((r) => r.uid === uid && r.status === 'pending')

  let found: PushReminderDoc | undefined
  if (targetId) {
    found = userPending.find((r) => r.id === targetId) ?? all.find((r) => r.uid === uid && r.id === targetId)
  }
  if (!found && targetTitle) {
    const q = normalizeForMatch(targetTitle)
    found =
      userPending.find((r) => normalizeForMatch(r.title) === q) ??
      userPending.find((r) => normalizeForMatch(r.title).includes(q))
  }

  if (!found) {
    throw new Error(
      targetId
        ? `Lembrete "${targetId}" não encontrado.`
        : `Nenhum lembrete pendente encontrado com o título "${targetTitle}".`,
    )
  }

  const cancelled: PushReminderDoc = {
    ...found,
    status: 'cancelled',
  }
  await writePushReminderToFirestore(projectId, bearerToken, cancelled, fetcher)

  return {
    status: 'cancelled',
    reminder: cancelled,
  }
}

export async function executePushReminderTool(
  toolName: string,
  args: Record<string, unknown>,
  uid: string,
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number; userIdToken?: string } = {},
): Promise<Record<string, unknown>> {
  try {
    if (toolName === 'create_push_reminder') {
      return await create_push_reminder(args as any, uid, env, deps)
    }
    if (toolName === 'list_push_reminders') {
      return await list_push_reminders(args, uid, env, deps)
    }
    if (toolName === 'cancel_push_reminder') {
      return await cancel_push_reminder(args as any, uid, env, deps)
    }
    return { error: `Ferramenta de lembrete desconhecida: ${toolName}` }
  } catch (e) {
    return { error: (e as Error).message || 'Erro ao processar lembrete push.' }
  }
}

export interface ProcessRemindersReport {
  checkedCount: number
  dueCount: number
  pushesSent: number
  completedCount: number
  rescheduledCount: number
}

/**
 * Executado pelo Cron do Worker: busca todos os lembretes `pending` com `triggerAt <= now`,
 * dispara o Web Push via FCM HTTP v1 para os tokens ativos do respectivo `uid`, e atualiza
 * `status = "sent"` (ou avança `triggerAt` se `recurrence` for `"daily"` ou `"weekly"`).
 */
export async function processDuePushReminders(
  env: { FCM_SERVICE_ACCOUNT?: string; FIREBASE_PROJECT_ID?: string },
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<ProcessRemindersReport> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
  const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)

  const allReminders = await listPushRemindersFromFirestore(projectId, accessToken, fetcher)
  const pendingReminders = allReminders.filter((r) => r.status === 'pending')
  const dueReminders = pendingReminders.filter((r) => {
    const ts = Date.parse(r.triggerAt)
    return Number.isFinite(ts) && ts <= nowMs
  })

  if (dueReminders.length === 0) {
    return {
      checkedCount: pendingReminders.length,
      dueCount: 0,
      pushesSent: 0,
      completedCount: 0,
      rescheduledCount: 0,
    }
  }

  const allTokens = (await listFcmTokens(projectId, accessToken, fetcher)).filter((t) => t.enabled)

  let pushesSent = 0
  let completedCount = 0
  let rescheduledCount = 0

  for (const reminder of dueReminders) {
    const userTokens = allTokens.filter((t) => t.uid === reminder.uid)
    const notifPayload: PushNotificationPayload = {
      title: `Lembrete: ${reminder.title}`,
      body: reminder.body || reminder.title,
      url: reminder.url || PWA_APP_BASE_URL,
      route: 'assistente',
      newsId: reminder.id,
    }

    for (const tokenDoc of userTokens) {
      const sendRes = await sendFcmNotificationToToken(
        projectId,
        accessToken,
        tokenDoc,
        notifPayload,
        fetcher,
      )
      if (sendRes.ok) pushesSent++
    }

    if (reminder.recurrence === 'daily' || reminder.recurrence === 'weekly') {
      const nextTriggerAt = computeNextReminderTriggerAtUtc(
        reminder.triggerAt,
        reminder.recurrence,
        nowMs,
      )
      await writePushReminderToFirestore(
        projectId,
        accessToken,
        {
          ...reminder,
          triggerAt: nextTriggerAt,
          sentAt: nowIso,
          lastSentAt: nowIso,
          status: 'pending',
        },
        fetcher,
      )
      rescheduledCount++
    } else {
      await writePushReminderToFirestore(
        projectId,
        accessToken,
        {
          ...reminder,
          status: 'sent',
          sentAt: nowIso,
        },
        fetcher,
      )
      completedCount++
    }
  }

  return {
    checkedCount: pendingReminders.length,
    dueCount: dueReminders.length,
    pushesSent,
    completedCount,
    rescheduledCount,
  }
}
