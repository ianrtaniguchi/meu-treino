import {
  executePushReminderTool,
  getIfesStatusReport,
  getServiceAccountAccessToken,
  parseServiceAccountSecret,
  processDuePushReminders,
  resetIfesCachesForTest,
  runIfesCron,
  sendTestPushToUserTokens,
} from './ifes'
import { handleCeturbProxyRequest, resetCeturbCachesForTest } from './ceturb'

export const DEFAULT_OWNER_UID = 'tH4A7sYnH1WDUdBVDd1mfltMPdj2'
export const OWNER_DAILY_MSG_LIMIT = 150
export const OWNER_DAILY_PHOTO_LIMIT = 30
export const SECONDARY_DAILY_MSG_LIMIT = 40
export const SECONDARY_DAILY_PHOTO_LIMIT = 10
const CALENDAR_TOOL_NAMES = new Set([
  'criar_evento',
  'listar_eventos',
  'editar_evento',
  'apagar_evento',
])

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface Env {
  /** Segredo opcional definido via `wrangler secret put GROQ_API_KEY` (se ausente, lê do Firestore) */
  GROQ_API_KEY?: string
  /** Modelo principal forçado pelo Worker (padrão: "openai/gpt-oss-120b") */
  GROQ_MODEL?: string
  /** Modelo de fallback caso o principal retorne 404, modelo indisponível ou 5xx */
  GROQ_FALLBACK_MODEL?: string
  /** Esforço de raciocínio para modelos gpt-oss ("low" | "medium" | "high") */
  GROQ_REASONING_EFFORT?: string
  /** Modelo com visão usado em /analyze-meal (padrão: "qwen/qwen3.6-27b") */
  GROQ_VISION_MODEL?: string
  /** ID do projeto Firebase (padrão: "meu-treino-2007") */
  FIREBASE_PROJECT_ID?: string
  /** UID do proprietário (dono da agenda Google Calendar e cota de 150 msgs / 30 fotos) */
  OWNER_UID?: string
  /** UID autorizado (legado) ou lista em ALLOWED_UIDS */
  ALLOWED_UID?: string
  /** Lista explícita de UIDs autorizados separados por vírgula (sem "*") */
  ALLOWED_UIDS?: string
  /** Origens permitidas no CORS separadas por vírgula */
  ALLOWED_ORIGINS?: string
  /** Limite por minuto por UID (padrão: "20") */
  RATE_LIMIT_PER_MIN?: string
  /** Binding opcional de Rate Limiting da Cloudflare */
  RATE_LIMITER?: RateLimiterBinding
  /** Binding opcional de Workers KV para rate limiting distribuído */
  RATE_LIMIT_KV?: KVNamespaceLike
  /** Secrets do Google Calendar OAuth 2.0 (opcionais; se faltarem, só a agenda retorna erro claro) */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_REFRESH_TOKEN?: string
  /** JSON completo da Service Account do Firebase (usado no cron de notícias do Ifes e no envio de Web Push via FCM HTTP v1) */
  FCM_SERVICE_ACCOUNT?: string
}

export const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
export const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const DEFAULT_TRANSCRIBE_MODEL = 'whisper-large-v3-turbo'
export const MAX_AUDIO_BODY_BYTES = 10 * 1024 * 1024 // 10 MB
export const MIN_AUDIO_FILE_BYTES = 256
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_CALENDAR_EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'
export const CALENDAR_TIMEZONE = 'America/Sao_Paulo'

export const MAX_BODY_BYTES = 64 * 1024 // 64 KB
/** Limite do corpo da rota /analyze-meal (foto do prato já reduzida no cliente, em data URL base64) */
export const MAX_IMAGE_BODY_BYTES = 1_500_000
export const DEFAULT_VISION_MODEL = 'qwen/qwen3.6-27b'
const MEAL_IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const MEAL_ANALYSIS_PROMPT = `Você é um nutricionista. Analise a foto do prato e estime os alimentos visíveis e a porção de cada um.
Responda APENAS com JSON válido, sem texto antes ou depois, exatamente neste formato:
{"itens":[{"nome":"","gramas":0,"kcal":0,"proteina_g":0,"carbo_g":0,"gordura_g":0,"confianca":"alta|media|baixa"}]}
Regras: nomes em português do Brasil; valores numéricos (não strings) para a porção total visível de cada item; "confianca" deve ser "alta", "media" ou "baixa". Se a imagem não tiver comida, responda {"itens":[]}.`
const FACULTY_SCHEDULE_ANALYSIS_PROMPT = `Leia a grade de horários das aulas na imagem. Não invente dados ilegíveis; use strings vazias para campos ausentes e null para professor ausente.
Responda APENAS com JSON válido, sem texto antes ou depois, exatamente neste formato:
{"aulas":[{"disciplina":"","dia":"segunda-feira","inicio":"08:00","fim":"10:00","sala":"","professor":null}]}
Use o nome do dia em português, horário 24h HH:mm, e inclua uma aula por linha/horário visível. Se não houver aulas legíveis, responda {"aulas":[]}.`
export const MAX_MESSAGES = 40
export const MAX_MESSAGE_CHARS = 12_000
export const MAX_TOKENS_CEILING = 1_024
export const DEFAULT_MAX_TOKENS = 800
export const DEFAULT_MODEL = 'openai/gpt-oss-120b'
export const DEFAULT_FALLBACK_MODEL = 'llama-3.3-70b-versatile'
export const DEFAULT_REASONING_EFFORT = 'medium'
export const FIRESTORE_KEY_CACHE_TTL_MS = 5 * 60_000 // 5 minutos

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

const ALLOWED_TOP_FIELDS = new Set([
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'max_tokens',
  'stream',
  'calendar_action',
  'reminder_action',
])

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

// ---------- Cache de JWKS do Google e Cache da chave por UID (5 min) ----------

interface CachedJwks {
  keys: JsonWebKeyWithKid[]
  expiresAt: number
}

export interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string
}

let jwksCache: CachedJwks | null = null
const memoryRateBuckets = new Map<string, { count: number; windowStartMs: number }>()
const memoryDailyQuotaBuckets = new Map<string, number>()
let googleAccessTokenCache: { accessToken: string; expiresAt: number } | null = null

export function resetWorkerCachesForTest() {
  jwksCache = null
  memoryRateBuckets.clear()
  memoryDailyQuotaBuckets.clear()
  googleAccessTokenCache = null
  resetIfesCachesForTest()
  resetCeturbCachesForTest()
}

/**
 * Verifica se o `uid` pertence ao proprietário principal (`OWNER_UID`).
 * Apenas o proprietário tem acesso às ferramentas do Google Calendar e à cota ampliada (150 msgs / 30 fotos).
 */
export function isOwnerUid(uid: string | undefined, env: Env): boolean {
  const cleanUid = (uid ?? '').trim()
  if (!cleanUid) return false
  const owner = (env.OWNER_UID ?? env.ALLOWED_UID?.split(',')[0] ?? DEFAULT_OWNER_UID).trim()
  if (!owner || owner === '*' || owner === '[SEU_UID]' || owner === '[COLE_SEU_UID_AQUI]') {
    return false
  }
  return cleanUid === owner
}

