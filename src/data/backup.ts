import { DB_VERSION, SYNCABLE_SETTINGS, db, migrateBodyV2, migrateRecordV3, migrateSessionV2, pkOf, recordDocId, runApplyingRemote, uid } from './db'
import { LOCK_SETTING_KEYS } from '../lib/lock'
import { TABLE_NAMES, type Backup, type OutboxEntry, type Snapshot, type SnapshotKind, type TableName } from './types'

export const BACKUP_APP_ID = 'meu-treino-pwa'
export const MAX_SNAPSHOTS_PER_KIND = 5
const WEEK_MS = 7 * 24 * 3600 * 1000

const tableOf = (name: TableName) => db.table(name)

/** Lê todas as tabelas (exceto snapshots e chaves de tranca local) para um objeto de backup. */
export async function buildBackup(): Promise<Backup> {
  const tables = {} as Backup['tables']
  await db.transaction('r', TABLE_NAMES.map(tableOf), async () => {
    for (const t of TABLE_NAMES) {
      const rows = await tableOf(t).toArray()
      tables[t] = t === 'settings' ? rows.filter((r: any) => !LOCK_SETTING_KEYS.has(String(r.key))) : rows
    }
  })
  return { app: BACKUP_APP_ID, schemaVersion: DB_VERSION, exportedAt: new Date().toISOString(), tables }
}

export class BackupError extends Error {}

/** Valida o texto JSON de um backup e migra para o schema atual. Lança BackupError se inválido. */
export function parseBackup(text: string): Backup {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('O arquivo não é um JSON válido.')
  }
  if (!raw || typeof raw !== 'object' || raw.app !== BACKUP_APP_ID) {
    throw new BackupError('Este arquivo não parece ser um backup do Meu Treino.')
  }
  const v = raw.schemaVersion
  if (!Number.isInteger(v) || v < 1) throw new BackupError('schemaVersion ausente ou inválido.')
  if (v > DB_VERSION) {
    throw new BackupError(`Backup de uma versão mais nova do app (schema ${v}). Atualize o app antes de importar.`)
  }
  if (!raw.tables || typeof raw.tables !== 'object') throw new BackupError('Backup sem tabelas.')
  const tables = {} as Backup['tables']
  for (const t of TABLE_NAMES) {
    const rows = raw.tables[t]
    if (!Array.isArray(rows)) throw new BackupError(`Tabela "${t}" ausente ou inválida.`)
    const pk = pkOf(t)
    for (const r of rows) {
      if (!r || typeof r !== 'object' || typeof r[pk] !== 'string') {
        throw new BackupError(`Registro inválido na tabela "${t}".`)
      }
    }
    tables[t] = rows
  }
  for (const s of tables.sessions) {
    if (typeof s.date !== 'string') throw new BackupError('Treino sem data no backup.')
  }
  for (const m of tables.meals) {
    if (typeof m.date !== 'string' || !Array.isArray(m.items)) throw new BackupError('Refeição inválida no backup.')
  }
  for (const b of tables.body) {
    if (typeof b.date !== 'string') throw new BackupError('Registro corporal sem data no backup.')
  }
  // Migrações de backups antigos (espelham as do Dexie)
  if (v < 2) {
    tables.sessions = tables.sessions.map(migrateSessionV2)
    tables.body = tables.body.map(migrateBodyV2)
  }
  if (v < 3) {
    const now = Date.now()
    for (const t of TABLE_NAMES) {
      tables[t] = tables[t].map((r) => migrateRecordV3(r, now))
    }
  }
  return { app: BACKUP_APP_ID, schemaVersion: DB_VERSION, exportedAt: String(raw.exportedAt ?? ''), tables }
}

export interface BackupPreview {
  sessions: number
  meals: number
  body: number
  exercises: number
  exportedAt: string
}
export function previewBackup(b: Backup): BackupPreview {
  return {
    sessions: b.tables.sessions.length,
    meals: b.tables.meals.length,
    body: b.tables.body.length,
    exercises: b.tables.exercises.length,
    exportedAt: b.exportedAt,
  }
}

export type ImportMode = 'merge' | 'replace'

function buildOutboxForRows(table: TableName, rows: any[], now = Date.now()): OutboxEntry[] {
  const pkField = pkOf(table)
  const out: OutboxEntry[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    if (table === 'settings' && !SYNCABLE_SETTINGS.has(String(r.key))) continue
    if ((table === 'exercises' || table === 'foods') && r.builtin && r.updatedAt === 1 && !r.deleted) continue
    const pk = String(r[pkField])
    out.push({
      id: recordDocId(table, pk),
      table,
      pk,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
      attempts: 0,
    })
  }
  return out
}

/**
 * Importa um backup já validado.
 *  - replace: cria snapshot de segurança, apaga tudo (preservando credenciais locais de Face ID/PIN) e grava o conteúdo do backup.
 *  - merge: só adiciona registros cujo id ainda não existe (o que já está no aparelho prevalece).
 */
