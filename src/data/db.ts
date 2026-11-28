import Dexie, { type Table } from 'dexie'
import { TABLE_NAMES, type Backup, type BodyEntry, type Exercise, type Expense, type ExpenseLimit, type Food, type Meal, type OutboxEntry, type RecurringExpense, type Routine, type Session, type Setting, type Snapshot, type TableName } from './types'

export const DB_NAME = 'meu-treino'
/** Versão do schema = schemaVersion gravado nos backups. */
export const DB_VERSION = 4
const PRE_EXPENSE_TABLE_NAMES: TableName[] = ['exercises', 'routines', 'sessions', 'foods', 'meals', 'body', 'settings']

/** Configurações que fazem sentido sincronizar entre aparelhos (nunca PIN/Face ID/estado efêmero). */
export const SYNCABLE_SETTINGS = new Set([
  'goals',
  'restSeconds',
  'streakGap',
  'ifesReadIds',
  'profileName',
  'todayModulesConfig',
  'faculdadeData',
  'expenseCategories',
  'mainNavTabs',
])

export function isSyncableSettingKey(key: string): boolean {
  return SYNCABLE_SETTINGS.has(key) || key.startsWith('mainNavTabs:')
}

export const pkOf = (table: TableName) => (table === 'settings' ? 'key' : 'id')
export const recordDocId = (table: TableName, pk: string) => `${table}:${pk}`

/**
 * Funções puras de migração v1 → v2 → v3. São usadas tanto pelo upgrade do Dexie
 * quanto para migrar backups antigos importados (ver backup.ts).
 *  - v2: sessões ganham `notes` e `entries` garantidos; medidas corporais ganham `measures`.
 *  - v3: todos os registros ganham `updatedAt` (ms) e `deleted: false`.
 */
export function migrateSessionV2(s: any): any {
  return { ...s, notes: s.notes ?? '', entries: s.entries ?? [] }
}
export function migrateBodyV2(b: any): any {
  return { ...b, measures: b.measures ?? {} }
}
export function migrateRecordV3<T extends Record<string, any>>(r: T, now = Date.now()): T {
  return {
    ...r,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
    deleted: typeof r.deleted === 'boolean' ? r.deleted : false,
  }
}

/**
 * Contador de escopos ativos onde gravações locais vêm do próprio motor de sync
 * (aplicação de dados remotos) e não devem gerar entradas na fila (outbox) nem sobrescrever `updatedAt`.
 */
let applyingRemoteDepth = 0
export async function runApplyingRemote<T>(fn: () => Promise<T>): Promise<T> {
  applyingRemoteDepth++
  try {
    return await fn()
  } finally {
    applyingRemoteDepth--
  }
}

let syncNotify: (() => void) | null = null
export function onLocalWrite(cb: (() => void) | null) {
  syncNotify = cb
}

/** Aguarda todas as gravações assíncronas pendentes na fila (outbox). */
const pendingOutboxBuffer = new Map<string, OutboxEntry>()
let outboxFlushPromise: Promise<void> | null = null
export async function waitPendingOutbox(): Promise<void> {
  while (outboxFlushPromise || pendingOutboxBuffer.size > 0) {
    if (outboxFlushPromise) await outboxFlushPromise
    else await new Promise((r) => setTimeout(r, 0))
  }
}

export function clearPendingOutboxBuffer() {
  pendingOutboxBuffer.clear()
}

function enqueueOutboxAsync(items: OutboxEntry[]) {
  if (items.length === 0) return
  for (const it of items) pendingOutboxBuffer.set(it.id, it)
  if (!outboxFlushPromise) {
    outboxFlushPromise = (async () => {
      try {
        while (pendingOutboxBuffer.size > 0) {
          const batch = [...pendingOutboxBuffer.values()]
          pendingOutboxBuffer.clear()
          await Dexie.ignoreTransaction(() => db.outbox.bulkPut(batch))
        }
        syncNotify?.()
      } catch {
        // ignore if db was closed/deleted
      } finally {
        outboxFlushPromise = null
      }
    })()
  }
}

export class AppDB extends Dexie {
  exercises!: Table<Exercise, string>
  routines!: Table<Routine, string>
  sessions!: Table<Session, string>
  foods!: Table<Food, string>
  meals!: Table<Meal, string>
  body!: Table<BodyEntry, string>
  expenses!: Table<Expense, string>
  expenseLimits!: Table<ExpenseLimit, string>
  recurringExpenses!: Table<RecurringExpense, string>
  settings!: Table<Setting, string>
  snapshots!: Table<Snapshot, string>
  outbox!: Table<OutboxEntry, string>