/**
 * Verifica se o `uid` extraído do JWT do Firebase Auth está na lista explícita `ALLOWED_UIDS` / `ALLOWED_UID`.
 * Recusa curingas (`"*"`, `"any"`), strings vazias e placeholders não configurados.
 */
export function isUidAllowed(uid: string | undefined, env: Env): uid is string {
  const cleanUid = (uid ?? '').trim()
  if (!cleanUid || cleanUid === '*' || cleanUid.toLowerCase() === 'any') return false

  const rawSource =
    env.ALLOWED_UIDS !== undefined
      ? env.ALLOWED_UIDS
      : env.ALLOWED_UID !== undefined
        ? env.ALLOWED_UID
        : ''
  const raw = String(rawSource ?? '').trim()
  if (!raw) return false

  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(
      (s) =>
        Boolean(s) &&
        s !== '*' &&
        s.toLowerCase() !== 'any' &&
        s !== '[SEU_UID]' &&
        s !== '[COLE_SEU_UID_AQUI]',
    )

  if (tokens.length === 0) return false
  return tokens.includes(cleanUid)
}

// ---------- Validação da chave do Groq (exclusivamente via secret GROQ_API_KEY do Worker) ----------

/**
 * Valida o formato da chave do Groq:
 * começa com "gsk_", tamanho razoável (20 a 200 caracteres), sem espaços em branco.
 */
export function isValidGroqApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value.startsWith('gsk_')) return false
  if (value.length < 20 || value.length > 200) return false
  if (/\s/.test(value)) return false
  return /^gsk_[A-Za-z0-9_-]+$/.test(value)
}

export function buildFirestoreUserDocUrl(projectId: string, uid: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`
}

/**
 * Resolve a chave do Groq exclusivamente a partir do secret `env.GROQ_API_KEY` do Worker.
 * Não lê mais `groqApiKey` do Firestore.
 */
function resolveGroqApiKey(env: Env): string {
  const secretKey = env.GROQ_API_KEY?.trim()
  if (!secretKey || !isValidGroqApiKey(secretKey)) {
    throw new Error('chave do assistente não configurada')
  }
  return secretKey
}

// ---------- JWKS do Google ----------

function parseMaxAgeSeconds(cacheControl: string | null): number {
  if (!cacheControl) return 3600
  const m = cacheControl.match(/max-age=(\d+)/i)
  if (!m) return 3600
  const sec = Number.parseInt(m[1], 10)
  return Number.isFinite(sec) && sec > 0 ? sec : 3600
}

async function getGoogleJwks(
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<JsonWebKeyWithKid[]> {
  if (jwksCache && nowMs < jwksCache.expiresAt) {
    return jwksCache.keys
  }
  const res = await fetcher(GOOGLE_JWKS_URL)
  if (!res.ok) {
    throw new Error('Falha ao obter chaves públicas de verificação.')
  }
  const ttlSec = parseMaxAgeSeconds(res.headers.get('cache-control'))
  const body = (await res.json()) as { keys?: JsonWebKeyWithKid[] }
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('Formato de JWKS inválido.')
  }
  jwksCache = {
    keys: body.keys,
    expiresAt: nowMs + ttlSec * 1000,
  }
  return jwksCache.keys
}

// ---------- Decodificação e verificação RS256 do Firebase ID Token ----------

function base64UrlToUint8Array(b64url: string): Uint8Array {
  const pad = '==='.slice((b64url.length + 3) % 4)
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJwtSegment<T>(seg: string): T {
  const bytes = base64UrlToUint8Array(seg)
  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json) as T
}

interface JwtHeader {
  alg?: string
  kid?: string
  typ?: string
}

export interface FirebaseJwtPayload {
  iss?: string
  aud?: string
  sub?: string
  exp?: number
  iat?: number
  auth_time?: number
}

export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<FirebaseJwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Token JWT malformado.')
  }

  let header: JwtHeader
  let payload: FirebaseJwtPayload
  try {
    header = decodeJwtSegment<JwtHeader>(parts[0])
    payload = decodeJwtSegment<FirebaseJwtPayload>(parts[1])
  } catch {
    throw new Error('Cabeçalho ou payload do JWT inválido.')
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Algoritmo ou kid do JWT inválido.')
  }

  const nowSec = Math.floor(nowMs / 1000)
  const expectedIss = `https://securetoken.google.com/${projectId}`

  if (payload.iss !== expectedIss) {
    throw new Error('Emissor (iss) do token inválido.')
  }
  if (payload.aud !== projectId) {
    throw new Error('Audiência (aud) do token inválida.')
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Token expirado.')
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 60) {
    throw new Error('Timestamp de emissão (iat) inválido.')
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    throw new Error('Subject (sub) ausente no token.')
  }

  const keys = await getGoogleJwks(fetcher, nowMs)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    throw new Error('Chave pública (kid) não encontrada no JWKS.')
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64UrlToUint8Array(parts[2])

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature as BufferSource,
    signedData as BufferSource,
  )
  if (!valid) {
    throw new Error('Assinatura do token inválida.')
  }

  return payload
}

// ---------- Rate Limiting simples por UID ----------

async function checkRateLimit(uid: string, env: Env, nowMs = Date.now()): Promise<boolean> {
  if (env.RATE_LIMITER) {
    const res = await env.RATE_LIMITER.limit({ key: uid })
    return res.success
  }

  const maxPerMin = Math.max(1, Number.parseInt(env.RATE_LIMIT_PER_MIN ?? '20', 10) || 20)
  const minuteBucket = Math.floor(nowMs / 60_000)

  if (env.RATE_LIMIT_KV) {
    const kvKey = `rl:${uid}:${minuteBucket}`
    const raw = await env.RATE_LIMIT_KV.get(kvKey)
    const count = raw ? Number.parseInt(raw, 10) || 0 : 0
    if (count >= maxPerMin) return false
    await env.RATE_LIMIT_KV.put(kvKey, String(count + 1), { expirationTtl: 120 })
    return true
  }

  const existing = memoryRateBuckets.get(uid)
  if (!existing || nowMs - existing.windowStartMs >= 60_000) {
    memoryRateBuckets.set(uid, { count: 1, windowStartMs: nowMs })
    return true
  }
  if (existing.count >= maxPerMin) {
    return false
  }
  existing.count += 1
  return true
}

export type DailyQuotaKind = 'msg' | 'photo'

export function formatSaoPauloDayKey(nowMs = Date.now()): string {
  // America/Sao_Paulo é UTC-3 fixo
  const spDate = new Date(nowMs - 3 * 3600_000)
  return spDate.toISOString().slice(0, 10)
}

export function getDailyQuotaLimit(uid: string, kind: DailyQuotaKind, env: Env): number {
  const owner = isOwnerUid(uid, env)
  if (kind === 'photo') {
    return owner ? OWNER_DAILY_PHOTO_LIMIT : SECONDARY_DAILY_PHOTO_LIMIT
  }
  return owner ? OWNER_DAILY_MSG_LIMIT : SECONDARY_DAILY_MSG_LIMIT
}

