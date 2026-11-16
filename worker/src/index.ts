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
  /** ID do projeto Firebase (padrão: "meu-treino-2007") */
  FIREBASE_PROJECT_ID?: string
  /** UID único autorizado a usar o assistente */
  ALLOWED_UID: string
  /** Origens permitidas no CORS separadas por vírgula */
  ALLOWED_ORIGINS?: string
  /** Limite por minuto por UID (padrão: "20") */
  RATE_LIMIT_PER_MIN?: string
  /** Binding opcional de Rate Limiting da Cloudflare */
  RATE_LIMITER?: RateLimiterBinding
  /** Binding opcional de Workers KV para rate limiting distribuído */
  RATE_LIMIT_KV?: KVNamespaceLike
}

export const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

export const MAX_BODY_BYTES = 64 * 1024 // 64 KB
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
const firestoreKeyCache = new Map<string, { key: string; expiresAt: number }>()
const memoryRateBuckets = new Map<string, { count: number; windowStartMs: number }>()

export function resetWorkerCachesForTest() {
  jwksCache = null
  firestoreKeyCache.clear()
  memoryRateBuckets.clear()
}

// ---------- Validação e busca da chave do Groq no Firestore (REST) ----------

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

interface FirestoreUserDocResponse {
  fields?: {
    groqApiKey?: {
      stringValue?: string
    }
  }
}

/**
 * Resolve a chave do Groq:
 * 1) Se `env.GROQ_API_KEY` (secret opcional do Worker) estiver definido e válido, usa-o;
 * 2) Caso contrário, consulta o cache em memória por `uid` (TTL de 5 min);
 * 3) Se não estiver em cache, faz GET REST em `users/{uid}` no Firestore com o Bearer ID token do usuário.
 * Lança erro genérico se ausente, recusado ou em formato inválido (nunca inclui a chave no erro).
 */
async function resolveGroqApiKey(
  env: Env,
  projectId: string,
  uid: string,
  userIdToken: string,
  fetcher: typeof fetch,
  nowMs: number,
): Promise<string> {
  const secretKey = env.GROQ_API_KEY?.trim()
  if (secretKey) {
    if (!isValidGroqApiKey(secretKey)) {
      throw new Error('chave do assistente não configurada')
    }
    return secretKey
  }

  const cached = firestoreKeyCache.get(uid)
  if (cached && nowMs < cached.expiresAt) {
    return cached.key
  }

  const url = buildFirestoreUserDocUrl(projectId, uid)
  let res: Response
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${userIdToken}`,
        Accept: 'application/json',
      },
    })
  } catch {
    throw new Error('chave do assistente não configurada')
  }

  if (!res.ok) {
    throw new Error('chave do assistente não configurada')
  }

  let doc: FirestoreUserDocResponse
  try {
    doc = (await res.json()) as FirestoreUserDocResponse
  } catch {
    throw new Error('chave do assistente não configurada')
  }

  const key = doc?.fields?.groqApiKey?.stringValue
  if (!isValidGroqApiKey(key)) {
    throw new Error('chave do assistente não configurada')
  }

  firestoreKeyCache.set(uid, {
    key,
    expiresAt: nowMs + FIRESTORE_KEY_CACHE_TTL_MS,
  })

  return key
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  messages: unknown[]
  tools?: unknown[]
  tool_choice?: unknown
  temperature?: number
  max_tokens: number
  stream?: boolean
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

  if (url.pathname !== '/chat') {
    return jsonResponse(404, { error: 'error: rota não encontrada.' }, origin)
  }

  if (request.method !== 'POST') {
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

  const allowedUid = (env.ALLOWED_UID ?? '').trim()
  if (
    !allowedUid ||
    allowedUid === '[SEU_UID]' ||
    allowedUid === '[COLE_SEU_UID_AQUI]' ||
    jwtPayload.sub !== allowedUid
  ) {
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

  // Limite de 64 KB para o corpo da requisição
  const contentLength = request.headers.get('Content-Length')
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'error: corpo da requisição excede 64 KB.' }, origin)
  }

  const rawBuffer = await request.arrayBuffer()
  if (rawBuffer.byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'error: corpo da requisição excede 64 KB.' }, origin)
  }

  let parsedBody: unknown
  try {
    const text = new TextDecoder().decode(rawBuffer)
    parsedBody = JSON.parse(text)
  } catch {
    return jsonResponse(400, { error: 'error: JSON inválido no corpo da requisição.' }, origin)
  }

  let validatedFields: ValidatedClientFields
  try {
    validatedFields = validateClientPayload(parsedBody)
  } catch (e) {
    return jsonResponse(400, { error: `error: ${(e as Error).message}` }, origin)
  }

  // Obtém a chave do Groq (secret opcional ou Firestore users/{uid}.groqApiKey com cache de 5 min)
  let groqApiKey: string
  try {
    groqApiKey = await resolveGroqApiKey(
      env,
      projectId,
      jwtPayload.sub,
      userIdToken,
      fetcher,
      nowMs,
    )
  } catch {
    return jsonResponse(503, { error: 'chave do assistente não configurada' }, origin)
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
}
