import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apagar_evento,
  buildFirestoreUserDocUrl,
  criar_evento,
  editar_evento,
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_JWKS_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GROQ_CHAT_URL,
  GROQ_TRANSCRIBE_URL,
  handleRequest,
  isValidGroqApiKey,
  listar_eventos,
  normalizeAudioFilename,
  parseFacultyScheduleContent,
  resetWorkerCachesForTest,
  type Env,
  type JsonWebKeyWithKid,
} from '../src/index'
import { computeNextReminderTriggerAtUtc, normalizeReminderRecurrence } from '../src/ifes'

describe('lembretes push mensais', () => {
  it('avança um vencimento mensal preservando o dia, horário e o último dia de meses curtos', () => {
    expect(normalizeReminderRecurrence('monthly', 1)).toBe('monthly')
    expect(normalizeReminderRecurrence('monthly', 32)).toBe('none')
    expect(computeNextReminderTriggerAtUtc(
      '2026-02-28T12:00:00.000Z',
      'monthly',
      Date.parse('2026-02-28T12:00:00.000Z'),
      1,
    )).toBe('2026-03-31T12:00:00.000Z')
    expect(computeNextReminderTriggerAtUtc(
      '2026-03-30T12:00:00.000Z',
      'monthly',
      Date.parse('2026-03-30T12:00:00.000Z'),
      31,
    )).toBe('2026-04-29T12:00:00.000Z')
  })
})

function bytesToBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function jsonToBase64Url(obj: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)))
}

let privateKey: CryptoKey
let publicJwk: JsonWebKeyWithKid
const KID = 'test-key-id-1'
const PROJECT_ID = 'meu-treino-2007'
const MY_UID = 'uid-autorizado-12345'
const ALLOWED_ORIGIN = 'https://ianrtaniguchi.github.io'
const VALID_FIRESTORE_KEY = 'gsk_ChaveValidaDeTesteNoFirestore1234567890ABCD'

async function signTestJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
): Promise<string> {
  const h = jsonToBase64Url(header)
  const p = jsonToBase64Url(payload)
  const signingInput = new TextEncoder().encode(`${h}.${p}`)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingInput)
  return `${h}.${p}.${bytesToBase64Url(new Uint8Array(sig))}`
}

function makeBaseEnv(): Env {
  return {
    GROQ_API_KEY: VALID_FIRESTORE_KEY,
    GROQ_MODEL: 'openai/gpt-oss-120b',
    GROQ_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
    GROQ_REASONING_EFFORT: 'medium',
    FIREBASE_PROJECT_ID: PROJECT_ID,
    OWNER_UID: MY_UID,
    ALLOWED_UIDS: MY_UID,
    ALLOWED_ORIGINS: 'https://ianrtaniguchi.github.io,http://localhost:5173',
    RATE_LIMIT_PER_MIN: '20',
  }
}