  constructor() {
    super(DB_NAME)
    // NUNCA altere uma versão já publicada: crie uma nova com .version(n+1).
    this.version(1).stores({
      exercises: 'id, category, name',
      routines: 'id',
      sessions: 'id, date',
      foods: 'id, name',
      meals: 'id, date',
      body: 'id, date',
      settings: 'key',
      snapshots: 'id, kind, createdAt',
    })
    this.version(2)
      .stores({
        sessions: 'id, date, routineId',
      })
      .upgrade(async (tx) => {
        await tx.table('sessions').toCollection().modify((s) => Object.assign(s, migrateSessionV2(s)))
        await tx.table('body').toCollection().modify((b) => Object.assign(b, migrateBodyV2(b)))
      })
    this.version(3)
      .stores({
        exercises: 'id, category, name, updatedAt',
        routines: 'id, updatedAt',
        sessions: 'id, date, routineId, updatedAt',
        foods: 'id, name, updatedAt',
        meals: 'id, date, updatedAt',
        body: 'id, date, updatedAt',
        settings: 'key, updatedAt',
        snapshots: 'id, kind, createdAt',
        outbox: 'id, table, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        // Snapshot automático antes da migração v2 → v3 (se já havia dados do usuário)
        const tables = {} as Backup['tables']
        for (const t of PRE_EXPENSE_TABLE_NAMES) {
          tables[t] = await tx.table(t).toArray()
        }
        tables.expenses = []
        tables.expenseLimits = []
        tables.recurringExpenses = []
        const hasUserData = tables.sessions.length + tables.meals.length + tables.body.length > 0
        if (hasUserData) {
          await tx.table('snapshots').add({
            id: uid(),
            createdAt: now,
            kind: 'seguranca',
            reason: 'Antes da migração para schema v3 (sincronização)',
            data: {
              app: 'meu-treino-pwa',
              schemaVersion: 2,
              exportedAt: new Date(now).toISOString(),
              tables,
            },
          })
        }
        for (const t of PRE_EXPENSE_TABLE_NAMES) {
          await tx
            .table(t)
            .toCollection()
            .modify((r) => Object.assign(r, migrateRecordV3(r, now)))
        }
      })

    this.version(4).stores({
      exercises: 'id, category, name, updatedAt',
      routines: 'id, updatedAt',
      sessions: 'id, date, routineId, updatedAt',
      foods: 'id, name, updatedAt',
      meals: 'id, date, updatedAt',
      body: 'id, date, updatedAt',
      expenses: 'id, date, category, updatedAt',
      expenseLimits: 'id, category, updatedAt',
      recurringExpenses: 'id, category, dayOfMonth, updatedAt',
      settings: 'key, updatedAt',
      snapshots: 'id, kind, createdAt',
      outbox: 'id, table, updatedAt',
    })

    this.installSyncMiddleware()
    this.installTableWrappers()
  }

  private installTableWrappers() {
    for (const tName of TABLE_NAMES) {
      const tbl = this.table(tName)
      const origGet = tbl.get.bind(tbl)
      tbl.get = (async (keyOrCrit: any, cb?: any) => {
        const r: any = await origGet(keyOrCrit, cb)
        if (applyingRemoteDepth === 0 && r && r.deleted === true) return undefined
        return r
      }) as any

      const origDelete = tbl.delete.bind(tbl)
      tbl.delete = (async (key: any) => {
        if (applyingRemoteDepth > 0) return origDelete(key)
        const cur: any = await origGet(key)
        if (!cur) return
        const now = Date.now()
        const tomb = { ...cur, updatedAt: now, deleted: true }
        await tbl.put(tomb)
      }) as any

      const origBulkDelete = tbl.bulkDelete.bind(tbl)
      tbl.bulkDelete = (async (keys: readonly any[]) => {
        if (applyingRemoteDepth > 0) return origBulkDelete([...keys])
        const now = Date.now()
        const tombs: any[] = []
        for (const k of keys) {
          const cur: any = await origGet(k)
          if (cur) tombs.push({ ...cur, updatedAt: now, deleted: true })
        }
        if (tombs.length > 0) await tbl.bulkPut(tombs)
      }) as any
    }
  }

