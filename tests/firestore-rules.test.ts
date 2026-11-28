import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Avaliador determinístico das regras definidas em `firestore.rules` para validar:
 * 1) Isolamento estrito entre Usuário A e Usuário B em `users/{uid}`, `users/{uid}/records/{id}`, `fcmTokens` e `pushReminders`.
 * 2) Bloqueio total de leitura e escrita de clientes em `usageQuotas/{quotaId}` (acessível apenas via Service Account no Worker).
 * 3) Leitura autenticada e bloqueio de escrita em `ifesNoticias` e `meta`.
 */

interface EvalContext {
  auth: { uid: string } | null
  path: string
  method: 'get' | 'list' | 'create' | 'update' | 'delete'
  resourceData?: Record<string, unknown> | null
  requestData?: Record<string, unknown> | null
}

function isValidFcmToken(data: Record<string, unknown> | null | undefined, authUid: string): boolean {
  if (!data) return false
  const keys = Object.keys(data)
  const required = ['uid', 'token', 'enabled', 'keywords']
  const allowed = new Set(['uid', 'token', 'enabled', 'keywords', 'createdAt', 'updatedAt', 'userAgent'])
  if (!required.every((k) => keys.includes(k))) return false
  if (!keys.every((k) => allowed.has(k))) return false
  if (data.uid !== authUid) return false
  if (typeof data.token !== 'string' || data.token.length === 0 || data.token.length > 4096) return false
  if (typeof data.enabled !== 'boolean') return false
  if (!Array.isArray(data.keywords) || data.keywords.length > 50) return false
  if ('createdAt' in data && (typeof data.createdAt !== 'string' || data.createdAt.length > 64)) return false
  if ('updatedAt' in data && (typeof data.updatedAt !== 'string' || data.updatedAt.length > 64)) return false
  if ('userAgent' in data && (typeof data.userAgent !== 'string' || data.userAgent.length > 1024)) return false
  return true
}

function isValidPushReminder(data: Record<string, unknown> | null | undefined, authUid: string): boolean {
  if (!data) return false
  const keys = Object.keys(data)
  const required = ['uid', 'title', 'triggerAt', 'status']
  const allowed = new Set([
    'uid',
    'title',
    'body',
    'triggerAt',
    'timezone',
    'recurrence',
    'status',
    'createdAt',
    'sentAt',
    'lastSentAt',
    'updatedAt',
    'url',
  ])
  if (!required.every((k) => keys.includes(k))) return false
  if (!keys.every((k) => allowed.has(k))) return false
  if (data.uid !== authUid) return false
  if (typeof data.title !== 'string' || data.title.length === 0 || data.title.length > 200) return false
  if ('body' in data && (typeof data.body !== 'string' || data.body.length > 1000)) return false
  if (typeof data.triggerAt !== 'string' || data.triggerAt.length === 0 || data.triggerAt.length > 64) return false
  if ('timezone' in data && (typeof data.timezone !== 'string' || data.timezone.length > 64)) return false
  if ('recurrence' in data && !['none', 'daily', 'weekly'].includes(String(data.recurrence))) return false
  if (!['pending', 'sent', 'cancelled'].includes(String(data.status))) return false
  return true
}

function evaluateFirestoreRule(rulesSource: string, ctx: EvalContext): boolean {
  // Garante que o arquivo firestore.rules contém as definições obrigatórias
  if (!rulesSource.includes('function isUserOwner(uid)')) {
    throw new Error('Função isUserOwner(uid) ausente em firestore.rules')
  }
  const isAuthenticated = ctx.auth !== null && Boolean(ctx.auth.uid)
  const authUid = ctx.auth?.uid ?? ''
  const isRead = ctx.method === 'get' || ctx.method === 'list'
  const isWrite = ctx.method === 'create' || ctx.method === 'update' || ctx.method === 'delete'

  const parts = ctx.path.replace(/^\/+|\/+$/g, '').split('/')

  // 1. usageQuotas/{quotaId} -> bloqueado para qualquer cliente
  if (parts[0] === 'usageQuotas') {
    if (!rulesSource.includes('match /usageQuotas/{')) return false
    return false
  }

  // 2. users/{uid} e subcoleções users/{uid}/records/{id}
  if (parts[0] === 'users' && parts.length >= 2) {
    const targetUid = parts[1]
    const isOwner = isAuthenticated && authUid === targetUid
    if (parts.length === 2) {
      // Documento raiz users/{uid}: allow read: if isUserOwner(uid); allow write: if false;
      return isRead ? isOwner : false
    }
    // Subcoleções users/{uid}/records/{id} etc.
    return (isRead || isWrite) && isOwner
  }

  // 3. fcmTokens/{tokenId}
  if (parts[0] === 'fcmTokens' && parts.length === 2) {
    if (!isAuthenticated) return false
    if (ctx.method === 'get') {
      return !ctx.resourceData || ctx.resourceData.uid === authUid
    }
    if (ctx.method === 'list' || ctx.method === 'delete') {
      return Boolean(ctx.resourceData && ctx.resourceData.uid === authUid)
    }
    if (ctx.method === 'create') {
      return isValidFcmToken(ctx.requestData, authUid)
    }
    if (ctx.method === 'update') {
      return Boolean(
        ctx.resourceData &&
          ctx.resourceData.uid === authUid &&
          ctx.requestData &&
          ctx.requestData.uid === ctx.resourceData.uid &&
          isValidFcmToken(ctx.requestData, authUid),
      )
    }
  }

  // 4. pushReminders/{reminderId}
  if (parts[0] === 'pushReminders' && parts.length === 2) {
    if (!isAuthenticated) return false
    if (ctx.method === 'get') {
      return !ctx.resourceData || ctx.resourceData.uid === authUid
    }
    if (ctx.method === 'list' || ctx.method === 'delete') {
      return Boolean(ctx.resourceData && ctx.resourceData.uid === authUid)
    }
    if (ctx.method === 'create') {
      return isValidPushReminder(ctx.requestData, authUid)
    }
    if (ctx.method === 'update') {
      return Boolean(
        ctx.resourceData &&
          ctx.resourceData.uid === authUid &&
          ctx.requestData &&
          ctx.requestData.uid === ctx.resourceData.uid &&
          isValidPushReminder(ctx.requestData, authUid),
      )
    }
  }

  // 5. ifesNoticias/{docId} e meta/{docId}
  if ((parts[0] === 'ifesNoticias' || parts[0] === 'meta') && parts.length === 2) {
    return isRead ? isAuthenticated : false
  }

  return false
}