export function buildFirestoreQuotaDocUrl(
  projectId: string,
  uid: string,
  dayKey: string,
  kind: DailyQuotaKind,
): string {
  const docId = `${uid}_${dayKey}_${kind}`
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/usageQuotas/${encodeURIComponent(docId)}`
}

/**
 * Verifica e incrementa a cota diária por UID (`msg` ou `photo`):
 * 1) Se `env.RATE_LIMIT_KV` (Workers KV) estiver vinculado, persiste em `quota:{kind}:{uid}:{YYYY-MM-DD}` (TTL 48h).
 * 2) Caso contrário, se `env.FCM_SERVICE_ACCOUNT` estiver configurado, persiste no Firestore em
 *    `usageQuotas/{uid}_{YYYY-MM-DD}_{kind}` via REST API com o token OAuth2 da Service Account.
 * 3) Em testes unitários sem KV nem Service Account, usa o mapa de teste `memoryDailyQuotaBuckets`.
 */
export async function checkAndConsumeDailyQuota(
  uid: string,
  kind: DailyQuotaKind,
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<{ allowed: boolean; limit: number; used: number }> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()
  const dayKey = formatSaoPauloDayKey(nowMs)
  const limit = getDailyQuotaLimit(uid, kind, env)
  const kvKey = `quota:${kind}:${uid}:${dayKey}`

  // 1. Workers KV
  if (env.RATE_LIMIT_KV) {
    const raw = await env.RATE_LIMIT_KV.get(kvKey)
    const count = raw ? Number.parseInt(raw, 10) || 0 : 0
    if (count >= limit) {
      return { allowed: false, limit, used: count }
    }
    await env.RATE_LIMIT_KV.put(kvKey, String(count + 1), { expirationTtl: 172_800 })
    return { allowed: true, limit, used: count + 1 }
  }

  // 2. Firestore (coleção usageQuotas via FCM_SERVICE_ACCOUNT)
  if (env.FCM_SERVICE_ACCOUNT && env.FCM_SERVICE_ACCOUNT.trim()) {
    const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
    const sa = parseServiceAccountSecret(env.FCM_SERVICE_ACCOUNT, projectId)
    const accessToken = await getServiceAccountAccessToken(sa, fetcher, nowMs)
    const docUrl = buildFirestoreQuotaDocUrl(projectId, uid, dayKey, kind)

    let count = 0
    const getRes = await fetcher(docUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
    if (getRes.ok) {
      const docJson = (await getRes.json()) as {
        fields?: { count?: { integerValue?: string; doubleValue?: number } }
      }
      const rawInt = docJson?.fields?.count?.integerValue
      const rawDbl = docJson?.fields?.count?.doubleValue
      count =
        rawInt !== undefined
          ? Number.parseInt(String(rawInt), 10) || 0
          : typeof rawDbl === 'number'
            ? rawDbl
            : 0
    }

    if (count >= limit) {
      return { allowed: false, limit, used: count }
    }

    const nextCount = count + 1
    await fetcher(docUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: uid },
          day: { stringValue: dayKey },
          kind: { stringValue: kind },
          count: { integerValue: String(nextCount) },
          updatedAt: { stringValue: new Date(nowMs).toISOString() },
        },
      }),
    })
    return { allowed: true, limit, used: nextCount }
  }

  // 3. Fallback apenas para testes unitários locais sem KV nem Service Account
  const count = memoryDailyQuotaBuckets.get(kvKey) ?? 0
  if (count >= limit) {
    return { allowed: false, limit, used: count }
  }
  memoryDailyQuotaBuckets.set(kvKey, count + 1)
  return { allowed: true, limit, used: count + 1 }
}

// ---------- CORS e Respostas JSON ----------

function getAllowedOrigins(env: Env): Set<string> {
  const raw = env.ALLOWED_ORIGINS ?? 'https://ianrtaniguchi.github.io,http://localhost:5173'
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  origin?: string | null,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? buildCorsHeaders(origin) : {}),
  }
  return new Response(JSON.stringify(body), { status, headers })
}

// ---------- Validação e montagem do corpo da requisição ----------

interface ValidatedClientFields {
  messages?: unknown[]
  tools?: unknown[]
  tool_choice?: unknown
  temperature?: number
  max_tokens: number
  stream?: boolean
  calendar_action?: {
    tool: string
    args: Record<string, unknown>
  }
  reminder_action?: {
    tool: string
    args: Record<string, unknown>
  }
}

function validateClientPayload(raw: unknown): ValidatedClientFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Corpo da requisição deve ser um objeto JSON.')
  }

  const obj = raw as Record<string, unknown>

  // Recusa qualquer campo não permitido (incluindo "model" ou "reasoning_effort" enviado pelo cliente)
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_FIELDS.has(key)) {
      throw new Error(`Campo não permitido: ${key}`)
    }
  }

  // Permite execução direta de ferramenta de agenda (calendar_action) sem exigir messages
  if (obj.calendar_action !== undefined) {
    if (!obj.calendar_action || typeof obj.calendar_action !== 'object' || Array.isArray(obj.calendar_action)) {
      throw new Error('Campo "calendar_action" inválido.')
    }
    const ca = obj.calendar_action as Record<string, unknown>
    if (typeof ca.tool !== 'string' || !ca.tool.trim()) {
      throw new Error('Campo "calendar_action.tool" inválido.')
    }
    const args =
      ca.args && typeof ca.args === 'object' && !Array.isArray(ca.args)
        ? (ca.args as Record<string, unknown>)
        : {}
    return {
      max_tokens: DEFAULT_MAX_TOKENS,
      calendar_action: { tool: ca.tool.trim(), args },
    }
  }

  // Permite execução direta de ferramenta de lembrete push (reminder_action) sem exigir messages
  if (obj.reminder_action !== undefined) {
    if (!obj.reminder_action || typeof obj.reminder_action !== 'object' || Array.isArray(obj.reminder_action)) {
      throw new Error('Campo "reminder_action" inválido.')
    }
    const ra = obj.reminder_action as Record<string, unknown>
    if (typeof ra.tool !== 'string' || !ra.tool.trim()) {
      throw new Error('Campo "reminder_action.tool" inválido.')
    }
    const args =
      ra.args && typeof ra.args === 'object' && !Array.isArray(ra.args)
        ? (ra.args as Record<string, unknown>)
        : {}
    return {
      max_tokens: DEFAULT_MAX_TOKENS,
      reminder_action: { tool: ra.tool.trim(), args },
    }
  }

  if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
    throw new Error('O campo "messages" é obrigatório e não pode ser vazio.')
  }
  if (obj.messages.length > MAX_MESSAGES) {
    throw new Error(`Número máximo de mensagens excedido (máx. ${MAX_MESSAGES}).`)
  }

  for (const msg of obj.messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      throw new Error('Mensagem inválida na lista "messages".')
    }
    const m = msg as Record<string, unknown>
    if (typeof m.role !== 'string' || !ALLOWED_ROLES.has(m.role)) {
      throw new Error('Role de mensagem inválido.')
    }
    if (typeof m.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Conteúdo da mensagem excede o limite de ${MAX_MESSAGE_CHARS} caracteres.`)
    }
  }

  const out: ValidatedClientFields = {
    messages: obj.messages,
    max_tokens: DEFAULT_MAX_TOKENS,
  }

  if (obj.max_tokens !== undefined) {
    if (typeof obj.max_tokens !== 'number' || !Number.isFinite(obj.max_tokens) || obj.max_tokens < 1) {
      throw new Error('Campo "max_tokens" inválido.')
    }
    out.max_tokens = Math.min(MAX_TOKENS_CEILING, Math.floor(obj.max_tokens))
  }

  if (obj.temperature !== undefined) {
    if (typeof obj.temperature !== 'number' || !Number.isFinite(obj.temperature) || obj.temperature < 0 || obj.temperature > 2) {
      throw new Error('Campo "temperature" deve estar entre 0 e 2.')
    }
    out.temperature = obj.temperature
  }

  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools) || obj.tools.length > 20) {
      throw new Error('Campo "tools" inválido.')
    }
    out.tools = obj.tools
  }

  if (obj.tool_choice !== undefined) {
    out.tool_choice = obj.tool_choice
  }

  if (obj.stream !== undefined) {
    if (typeof obj.stream !== 'boolean') {
      throw new Error('Campo "stream" deve ser booleano.')
    }
    out.stream = obj.stream
  }

  return out
}

