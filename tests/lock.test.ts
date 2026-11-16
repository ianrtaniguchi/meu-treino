import { beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, importBackup } from '../src/data/backup'
import { db, setSetting, SYNCABLE_SETTINGS } from '../src/data/db'
import {
  computePinBackoffMs,
  disableLock,
  generateSalt,
  getLockConfig,
  hashPin,
  isValidPin,
  LOCK_SETTING_KEYS,
  saveLockSetup,
   setLockTimeoutMinutes,
  shouldLockAfterBackground,
  verifyPin,
} from '../src/lib/lock'

async function resetDb() {
  await db.delete()
  await db.open()
}

describe('Tranca com Face ID e PIN reserva (lógica local)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('valida formato do PIN (4 a 6 dígitos numéricos) e gera/verifica hash PBKDF2 com salt', async () => {
    expect(isValidPin('123')).toBe(false)
    expect(isValidPin('1234567')).toBe(false)
    expect(isValidPin('12a4')).toBe(false)
    expect(isValidPin('1234')).toBe(true)
    expect(isValidPin('987654')).toBe(true)

    const salt1 = generateSalt()
    const salt2 = generateSalt()
    expect(salt1).not.toBe(salt2)

    const hash1 = await hashPin('2580', salt1)
    const hash2 = await hashPin('2580', salt2)
    // Mesmo PIN com salts diferentes gera hashes diferentes e nunca contém o PIN puro
    expect(hash1).not.toBe(hash2)
    expect(hash1).not.toContain('2580')

    expect(await verifyPin('2580', salt1, hash1)).toBe(true)
    expect(await verifyPin('2581', salt1, hash1)).toBe(false)
    expect(await verifyPin('00', salt1, hash1)).toBe(false)
  })

  it('calcula timeout de retorno ao primeiro plano corretamente', () => {
    const t0 = 1_700_000_000_000
    expect(shouldLockAfterBackground(null, t0 + 120_000, 1)).toBe(false)
    expect(shouldLockAfterBackground(t0, t0 + 59_999, 1)).toBe(false)
    expect(shouldLockAfterBackground(t0, t0 + 60_000, 1)).toBe(true)
    expect(shouldLockAfterBackground(t0, t0 + 4 * 60_000, 5)).toBe(false)
    expect(shouldLockAfterBackground(t0, t0 + 5 * 60_000, 5)).toBe(true)
    expect(shouldLockAfterBackground(t0, t0, 0)).toBe(true)
  })

  it('calcula atraso crescente (backoff) após tentativas erradas de PIN', () => {
    expect(computePinBackoffMs(0)).toBe(0)
    expect(computePinBackoffMs(1)).toBe(0)
    expect(computePinBackoffMs(2)).toBe(2_000)
    expect(computePinBackoffMs(3)).toBe(4_000)
    expect(computePinBackoffMs(4)).toBe(8_000)
    expect(computePinBackoffMs(5)).toBe(16_000)
    expect(computePinBackoffMs(6)).toBe(30_000)
    expect(computePinBackoffMs(10)).toBe(30_000)
  })

  it('garante que credencial e PIN não entram no Firestore (outbox), não entram no backup e não são sobrescritos ao importar', async () => {
    // 1. Nenhuma chave de bloqueio pode estar em SYNCABLE_SETTINGS
    for (const k of LOCK_SETTING_KEYS) {
      expect(SYNCABLE_SETTINGS.has(k)).toBe(false)
    }

    // 2. Salvar configuração de Face ID + PIN não deve enfileirar nada na outbox
    await saveLockSetup('cred_id_teste_abc123', '4321', 3)
    await setLockTimeoutMinutes(5)
    expect(await db.outbox.count()).toBe(0)

    const cfgBefore = await getLockConfig()
    expect(cfgBefore.enabled).toBe(true)
    expect(cfgBefore.credentialId).toBe('cred_id_teste_abc123')
    expect(cfgBefore.timeoutMinutes).toBe(5)
    expect(cfgBefore.pinHash).toBeTruthy()
    expect(cfgBefore.pinSalt).toBeTruthy()
    expect(await verifyPin('4321', cfgBefore.pinSalt!, cfgBefore.pinHash!)).toBe(true)

    // 3. Exportar backup: nenhuma chave de bloqueio deve constar em tables.settings
    await setSetting('restSeconds', 90)
    const exported = await buildBackup()
    const exportedKeys = exported.tables.settings.map((s) => s.key)
    expect(exportedKeys).toContain('restSeconds')
    for (const k of LOCK_SETTING_KEYS) {
      expect(exportedKeys).not.toContain(k)
    }

    // 4. Importar backup (mesmo se um arquivo malicioso/externo trouxer chaves de lock e em modo replace)
    // não deve apagar nem sobrescrever a tranca local do aparelho
    const maliciousBackup = structuredClone(exported)
    maliciousBackup.tables.settings.push(
      { key: 'lockEnabled', value: false },
      { key: 'lockCredentialId', value: 'cred_injetada' },
      { key: 'lockPinHash', value: 'hash_injetado' },
      { key: 'restSeconds', value: 120 },
    )

    await importBackup(maliciousBackup, 'replace')

    const cfgAfterReplace = await getLockConfig()
    expect(cfgAfterReplace.enabled).toBe(true)
    expect(cfgAfterReplace.credentialId).toBe('cred_id_teste_abc123')
    expect(cfgAfterReplace.timeoutMinutes).toBe(5)
    expect(await verifyPin('4321', cfgAfterReplace.pinSalt!, cfgAfterReplace.pinHash!)).toBe(true)

    // E tampoco em modo merge
    await importBackup(maliciousBackup, 'merge')
    const cfgAfterMerge = await getLockConfig()
    expect(cfgAfterMerge.enabled).toBe(true)
    expect(cfgAfterMerge.credentialId).toBe('cred_id_teste_abc123')

    // 5. Desativar bloqueio limpa credencial e PIN sem gerar entradas na outbox
    await db.outbox.clear()
    await disableLock()
    expect(await db.outbox.count()).toBe(0)
    const cfgDisabled = await getLockConfig()
    expect(cfgDisabled.enabled).toBe(false)
    expect(cfgDisabled.credentialId).toBeNull()
    expect(cfgDisabled.pinHash).toBeNull()
  })
})