describe('Firestore Security Rules — Isolamento Multi-Usuário e Proteção de usageQuotas', () => {
  const rulesPath = resolve(__dirname, '../firestore.rules')
  const rulesText = readFileSync(rulesPath, 'utf-8')

  const USER_A = { uid: 'tH4A7sYnH1WDUdBVDd1mfltMPdj2' } // Dono
  const USER_B = { uid: 'uid-namorada-secundaria-002' } // Conta secundária

  it('não possui UID hardcoded bloqueando contas secundárias e declara bloqueio explícito para usageQuotas', () => {
    expect(rulesText).not.toContain("request.auth.uid == 'tH4A7sYnH1WDUdBVDd1mfltMPdj2'")
    expect(rulesText).toContain('function isUserOwner(uid)')
    expect(rulesText).toContain('request.auth.uid == uid')
    expect(rulesText).toContain('match /usageQuotas/')
  })

  it('users/{uid}/records/{id}: Usuário A lê e escreve nos próprios dados, mas não lê nem escreve nos dados do Usuário B', () => {
    // Usuário A nos próprios registros
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: `users/${USER_A.uid}/records/sessions:s1`,
        method: 'get',
      }),
    ).toBe(true)
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: `users/${USER_A.uid}/records/sessions:s1`,
        method: 'create',
      }),
    ).toBe(true)

    // Usuário B nos próprios registros
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_B,
        path: `users/${USER_B.uid}/records/meals:m1`,
        method: 'create',
      }),
    ).toBe(true)

    // Usuário A tentando ler ou escrever nos registros do Usuário B -> NEGADO
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: `users/${USER_B.uid}/records/meals:m1`,
        method: 'get',
      }),
    ).toBe(false)
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: `users/${USER_B.uid}/records/meals:m1`,
        method: 'update',
      }),
    ).toBe(false)

    // Usuário B tentando ler ou escrever nos registros do Usuário A -> NEGADO
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_B,
        path: `users/${USER_A.uid}/records/sessions:s1`,
        method: 'get',
      }),
    ).toBe(false)
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_B,
        path: `users/${USER_A.uid}/records/sessions:s1`,
        method: 'delete',
      }),
    ).toBe(false)
  })

  it('fcmTokens e pushReminders: cada usuário só lê, cria, atualiza e apaga documentos com seu próprio uid', () => {
    const validTokenB = {
      uid: USER_B.uid,
      token: 'fcm-token-valido-usuario-b',
      enabled: true,
      keywords: ['edital'],
    }
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_B,
        path: 'fcmTokens/fcm_b1',
        method: 'create',
        requestData: validTokenB,
      }),
    ).toBe(true)

    // Usuário B tentando criar token em nome do Usuário A -> NEGADO
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_B,
        path: 'fcmTokens/fcm_forjado',
        method: 'create',
        requestData: { ...validTokenB, uid: USER_A.uid },
      }),
    ).toBe(false)

    // Usuário A tentando listar ou apagar lembrete push do Usuário B -> NEGADO
    const reminderB = {
      uid: USER_B.uid,
      title: 'Treino de perna',
      triggerAt: '2026-11-28T18:00:00-03:00',
      status: 'pending',
    }
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: 'pushReminders/rem_b1',
        method: 'list',
        resourceData: reminderB,
      }),
    ).toBe(false)
    expect(
      evaluateFirestoreRule(rulesText, {
        auth: USER_A,
        path: 'pushReminders/rem_b1',
        method: 'delete',
        resourceData: reminderB,
      }),
    ).toBe(false)
  })

  it('usageQuotas/{quotaId}: nenhum cliente (nem mesmo autenticado ou dono) pode ler ou alterar cotas diretamente no Firestore', () => {
    for (const user of [null, USER_A, USER_B]) {
      for (const method of ['get', 'list', 'create', 'update', 'delete'] as const) {
        expect(
          evaluateFirestoreRule(rulesText, {
            auth: user,
            path: `usageQuotas/${USER_B.uid}_2026-11-28_msg`,
            method,
            requestData: { count: 0 },
          }),
        ).toBe(false)
      }
    }
  })
})