function isGptOssModel(model: string): boolean {
  return model.toLowerCase().includes('gpt-oss')
}

function buildGroqBody(
  base: ValidatedClientFields,
  model: string,
  reasoningEffortEnv?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: base.messages,
    max_tokens: base.max_tokens,
  }
  if (base.tools !== undefined) payload.tools = base.tools
  if (base.tool_choice !== undefined) payload.tool_choice = base.tool_choice
  if (base.temperature !== undefined) payload.temperature = base.temperature
  if (base.stream !== undefined) payload.stream = base.stream

  // `reasoning_effort` ("low" | "medium" | "high") é enviado SOMENTE para modelos gpt-oss
  if (isGptOssModel(model)) {
    const rawEffort = (reasoningEffortEnv ?? DEFAULT_REASONING_EFFORT).trim().toLowerCase()
    payload.reasoning_effort = VALID_REASONING_EFFORTS.has(rawEffort)
      ? rawEffort
      : DEFAULT_REASONING_EFFORT
  }

  return payload
}

async function shouldRetryWithFallback(res: Response): Promise<boolean> {
  if (res.status === 404 || res.status >= 500) return true
  if (res.status === 400 || res.status === 422 || res.status === 503) {
    try {
      const cloned = res.clone()
      const text = (await cloned.text()).toLowerCase()
      if (
        text.includes('model_not_found') ||
        text.includes('model_decommissioned') ||
        text.includes('model is not available') ||
        text.includes('does not exist') ||
        text.includes('unavailable')
      ) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

/**
 * Remove campos de raciocínio interno (`reasoning`, `reasoning_content`) das mensagens
 * devolvidas pelo provedor e garante que a chave nunca apareça na resposta.
 */
function sanitizeGroqResponse(data: Record<string, unknown>, apiKey: string): Record<string, unknown> {
  const rawJson = JSON.stringify(data)
  const safeJson = apiKey ? rawJson.split(apiKey).join('[REDACTED]') : rawJson
  const cloned = JSON.parse(safeJson) as Record<string, unknown>
  if (Array.isArray(cloned.choices)) {
    for (const choice of cloned.choices) {
      if (choice && typeof choice === 'object' && choice.message && typeof choice.message === 'object') {
        delete (choice.message as Record<string, unknown>).reasoning
        delete (choice.message as Record<string, unknown>).reasoning_content
      }
    }
  }
  return cloned
}

// ---------- Google Calendar API (OAuth Refresh Token + 4 ferramentas no Worker) ----------

export interface CalendarEventSummary {
  id: string
  titulo: string
  inicio: string
  fim: string
  local: string
  descricao: string
  htmlLink: string
}

export class CalendarConfigError extends Error {}

function hasGoogleCalendarSecrets(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() &&
      env.GOOGLE_CLIENT_SECRET?.trim() &&
      env.GOOGLE_REFRESH_TOKEN?.trim(),
  )
}

export async function getGoogleAccessToken(
  env: Env,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
  forceRefresh = false,
): Promise<string> {
  if (!hasGoogleCalendarSecrets(env)) {
    throw new CalendarConfigError(
      'Google Calendar não configurado no Worker (defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN).',
    )
  }

  if (!forceRefresh && googleAccessTokenCache && nowMs < googleAccessTokenCache.expiresAt) {
    return googleAccessTokenCache.accessToken
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!.trim(),
    client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
    refresh_token: env.GOOGLE_REFRESH_TOKEN!.trim(),
    grant_type: 'refresh_token',
  })

  const res = await fetcher(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    throw new Error(`Falha ao renovar access token do Google Calendar (HTTP ${res.status}).`)
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data?.access_token) {
    throw new Error('Resposta OAuth do Google sem access_token.')
  }

  const ttlSec = Math.max(30, (Number(data.expires_in) || 3600) - 60)
  googleAccessTokenCache = {
    accessToken: data.access_token,
    expiresAt: nowMs + ttlSec * 1000,
  }
  return data.access_token
}

function normalizeSaoPauloIso(dt: string): string {
  const s = dt.trim()
  if (!s) throw new Error('Data/hora vazia.')
  // Se vier apenas AAAA-MM-DD, assume 09:00 em America/Sao_Paulo
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T09:00:00-03:00`
  }
  // Se vier AAAA-MM-DDTHH:MM sem segundos, completa :00
  const withSec = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s
  // Se não tiver sufixo Z nem offset +-HH:MM, adiciona -03:00 (America/Sao_Paulo)
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(withSec)) {
    return `${withSec}-03:00`
  }
  return withSec
}

function addDefaultOneHourIso(inicioIso: string): string {
  const d = new Date(inicioIso)
  if (Number.isNaN(d.getTime())) {
    throw new Error('Data/hora de início inválida.')
  }
  const endMs = d.getTime() + 60 * 60 * 1000
  // Mantém no fuso -03:00 (America/Sao_Paulo)
  const spDate = new Date(endMs - 3 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${spDate.getUTCFullYear()}-${pad(spDate.getUTCMonth() + 1)}-${pad(spDate.getUTCDate())}T${pad(spDate.getUTCHours())}:${pad(spDate.getUTCMinutes())}:${pad(spDate.getUTCSeconds())}-03:00`
}

function mapGoogleCalendarEvent(raw: any): CalendarEventSummary {
  return {
    id: String(raw?.id ?? ''),
    titulo: String(raw?.summary ?? '(sem título)'),
    inicio: String(raw?.start?.dateTime ?? raw?.start?.date ?? ''),
    fim: String(raw?.end?.dateTime ?? raw?.end?.date ?? ''),
    local: String(raw?.location ?? ''),
    descricao: String(raw?.description ?? ''),
    htmlLink: String(raw?.htmlLink ?? ''),
  }
}

async function callGoogleCalendarApi(
  env: Env,
  pathAndQuery: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<Response> {
  let token = await getGoogleAccessToken(env, fetcher, nowMs, false)
  const url = `${GOOGLE_CALENDAR_EVENTS_URL}${pathAndQuery}`
  const doFetch = (accessToken: string) =>
    fetcher(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })

  let res = await doFetch(token)
  if (res.status === 401) {
    token = await getGoogleAccessToken(env, fetcher, nowMs, true)
    res = await doFetch(token)
  }
  return res
}

export async function criar_evento(
  params: {
    titulo: string
    inicio: string
    fim?: string
    local?: string
    descricao?: string
  },
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  const titulo = String(params.titulo ?? '').trim()
  const inicioRaw = String(params.inicio ?? '').trim()
  if (!titulo || !inicioRaw) {
    throw new Error('Título e horário de início são obrigatórios para criar_evento.')
  }
  const inicio = normalizeSaoPauloIso(inicioRaw)
  const fim = params.fim && String(params.fim).trim() ? normalizeSaoPauloIso(String(params.fim)) : addDefaultOneHourIso(inicio)

  const body: Record<string, unknown> = {
    summary: titulo,
    start: { dateTime: inicio, timeZone: CALENDAR_TIMEZONE },
    end: { dateTime: fim, timeZone: CALENDAR_TIMEZONE },
  }
  if (params.local !== undefined) body.location = String(params.local).trim()
  if (params.descricao !== undefined) body.description = String(params.descricao).trim()

  const res = await callGoogleCalendarApi(
    env,
    '',
    { method: 'POST', body: JSON.stringify(body) },
    deps.fetcher,
    deps.nowMs,
  )
  if (!res.ok) {
    throw new Error(`Erro ao criar evento no Google Calendar (HTTP ${res.status}).`)
  }
  const created = await res.json()
  return {
    status: 'created',
    event: mapGoogleCalendarEvent(created),
  }
}

export async function listar_eventos(
  params: { inicio: string; fim: string },
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeMin = normalizeSaoPauloIso(String(params.inicio ?? ''))
  const timeMax = normalizeSaoPauloIso(String(params.fim ?? ''))
  const qs = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    timeZone: CALENDAR_TIMEZONE,
    maxResults: '25',
  })

  const res = await callGoogleCalendarApi(
    env,
    `?${qs.toString()}`,
    { method: 'GET' },
    deps.fetcher,
    deps.nowMs,
  )
  if (!res.ok) {
    throw new Error(`Erro ao listar eventos no Google Calendar (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as { items?: any[] }
  const events = Array.isArray(data?.items) ? data.items.map(mapGoogleCalendarEvent) : []
  return {
    status: 'listed',
    events,
  }
}

export async function editar_evento(
  params: {
    id: string
    campos?: {
      titulo?: string
      inicio?: string
      fim?: string
      local?: string
      descricao?: string
    }
    titulo?: string
    inicio?: string
    fim?: string
    local?: string
    descricao?: string
    confirmado?: boolean | string
  },
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  const eventId = String(params.id ?? '').trim()
  if (!eventId) {
    throw new Error('O parâmetro "id" do evento é obrigatório para editar_evento.')
  }

  const rawCampos =
    params.campos && typeof params.campos === 'object' ? params.campos : {}
  const campos: Record<string, string> = {}
  for (const k of ['titulo', 'inicio', 'fim', 'local', 'descricao'] as const) {
    const val = rawCampos[k] ?? params[k]
    if (typeof val === 'string' && val.trim() !== '') {
      campos[k] = val.trim()
    }
  }

  // Busca o evento atual no Google Calendar
  const getRes = await callGoogleCalendarApi(
    env,
    `/${encodeURIComponent(eventId)}`,
    { method: 'GET' },
    deps.fetcher,
    deps.nowMs,
  )
  if (!getRes.ok) {
    throw new Error(`Evento não encontrado no Google Calendar (HTTP ${getRes.status}).`)
  }
  const currentRaw = await getRes.json()
  const currentEvent = mapGoogleCalendarEvent(currentRaw)

  const isConfirmed =
    params.confirmado === true ||
    params.confirmado === 'confirmado' ||
    (rawCampos as any).confirmado === true ||
    (rawCampos as any).confirmado === 'confirmado'

  // Exigência no código do Worker: a 1ª chamada devolve o evento e pede confirmação sem alterar nada
  if (!isConfirmed) {
    const previewEvent: CalendarEventSummary = {
      ...currentEvent,
      titulo: campos.titulo ?? currentEvent.titulo,
      inicio: campos.inicio ? normalizeSaoPauloIso(campos.inicio) : currentEvent.inicio,
      fim: campos.fim ? normalizeSaoPauloIso(campos.fim) : currentEvent.fim,
      local: campos.local !== undefined ? campos.local : currentEvent.local,
      descricao: campos.descricao !== undefined ? campos.descricao : currentEvent.descricao,
    }
    return {
      status: 'confirmation_required',
      requiresConfirmation: true,
      action: 'editar_evento',
      message:
        'Confirmação necessária para editar este evento. Toque no botão Confirmar no card do evento para aplicar.',
      event: previewEvent,
      currentEvent,
      pendingAction: {
        tool: 'editar_evento',
        id: eventId,
        campos,
      },
    }
  }

  const patchBody: Record<string, unknown> = {}
  if (campos.titulo !== undefined) patchBody.summary = campos.titulo
  if (campos.local !== undefined) patchBody.location = campos.local
  if (campos.descricao !== undefined) patchBody.description = campos.descricao
  if (campos.inicio !== undefined) {
    const newStart = normalizeSaoPauloIso(campos.inicio)
    patchBody.start = { dateTime: newStart, timeZone: CALENDAR_TIMEZONE }
    if (campos.fim === undefined) {
      patchBody.end = { dateTime: addDefaultOneHourIso(newStart), timeZone: CALENDAR_TIMEZONE }
    }
  }
  if (campos.fim !== undefined) {
    patchBody.end = { dateTime: normalizeSaoPauloIso(campos.fim), timeZone: CALENDAR_TIMEZONE }
  }

  const patchRes = await callGoogleCalendarApi(
    env,
    `/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: JSON.stringify(patchBody) },
    deps.fetcher,
    deps.nowMs,
  )
  if (!patchRes.ok) {
    throw new Error(`Erro ao atualizar evento no Google Calendar (HTTP ${patchRes.status}).`)
  }
  const updatedRaw = await patchRes.json()
  return {
    status: 'updated',
    event: mapGoogleCalendarEvent(updatedRaw),
  }
}

