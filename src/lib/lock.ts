import { db, getRawRecord, runApplyingRemote } from '../data/db'

/**
 * Chaves locais de segurança e assistente na tabela `settings`.
 * NUNCA são sincronizadas com o Firestore e NUNCA entram/saem em backups JSON.
 */
export const LOCK_SETTING_KEYS = new Set([
  'lockEnabled',
  'lockCredentialId',
  'lockPinHash',
  'lockPinSalt',
  'lockTimeoutMinutes',
  'lockLastUnlockedAt',
  'lockHiddenAt',
  'assistantHistory',
])

/** Padrão ao ativar a tranca: 0 minutos = "sempre ao abrir" (0 segundos). */
export const DEFAULT_LOCK_TIMEOUT_MINUTES = 0

const LS_LOCK_ENABLED = 'meu_treino_lock_enabled'
const LS_LOCK_HIDDEN_AT = 'meu_treino_lock_hidden_at'
const LS_LOCK_UNLOCKED_AT = 'meu_treino_lock_unlocked_at'
const LS_LOCK_TIMEOUT_MIN = 'meu_treino_lock_timeout_min'

function safeSetLocalStorage(key: string, value: string | null) {
  try {
    if (typeof localStorage === 'undefined') return
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // ignora caso localStorage esteja indisponível no ambiente de teste
  }
}

function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// ---------- Estado reativo de bloqueio (para Statusline e App) ----------

type LockStateListener = (locked: boolean) => void
const lockStateListeners = new Set<LockStateListener>()
let currentLockedState: boolean = safeGetLocalStorage(LS_LOCK_ENABLED) === '1'

export function getLockedState(): boolean {
  return currentLockedState
}

export function setLockedState(locked: boolean): void {
  currentLockedState = locked
  for (const fn of lockStateListeners) fn(currentLockedState)
}

export function subscribeLockedState(fn: LockStateListener): () => void {
  lockStateListeners.add(fn)
  fn(currentLockedState)
  return () => lockStateListeners.delete(fn)
}

// ---------- Codificação base64url ----------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlToBytes(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// ---------- Validação e Hash de PIN via Web Crypto (PBKDF2-SHA256) ----------

export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin)
}

export function generateSalt(length = 16): string {
  const buf = new Uint8Array(length)
  crypto.getRandomValues(buf)
  return bytesToBase64Url(buf)
}

export async function hashPin(pin: string, saltB64: string): Promise<string> {
  if (!isValidPin(pin)) {
    throw new Error('O PIN deve conter de 4 a 6 dígitos numéricos.')
  }
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const saltBytes = base64UrlToBytes(saltB64)
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as BufferSource,
      iterations: 60_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  )
  return bytesToBase64Url(new Uint8Array(bits))
}

export async function verifyPin(pin: string, saltB64: string, expectedHashB64: string): Promise<boolean> {
  if (!isValidPin(pin) || !saltB64 || !expectedHashB64) return false
  const computed = await hashPin(pin, saltB64)
  // Comparação em tempo constante
  if (computed.length !== expectedHashB64.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedHashB64.charCodeAt(i)
  }
  return diff === 0
}

// ---------- Lógica de bloqueio (abertura a frio, retorno de segundo plano e backoff) ----------

/**
 * Na abertura a frio (cold start), se a tranca estiver ativada (`enabled === true`),
 * deve começar SEMPRE bloqueada (`true`) antes de renderizar qualquer conteúdo.
 */
export function shouldLockOnColdStart(enabled: boolean): boolean {
  return enabled === true
}

/**
 * Retorna `true` se o tempo em segundo plano (`now - hiddenAt`) atingiu ou ultrapassou `timeoutMinutes`.
 * Quando `timeoutMinutes === 0` ("sempre ao abrir"), bloqueia imediatamente em qualquer retorno (`now >= hiddenAt`).
 */
export function shouldLockAfterBackground(
  hiddenAt: number | null,
  now: number,
  timeoutMinutes: number,
): boolean {
  if (hiddenAt === null || hiddenAt <= 0) return false
  const mins = Math.max(0, timeoutMinutes)
  if (mins === 0) return now >= hiddenAt
  return now - hiddenAt >= mins * 60_000
}

/**
 * Calcula o atraso de espera (em ms) após `failedAttempts` tentativas incorretas de PIN.
 *  - 0 ou 1 erro: 0ms
 *  - 2 erros: 2.000ms (2s)
 *  - 3 erros: 4.000ms (4s)
 *  - 4 erros: 8.000ms (8s)
 *  - 5 erros: 16.000ms (16s)
 *  - 6+ erros: 30.000ms (30s máx)
 */
export function computePinBackoffMs(failedAttempts: number): number {
  if (failedAttempts <= 1) return 0
  const ms = 1000 * Math.pow(2, failedAttempts - 1)
  return Math.min(30_000, ms)
}

export function formatTimeoutLabel(timeoutMinutes: number): string {
  if (timeoutMinutes <= 0) return 'sempre ao abrir (0s)'
  return `${timeoutMinutes} min`
}