export async function importBackup(b: Backup, mode: ImportMode): Promise<void> {
  if (mode === 'replace') await createSnapshot('seguranca', 'Antes de substituir dados (importação)')
  await db.transaction('rw', [...TABLE_NAMES.map(tableOf), db.outbox], async () => {
    if (mode === 'replace') await runApplyingRemote(() => db.outbox.clear())
    const outbox: OutboxEntry[] = []
    for (const t of TABLE_NAMES) {
      const table = tableOf(t)
      // Nunca aceita nem sobrescreve chaves locais de Face ID / PIN vindas de um arquivo externo
      const rows = t === 'settings' ? b.tables[t].filter((r: any) => !LOCK_SETTING_KEYS.has(String(r.key))) : b.tables[t]
      if (mode === 'replace') {
        const preservedLock =
          t === 'settings'
            ? (await runApplyingRemote(() => table.toArray())).filter((r: any) => LOCK_SETTING_KEYS.has(String(r.key)))
            : []
        await runApplyingRemote(() => table.clear())
        await runApplyingRemote(() => table.bulkPut([...rows, ...preservedLock]))
        outbox.push(...buildOutboxForRows(t, rows))
      } else {
        const pk = pkOf(t)
        const existing = new Set((await table.toArray()).map((r: any) => String(r[pk])))
        const toAdd = rows.filter((r) => !existing.has(String(r[pk])))
        await runApplyingRemote(() => table.bulkPut(toAdd))
        outbox.push(...buildOutboxForRows(t, toAdd))
      }
    }
    if (outbox.length > 0) await runApplyingRemote(() => db.outbox.bulkPut(outbox))
  })
}

/** Substitui todos os dados pelo conteúdo de um backup, sem snapshot (uso interno). */
async function replaceAll(b: Backup) {
  await db.transaction('rw', [...TABLE_NAMES.map(tableOf), db.outbox], async () => {
    await runApplyingRemote(() => db.outbox.clear())
    const outbox: OutboxEntry[] = []
    for (const t of TABLE_NAMES) {
      const table = tableOf(t)
      const rows = t === 'settings' ? b.tables[t].filter((r: any) => !LOCK_SETTING_KEYS.has(String(r.key))) : b.tables[t]
      const preservedLock =
        t === 'settings'
          ? (await runApplyingRemote(() => table.toArray())).filter((r: any) => LOCK_SETTING_KEYS.has(String(r.key)))
          : []
      await runApplyingRemote(() => table.clear())
      await runApplyingRemote(() => table.bulkPut([...rows, ...preservedLock]))
      outbox.push(...buildOutboxForRows(t, rows))
    }
    if (outbox.length > 0) await runApplyingRemote(() => db.outbox.bulkPut(outbox))
  })
}

// ---------- Snapshots internos ----------

export async function createSnapshot(kind: SnapshotKind, reason: string): Promise<Snapshot> {
  const snap: Snapshot = { id: uid(), createdAt: Date.now(), kind, reason, data: await buildBackup() }
  await db.transaction('rw', db.snapshots, async () => {
    await db.snapshots.add(snap)
    // mantém só os N mais recentes de cada tipo
    const same = await db.snapshots.where('kind').equals(kind).sortBy('createdAt')
    const excess = same.length - MAX_SNAPSHOTS_PER_KIND
    if (excess > 0) await db.snapshots.bulkDelete(same.slice(0, excess).map((s) => s.id))
  })
  return snap
}

export async function listSnapshots(): Promise<Snapshot[]> {
  return (await db.snapshots.orderBy('createdAt').toArray()).reverse()
}

/** Restaura um snapshot (antes, guarda um snapshot de segurança do estado atual). */
export async function restoreSnapshot(id: string): Promise<void> {
  const snap = await db.snapshots.get(id)
  if (!snap) throw new BackupError('Snapshot não encontrado.')
  await createSnapshot('seguranca', 'Antes de restaurar um snapshot')
  await replaceAll(snap.data)
}

/** Cria um snapshot automático se o último automático tem mais de 7 dias (e há dados). */
export async function autoSnapshotIfDue(now = Date.now()): Promise<Snapshot | null> {
  const [sessions, meals, body] = await Promise.all([db.sessions.count(), db.meals.count(), db.body.count()])
  if (sessions + meals + body === 0) return null
  const last = (await db.snapshots.where('kind').equals('auto').sortBy('createdAt')).pop()
  if (last && now - last.createdAt < WEEK_MS) return null
  return createSnapshot('auto', 'Automático (semanal)')
}

// ---------- Exportação para arquivo ----------

export function backupFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `meu-treino-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
}

/**
 * Exporta o backup: Web Share com arquivo (iPhone → Arquivos/iCloud) ou download.
 * Retorna true se concluído; false se o usuário cancelou o compartilhamento.
 */
export async function exportBackupToFile(): Promise<boolean> {
  const backup = await buildBackup()
  const json = JSON.stringify(backup)
  const name = backupFileName()
  const file = new File([json], name, { type: 'application/json' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name })
      return true
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false
      // outro erro: cai para o download normal
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}