export async function apagar_evento(
  params: { id: string; confirmado?: boolean | string },
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  const eventId = String(params.id ?? '').trim()
  if (!eventId) {
    throw new Error('O parâmetro "id" do evento é obrigatório para apagar_evento.')
  }

  const isConfirmed = params.confirmado === true || params.confirmado === 'confirmado'

  // Exigência no código do Worker: a 1ª chamada busca o evento, devolve-o e pede confirmação sem apagar
  if (!isConfirmed) {
    const getRes = await callGoogleCalendarApi(
      env,
      `/${encodeURIComponent(eventId)}`,
      { method: 'GET' },
      deps.fetcher,
      deps.nowMs,
    )
    if (!getRes.ok) {
      throw new Error(`Evento não encontrado no Google Calendar (HTTP ${getRes.status}).`)
    }
    const currentRaw = await getRes.json()
    const currentEvent = mapGoogleCalendarEvent(currentRaw)
    return {
      status: 'confirmation_required',
      requiresConfirmation: true,
      action: 'apagar_evento',
      message:
        'Confirmação necessária para apagar este evento. Toque no botão Confirmar no card do evento para excluir.',
      event: currentEvent,
      pendingAction: {
        tool: 'apagar_evento',
        id: eventId,
      },
    }
  }

  const delRes = await callGoogleCalendarApi(
    env,
    `/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
    deps.fetcher,
    deps.nowMs,
  )
  if (!delRes.ok && delRes.status !== 204) {
    throw new Error(`Erro ao apagar evento no Google Calendar (HTTP ${delRes.status}).`)
  }
  return {
    status: 'deleted',
    id: eventId,
  }
}

export async function executeCalendarTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Record<string, unknown>> {
  try {
    if (toolName === 'criar_evento') {
      return await criar_evento(args as any, env, deps)
    }
    if (toolName === 'listar_eventos') {
      return await listar_eventos(args as any, env, deps)
    }
    if (toolName === 'editar_evento') {
      return await editar_evento(args as any, env, deps)
    }
    if (toolName === 'apagar_evento') {
      return await apagar_evento(args as any, env, deps)
    }
    return { error: `Ferramenta de agenda desconhecida: ${toolName}` }
  } catch (e) {
    return { error: (e as Error).message || 'Erro ao acessar o Google Calendar.' }
  }
}

// ---------- Foto do prato (/analyze-meal): visão + JSON ----------

/** Extrai o objeto JSON do texto devolvido pelo modelo (tolera cercas ```json). */
export function parseMealAnalysisContent(content: unknown): { itens: unknown[] } {
  if (typeof content !== 'string') throw new Error('resposta vazia')
  let text = content.trim()
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) text = fence[1].trim()
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).itens)) {
    throw new Error('formato inesperado')
  }
  return { itens: (parsed as any).itens as unknown[] }
}