// ---------- WebAuthn (Face ID / Touch ID via autenticador de plataforma) ----------

export function isPlatformWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator?.credentials?.create === 'function' &&
    typeof navigator?.credentials?.get === 'function'
  )
}

function describeWebAuthnError(err: unknown, action: 'registro' | 'autenticacao'): string {
  const e = err as { name?: string; message?: string } | undefined
  const name = e?.name ?? ''
  const msg = e?.message ?? ''
  if (name === 'NotAllowedError') {
    return action === 'registro'
      ? 'error: permissão do Face ID negada ou cancelada pelo usuário (NotAllowedError).'
      : 'error: verificação do Face ID cancelada ou não permitida (NotAllowedError).'
  }
  if (name === 'NotSupportedError') {
    return 'error: autenticador de plataforma (Face ID) não suportado neste contexto (NotSupportedError).'
  }
  if (name === 'SecurityError') {
    return `error: domínio inseguro para WebAuthn (${typeof window !== 'undefined' ? window.location.origin : 'origem'}) — use HTTPS ou localhost (SecurityError).`
  }
  if (name === 'InvalidStateError') {
    return 'error: credencial biométrica já registrada ou estado inválido (InvalidStateError).'
  }
  if (msg) {
    return msg.startsWith('error:') ? msg : `error: ${msg}`
  }
  return `error: falha inesperada no WebAuthn (${action}).`
}

/**
 * Registra uma credencial WebAuthn de plataforma (Face ID no iOS) e retorna o `credentialId` (base64url).
 * Deve ser chamado diretamente a partir de um gesto de toque do usuário.
 */
export async function registerBiometricCredential(): Promise<string> {
  if (!isPlatformWebAuthnSupported()) {
    throw new Error('error: WebAuthn / Face ID não suportado neste navegador (abra no Safari ou no app instalado na Tela de Início).')
  }
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  const userId = new Uint8Array(16)
  crypto.getRandomValues(userId)

  let cred: PublicKeyCredential | null = null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: {
          name: 'Meu Treino',
          id: window.location.hostname || 'localhost',
        },
        user: {
          id: userId,
          name: 'local-user',
          displayName: 'Meu Treino',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60_000,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null
  } catch (err) {
    throw new Error(describeWebAuthnError(err, 'registro'))
  }

  if (!cred || !cred.rawId) {
    throw new Error('error: registro do Face ID cancelado ou nenhuma credencial retornada.')
  }
  return bytesToBase64Url(new Uint8Array(cred.rawId))
}

/**
 * Solicita verificação biométrica (Face ID) para o `credentialId` salvo.
 * Deve partir sempre de um toque do usuário (exigência do iOS WebKit).
 */