describe('Cloudflare Worker Proxy (/chat)', () => {
  const nowMs = 1_730_000_000_000
  const nowSec = Math.floor(nowMs / 1000)

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    privateKey = pair.privateKey
    const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKeyWithKid
    publicJwk = { ...exported, kid: KID, alg: 'RS256', use: 'sig' }
  })

  beforeEach(() => {
    resetWorkerCachesForTest()
  })

  function createMockFetcher(options?: {
    onFirestoreCall?: (init?: RequestInit) => Response | Promise<Response>
    onGroqCall?: (init?: RequestInit) => Response | Promise<Response>
  }): typeof fetch {
    const expectedFirestoreUrl = buildFirestoreUserDocUrl(PROJECT_ID, MY_UID)
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === GOOGLE_JWKS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
      if (url === expectedFirestoreUrl) {
        if (options?.onFirestoreCall) return options.onFirestoreCall(init)
        return new Response(
          JSON.stringify({
            name: `projects/${PROJECT_ID}/databases/(default)/documents/users/${MY_UID}`,
            fields: {
              groqApiKey: { stringValue: VALID_FIRESTORE_KEY },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === GROQ_CHAT_URL) {
        if (options?.onGroqCall) return options.onGroqCall(init)
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-mock-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Treino analisado com sucesso.',
                  reasoning: 'raciocinio interno que deve ser omitido',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`URL inesperada no mock: ${url}`)
    }
  }

  it('recusa origem não autorizada com 403 (CORS) e aceita preflight OPTIONS de origem autorizada', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()

    const badOriginReq = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: 'https://site-malicioso.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
    })
    const resBad = await handleRequest(badOriginReq, env, { fetcher, nowMs })
    expect(resBad.status).toBe(403)

    const optionsOk = new Request('https://worker.example.com/chat', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN },
    })
    const resOpt = await handleRequest(optionsOk, env, { fetcher, nowMs })
    expect(resOpt.status).toBe(204)
    expect(resOpt.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
  })

  it('recusa token inválido ou malformado com 401', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()

    const validToken = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 60,
      exp: nowSec + 3600,
    })
    const tamperedToken = validToken.slice(0, -4) + 'AAAA'

    const req = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${tamperedToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
    })
    const res = await handleRequest(req, env, { fetcher, nowMs })
    expect(res.status).toBe(401)
  })

  it('recusa token expirado com 401', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()

    const expiredToken = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 7200,
      exp: nowSec - 10,
    })

    const req = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${expiredToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
    })
    const res = await handleRequest(req, env, { fetcher, nowMs })
    expect(res.status).toBe(401)
  })

  it('recusa token válido porém de outro UID com 403', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()

    const otherUserToken = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: 'outro-uid-intruso-999',
      iat: nowSec - 30,
      exp: nowSec + 3600,
    })

    const req = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${otherUserToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
    })
    const res = await handleRequest(req, env, { fetcher, nowMs })
    expect(res.status).toBe(403)
  })

  it('suporta múltiplas contas em ALLOWED_UIDS (lista explícita), recusa "*" e bloqueia Google Calendar para contas secundárias', async () => {
    const secondaryUid = 'uid-conta-secundaria-777'
    const secondaryToken = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: secondaryUid,
      iat: nowSec - 30,
      exp: nowSec + 3600,
    })

    let forwardedTools: any[] = []
    const fetcher = createMockFetcher({
      onGroqCall: (init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        forwardedTools = body.tools ?? []
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-sec-1',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Olá, conta secundária!' },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    // 1. Curinga "*" em ALLOWED_UIDS / ALLOWED_UID é recusado (403)
    const wildcardEnv: Env = {
      ...makeBaseEnv(),
      ALLOWED_UIDS: '*',
    }
    const makeSecondaryReq = (payload: Record<string, unknown>) =>
      new Request('https://worker.example.com/chat', {
        method: 'POST',
        headers: {
          Origin: ALLOWED_ORIGIN,
          Authorization: `Bearer ${secondaryToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

    const resWildcard = await handleRequest(
      makeSecondaryReq({ messages: [{ role: 'user', content: 'oi' }] }),
      wildcardEnv,
      { fetcher, nowMs },
    )
    expect(resWildcard.status).toBe(403)

    // 2. Lista explícita em ALLOWED_UIDS aceita a conta secundária e remove ferramentas do Google Calendar do payload
    const listEnv: Env = {
      ...makeBaseEnv(),
      OWNER_UID: MY_UID,
      ALLOWED_UIDS: `${MY_UID}, ${secondaryUid}`,
    }
    const resListOk = await handleRequest(
      makeSecondaryReq({
        messages: [{ role: 'user', content: 'oi da conta secundária' }],
        tools: [
          { type: 'function', function: { name: 'propose_meal', parameters: {} } },
          { type: 'function', function: { name: 'propose_expense', parameters: {} } },
          { type: 'function', function: { name: 'get_expense_summary', parameters: {} } },
          { type: 'function', function: { name: 'criar_evento', parameters: {} } },
          { type: 'function', function: { name: 'listar_eventos', parameters: {} } },
        ],
      }),
      listEnv,
      { fetcher, nowMs },
    )
    expect(resListOk.status).toBe(200)
    expect(forwardedTools.map((t) => t.function.name)).toEqual(['propose_meal'])

    // 3. Conta secundária tentando executar calendar_action diretamente recebe HTTP 403
    const resCalForbidden = await handleRequest(
      makeSecondaryReq({
        calendar_action: {
          tool: 'listar_eventos',
          args: { inicio: '2026-11-17T00:00:00-03:00', fim: '2026-11-17T23:59:59-03:00' },
        },
      }),
      listEnv,
      { fetcher, nowMs },
    )
    expect(resCalForbidden.status).toBe(403)
    const calErrBody = (await resCalForbidden.json()) as { error: string }
    expect(calErrBody.error).toContain('Google Calendar')
  })

  it('aplica cota diária persistente por usuário (40 msgs e 10 fotos para conta secundária; 150 msgs e 30 fotos para o dono)', async () => {
    const secondaryUid = 'uid-namorada-123'
    const kvStore = new Map<string, string>()
    const mockKv = {
      async get(key: string) {
        return kvStore.get(key) ?? null
      },
      async put(key: string, value: string) {
        kvStore.set(key, value)
      },
    }

    const env: Env = {
      ...makeBaseEnv(),
      OWNER_UID: MY_UID,
      ALLOWED_UIDS: `${MY_UID},${secondaryUid}`,
      RATE_LIMIT_PER_MIN: '500',
      RATE_LIMIT_KV: mockKv,
    }
    const fetcher = createMockFetcher({
      onGroqCall: () =>
        new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: '{"itens":[]}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })

    const secToken = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: secondaryUid,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    // Pré-popula KV com 39 mensagens usadas hoje pela conta secundária
    const dayKey = new Date(nowMs - 3 * 3600_000).toISOString().slice(0, 10)
    kvStore.set(`quota:msg:${secondaryUid}:${dayKey}`, '39')

    const makeChat = () =>
      new Request('https://worker.example.com/chat', {
        method: 'POST',
        headers: {
          Origin: ALLOWED_ORIGIN,
          Authorization: `Bearer ${secToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'msg 40' }] }),
      })

    // 40ª mensagem passa
    const res40 = await handleRequest(makeChat(), env, { fetcher, nowMs })
    expect(res40.status).toBe(200)
    expect(kvStore.get(`quota:msg:${secondaryUid}:${dayKey}`)).toBe('40')

    // 41ª mensagem é bloqueada com 429 (40/dia)
    const res41 = await handleRequest(makeChat(), env, { fetcher, nowMs })
    expect(res41.status).toBe(429)
    const err41 = (await res41.json()) as { error: string }
    expect(err41.error).toContain('40/dia')

    // Pré-popula KV com 10 fotos usadas hoje pela conta secundária -> 11ª foto retorna 429 (10/dia)
    kvStore.set(`quota:photo:${secondaryUid}:${dayKey}`, '10')
    const photoReq = new Request('https://worker.example.com/analyze-meal', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${secToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }),
    })
    const resPhoto11 = await handleRequest(photoReq, env, { fetcher, nowMs })
    expect(resPhoto11.status).toBe(429)
    const errPhoto = (await resPhoto11.json()) as { error: string }
    expect(errPhoto.error).toContain('10/dia')

    const facultyPhotoReq = new Request('https://worker.example.com/analyze-faculty-schedule', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${secToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }),
    })
    const facultyPhotoRes = await handleRequest(facultyPhotoReq, env, { fetcher, nowMs })
    expect(facultyPhotoRes.status).toBe(429)
    expect((await facultyPhotoRes.json()).error).toContain('10/dia')
  })

  it('recusa corpo maior que 64 KB com 413', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 30,
      exp: nowSec + 3600,
    })

    const hugeContent = 'x'.repeat(70 * 1024)
    const req = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: hugeContent }] }),
    })

    const res = await handleRequest(req, env, { fetcher, nowMs })
    expect(res.status).toBe(413)
  })

  it('recusa campos proibidos (como model ou chaves desconhecidas) com 400', async () => {
    const env = makeBaseEnv()
    const fetcher = createMockFetcher()
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 30,
      exp: nowSec + 3600,
    })

    const reqWithModel = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'modelo-escolhido-pelo-cliente',
        messages: [{ role: 'user', content: 'oi' }],
      }),
    })

    const res = await handleRequest(reqWithModel, env, { fetcher, nowMs })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('model')
  })

  it('usa exclusivamente o secret GROQ_API_KEY do Worker (sem consultar o Firestore) e força openai/gpt-oss-120b com reasoning_effort', async () => {
    const env = { ...makeBaseEnv(), RATE_LIMIT_PER_MIN: '5' }
    let firestoreCalls = 0
    let capturedBody: Record<string, any> = {}
    let capturedGroqAuth = ''

    const fetcher = createMockFetcher({
      onFirestoreCall: () => {
        firestoreCalls++
        return new Response('{}', { status: 200 })
      },
      onGroqCall: (init) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}'))
        capturedGroqAuth = new Headers(init?.headers).get('Authorization') ?? ''
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-ok',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Bons treinos!',
                  reasoning: 'pensamento interno secreto',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    const makeValidReq = () =>
      new Request('https://worker.example.com/chat', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Como está meu volume na semana?' }],
          temperature: 0.3,
          max_tokens: 99999,
        }),
      })

    const res1 = await handleRequest(makeValidReq(), env, { fetcher, nowMs })
    expect(res1.status).toBe(200)
    expect(firestoreCalls).toBe(0)
    expect(capturedGroqAuth).toBe(`Bearer ${VALID_FIRESTORE_KEY}`)
    expect(capturedBody.model).toBe('openai/gpt-oss-120b')
    expect(capturedBody.reasoning_effort).toBe('medium')
    expect(capturedBody.max_tokens).toBe(1024)

    const data1 = (await res1.json()) as any
    expect(data1.choices[0].message.content).toBe('Bons treinos!')
    expect(data1.choices[0].message.reasoning).toBeUndefined()
  })

  it('tenta GROQ_FALLBACK_MODEL (sem reasoning_effort) uma vez se o modelo principal retornar 404 ou 5xx', async () => {
    const env = makeBaseEnv()
    const calledModels: Array<{ model: string; reasoning_effort?: string }> = []

    const fetcher = createMockFetcher({
      onGroqCall: (init) => {
        const b = JSON.parse(String(init?.body ?? '{}'))
        calledModels.push({ model: b.model, reasoning_effort: b.reasoning_effort })
        if (b.model === 'openai/gpt-oss-120b') {
          return new Response(
            JSON.stringify({ error: { message: 'Model unavailable', code: 'model_not_found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-fallback',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Respondido pelo fallback.' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    const req = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Teste de fallback' }],
      }),
    })

    const res = await handleRequest(req, env, { fetcher, nowMs })
    expect(res.status).toBe(200)
    expect(calledModels).toEqual([
      { model: 'openai/gpt-oss-120b', reasoning_effort: 'medium' },
      { model: 'llama-3.3-70b-versatile', reasoning_effort: undefined },
    ])
  })

  it('retorna 503 genérico quando o campo groqApiKey está ausente, formato inválido ou Firestore recusa, sem vazar chave nem logar', async () => {
    const env = makeBaseEnv()
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const makeReq = () =>
      new Request('https://worker.example.com/chat', {
        method: 'POST',
        headers: {
          Origin: ALLOWED_ORIGIN,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Oi' }],
        }),
      })

    // 1. Secret GROQ_API_KEY ausente no Worker
    const envWithoutKey: Env = { ...env, GROQ_API_KEY: undefined }
    const resMissing = await handleRequest(makeReq(), envWithoutKey, { fetcher: createMockFetcher(), nowMs })
    expect(resMissing.status).toBe(503)
    expect(await resMissing.json()).toEqual({ error: 'chave do assistente não configurada' })

    // 2. Formato inválido da chave (não começa com gsk_, curta demais ou contém espaço)
    expect(isValidGroqApiKey('chave-sem-prefixo-123456789012345')).toBe(false)
    expect(isValidGroqApiKey('gsk_curta')).toBe(false)
    expect(isValidGroqApiKey('gsk_com espaco12345678901234567890')).toBe(false)
    expect(isValidGroqApiKey(VALID_FIRESTORE_KEY)).toBe(true)

    const badKey = 'gsk_com espaco invalido 1234567890'
    const envBadKey: Env = { ...env, GROQ_API_KEY: badKey }
    const resBadFormat = await handleRequest(makeReq(), envBadKey, { fetcher: createMockFetcher(), nowMs })
    expect(resBadFormat.status).toBe(503)
    const bodyBadFormat = JSON.stringify(await resBadFormat.json())
    expect(bodyBadFormat).toBe(JSON.stringify({ error: 'chave do assistente não configurada' }))
    expect(bodyBadFormat).not.toContain(badKey)

    // 3. Mesmo se o Groq ecoar a chave num erro ou resposta, ela nunca vaza ao cliente nem em logs
    resetWorkerCachesForTest()
    const fetcherEchoLeak = createMockFetcher({
      onGroqCall: () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `Echo acidental ${VALID_FIRESTORE_KEY}` },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    const resLeakCheck = await handleRequest(makeReq(), env, { fetcher: fetcherEchoLeak, nowMs })
    const leakText = await resLeakCheck.text()
    expect(leakText).not.toContain(VALID_FIRESTORE_KEY)

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
    ].join(' ')
    expect(allLogs).not.toContain(VALID_FIRESTORE_KEY)
    expect(allLogs).not.toContain(badKey)

    logSpy.mockRestore()
    warnSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('agenda (Google Calendar): se faltarem secrets do Google, só a agenda retorna erro claro e o resto do assistente segue funcionando', async () => {
    const envWithoutGoogle = makeBaseEnv()
    const fetcher = createMockFetcher()
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    // 1. Chamada normal de chat continua funcionando normalmente
    const chatReq = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Como está meu treino?' }],
      }),
    })
    const chatRes = await handleRequest(chatReq, envWithoutGoogle, { fetcher, nowMs })
    expect(chatRes.status).toBe(200)

    // 2. Chamada de agenda sem secrets devolve erro claro apenas para a agenda
    const calReq = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        calendar_action: {
          tool: 'listar_eventos',
          args: { inicio: '2026-11-17T00:00:00-03:00', fim: '2026-11-17T23:59:59-03:00' },
        },
      }),
    })
    const calRes = await handleRequest(calReq, envWithoutGoogle, { fetcher, nowMs })
    expect(calRes.status).toBe(200)
    const calData = (await calRes.json()) as { error?: string }
    expect(calData.error).toContain('GOOGLE_CLIENT_ID')
  })

  it('agenda (Google Calendar): criar_evento (duração padrão 1h), listar_eventos, renovação de access token e confirmação obrigatória no código para editar_evento e apagar_evento', async () => {
    const env: Env = {
      ...makeBaseEnv(),
      GOOGLE_CLIENT_ID: 'client-id-mock',
      GOOGLE_CLIENT_SECRET: 'client-secret-mock',
      GOOGLE_REFRESH_TOKEN: 'refresh-token-mock',
    }

    let oauthCalls = 0
    let patchCalls = 0
    let deleteCalls = 0
    let lastCreatedPayload: any = null

    const calFetcher: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === GOOGLE_OAUTH_TOKEN_URL) {
        oauthCalls++
        return new Response(
          JSON.stringify({
            access_token: `ya29.mock_token_${oauthCalls}`,
            expires_in: 120, // 2 min (expira em 60s considerando margem)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === GOOGLE_CALENDAR_EVENTS_URL && method === 'POST') {
        lastCreatedPayload = JSON.parse(String(init?.body ?? '{}'))
        return new Response(
          JSON.stringify({
            id: 'evt-101',
            summary: lastCreatedPayload.summary,
            location: lastCreatedPayload.location,
            description: lastCreatedPayload.description,
            start: lastCreatedPayload.start,
            end: lastCreatedPayload.end,
            htmlLink: 'https://calendar.google.com/calendar/event?eid=evt101',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.startsWith(`${GOOGLE_CALENDAR_EVENTS_URL}?`) && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'evt-101',
                summary: 'Consulta Nutricionista',
                location: 'Av. Paulista, 1000',
                description: 'Levar exames',
                start: { dateTime: '2026-11-17T14:00:00-03:00' },
                end: { dateTime: '2026-11-17T15:00:00-03:00' },
                htmlLink: 'https://calendar.google.com/calendar/event?eid=evt101',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === `${GOOGLE_CALENDAR_EVENTS_URL}/evt-101` && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'evt-101',
            summary: 'Consulta Nutricionista',
            location: 'Av. Paulista, 1000',
            description: 'Levar exames',
            start: { dateTime: '2026-11-17T14:00:00-03:00' },
            end: { dateTime: '2026-11-17T15:00:00-03:00' },
            htmlLink: 'https://calendar.google.com/calendar/event?eid=evt101',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === `${GOOGLE_CALENDAR_EVENTS_URL}/evt-101` && method === 'PATCH') {
        patchCalls++
        const patch = JSON.parse(String(init?.body ?? '{}'))
        return new Response(
          JSON.stringify({
            id: 'evt-101',
            summary: patch.summary ?? 'Consulta Nutricionista',
            location: patch.location ?? 'Av. Paulista, 1000',
            description: patch.description ?? 'Levar exames',
            start: patch.start ?? { dateTime: '2026-11-17T14:00:00-03:00' },
            end: patch.end ?? { dateTime: '2026-11-17T15:00:00-03:00' },
            htmlLink: 'https://calendar.google.com/calendar/event?eid=evt101',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === `${GOOGLE_CALENDAR_EVENTS_URL}/evt-101` && method === 'DELETE') {
        deleteCalls++
        return new Response(null, { status: 204 })
      }

      throw new Error(`URL inesperada no mock de agenda: ${method} ${url}`)
    }

    // 1. criar_evento sem `fim` aplica duração padrão de 1h em America/Sao_Paulo
    const created = await criar_evento(
      {
        titulo: 'Consulta Nutricionista',
        inicio: '2026-11-17T14:00:00-03:00',
        local: 'Av. Paulista, 1000',
        descricao: 'Levar exames',
      },
      env,
      { fetcher: calFetcher, nowMs },
    )
    expect(created.status).toBe('created')
    expect(lastCreatedPayload.start.dateTime).toBe('2026-11-17T14:00:00-03:00')
    expect(lastCreatedPayload.end.dateTime).toBe('2026-11-17T15:00:00-03:00')
    expect(oauthCalls).toBe(1)

    // 2. listar_eventos reutiliza o access_token em cache antes de expirar
    const listed = await listar_eventos(
      { inicio: '2026-11-17T00:00:00-03:00', fim: '2026-11-17T23:59:59-03:00' },
      env,
      { fetcher: calFetcher, nowMs: nowMs + 10_000 },
    )
    expect(listed.status).toBe('listed')
    expect((listed.events as any[])[0].titulo).toBe('Consulta Nutricionista')
    expect(oauthCalls).toBe(1)

    // 3. editar_evento: 1ª chamada (sem confirmado) NÃO faz PATCH, devolve o evento e pede confirmação
    const editPreview = await editar_evento(
      { id: 'evt-101', campos: { titulo: 'Nutricionista Esportivo' } },
      env,
      { fetcher: calFetcher, nowMs: nowMs + 20_000 },
    )
    expect(editPreview.status).toBe('confirmation_required')
    expect(editPreview.requiresConfirmation).toBe(true)
    expect((editPreview.event as any).titulo).toBe('Nutricionista Esportivo')
    expect(patchCalls).toBe(0)

    // 4. editar_evento: 2ª chamada (com confirmado: "confirmado", e simulando expiração do access_token para testar renovação) executa PATCH
    const editConfirmed = await editar_evento(
      { id: 'evt-101', campos: { titulo: 'Nutricionista Esportivo' }, confirmado: 'confirmado' },
      env,
      { fetcher: calFetcher, nowMs: nowMs + 180_000 }, // após expirar o TTL do token
    )
    expect(editConfirmed.status).toBe('updated')
    expect((editConfirmed.event as any).titulo).toBe('Nutricionista Esportivo')
    expect(patchCalls).toBe(1)
    expect(oauthCalls).toBe(2) // renovou o access token automaticamente!

    // 5. apagar_evento: 1ª chamada (sem confirmado) NÃO faz DELETE, devolve o evento e pede confirmação
    const delPreview = await apagar_evento(
      { id: 'evt-101' },
      env,
      { fetcher: calFetcher, nowMs: nowMs + 185_000 },
    )
    expect(delPreview.status).toBe('confirmation_required')
    expect(delPreview.requiresConfirmation).toBe(true)
    expect((delPreview.event as any).id).toBe('evt-101')
    expect(deleteCalls).toBe(0)

    // 6. apagar_evento: 2ª chamada (com confirmado: "confirmado") executa DELETE
    const delConfirmed = await apagar_evento(
      { id: 'evt-101', confirmado: 'confirmado' },
      env,
      { fetcher: calFetcher, nowMs: nowMs + 186_000 },
    )
    expect(delConfirmed.status).toBe('deleted')
    expect(deleteCalls).toBe(1)
  })

  it('/analyze-meal: força o modelo de visão, desliga o raciocínio, aceita foto > 64 KB e valida a entrada', async () => {
    const env = makeBaseEnv()
    let groqBody: any = null
    const fetcher = createMockFetcher({
      onGroqCall: (init) => {
        groqBody = JSON.parse(String(init?.body ?? '{}'))
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"itens":[{"nome":"Arroz","gramas":150,"kcal":195,"proteina_g":4,"carbo_g":42,"gordura_g":0.5,"confianca":"alta"}]}\n```' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })
    const post = (body: unknown) =>
      new Request('https://worker.example.com/analyze-meal', {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    // foto de ~200 KB (acima do limite de 64 KB do chat) é aceita
    const image = `data:image/jpeg;base64,${'A'.repeat(200_000)}`
    const res = await handleRequest(post({ image }), env, { fetcher, nowMs })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { itens: any[] }
    expect(data.itens[0].nome).toBe('Arroz')
    expect(groqBody.model).toBe('qwen/qwen3.6-27b')
    expect(groqBody.reasoning_effort).toBe('none')
    expect(groqBody.response_format).toEqual({ type: 'json_object' })
    expect(groqBody.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: image } })

    // entrada inválida e campos extras
    expect((await handleRequest(post({ image: 'http://evil/x.jpg' }), env, { fetcher, nowMs })).status).toBe(400)
    expect((await handleRequest(post({ image, model: 'outro' }), env, { fetcher, nowMs })).status).toBe(400)

    // resposta não-JSON da IA vira 502 limpo
    const badFetcher = createMockFetcher({
      onGroqCall: () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'não sei' } }] }), { status: 200 }),
    })
    const bad = await handleRequest(post({ image }), env, { fetcher: badFetcher, nowMs })
    expect(bad.status).toBe(502)

    // o chat continua limitado a 64 KB
    const bigChat = new Request('https://worker.example.com/chat', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(70 * 1024) }] }),
    })
    expect((await handleRequest(bigChat, env, { fetcher: badFetcher, nowMs })).status).toBe(413)
  })

  it('/analyze-faculty-schedule: analisa a grade usando a cota de fotos e valida o JSON', async () => {
    const env = makeBaseEnv()
    let groqBody: any = null
    const fetcher = createMockFetcher({
      onGroqCall: (init) => {
        groqBody = JSON.parse(String(init?.body ?? '{}'))
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"aulas":[{"disciplina":"Cálculo II","dia":"segunda-feira","inicio":"08:00","fim":"10:00","sala":"A-101","professor":null}]}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })
    const post = (body: unknown) =>
      new Request('https://worker.example.com/analyze-faculty-schedule', {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    const image = `data:image/jpeg;base64,${'A'.repeat(200_000)}`
    const response = await handleRequest(post({ image }), env, { fetcher, nowMs })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      aulas: [{ disciplina: 'Cálculo II', dia: 'segunda-feira', inicio: '08:00', fim: '10:00', sala: 'A-101', professor: null }],
    })
    expect(groqBody.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: image } })
    expect(groqBody.response_format).toEqual({ type: 'json_object' })

    const invalid = await handleRequest(post({ image, extra: true }), env, { fetcher, nowMs })
    expect(invalid.status).toBe(400)
    expect(parseFacultyScheduleContent('{"aulas":[]}')).toEqual({ aulas: [] })
    expect(() => parseFacultyScheduleContent('{"items":[]}')).toThrow('formato inesperado')
  })

  it('/transcribe: transcreve multipart/form-data com whisper-large-v3-turbo (language=pt, response_format=json, temperature=0) e valida limites', async () => {
    expect(normalizeAudioFilename('gravacao.webm', 'audio/webm;codecs=opus')).toBe('gravacao.webm')
    expect(normalizeAudioFilename('', 'audio/mp4')).toBe('gravacao.m4a')
    expect(normalizeAudioFilename('sem-extensao', 'audio/aac')).toBe('gravacao.m4a')

    const env = makeBaseEnv()
    const token = await signTestJwt({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: MY_UID,
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })

    let capturedForm: any = null
    let capturedAuth = ''

    const baseFetcher = createMockFetcher()
    const transcribeFetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === GROQ_TRANSCRIBE_URL) {
        capturedAuth = new Headers(init?.headers).get('Authorization') ?? ''
        capturedForm = init?.body as FormData
        return new Response(
          JSON.stringify({ text: 'Me lembra às 18 horas de tomar creatina.' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return baseFetcher(input, init)
    }

    // 1. Áudio válido em audio/mp4 (como gravado pelo iPhone iOS Safari/PWA)
    const audioBytes = new Uint8Array(1024).fill(7)
    const audioBlob = new Blob([audioBytes], { type: 'audio/mp4' })
    const form = new FormData()
    form.append('file', audioBlob, 'gravacao.m4a')

    const reqOk = new Request('https://worker.example.com/transcribe', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: form,
    })
    const resOk = await handleRequest(reqOk, env, { fetcher: transcribeFetcher, nowMs })
    expect(resOk.status).toBe(200)
    const dataOk = (await resOk.json()) as { text: string }
    expect(dataOk.text).toBe('Me lembra às 18 horas de tomar creatina.')
    expect(capturedAuth).toBe(`Bearer ${VALID_FIRESTORE_KEY}`)
    expect(capturedForm?.get('model')).toBe('whisper-large-v3-turbo')
    expect(capturedForm?.get('language')).toBe('pt')
    expect(capturedForm?.get('response_format')).toBe('json')
    expect(capturedForm?.get('temperature')).toBe('0')
    const uploadedFile = capturedForm?.get('file') as File
    expect(uploadedFile.name).toBe('gravacao.m4a')

    // 2. Áudio vazio / muito curto (< 256 bytes) -> 400
    const tinyForm = new FormData()
    tinyForm.append('file', new Blob([new Uint8Array(10)], { type: 'audio/webm' }), 'gravacao.webm')
    const reqTiny = new Request('https://worker.example.com/transcribe', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: tinyForm,
    })
    const resTiny = await handleRequest(reqTiny, env, { fetcher: transcribeFetcher, nowMs })
    expect(resTiny.status).toBe(400)
  })
})