async function analyzeMealImage(
  imageDataUrl: string,
  groqApiKey: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const model = (env.GROQ_VISION_MODEL ?? DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL
  let res: Response
  try {
    res = await fetcher(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: MEAL_ANALYSIS_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        // Desativa o raciocínio/thinking para a resposta vir rápida e só com o JSON
        reasoning_effort: 'none',
        temperature: 0.2,
        max_completion_tokens: 1200,
      }),
    })
  } catch {
    return { status: 502, body: { error: 'error: falha de comunicação com o provedor de IA.' } }
  }

  if (!res.ok) {
    if (res.status === 429) {
      return { status: 429, body: { error: 'error: limite de uso da API de IA atingido (429). Tente novamente em instantes.' } }
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 502, body: { error: 'error: falha de autenticação do provedor de IA.' } }
    }
    return { status: 502, body: { error: `error: serviço de IA temporariamente indisponível (${res.status}).` } }
  }

  try {
    const data = (await res.json()) as any
    const parsed = parseMealAnalysisContent(data?.choices?.[0]?.message?.content)
    return { status: 200, body: parsed }
  } catch {
    return { status: 502, body: { error: 'error: a IA devolveu uma resposta inválida. Tente outra foto.' } }
  }
}

// ---------- Foto da grade de aulas (/analyze-faculty-schedule) ----------

export function parseFacultyScheduleContent(content: unknown): { aulas: unknown[] } {
  if (typeof content !== 'string') throw new Error('resposta vazia')
  let text = content.trim()
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) text = fence[1].trim()
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).aulas)) {
    throw new Error('formato inesperado')
  }
  return { aulas: (parsed as any).aulas as unknown[] }
}

async function analyzeFacultyScheduleImage(
  imageDataUrl: string,
  groqApiKey: string,
  env: Env,
  fetcher: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const model = (env.GROQ_VISION_MODEL ?? DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL
  let res: Response
  try {
    res = await fetcher(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: FACULTY_SCHEDULE_ANALYSIS_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'none',
        temperature: 0.1,
        max_completion_tokens: 1600,
      }),
    })
  } catch {
    return { status: 502, body: { error: 'error: falha de comunicação com o provedor de IA.' } }
  }

  if (!res.ok) {
    if (res.status === 429) {
      return { status: 429, body: { error: 'error: limite de uso da API de IA atingido (429). Tente novamente em instantes.' } }
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 502, body: { error: 'error: falha de autenticação do provedor de IA.' } }
    }
    return { status: 502, body: { error: `error: serviço de IA temporariamente indisponível (${res.status}).` } }
  }

  try {
    const data = (await res.json()) as any
    const parsed = parseFacultyScheduleContent(data?.choices?.[0]?.message?.content)
    return { status: 200, body: parsed }
  } catch {
    return { status: 502, body: { error: 'error: a IA devolveu uma resposta inválida. Tente outra foto.' } }
  }
}

// ---------- Transcrição de áudio por voz (/transcribe): Whisper na Groq ----------

const ALLOWED_AUDIO_EXT_RE = /\.(webm|m4a|mp4|mp3|mpeg|mpga|ogg|oga|wav|flac)$/i

export function normalizeAudioFilename(rawName?: string | null, mimeType?: string | null): string {
  const cleanName = typeof rawName === 'string' ? rawName.trim() : ''
  if (cleanName && ALLOWED_AUDIO_EXT_RE.test(cleanName)) {
    return cleanName
  }
  const m = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a') || m.includes('x-m4a')) {
    return 'gravacao.m4a'
  }
  if (m.includes('ogg') || (m.includes('opus') && !m.includes('webm'))) {
    return 'gravacao.ogg'
  }
  if (m.includes('wav')) {
    return 'gravacao.wav'
  }
  if (m.includes('mp3') || m.includes('mpeg')) {
    return 'gravacao.mp3'
  }
  return 'gravacao.webm'
}

async function transcribeAudioWithGroq(
  audioBlob: Blob,
  filename: string,
  groqApiKey: string,
  fetcher: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const upstreamForm = new FormData()
  upstreamForm.append('file', audioBlob, filename)
  upstreamForm.append('model', DEFAULT_TRANSCRIBE_MODEL)
  upstreamForm.append('language', 'pt')
  upstreamForm.append('response_format', 'json')
  upstreamForm.append('temperature', '0')

  let res: Response
  try {
    res = await fetcher(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: upstreamForm,
    })
  } catch {
    return {
      status: 502,
      body: { error: 'error: falha de comunicação com o serviço de transcrição da Groq.' },
    }
  }

  if (!res.ok) {
    if (res.status === 429) {
      return {
        status: 429,
        body: { error: 'error: limite de transcrição da Groq atingido (429). Aguarde alguns instantes.' },
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        status: 502,
        body: { error: 'error: falha de autenticação na API de transcrição da Groq.' },
      }
    }
    return {
      status: 502,
      body: { error: `error: falha no serviço de transcrição da Groq (HTTP ${res.status}).` },
    }
  }

  try {
    const data = (await res.json()) as { text?: unknown }
    const text = typeof data?.text === 'string' ? data.text.trim() : ''
    if (!text) {
      return {
        status: 422,
        body: { error: 'error: nenhuma fala foi reconhecida no áudio. Tente falar mais perto do microfone.' },
      }
    }
    return { status: 200, body: { text } }
  } catch {
    return {
      status: 502,
      body: { error: 'error: resposta inválida do serviço de transcrição.' },
    }
  }
}

