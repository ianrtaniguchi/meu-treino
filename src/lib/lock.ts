import { db, getRawRecord, runApplyingRemote } from '../data/db'

/**
 * Chaves locais de segurança na tabela `settings`.
 * NUNCA são sincronizadas com o Firestore e NUNCA entram/saem em backups JSON.
 */
export const LOCK_SETTING_KEYS = new Set([
  'lockEnabled',
  'lockCredentialId',
  'lockPinHash',
  'lockPinSalt',
  'lockTimeoutMinutes',
  'assistantHistory',
])

export const DEFAULT_LOCK_TIMEOUT_MINUTES = 1

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

// ---------- Timeout de bloqueio em segundo plano e atraso crescente de tentativas ----------

/**
 * Retorna `true` se o tempo em segundo plano (`now - hiddenAt`) atingiu ou ultrapassou `timeoutMinutes`.
 */
export function shouldLockAfterBackground(
  hiddenAt: number | null,
  now: number,
  timeoutMinutes: number,
): boolean {
  if (hiddenAt === null || hiddenAt <= 0) return false
  const mins = Math.max(0, timeoutMinutes)
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

// ---------- WebAuthn (Face ID / Touch ID via autenticador de plataforma) ----------

export function isPlatformWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator?.credentials?.create === 'function' &&
    typeof navigator?.credentials?.get === 'function'
  )
}

/**
 * Registra uma credencial WebAuthn de plataforma (Face ID no iOS) e retorna o `credentialId` (base64url).
 * Deve ser chamado diretamente a partir de um gesto de toque do usuário.
 */
export async function registerBiometricCredential(): Promise<string> {
  if (!isPlatformWebAuthnSupported()) {
    throw new Error('WebAuthn / Face ID não suportado neste navegador.')
  }
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  const userId = new Uint8Array(16)
  crypto.getRandomValues(userId)

  const cred = (await navigator.credentials.create({
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

  if (!cred || !cred.rawId) {
    throw new Error('Registro do Face ID cancelado.')
  }
  return bytesToBase64Url(new Uint8Array(cred.rawId))
}

/**
 * Solicita verificação biométrica (Face ID) para o `credentialId` salvo.
 * Deve partir sempre de um toque do usuário (exigência do iOS WebKit).
 */
export async function authenticateBiometricCredential(credentialIdB64: string): Promise<boolean> {
  if (!isPlatformWebAuthnSupported() || !credentialIdB64) {
    throw new Error('Face ID indisponível.')
  }
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  const rawId = base64UrlToBytes(credentialIdB64)

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
}

// ---------- Persistência local da configuração de bloqueio (sem entrar na outbox) ----------

export interface LockConfig {
  enabled: boolean
  credentialId: string | null
  pinHash: string | null
  pinSalt: string | null
  timeoutMinutes: number
}

export async function getLockConfig(): Promise<LockConfig> {
  const [en, cred, hash, salt, to] = await Promise.all([
    getRawRecord('settings', 'lockEnabled'),
    getRawRecord('settings', 'lockCredentialId'),
    getRawRecord('settings', 'lockPinHash'),
    getRawRecord('settings', 'lockPinSalt'),
    getRawRecord('settings', 'lockTimeoutMinutes'),
  ])
  const enabled = en && !en.deleted ? en.value === true : false
  const credentialId = cred && !cred.deleted && typeof cred.value === 'string' ? cred.value : null
  const pinHash = hash && !hash.deleted && typeof hash.value === 'string' ? hash.value : null
  const pinSalt = salt && !salt.deleted && typeof salt.value === 'string' ? salt.value : null
  const timeoutMinutes =
    to && !to.deleted && typeof to.value === 'number' ? to.value : DEFAULT_LOCK_TIMEOUT_MINUTES
  return { enabled, credentialId, pinHash, pinSalt, timeoutMinutes }
}

export async function saveLockSetup(credentialId: string, pin: string, timeoutMinutes = DEFAULT_LOCK_TIMEOUT_MINUTES): Promise<void> {
  const salt = generateSalt()
  const hash = await hashPin(pin, salt)
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.bulkPut([
      { key: 'lockEnabled', value: true, updatedAt: now, deleted: false },
      { key: 'lockCredentialId', value: credentialId, updatedAt: now, deleted: false },
      { key: 'lockPinHash', value: hash, updatedAt: now, deleted: false },
      { key: 'lockPinSalt', value: salt, updatedAt: now, deleted: false },
      { key: 'lockTimeoutMinutes', value: timeoutMinutes, updatedAt: now, deleted: false },
    ])
  })
}

export async function disableLock(): Promise<void> {
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.bulkPut([
      { key: 'lockEnabled', value: false, updatedAt: now, deleted: false },
      { key: 'lockCredentialId', value: null, updatedAt: now, deleted: false },
      { key: 'lockPinHash', value: null, updatedAt: now, deleted: false },
      { key: 'lockPinSalt', value: null, updatedAt: now, deleted: false },
    ])
  })
}

export async function setLockTimeoutMinutes(minutes: number): Promise<void> {
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.put({
      key: 'lockTimeoutMinutes',
      value: Math.max(0, minutes),
      updatedAt: now,
      deleted: false,
    })
  })
}
