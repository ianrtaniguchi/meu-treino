import Dexie, { type Table } from 'dexie'
import type { BodyEntry, Exercise, Food, Meal, Routine, Session, Setting, Snapshot } from './types'

export const DB_NAME = 'meu-treino'
/** Versão do schema = schemaVersion gravado nos backups. */
export const DB_VERSION = 2

/**
 * Funções puras de migração v1 → v2. São usadas tanto pelo upgrade do Dexie
 * quanto para migrar backups antigos importados (ver backup.ts).
 *  - v2: sessões ganham `notes` e `entries` garantidos; medidas corporais ganham `measures`.
 */
export function migrateSessionV2(s: any): any {
  return { ...s, notes: s.notes ?? '', entries: s.entries ?? [] }
}
export function migrateBodyV2(b: any): any {
  return { ...b, measures: b.measures ?? {} }
}

export class AppDB extends Dexie {
  exercises!: Table<Exercise, string>
  routines!: Table<Routine, string>
  sessions!: Table<Session, string>
  foods!: Table<Food, string>
  meals!: Table<Meal, string>
  body!: Table<BodyEntry, string>
  settings!: Table<Setting, string>
  snapshots!: Table<Snapshot, string>

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
  }
}

export const db = new AppDB()

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await db.settings.get(key)
  return (r ? (r.value as T) : fallback)
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}