export async function authenticateBiometricCredential(credentialIdB64: string): Promise<boolean> {
  if (!isPlatformWebAuthnSupported() || !credentialIdB64) {
    throw new Error('error: Face ID indisponível.')
  }
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  const rawId = base64UrlToBytes(credentialIdB64)

  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [
          {
            type: 'public-key',
            id: rawId as BufferSource,
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null

    return Boolean(assertion && assertion.rawId)
  } catch (err) {
    throw new Error(describeWebAuthnError(err, 'autenticacao'))
  }
}

// ---------- Persistência local da configuração e timestamps de bloqueio (sem entrar na outbox) ----------

export interface LockConfig {
  enabled: boolean
  credentialId: string | null
  pinHash: string | null
  pinSalt: string | null
  timeoutMinutes: number
  lastUnlockedAt: number | null
  hiddenAt: number | null
}

export async function getLockConfig(): Promise<LockConfig> {
  const [en, cred, hash, salt, to, unlockedAt, hiddenAt] = await Promise.all([
    getRawRecord('settings', 'lockEnabled'),
    getRawRecord('settings', 'lockCredentialId'),
    getRawRecord('settings', 'lockPinHash'),
    getRawRecord('settings', 'lockPinSalt'),
    getRawRecord('settings', 'lockTimeoutMinutes'),
    getRawRecord('settings', 'lockLastUnlockedAt'),
    getRawRecord('settings', 'lockHiddenAt'),
  ])
  const enabled = en && !en.deleted ? en.value === true : false
  const credentialId = cred && !cred.deleted && typeof cred.value === 'string' ? cred.value : null
  const pinHash = hash && !hash.deleted && typeof hash.value === 'string' ? hash.value : null
  const pinSalt = salt && !salt.deleted && typeof salt.value === 'string' ? salt.value : null
  const timeoutMinutes =
    to && !to.deleted && typeof to.value === 'number' ? to.value : DEFAULT_LOCK_TIMEOUT_MINUTES
  const lastUnlockedVal =
    unlockedAt && !unlockedAt.deleted && typeof unlockedAt.value === 'number'
      ? unlockedAt.value
      : Number(safeGetLocalStorage(LS_LOCK_UNLOCKED_AT) || 0) || null
  const hiddenVal =
    hiddenAt && !hiddenAt.deleted && typeof hiddenAt.value === 'number'
      ? hiddenAt.value
      : Number(safeGetLocalStorage(LS_LOCK_HIDDEN_AT) || 0) || null

  safeSetLocalStorage(LS_LOCK_ENABLED, enabled ? '1' : '0')
  safeSetLocalStorage(LS_LOCK_TIMEOUT_MIN, String(timeoutMinutes))

  return {
    enabled,
    credentialId,
    pinHash,
    pinSalt,
    timeoutMinutes,
    lastUnlockedAt: lastUnlockedVal,
    hiddenAt: hiddenVal,
  }
}

export async function saveLockSetup(
  credentialId: string,
  pin: string,
  timeoutMinutes = DEFAULT_LOCK_TIMEOUT_MINUTES,
): Promise<void> {
  const salt = generateSalt()
  const hash = await hashPin(pin, salt)
  const now = Date.now()
  safeSetLocalStorage(LS_LOCK_ENABLED, '1')
  safeSetLocalStorage(LS_LOCK_TIMEOUT_MIN, String(timeoutMinutes))
  safeSetLocalStorage(LS_LOCK_UNLOCKED_AT, String(now))
  safeSetLocalStorage(LS_LOCK_HIDDEN_AT, null)

  await runApplyingRemote(async () => {
    await db.settings.bulkPut([
      { key: 'lockEnabled', value: true, updatedAt: now, deleted: false },
      { key: 'lockCredentialId', value: credentialId, updatedAt: now, deleted: false },
      { key: 'lockPinHash', value: hash, updatedAt: now, deleted: false },
      { key: 'lockPinSalt', value: salt, updatedAt: now, deleted: false },
      { key: 'lockTimeoutMinutes', value: timeoutMinutes, updatedAt: now, deleted: false },
      { key: 'lockLastUnlockedAt', value: now, updatedAt: now, deleted: false },
      { key: 'lockHiddenAt', value: null, updatedAt: now, deleted: false },
    ])
  })
  // Ao acabar de configurar na aba Config, considera a sessão atual recém-desbloqueada
  setLockedState(false)
}

export async function disableLock(): Promise<void> {
  const now = Date.now()
  safeSetLocalStorage(LS_LOCK_ENABLED, '0')
  safeSetLocalStorage(LS_LOCK_HIDDEN_AT, null)
  safeSetLocalStorage(LS_LOCK_UNLOCKED_AT, null)

  await runApplyingRemote(async () => {
    await db.settings.bulkPut([
      { key: 'lockEnabled', value: false, updatedAt: now, deleted: false },
      { key: 'lockCredentialId', value: null, updatedAt: now, deleted: false },
      { key: 'lockPinHash', value: null, updatedAt: now, deleted: false },
      { key: 'lockPinSalt', value: null, updatedAt: now, deleted: false },
      { key: 'lockLastUnlockedAt', value: null, updatedAt: now, deleted: false },
      { key: 'lockHiddenAt', value: null, updatedAt: now, deleted: false },
    ])
  })
  setLockedState(false)
}

export async function setLockTimeoutMinutes(minutes: number): Promise<void> {
  const clean = Math.max(0, minutes)
  const now = Date.now()
  safeSetLocalStorage(LS_LOCK_TIMEOUT_MIN, String(clean))
  await runApplyingRemote(async () => {
    await db.settings.put({
      key: 'lockTimeoutMinutes',
      value: clean,
      updatedAt: now,
      deleted: false,
    })
  })
}

/**
 * Persiste o instante em que o app foi desbloqueado com sucesso (em localStorage e no IndexedDB local).
 */
export async function recordUnlockTimestamp(now = Date.now()): Promise<void> {
  safeSetLocalStorage(LS_LOCK_UNLOCKED_AT, String(now))
  safeSetLocalStorage(LS_LOCK_HIDDEN_AT, null)
  setLockedState(false)
  await runApplyingRemote(async () => {
    await db.settings.bulkPut([
      { key: 'lockLastUnlockedAt', value: now, updatedAt: now, deleted: false },
      { key: 'lockHiddenAt', value: null, updatedAt: now, deleted: false },
    ])
  })
}

/**
 * Persiste o instante em que o app foi enviado para segundo plano (em localStorage e no IndexedDB local).
 */
export async function recordHiddenTimestamp(now = Date.now()): Promise<void> {
  safeSetLocalStorage(LS_LOCK_HIDDEN_AT, String(now))
  await runApplyingRemote(async () => {
    await db.settings.put({
      key: 'lockHiddenAt',
      value: now,
      updatedAt: now,
      deleted: false,
    })
  })
}

/**
 * Lê o instante persistido em que o app foi para segundo plano (com leitura síncrona de fallback via localStorage).
 */
export async function getPersistedHiddenAt(): Promise<number | null> {
  const lsVal = Number(safeGetLocalStorage(LS_LOCK_HIDDEN_AT) || 0)
  if (lsVal > 0) return lsVal
  const row = await getRawRecord('settings', 'lockHiddenAt')
  if (row && !row.deleted && typeof row.value === 'number' && row.value > 0) {
    return row.value
  }
  return null
}