// ---------- Handler principal do Cloudflare Worker ----------

export async function handleRequest(
  request: Request,
  env: Env,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()

  const origin = request.headers.get('Origin')
  const allowedOrigins = getAllowedOrigins(env)
  const originAllowed = Boolean(origin && allowedOrigins.has(origin))

  const url = new URL(request.url)

  // Preflight CORS
  if (request.method === 'OPTIONS') {
    if (!originAllowed || !origin) {
      return jsonResponse(403, { error: 'error: origem não permitida pelo CORS.' })
    }
    return new Response(null, { status: 204, headers: buildCorsHeaders(origin) })
  }

  // Bloqueia origens não autorizadas em qualquer requisição
  if (!originAllowed || !origin) {
    return jsonResponse(403, { error: 'error: origem não permitida pelo CORS.' })
  }

  // Rotas públicas de proxy com cache da Ceturb-ES (/ceturb/lines, /ceturb/schedules, /ceturb/itinerary, /ceturb/integrations, /ceturb/fares)
  if (url.pathname.startsWith('/ceturb/')) {
    return handleCeturbProxyRequest(url, request, buildCorsHeaders(origin), { fetcher, nowMs })
  }

  const isAnalyzeMeal = url.pathname === '/analyze-meal'
  const isAnalyzeFacultySchedule = url.pathname === '/analyze-faculty-schedule'
  const isTranscribe = url.pathname === '/transcribe'
  const isIfesStatus = url.pathname === '/ifes/status'
  const isPushTest = url.pathname === '/push-test'
  if (
    url.pathname !== '/chat' &&
    !isAnalyzeMeal &&
    !isAnalyzeFacultySchedule &&
    !isTranscribe &&
    !isIfesStatus &&
    !isPushTest
  ) {
    return jsonResponse(404, { error: 'error: rota não encontrada.' }, origin)
  }

  if (isIfesStatus) {
    if (request.method !== 'GET') {
      return jsonResponse(405, { error: 'error: método não permitido (use GET).' }, origin)
    }
  } else if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'error: método não permitido (use POST).' }, origin)
  }

  // Validação do cabeçalho Authorization: Bearer <token>
  const authHeader = request.headers.get('Authorization') ?? ''
  const match = authHeader.match(/^Bearer\s+([^\s]+)$/i)
  if (!match) {
    return jsonResponse(401, { error: 'error: token de autenticação ausente.' }, origin)
  }
  const userIdToken = match[1]

  const projectId = (env.FIREBASE_PROJECT_ID ?? 'meu-treino-2007').trim() || 'meu-treino-2007'
  let jwtPayload: FirebaseJwtPayload
  try {
    jwtPayload = await verifyFirebaseIdToken(userIdToken, projectId, fetcher, nowMs)
  } catch {
    return jsonResponse(401, { error: 'error: token de autenticação inválido ou expirado.' }, origin)
  }

  if (!isUidAllowed(jwtPayload.sub, env)) {
    return jsonResponse(403, { error: 'error: usuário não autorizado para este assistente.' }, origin)
  }

  // Rate limiting por UID
  const withinLimit = await checkRateLimit(jwtPayload.sub, env, nowMs)
  if (!withinLimit) {
    return jsonResponse(
      429,
      { error: 'error: limite de requisições por minuto atingido. Aguarde um instante.' },
      origin,
    )
  }

  if (isIfesStatus) {
    try {
      const report = await getIfesStatusReport(env, { fetcher, nowMs })
      return jsonResponse(200, report, origin)
    } catch (e) {
      return jsonResponse(503, { error: `error: ${(e as Error).message}` }, origin)
    }
  }

  if (isPushTest) {
    try {
      const result = await sendTestPushToUserTokens(jwtPayload.sub, env, { fetcher, nowMs })
      return jsonResponse(200, result, origin)
    } catch (e) {
      return jsonResponse(503, { error: `error: ${(e as Error).message}` }, origin)
    }
  }

  if (isTranscribe) {
    const contentLengthHeader = request.headers.get('Content-Length')
    if (contentLengthHeader && Number.parseInt(contentLengthHeader, 10) > MAX_AUDIO_BODY_BYTES) {
      return jsonResponse(413, { error: 'error: arquivo de áudio excede o limite de 10 MB.' }, origin)
    }
    const contentType = request.headers.get('Content-Type') ?? ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return jsonResponse(
        400,
        { error: 'error: envie o áudio em multipart/form-data com o campo "file".' },
        origin,
      )
    }

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return jsonResponse(400, { error: 'error: falha ao ler multipart/form-data do áudio.' }, origin)
    }

    const fileEntry = formData.get('file')
    if (!fileEntry || typeof fileEntry === 'string' || typeof (fileEntry as Blob).arrayBuffer !== 'function') {
      return jsonResponse(400, { error: 'error: campo "file" ausente ou inválido no envio de áudio.' }, origin)
    }

    const audioBlob = fileEntry as Blob
    if (audioBlob.size < MIN_AUDIO_FILE_BYTES) {
      return jsonResponse(
        400,
        { error: 'error: áudio vazio ou muito curto. Grave por pelo menos 1 segundo.' },
        origin,
      )
    }
    if (audioBlob.size > MAX_AUDIO_BODY_BYTES) {
      return jsonResponse(413, { error: 'error: arquivo de áudio excede o limite de 10 MB.' }, origin)
    }

    let groqKey: string
    try {
      groqKey = resolveGroqApiKey(env)
    } catch {
      return jsonResponse(503, { error: 'chave do assistente não configurada' }, origin)
    }

    const quota = await checkAndConsumeDailyQuota(jwtPayload.sub, 'msg', env, { fetcher, nowMs })
    if (!quota.allowed) {
      return jsonResponse(
        429,
        {
          error: `error: limite diário de mensagens atingido (${quota.limit}/dia). Tente novamente amanhã.`,
        },
        origin,
      )
    }

    const rawName = typeof (audioBlob as File).name === 'string' ? (audioBlob as File).name : undefined
    const filename = normalizeAudioFilename(rawName, audioBlob.type)
    const out = await transcribeAudioWithGroq(audioBlob, filename, groqKey, fetcher)
    return jsonResponse(out.status, out.body, origin)
  }

  // Limite de 64 KB para o corpo do chat (a foto do prato tem um limite próprio, maior)
  const isPhotoAnalysis = isAnalyzeMeal || isAnalyzeFacultySchedule
  const maxBodyBytes = isPhotoAnalysis ? MAX_IMAGE_BODY_BYTES : MAX_BODY_BYTES
  const tooLargeMsg = isPhotoAnalysis ? 'error: foto muito grande.' : 'error: corpo da requisição excede 64 KB.'
  const contentLength = request.headers.get('Content-Length')
  if (contentLength && Number.parseInt(contentLength, 10) > maxBodyBytes) {
    return jsonResponse(413, { error: tooLargeMsg }, origin)
  }

  const rawBuffer = await request.arrayBuffer()
  if (rawBuffer.byteLength > maxBodyBytes) {
    return jsonResponse(413, { error: tooLargeMsg }, origin)
  }

  let parsedBody: unknown
  try {
    const text = new TextDecoder().decode(rawBuffer)
    parsedBody = JSON.parse(text)
  } catch {
    return jsonResponse(400, { error: 'error: JSON inválido no corpo da requisição.' }, origin)
  }

  if (isAnalyzeMeal) {
    const b = parsedBody as Record<string, unknown> | null
    const image = b && typeof b === 'object' && !Array.isArray(b) ? b.image : undefined
    const extra = b && typeof b === 'object' ? Object.keys(b).filter((k) => k !== 'image') : []
    if (typeof image !== 'string' || !MEAL_IMAGE_DATA_URL_RE.test(image) || extra.length > 0) {
      return jsonResponse(400, { error: 'error: envie { "image": "data:image/jpeg;base64,..." }.' }, origin)
    }
    let visionKey: string
    try {
      visionKey = resolveGroqApiKey(env)
    } catch {
      return jsonResponse(503, { error: 'chave do assistente não configurada' }, origin)
    }
    const photoQuota = await checkAndConsumeDailyQuota(jwtPayload.sub, 'photo', env, {
      fetcher,
      nowMs,
    })
    if (!photoQuota.allowed) {
      return jsonResponse(
        429,
        {
          error: `error: limite diário de fotos do prato atingido (${photoQuota.limit}/dia). Tente novamente amanhã.`,
        },
        origin,
      )
    }
    const out = await analyzeMealImage(image, visionKey, env, fetcher)
    return jsonResponse(out.status, out.body, origin)
  }

  if (isAnalyzeFacultySchedule) {
    const b = parsedBody as Record<string, unknown> | null
    const image = b && typeof b === 'object' && !Array.isArray(b) ? b.image : undefined
    const extra = b && typeof b === 'object' ? Object.keys(b).filter((k) => k !== 'image') : []
    if (typeof image !== 'string' || !MEAL_IMAGE_DATA_URL_RE.test(image) || extra.length > 0) {
      return jsonResponse(400, { error: 'error: envie { "image": "data:image/jpeg;base64,..." }.' }, origin)
    }
    let visionKey: string
    try {
      visionKey = resolveGroqApiKey(env)
    } catch {
      return jsonResponse(503, { error: 'chave do assistente não configurada' }, origin)
    }
    const photoQuota = await checkAndConsumeDailyQuota(jwtPayload.sub, 'photo', env, {
      fetcher,
      nowMs,
    })
    if (!photoQuota.allowed) {
      return jsonResponse(
        429,
        {
          error: `error: limite diário de fotos atingido (${photoQuota.limit}/dia). Tente novamente amanhã.`,
        },
        origin,
      )
    }
    const out = await analyzeFacultyScheduleImage(image, visionKey, env, fetcher)
    return jsonResponse(out.status, out.body, origin)
  }

  let validatedFields: ValidatedClientFields
  try {
    validatedFields = validateClientPayload(parsedBody)
  } catch (e) {
    return jsonResponse(400, { error: `error: ${(e as Error).message}` }, origin)
  }

  const userIsOwner = isOwnerUid(jwtPayload.sub, env)

  // As ferramentas do Google Calendar funcionam SOMENTE para o OWNER_UID
  if (validatedFields.calendar_action) {
    if (!userIsOwner) {
      return jsonResponse(
        403,
        { error: 'error: as ferramentas do Google Calendar são restritas ao proprietário.' },
        origin,
      )
    }
    const calResult = await executeCalendarTool(
      validatedFields.calendar_action.tool,
      validatedFields.calendar_action.args,
      env,
      { fetcher, nowMs },
    )
    return jsonResponse(200, calResult, origin)
  }

  if (validatedFields.reminder_action) {
    const remResult = await executePushReminderTool(
      validatedFields.reminder_action.tool,
      validatedFields.reminder_action.args,
      jwtPayload.sub,
      env,
      { fetcher, nowMs, userIdToken },
    )
    return jsonResponse(200, remResult, origin)
  }

  // Remove ferramentas do Google Calendar caso uma conta secundária as envie no payload de tools
  if (!userIsOwner && Array.isArray(validatedFields.tools)) {
    validatedFields.tools = validatedFields.tools.filter((t: any) => {
      const fnName = typeof t?.function?.name === 'string' ? t.function.name : ''
      return !CALENDAR_TOOL_NAMES.has(fnName)
    })
  }

  // Obtém a chave do Groq exclusivamente do secret GROQ_API_KEY do Worker
  let groqApiKey: string
  try {
    groqApiKey = resolveGroqApiKey(env)
  } catch {
    return jsonResponse(503, { error: 'chave do assistente não configurada' }, origin)
  }

  const msgQuota = await checkAndConsumeDailyQuota(jwtPayload.sub, 'msg', env, { fetcher, nowMs })
  if (!msgQuota.allowed) {
    return jsonResponse(
      429,
      {
        error: `error: limite diário de mensagens atingido (${msgQuota.limit}/dia). Tente novamente amanhã.`,
      },
      origin,
    )
  }

  const primaryModel = (env.GROQ_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL
  const fallbackModel = (env.GROQ_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL).trim() || DEFAULT_FALLBACK_MODEL

  const callGroq = (model: string) =>
    fetcher(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildGroqBody(validatedFields, model, env.GROQ_REASONING_EFFORT)),
    })

  try {
    let upstreamRes = await callGroq(primaryModel)

    if (!upstreamRes.ok && fallbackModel && fallbackModel !== primaryModel && (await shouldRetryWithFallback(upstreamRes))) {
      upstreamRes = await callGroq(fallbackModel)
    }

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        return jsonResponse(
          502,
          { error: 'error: falha de autenticação do provedor de IA.' },
          origin,
        )
      }
      if (upstreamRes.status === 429) {
        return jsonResponse(
          429,
          { error: 'error: limite de uso da API de IA atingido (429). Tente novamente em instantes.' },
          origin,
        )
      }
      return jsonResponse(
        502,
        { error: `error: serviço de IA temporariamente indisponível (${upstreamRes.status}).` },
        origin,
      )
    }

    const data = (await upstreamRes.json()) as Record<string, unknown>
    return jsonResponse(200, sanitizeGroqResponse(data, groqApiKey), origin)
  } catch {
    return jsonResponse(502, { error: 'error: falha de comunicação com o provedor de IA.' }, origin)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
  async scheduled(
    event: { scheduledTime?: number } | unknown,
    env: Env,
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const scheduledMs =
      event && typeof event === 'object' && typeof (event as any).scheduledTime === 'number'
        ? ((event as any).scheduledTime as number)
        : Date.now()
    const shouldRunIfes = new Date(scheduledMs).getUTCMinutes() % 20 === 0

    const task = (async () => {
      await processDuePushReminders(env, { nowMs: scheduledMs }).catch((err) => {
        console.error('[push-reminders-cron] erro não tratado:', err)
      })
      if (shouldRunIfes) {
        await runIfesCron(env, { nowMs: scheduledMs }).catch((err) => {
          console.error('[ifes-cron] erro não tratado:', err)
        })
      }
    })()

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task)
    } else {
      await task
    }
  },
}