  private installSyncMiddleware() {
    this.use({
      stack: 'dbcore',
      name: 'SyncOutboxMiddleware',
      create(downlevelDatabase) {
        return {
          ...downlevelDatabase,
          table(tableName: string) {
            const downlevelTable = downlevelDatabase.table(tableName)
            if (!TABLE_NAMES.includes(tableName as TableName)) return downlevelTable
            const tName = tableName as TableName
            const pkField = pkOf(tName)
            const shouldQueue = (pk: string, val?: any) => {
              if (tName === 'settings') return isSyncableSettingKey(pk)
              // exercícios e alimentos builtin não editados na seed inicial não precisam ir para a fila até que sejam alterados/usados,
              // a menos que não sejam builtin ou já estejam sendo editados.
              if ((tName === 'exercises' || tName === 'foods') && val?.builtin && val?._seedInit) return false
              return true
            }

            return {
              ...downlevelTable,
              async mutate(req) {
                if (applyingRemoteDepth > 0) return downlevelTable.mutate(req)

                const now = Date.now()
                const outboxItems: OutboxEntry[] = []

                if (req.type === 'add' || req.type === 'put') {
                  const values = req.values.map((v: any) => {
                    const isSeed = v?._seedInit === true
                    const explicitTs = v?._preserveUpdatedAt === true && typeof v?.updatedAt === 'number'
                    const clean = { ...v }
                    delete clean._seedInit
                    delete clean._preserveUpdatedAt
                    const updatedAt = (isSeed || explicitTs) && typeof clean.updatedAt === 'number' ? clean.updatedAt : now
                    const deleted = typeof clean.deleted === 'boolean' ? clean.deleted : false
                    const next = { ...clean, updatedAt, deleted }
                    const pk = String(next[pkField])
                    if (!isSeed && shouldQueue(pk, next)) {
                      outboxItems.push({
                        id: recordDocId(tName, pk),
                        table: tName,
                        pk,
                        updatedAt,
                        attempts: 0,
                      })
                    }
                    return next
                  })
                  const res = await downlevelTable.mutate({ ...req, values })
                  if (outboxItems.length > 0) {
                    enqueueOutboxAsync(outboxItems)
                  }
                  return res
                }

                if (req.type === 'delete') {
                  if (tName === 'outbox' as any) {
                    clearPendingOutboxBuffer()
                  }
                  // Converte delete em soft delete (deleted = true, updatedAt = now) para propagar entre aparelhos!
                  const existing: any[] =
                    (req as any).existingValues ??
                    (await downlevelTable.getMany({ trans: req.trans, keys: req.keys }))
                  const toPut: any[] = []
                  for (let i = 0; i < req.keys.length; i++) {
                    const pk = String(req.keys[i])
                    const cur = existing[i] ?? (await downlevelTable.get({ trans: req.trans, key: req.keys[i] }))
                    if (cur) {
                      const tomb = { ...cur, updatedAt: now, deleted: true }
                      toPut.push(tomb)
                      if (shouldQueue(pk, tomb)) {
                        outboxItems.push({
                          id: recordDocId(tName, pk),
                          table: tName,
                          pk,
                          updatedAt: now,
                          attempts: 0,
                        })
                      }
                    }
                  }
                  if (toPut.length > 0) {
                    await downlevelTable.mutate({ type: 'put', trans: req.trans, values: toPut })
                    if (outboxItems.length > 0) {
                      enqueueOutboxAsync(outboxItems)
                    }
                    return { numFailures: 0, failures: {}, lastResult: undefined }
                  }
                  return downlevelTable.mutate(req)
                }

                return downlevelTable.mutate(req)
              },
              // Filtra registros com deleted === true nas leituras normais da UI
              async get(req) {
                const r: any = await downlevelTable.get(req)
                if (applyingRemoteDepth === 0 && r && r.deleted === true) return undefined
                return r
              },
              async getMany(req) {
                const list: any[] = await downlevelTable.getMany(req)
                if (applyingRemoteDepth > 0) return list
                return list.map((r) => (r && r.deleted === true ? undefined : r))
              },
              async query(req) {
                const res = await downlevelTable.query(req)
                if (applyingRemoteDepth > 0 || !req.values) return res
                return {
                  ...res,
                  result: res.result.filter((r: any) => !r || r.deleted !== true),
                }
              },
              async count(req) {
                if (applyingRemoteDepth > 0) return downlevelTable.count(req)
                const res = await downlevelTable.query({ trans: req.trans, query: req.query, values: true })
                return res.result.filter((r: any) => !r || r.deleted !== true).length
              },
            }
          },
        }
      },
    })
  }
}

export const db = new AppDB()

/** Lê todos os registros de uma tabela incluindo soft-deleted (para sync/merge). */
export async function getRawTable<T = any>(table: TableName): Promise<T[]> {
  return runApplyingRemote(() => db.table(table).toArray())
}

/** Lê um registro específico incluindo soft-deleted. */
export async function getRawRecord<T = any>(table: TableName, pk: string): Promise<T | undefined> {
  return runApplyingRemote(() => db.table(table).get(pk))
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await db.settings.get(key)
  return r ? (r.value as T) : fallback
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}
