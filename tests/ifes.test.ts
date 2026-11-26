import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, SYNCABLE_SETTINGS, waitPendingOutbox } from '../src/data/db'
import {
  countUnreadNoticias,
  formatIfesPublishedAt,
  markAllIfesNewsRead,
  markIfesNewsRead,
  parseKeywordsInput,
} from '../src/lib/notifications'
import {
  buildFcmHttpV1Message,
  buildPushNotificationsForItems,
  cancel_push_reminder,
  computeNewsId,
  computeNextReminderTriggerAtUtc,
  create_push_reminder,
  IFES_VITORIA_NEWS_URL,
  isCampusVitoriaNewsUrl,
  isFcmTokenInvalidResponse,
  list_push_reminders,
  matchesKeywords,
  normalizeReminderTriggerAtUtc,
  parseIfesDateTimeToIso,
  parseIfesVitoriaHtml,
  parseIfesVitoriaRss,
  parseServiceAccountSecret,
  processDuePushReminders,
  PWA_APP_ICON_URL,
  PWA_APP_NOTICIAS_URL,
  resetIfesCachesForTest,
  runIfesCron,
  selectNewNewsItems,
  signServiceAccountJwt,
  type IfesNewsItem,
  type ServiceAccountCredentials,
} from '../worker/src/ifes'
import {
  GOOGLE_JWKS_URL,
  handleRequest,
  resetWorkerCachesForTest,
  type Env,
  type JsonWebKeyWithKid,
} from '../worker/src/index'

// Fixture real extraído da listagem HTML do portal https://vitoria.ifes.edu.br/noticias (Joomla tile-list-1)
const REAL_IFES_VITORIA_HTML_FIXTURE = `
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <title>Ifes – Campus Vitória - Notícias</title>
</head>
<body>
<div class="tile-list-1">
  <div class="tileItem">
    <div class="span10 tileContent">
      <h2 class="tileHeadline">
        <a href="/noticias/18574-campus-vitoria-divulga-programacao-da-semana-da-memoria-e-da-arte">Campus Vitória divulga programação da Semana da Memória e da Arte</a>
      </h2>
      <span class="description">
        <p>As atividades serão realizadas nos dias 13, 14 e 17 de abril e serão abertas ao público externo; confira a programação.</p>
      </span>
    </div>
    <div class="span2 tileInfo">
      <ul>
        <li><i class="icon-fixed-width icon-calendar"></i> 10/04/26</li>
        <li><i class="icon-fixed-width icon-time"></i> 11h17</li>
      </ul>
    </div>
  </div>

  <div class="tileItem">
    <div class="span10 tileContent">
      <h2 class="tileHeadline">
        <a href="/noticias/18573-estudantes-podem-solicitar-revisao-do-cadastro-unico-dos-programas-da-assistencia-estudantil">Estudantes podem solicitar revisão do Cadastro Único dos Programas da Assistência Estudantil</a>
      </h2>
      <span class="description">
        <p>O prazo para o pedido de revisão vai de 9 a 13 de abril. Também estão abertas novas inscrições ao CadÚnico.</p>
      </span>
    </div>
    <div class="span2 tileInfo">
      <ul>
        <li><i class="icon-fixed-width icon-calendar"></i> 09/04/26</li>
        <li><i class="icon-fixed-width icon-time"></i> 13h36</li>
      </ul>
    </div>
  </div>

  <div class="tileItem">
    <div class="span10 tileContent">
      <h2 class="tileHeadline">
        <a href="/noticias/18572-prorrogadas-as-inscricoes-para-selecao-de-bolsistas-do-programa-partiu-if">Prorrogadas as inscrições para seleção de bolsistas do Programa Partiu IF</a>
      </h2>
      <span class="description">
        <p>Estudantes do Campus Vitória podem se inscrever até 12 de abril para vagas de monitoria com bolsa mensal.</p>
      </span>
    </div>
    <div class="span2 tileInfo">
      <ul>
        <li><i class="icon-fixed-width icon-calendar"></i> 07/04/26</li>
        <li><i class="icon-fixed-width icon-time"></i> 15h06</li>
      </ul>
    </div>
  </div>

  <!-- Item de outro domínio que deve ser filtrado e ignorado pelo filtro estrito do Campus Vitória -->
  <div class="tileItem">
    <div class="span10 tileContent">
      <h2 class="tileHeadline">
        <a href="https://serra.ifes.edu.br/noticias/99999-noticia-de-outro-campus">Notícia do Campus Serra que não deve entrar</a>
      </h2>
      <span class="description">
        <p>Conteúdo de outro campus.</p>
      </span>
    </div>
    <div class="span2 tileInfo">
      <ul>
        <li><i class="icon-fixed-width icon-calendar"></i> 07/04/26</li>
        <li><i class="icon-fixed-width icon-time"></i> 10h00</li>
      </ul>
    </div>
  </div>
</div>
</body>
</html>
`

