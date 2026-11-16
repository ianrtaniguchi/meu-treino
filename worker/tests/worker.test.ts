import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFirestoreUserDocUrl,
  FIRESTORE_KEY_CACHE_TTL_MS,
  GOOGLE_JWKS_URL,
  GROQ_CHAT_URL,
  handleRequest,
  isValidGroqApiKey,
  resetWorkerCachesForTest,
  type Env,
  type JsonWebKeyWithKid,
} from '../src/index'

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
    GROQ_MODEL: 'openai/gpt-oss-120b',
    GROQ_FALLBACK_MODEL: 'llama-3.3-70b-versatile',
    GROQ_REASONING_EFFORT: 'medium',
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ALLOWED_UID: MY_UID,
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

  it('busca chave no Firestore com sucesso, aplica cache de 5 minutos por UID e força openai/gpt-oss-120b com reasoning_effort', async () => {
    const env = { ...makeBaseEnv(), RATE_LIMIT_PER_MIN: '5' }
    let firestoreCalls = 0
    let firestoreAuthHeader = ''
    let capturedBody: Record<string, any> = {}
    let capturedGroqAuth = ''

    const fetcher = createMockFetcher({
      onFirestoreCall: (init) => {
        firestoreCalls++
        firestoreAuthHeader = new Headers(init?.headers).get('Authorization') ?? ''
        return new Response(
          JSON.stringify({
            fields: {
              groqApiKey: { stringValue: VALID_FIRESTORE_KEY },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
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

    // 1ª chamada: busca no Firestore
    const res1 = await handleRequest(makeValidReq(), env, { fetcher, nowMs })
    expect(res1.status).toBe(200)
    expect(firestoreCalls).toBe(1)
    expect(firestoreAuthHeader).toBe(`Bearer ${token}`)
    expect(capturedGroqAuth).toBe(`Bearer ${VALID_FIRESTORE_KEY}`)
    expect(capturedBody.model).toBe('openai/gpt-oss-120b')
    expect(capturedBody.reasoning_effort).toBe('medium')
    expect(capturedBody.max_tokens).toBe(1024)

    const data1 = (await res1.json()) as any
    expect(data1.choices[0].message.content).toBe('Bons treinos!')
    expect(data1.choices[0].message.reasoning).toBeUndefined()

    // 2ª chamada dentro dos 5 minutos: usa cache em memória (NÃO consulta o Firestore de novo)
    const res2 = await handleRequest(makeValidReq(), env, { fetcher, nowMs: nowMs + 60_000 })
    expect(res2.status).toBe(200)
    expect(firestoreCalls).toBe(1)

    // 3ª chamada após expirar o TTL de 5 minutos: consulta o Firestore novamente
    const res3 = await handleRequest(makeValidReq(), env, {
      fetcher,
      nowMs: nowMs + FIRESTORE_KEY_CACHE_TTL_MS + 1000,
    })
    expect(res3.status).toBe(200)
    expect(firestoreCalls).toBe(2)
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

    // 1. Campo groqApiKey ausente no documento users/{uid}
    const fetcherMissingField = createMockFetcher({
      onFirestoreCall: () =>
        new Response(JSON.stringify({ fields: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    const resMissing = await handleRequest(makeReq(), env, { fetcher: fetcherMissingField, nowMs })
    expect(resMissing.status).toBe(503)
    expect(await resMissing.json()).toEqual({ error: 'chave do assistente não configurada' })

    // 2. Firestore recusa (403 Forbidden ou 404 Not Found)
    resetWorkerCachesForTest()
    const fetcherRefused = createMockFetcher({
      onFirestoreCall: () =>
        new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    const resRefused = await handleRequest(makeReq(), env, { fetcher: fetcherRefused, nowMs })
    expect(resRefused.status).toBe(503)
    expect(await resRefused.json()).toEqual({ error: 'chave do assistente não configurada' })

    // 3. Formato inválido da chave (não começa com gsk_, curta demais ou contém espaço)
    expect(isValidGroqApiKey('chave-sem-prefixo-123456789012345')).toBe(false)
    expect(isValidGroqApiKey('gsk_curta')).toBe(false)
    expect(isValidGroqApiKey('gsk_com espaco12345678901234567890')).toBe(false)
    expect(isValidGroqApiKey(VALID_FIRESTORE_KEY)).toBe(true)

    resetWorkerCachesForTest()
    const badKey = 'gsk_com espaco invalido 1234567890'
    const fetcherBadFormat = createMockFetcher({
      onFirestoreCall: () =>
        new Response(
          JSON.stringify({ fields: { groqApiKey: { stringValue: badKey } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    const resBadFormat = await handleRequest(makeReq(), env, { fetcher: fetcherBadFormat, nowMs })
    expect(resBadFormat.status).toBe(503)
    const bodyBadFormat = JSON.stringify(await resBadFormat.json())
    expect(bodyBadFormat).toBe(JSON.stringify({ error: 'chave do assistente não configurada' }))
    expect(bodyBadFormat).not.toContain(badKey)

    // 4. Mesmo se o Groq ecoar a chave num erro ou resposta, ela nunca vaza ao cliente nem em logs
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
})