const REAL_IFES_VITORIA_RSS_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Ifes – Campus Vitória - Notícias</title>
    <link>https://vitoria.ifes.edu.br/noticias</link>
    <item>
      <title>Campus Vitória divulga programação da Semana da Memória e da Arte</title>
      <link>https://vitoria.ifes.edu.br/noticias/18574-campus-vitoria-divulga-programacao-da-semana-da-memoria-e-da-arte</link>
      <description><![CDATA[<p>As atividades serão realizadas nos dias 13, 14 e 17 de abril e serão abertas ao público externo.</p>]]></description>
      <pubDate>Fri, 10 Apr 2026 11:17:02 -0300</pubDate>
    </item>
    <item>
      <title>Notícia externa da Reitoria</title>
      <link>https://ifes.edu.br/noticias/22526-noticia-geral-reitoria</link>
      <description><![CDATA[<p>Não pertence ao subdomínio vitoria.ifes.edu.br</p>]]></description>
      <pubDate>Fri, 10 Apr 2026 10:00:00 -0300</pubDate>
    </item>
  </channel>
</rss>`

function arrayBufferToPemPrivateKey(buffer: ArrayBuffer): string {
  const b64 = Buffer.from(buffer).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? [b64]
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

describe('Notícias do Ifes Campus Vitória — Parser, Filtro, Deduplicação, JWT e Push FCM', () => {
  let rsaPrivateKeyPem: string
  let rsaPublicKey: CryptoKey
  let firebaseIdTokenPrivateKey: CryptoKey
  let firebasePublicJwk: JsonWebKeyWithKid
  const PROJECT_ID = 'meu-treino-2007'
  const OWNER_UID = 'tH4A7sYnH1WDUdBVDd1mfltMPdj2'
  const KID = 'test-kid-ifes-1'

  beforeAll(async () => {
    // Par de chaves RSA para simular a Service Account do Firebase (FCM_SERVICE_ACCOUNT)
    const saPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', saPair.privateKey)
    rsaPrivateKeyPem = arrayBufferToPemPrivateKey(pkcs8)
    rsaPublicKey = saPair.publicKey

    // Par de chaves RSA para assinar ID Token do Firebase nos testes das rotas autenticadas
    const fbPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    firebaseIdTokenPrivateKey = fbPair.privateKey
    const exported = (await crypto.subtle.exportKey('jwk', fbPair.publicKey)) as JsonWebKeyWithKid
    firebasePublicJwk = { ...exported, kid: KID, alg: 'RS256', use: 'sig' }
  })

  beforeEach(async () => {
    resetIfesCachesForTest()
    resetWorkerCachesForTest()
    await db.delete()
    await db.open()
  })

  it('parser HTML e RSS: extrai data (dd/mm/aa), hora (HHhMM), título, resumo e link e filtra SOMENTE Campus Vitória', async () => {
    expect(isCampusVitoriaNewsUrl('https://vitoria.ifes.edu.br/noticias/18574-semana-da-arte')).toBe(true)
    expect(isCampusVitoriaNewsUrl('https://ifes.edu.br/noticias/22526-outro')).toBe(false)
    expect(isCampusVitoriaNewsUrl('https://serra.ifes.edu.br/noticias/123-serra')).toBe(false)
    expect(isCampusVitoriaNewsUrl('https://vitoria.ifes.edu.br/noticias')).toBe(false)

    expect(parseIfesDateTimeToIso('10/04/26', '11h17')).toBe('2026-04-10T11:17:00-03:00')

    const parsedHtml = await parseIfesVitoriaHtml(REAL_IFES_VITORIA_HTML_FIXTURE)
    expect(parsedHtml).toHaveLength(3) // o 4º item é de serra.ifes.edu.br e foi filtrado

    expect(parsedHtml[0]).toMatchObject({
      title: 'Campus Vitória divulga programação da Semana da Memória e da Arte',
      summary:
        'As atividades serão realizadas nos dias 13, 14 e 17 de abril e serão abertas ao público externo; confira a programação.',
      publishedAt: '2026-04-10T11:17:00-03:00',
      url: 'https://vitoria.ifes.edu.br/noticias/18574-campus-vitoria-divulga-programacao-da-semana-da-memoria-e-da-arte',
    })
    expect(parsedHtml[0].id).toMatch(/^vix-[0-9a-f]{20}$/)

    // Hash do link é estável e determinístico
    const sameId = await computeNewsId(parsedHtml[0].url)
    expect(sameId).toBe(parsedHtml[0].id)

    // Fallback RSS também extrai e filtra apenas vitoria.ifes.edu.br
    const parsedRss = await parseIfesVitoriaRss(REAL_IFES_VITORIA_RSS_FIXTURE)
    expect(parsedRss).toHaveLength(1)
    expect(parsedRss[0].url).toBe(parsedHtml[0].url)
    expect(parsedRss[0].id).toBe(parsedHtml[0].id)
  })

  it('deduplicação: selectNewNewsItems retorna apenas notícias cujo id ainda não existe no Firestore', async () => {
    const items = await parseIfesVitoriaHtml(REAL_IFES_VITORIA_HTML_FIXTURE)
    const existing = new Set<string>([items[1].id, items[2].id])
    const onlyNew = selectNewNewsItems(items, existing)
    expect(onlyNew).toHaveLength(1)
    expect(onlyNew[0].id).toBe(items[0].id)
  })

  it('filtro por palavras-chave: case-insensitive, ignora acentos e lista vazia aceita tudo', () => {
    const item: Pick<IfesNewsItem, 'title' | 'summary'> = {
      title: 'Estudantes podem solicitar revisão do Cadastro Único da Assistência Estudantil',
      summary: 'Inscrições abertas para seleção de bolsistas e estágio no Campus Vitória.',
    }

    // Lista vazia = recebe todas
    expect(matchesKeywords(item, [])).toBe(true)
    expect(matchesKeywords(item, ['   '])).toBe(true)

    // Ignora maiúsculas/minúsculas e acentos ("assistencia", "unico", "estagio", "REVISAO")
    expect(matchesKeywords(item, ['assistencia'])).toBe(true)
    expect(matchesKeywords(item, ['CADASTRO UNICO'])).toBe(true)
    expect(matchesKeywords(item, ['mestrado', 'estagio'])).toBe(true)
    expect(matchesKeywords(item, ['mestrado', 'doutorado'])).toBe(false)
  })

  it('agrupamento e limite de pushes: 1ª execução sem push, até 5 individuais e >5 agrupadas em 1 push', () => {
    const makeItems = (count: number): IfesNewsItem[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `id-${i + 1}`,
        title: `Notícia ${i + 1}`,
        summary: `Resumo da notícia ${i + 1}`,
        publishedAt: '2026-04-10T11:17:00-03:00',
        url: `https://vitoria.ifes.edu.br/noticias/${18500 + i}-noticia-${i + 1}`,
      }))

    // 1. Primeira execução (isFirstSeed = true): popula histórico SEM enviar push
    expect(buildPushNotificationsForItems(makeItems(10), [], true)).toEqual([])

    // 2. Até 5 notícias novas: envia 1 notificação para cada notícia
    const threePushes = buildPushNotificationsForItems(makeItems(3), [], false)
    expect(threePushes).toHaveLength(3)
    expect(threePushes[0].title).toBe('Notícia 1')
    expect(threePushes[0].route).toBe('noticias')

    const fivePushes = buildPushNotificationsForItems(makeItems(5), [], false)
    expect(fivePushes).toHaveLength(5)

    // 3. Mais de 5 notícias novas (> 5): agrupa em 1 única notificação "N novas notícias do Ifes"
    const grouped = buildPushNotificationsForItems(makeItems(7), [], false)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].title).toBe('7 novas notícias do Ifes')
    expect(grouped[0].route).toBe('noticias')

    // 4. Payload FCM HTTP v1 trunca o body em 120 caracteres e inclui webpush.fcm_options.link
    const longItem = {
      title: 'Título do Edital',
      body: 'A'.repeat(200),
      url: 'https://vitoria.ifes.edu.br/noticias/18574-edital',
      route: 'noticias' as const,
      newsId: 'hash123',
    }
    const fcmMsg = buildFcmHttpV1Message('token-xyz', longItem) as any
    expect(fcmMsg.message.notification.body.length).toBeLessThanOrEqual(120)
    expect(fcmMsg.message.data.url).toBe('https://vitoria.ifes.edu.br/noticias/18574-edital')
    expect(fcmMsg.message.data.route).toBe('noticias')
    expect(fcmMsg.message.webpush.headers).toEqual({
      TTL: '86400',
      Urgency: 'high',
    })
    expect(fcmMsg.message.webpush.notification.icon).toBe(PWA_APP_ICON_URL)
    expect(fcmMsg.message.webpush.notification.badge).toBe(PWA_APP_ICON_URL)
    expect(fcmMsg.message.webpush.fcm_options.link).toBe(
      'https://vitoria.ifes.edu.br/noticias/18574-edital',
    )

    // 5. Se a URL for relativa (ex.: "./?tab=noticias" no push de teste), normaliza para HTTPS canônico do PWA
    const relativeItem = {
      title: 'Teste de notificação do app',
      body: 'Corpo do teste',
      url: './?tab=noticias',
      route: 'noticias' as const,
      newsId: 'test-push',
    }
    const fcmRelativeMsg = buildFcmHttpV1Message('token-xyz', relativeItem) as any
    expect(fcmRelativeMsg.message.webpush.fcm_options.link).toBe(PWA_APP_NOTICIAS_URL)
    expect(fcmRelativeMsg.message.data.url).toBe(PWA_APP_NOTICIAS_URL)
  })

  it('gera e assina JWT OAuth2 (RS256 via WebCrypto) válido para a Service Account do Firebase', async () => {
    const sa: ServiceAccountCredentials = {
      project_id: PROJECT_ID,
      client_email: 'firebase-adminsdk-test@meu-treino-2007.iam.gserviceaccount.com',
      private_key: rsaPrivateKeyPem,
      token_uri: 'https://oauth2.googleapis.com/token',
    }
    const nowMs = 1_775_830_000_000
    const jwt = await signServiceAccountJwt(
      sa,
      [
        'https://www.googleapis.com/auth/firebase.messaging',
        'https://www.googleapis.com/auth/datastore',
      ],
      nowMs,
    )
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(payload.iss).toBe(sa.client_email)
    expect(payload.sub).toBe(sa.client_email)
    expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
    expect(payload.scope).toContain('https://www.googleapis.com/auth/firebase.messaging')
    expect(payload.scope).toContain('https://www.googleapis.com/auth/datastore')
    expect(payload.exp - payload.iat).toBe(3600)

    // Verifica criptograficamente a assinatura RS256 com a chave pública correspondente
    const signedBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const sigBytes = Buffer.from(parts[2], 'base64url')
    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      rsaPublicKey,
      sigBytes,
      signedBytes,
    )
    expect(isValid).toBe(true)
  })

  it('cron completo (runIfesCron): 1ª execução popula sem push; 2ª execução envia push com filtro de keywords e remove token inválido (UNREGISTERED); 3 falhas seguidas gravam alerta em meta/ifesNoticias', async () => {
    const saJson = JSON.stringify({
      project_id: PROJECT_ID,
      client_email: 'worker@meu-treino-2007.iam.gserviceaccount.com',
      private_key: rsaPrivateKeyPem,
    })

    // Banco Firestore em memória para simular REST API v1
    const firestoreDocs = new Map<string, Record<string, any>>()
    const deletedTokenDocIds: string[] = []
    const fcmSentPayloads: Array<{ token: string; title: string; body: string }> = []
    let currentIfesHtml = REAL_IFES_VITORIA_HTML_FIXTURE

    // Registra 3 tokens em fcmTokens:
    // 1) token válido com keyword "bolsistas" (deve receber apenas a notícia sobre bolsistas)
    // 2) token válido sem keywords (recebe todas)
    // 3) token expirado/inválido que retorna 404 UNREGISTERED no FCM (deve ser removido de fcmTokens!)
    firestoreDocs.set('fcmTokens/tok-keyword', {
      fields: {
        token: { stringValue: 'token-valid-keyword' },
        uid: { stringValue: OWNER_UID },
        enabled: { booleanValue: true },
        keywords: { arrayValue: { values: [{ stringValue: 'bolsistas' }] } },
      },
    })
    firestoreDocs.set('fcmTokens/tok-all', {
      fields: {
        token: { stringValue: 'token-valid-all' },
        uid: { stringValue: OWNER_UID },
        enabled: { booleanValue: true },
        keywords: { arrayValue: { values: [] } },
      },
    })
    firestoreDocs.set('fcmTokens/tok-expired', {
      fields: {
        token: { stringValue: 'token-unregistered-404' },
        uid: { stringValue: OWNER_UID },
        enabled: { booleanValue: true },
        keywords: { arrayValue: { values: [] } },
      },
    })

    const mockFetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'sa-oauth-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.startsWith(IFES_VITORIA_NEWS_URL)) {
        return new Response(currentIfesHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      // FCM HTTP v1 endpoint
      if (url === `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        const targetToken = body.message.token
        if (targetToken === 'token-unregistered-404') {
          return new Response(
            JSON.stringify({
              error: {
                code: 404,
                message: 'Requested entity was not found.',
                status: 'NOT_FOUND',
                details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
              },
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        fcmSentPayloads.push({
          token: targetToken,
          title: body.message.notification.title,
          body: body.message.notification.body,
        })
        return new Response(JSON.stringify({ name: 'projects/meu-treino-2007/messages/msg-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Firestore REST API
      const docsPrefix = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/`
      if (url.startsWith(docsPrefix)) {
        const rel = url.slice(docsPrefix.length).split('?')[0]

        // List collection (GET ifesNoticias ou GET fcmTokens)
        if ((rel === 'ifesNoticias' || rel === 'fcmTokens') && method === 'GET') {
          const docs: any[] = []
          for (const [k, v] of firestoreDocs.entries()) {
            if (k.startsWith(`${rel}/`)) {
              docs.push({
                name: `projects/${PROJECT_ID}/databases/(default)/documents/${k}`,
                fields: v.fields,
              })
            }
          }
          return new Response(JSON.stringify({ documents: docs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (method === 'GET') {
          const existing = firestoreDocs.get(rel)
          if (!existing) {
            return new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 })
          }
          return new Response(
            JSON.stringify({
              name: `projects/${PROJECT_ID}/databases/(default)/documents/${rel}`,
              fields: existing.fields,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (method === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}'))
          firestoreDocs.set(rel, { fields: body.fields })
          return new Response(
            JSON.stringify({
              name: `projects/${PROJECT_ID}/databases/(default)/documents/${rel}`,
              fields: body.fields,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (method === 'DELETE') {
          firestoreDocs.delete(rel)
          deletedTokenDocIds.push(rel)
          return new Response(JSON.stringify({}), { status: 200 })
        }
      }

      throw new Error(`URL inesperada no mock do cron: ${method} ${url}`)
    }

    const env = {
      FIREBASE_PROJECT_ID: PROJECT_ID,
      FCM_SERVICE_ACCOUNT: saJson,
    }

    // 1ª EXECUÇÃO (coleção vazia): popula as 3 notícias no Firestore SEM enviar nenhum push
    const run1 = await runIfesCron(env, { fetcher: mockFetcher, nowMs: 1_775_830_000_000 })
    expect(run1.ok).toBe(true)
    expect(run1.isFirstSeed).toBe(true)
    expect(run1.newItemsCount).toBe(3)
    expect(run1.pushesSent).toBe(0)
    expect(fcmSentPayloads).toHaveLength(0)

    const savedNoticiasCount = [...firestoreDocs.keys()].filter((k) => k.startsWith('ifesNoticias/')).length
    expect(savedNoticiasCount).toBe(3)

    // 2ª EXECUÇÃO: surge 1 nova notícia sobre "bolsistas" no topo da página
    currentIfesHtml = REAL_IFES_VITORIA_HTML_FIXTURE.replace(
      '<div class="tile-list-1">',
      `<div class="tile-list-1">
      <div class="tileItem">
        <div class="span10 tileContent">
          <h2 class="tileHeadline">
            <a href="/noticias/18575-resultado-final-da-selecao-de-bolsistas-de-pesquisa">Resultado final da seleção de bolsistas de pesquisa</a>
          </h2>
          <span class="description">
            <p>Confira a lista de aprovados no edital de iniciação científica do Campus Vitória.</p>
          </span>
        </div>
        <div class="span2 tileInfo">
          <ul>
            <li><i class="icon-fixed-width icon-calendar"></i> 11/04/26</li>
            <li><i class="icon-fixed-width icon-time"></i> 09h30</li>
          </ul>
        </div>
      </div>`,
    )

    const run2 = await runIfesCron(env, { fetcher: mockFetcher, nowMs: 1_775_831_200_000 })
    expect(run2.ok).toBe(true)
    expect(run2.isFirstSeed).toBe(false)
    expect(run2.newItemsCount).toBe(1)
    // tok-keyword e tok-all recebem (2 pushes enviados); tok-expired retorna 404 UNREGISTERED e é removido!
    expect(run2.pushesSent).toBe(2)
    expect(run2.invalidTokensRemoved).toBe(1)
    expect(deletedTokenDocIds).toContain('fcmTokens/tok-expired')
    expect(firestoreDocs.has('fcmTokens/tok-expired')).toBe(false)

    // 3ª, 4ª e 5ª EXECUÇÕES com HTML alterado/vazio (0 itens retornados quando já existiam itens):
    // Não apaga nenhuma notícia e, na 3ª vez consecutiva, grava alerta em meta/ifesNoticias
    currentIfesHtml = '<html><body><div>Layout mudou sem itens</div></body></html>'
    await runIfesCron(env, { fetcher: mockFetcher, nowMs: 1_775_832_400_000 })
    await runIfesCron(env, { fetcher: mockFetcher, nowMs: 1_775_833_600_000 })
    const runZero3 = await runIfesCron(env, { fetcher: mockFetcher, nowMs: 1_775_834_800_000 })

    expect(runZero3.ok).toBe(false)
    expect(runZero3.meta.consecutiveZeroRuns).toBe(3)
    expect(runZero3.meta.alert).toContain('3 execuções seguidas')

    const metaDoc = firestoreDocs.get('meta/ifesNoticias')
    expect(metaDoc?.fields?.consecutiveZeroRuns?.integerValue).toBe('3')
    expect(metaDoc?.fields?.alert?.stringValue).toContain('3 execuções seguidas')
    // Nenhuma notícia existente foi apagada
    expect([...firestoreDocs.keys()].filter((k) => k.startsWith('ifesNoticias/')).length).toBe(4)
  })

  it('detecta códigos de token FCM inválido (SOMENTE 404 UNREGISTERED e 400 INVALID_ARGUMENT) e valida project_id da Service Account', () => {
    expect(
      isFcmTokenInvalidResponse(404, {
        error: {
          status: 'NOT_FOUND',
          details: [{ errorCode: 'UNREGISTERED' }],
        },
      }),
    ).toBe(true)

    // 404 sem UNREGISTERED (ex.: URL/projeto errado) NÃO deve apagar token
    expect(
      isFcmTokenInvalidResponse(404, {
        error: {
          status: 'NOT_FOUND',
          message: 'Project not found',
        },
      }),
    ).toBe(false)

    // 401 THIRD_PARTY_AUTH_ERROR NÃO deve apagar token silenciosamente sem diagnóstico
    expect(
      isFcmTokenInvalidResponse(401, {
        error: {
          code: 401,
          message: 'Third party auth error.',
          status: 'UNAUTHENTICATED',
          details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }],
        },
      }),
    ).toBe(false)

    expect(
      isFcmTokenInvalidResponse(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
        },
      }),
    ).toBe(true)

    expect(
      isFcmTokenInvalidResponse(503, {
        error: {
          status: 'UNAVAILABLE',
          message: 'Temporary server error',
        },
      }),
    ).toBe(false)

    // Validação de project_id no FCM_SERVICE_ACCOUNT
    expect(() =>
      parseServiceAccountSecret(
        JSON.stringify({
          project_id: 'outro-projeto-errado',
          client_email: 'sa@outro-projeto.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        }),
        'meu-treino-2007',
      ),
    ).toThrow(/meu-treino-2007/)
  })

  it('rotas autenticadas GET /ifes/status e POST /push-test exigem Firebase ID token e respeitam ALLOWED_UID', async () => {
    const saJson = JSON.stringify({
      project_id: PROJECT_ID,
      client_email: 'worker@meu-treino-2007.iam.gserviceaccount.com',
      private_key: rsaPrivateKeyPem,
    })
    const nowMs = 1_775_830_000_000
    const nowSec = Math.floor(nowMs / 1000)

    const h = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' })),
    )
    const p = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: `https://securetoken.google.com/${PROJECT_ID}`,
          aud: PROJECT_ID,
          sub: OWNER_UID,
          iat: nowSec - 10,
          exp: nowSec + 3600,
        }),
      ),
    )
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      firebaseIdTokenPrivateKey,
      new TextEncoder().encode(`${h}.${p}`),
    )
    const validIdToken = `${h}.${p}.${bytesToBase64Url(new Uint8Array(sig))}`

    const env: Env = {
      FIREBASE_PROJECT_ID: PROJECT_ID,
      ALLOWED_UID: OWNER_UID,
      ALLOWED_ORIGINS: 'https://ianrtaniguchi.github.io',
      FCM_SERVICE_ACCOUNT: saJson,
    }

    const mockFetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === GOOGLE_JWKS_URL) {
        return new Response(JSON.stringify({ keys: [firebasePublicJwk] }), { status: 200 })
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 })
      }
      if (url.endsWith('/documents/meta/ifesNoticias')) {
        return new Response(
          JSON.stringify({
            fields: {
              lastRunAt: { stringValue: '2026-04-10T14:20:00.000Z' },
              lastNewestId: { stringValue: 'abc123' },
              consecutiveZeroRuns: { integerValue: '0' },
              lastError: { nullValue: null },
              alert: { nullValue: null },
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/documents/ifesNoticias')) {
        return new Response(
          JSON.stringify({
            documents: [{ name: 'doc1' }, { name: 'doc2' }],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/documents/fcmTokens')) {
        return new Response(
          JSON.stringify({
            documents: [
              {
                name: `projects/${PROJECT_ID}/databases/(default)/documents/fcmTokens/fcm_1`,
                fields: {
                  token: { stringValue: 'meu-token-iphone-1234567890' },
                  uid: { stringValue: OWNER_UID },
                  enabled: { booleanValue: true },
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url === `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`) {
        return new Response(JSON.stringify({ name: 'projects/meu-treino-2007/messages/test-1' }), {
          status: 200,
        })
      }
      throw new Error(`URL não esperada: ${url}`)
    }

    // Sem token -> 401
    const unauthRes = await handleRequest(
      new Request('https://worker.example.com/ifes/status', {
        method: 'GET',
        headers: { Origin: 'https://ianrtaniguchi.github.io' },
      }),
      env,
      { fetcher: mockFetcher, nowMs },
    )
    expect(unauthRes.status).toBe(401)

    // GET /ifes/status autenticado -> 200
    const statusRes = await handleRequest(
      new Request('https://worker.example.com/ifes/status', {
        method: 'GET',
        headers: {
          Origin: 'https://ianrtaniguchi.github.io',
          Authorization: `Bearer ${validIdToken}`,
        },
      }),
      env,
      { fetcher: mockFetcher, nowMs },
    )
    expect(statusRes.status).toBe(200)
    const statusBody = (await statusRes.json()) as any
    expect(statusBody.lastRunAt).toBe('2026-04-10T14:20:00.000Z')
    expect(statusBody.totalNoticias).toBe(2)

    // POST /push-test autenticado -> 200
    const pushTestRes = await handleRequest(
      new Request('https://worker.example.com/push-test', {
        method: 'POST',
        headers: {
          Origin: 'https://ianrtaniguchi.github.io',
          Authorization: `Bearer ${validIdToken}`,
        },
      }),
      env,
      { fetcher: mockFetcher, nowMs },
    )
    expect(pushTestRes.status).toBe(200)
    const pushTestBody = (await pushTestRes.json()) as any
    expect(pushTestBody.sent).toBe(1)
    expect(pushTestBody.results[0].ok).toBe(true)
  })

  it('app (Dexie): marca notícias como lidas sem abrir transação explícita (compatível com SyncOutboxMiddleware) e calcula badge de não lidas', async () => {
    expect(SYNCABLE_SETTINGS.has('ifesReadIds')).toBe(true)

    const sampleNews = [
      { id: 'n1', title: 'A', summary: '', publishedAt: '2026-04-10T11:17:00-03:00', url: 'https://vitoria.ifes.edu.br/noticias/1-a' },
      { id: 'n2', title: 'B', summary: '', publishedAt: '2026-04-09T13:36:00-03:00', url: 'https://vitoria.ifes.edu.br/noticias/2-b' },
    ]

    expect(countUnreadNoticias(sampleNews, [])).toBe(2)

    const afterOne = await markIfesNewsRead('n1')
    await waitPendingOutbox()
    expect(afterOne).toEqual(['n1'])
    expect(countUnreadNoticias(sampleNews, afterOne)).toBe(1)

    const afterAll = await markAllIfesNewsRead(['n1', 'n2'])
    await waitPendingOutbox()
    expect(countUnreadNoticias(sampleNews, afterAll)).toBe(0)

    expect(formatIfesPublishedAt('2026-04-10T11:17:00-03:00')).toBe('10/04/26 · 11h17')
    expect(parseKeywordsInput('edital, bolsa,  estágio , EDITAL ')).toEqual([
      'edital',
      'bolsa',
      'estágio',
    ])

    // Verifica que ifesReadIds entrou normalmente na outbox para sincronizar entre aparelhos
    const outboxEntry = await db.outbox.get('settings:ifesReadIds')
    expect(outboxEntry).toBeDefined()
  })

  it('segurança: verifica que firestore.rules protege ifesNoticias, fcmTokens, meta/* e mantém restrição ao UID autorizado', () => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules')
    const rules = fs.readFileSync(rulesPath, 'utf-8')
    expect(rules).toContain('match /ifesNoticias/{docId}')
    expect(rules).toContain('match /fcmTokens/{tokenId}')
    expect(rules).toContain('match /meta/{docId}')
    expect(rules).toContain('match /pushReminders/{reminderId}')
    expect(rules).toContain('allow write: if false;')
  })

  it('lembretes push no Worker: cria, lista, cancela por título/ID e processDuePushReminders dispara FCM HTTP v1 para vencidos (none vs daily/weekly)', async () => {
    // 1. Normalização de data/hora America/Sao_Paulo (-03:00) para ISO UTC
    expect(normalizeReminderTriggerAtUtc('2026-11-26T18:00:00-03:00')).toBe('2026-11-26T21:00:00.000Z')
    expect(normalizeReminderTriggerAtUtc('2026-11-26T07:30')).toBe('2026-11-26T10:30:00.000Z')
    expect(
      computeNextReminderTriggerAtUtc(
        '2026-11-26T21:00:00.000Z',
        'daily',
        Date.parse('2026-11-26T21:01:00.000Z'),
      ),
    ).toBe('2026-11-27T21:00:00.000Z')
    expect(
      computeNextReminderTriggerAtUtc(
        '2026-11-26T21:00:00.000Z',
        'weekly',
        Date.parse('2026-11-26T21:01:00.000Z'),
      ),
    ).toBe('2026-12-03T21:00:00.000Z')

    const saJson = JSON.stringify({
      project_id: PROJECT_ID,
      client_email: 'worker@meu-treino-2007.iam.gserviceaccount.com',
      private_key: rsaPrivateKeyPem,
    })
    const env = {
      FIREBASE_PROJECT_ID: PROJECT_ID,
      FCM_SERVICE_ACCOUNT: saJson,
    }

    const firestoreDocs = new Map<string, Record<string, any>>()
    const sentPushes: any[] = []

    firestoreDocs.set('fcmTokens/tok-owner', {
      fields: {
        token: { stringValue: 'token-iphone-owner-123456' },
        uid: { stringValue: OWNER_UID },
        enabled: { booleanValue: true },
        keywords: { arrayValue: { values: [] } },
      },
    })

    const mockFetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'sa-oauth-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url === `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sentPushes.push(body)
        return new Response(JSON.stringify({ name: 'projects/meu-treino-2007/messages/rem-msg-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const docsPrefix = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/`
      if (url.startsWith(docsPrefix)) {
        const rel = url.slice(docsPrefix.length).split('?')[0]
        if ((rel === 'pushReminders' || rel === 'fcmTokens') && method === 'GET') {
          const docs: any[] = []
          for (const [k, v] of firestoreDocs.entries()) {
            if (k.startsWith(`${rel}/`)) {
              docs.push({
                name: `projects/${PROJECT_ID}/databases/(default)/documents/${k}`,
                fields: v.fields,
              })
            }
          }
          return new Response(JSON.stringify({ documents: docs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (method === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}'))
          firestoreDocs.set(rel, { fields: body.fields })
          return new Response(
            JSON.stringify({
              name: `projects/${PROJECT_ID}/databases/(default)/documents/${rel}`,
              fields: body.fields,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
      }
      throw new Error(`URL não esperada no mock de lembretes: ${method} ${url}`)
    }

    const baseNowMs = Date.parse('2026-11-26T20:00:00.000Z') // 17:00 em America/Sao_Paulo

    // 2. Cria 3 lembretes: 1 único às 18:00 (-03:00), 1 diário às 18:00 (-03:00) e 1 futuro às 22:00 (-03:00)
    const c1 = (await create_push_reminder(
      {
        title: 'Ir pro Jiu-Jitsu',
        body: 'Levar kimono',
        dateTime: '2026-11-26T18:00:00-03:00',
        recurrence: 'none',
      },
      OWNER_UID,
      env,
      { fetcher: mockFetcher, nowMs: baseNowMs },
    )) as any
    expect(c1.status).toBe('created')
    expect(c1.reminder.triggerAt).toBe('2026-11-26T21:00:00.000Z')

    const c2 = (await create_push_reminder(
      {
        title: 'Tomar creatina',
        body: '5g',
        dateTime: '2026-11-26T18:00:00-03:00',
        recurrence: 'daily',
      },
      OWNER_UID,
      env,
      { fetcher: mockFetcher, nowMs: baseNowMs },
    )) as any
    expect(c2.status).toBe('created')

    const c3 = (await create_push_reminder(
      {
        title: 'Estudar Cálculo I',
        dateTime: '2026-11-26T22:00:00-03:00',
        recurrence: 'none',
      },
      OWNER_UID,
      env,
      { fetcher: mockFetcher, nowMs: baseNowMs },
    )) as any
    expect(c3.status).toBe('created')

    // 3. Lista lembretes pendentes (3 itens)
    const listed1 = (await list_push_reminders({}, OWNER_UID, env, {
      fetcher: mockFetcher,
      nowMs: baseNowMs,
    })) as any
    expect(listed1.reminders).toHaveLength(3)

    // 4. Cancela "Estudar Cálculo I" pelo título (sem acento/case-insensitive)
    const cancelled = (await cancel_push_reminder(
      { title: 'estudar calculo i' },
      OWNER_UID,
      env,
      { fetcher: mockFetcher, nowMs: baseNowMs },
    )) as any
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.reminder.status).toBe('cancelled')

    // 5. Executa processDuePushReminders às 18:05 (-03:00, ou seja, 2026-11-26T21:05:00.000Z):
    // Dispara push para "Ir pro Jiu-Jitsu" (marca status = "sent") e "Tomar creatina" (reagenda +1 dia para 2026-11-27T21:00:00.000Z)
    const cronNowMs = Date.parse('2026-11-26T21:05:00.000Z')
    const report = await processDuePushReminders(env, { fetcher: mockFetcher, nowMs: cronNowMs })
    expect(report.dueCount).toBe(2)
    expect(report.pushesSent).toBe(2)
    expect(report.completedCount).toBe(1)
    expect(report.rescheduledCount).toBe(1)
    expect(sentPushes).toHaveLength(2)
    expect(sentPushes[0].message.webpush.headers).toEqual({ TTL: '86400', Urgency: 'high' })

    // Após o disparo, só o lembrete diário reagendado continua como "pending"
    const listedAfter = (await list_push_reminders({}, OWNER_UID, env, {
      fetcher: mockFetcher,
      nowMs: cronNowMs,
    })) as any
    expect(listedAfter.reminders).toHaveLength(1)
    expect(listedAfter.reminders[0].title).toBe('Tomar creatina')
    expect(listedAfter.reminders[0].triggerAt).toBe('2026-11-27T21:00:00.000Z')
  })
})
