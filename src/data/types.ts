// Tipos do domínio. Datas são strings locais "AAAA-MM-DD" (sem fuso).

export type Measure = 'reps' | 'time'

export interface SyncMeta {
  /** Timestamp em ms da última atualização local ou remota (last-write-wins). */
  updatedAt?: number
  /** Soft delete para propagação entre aparelhos. */
  deleted?: boolean
}

export interface Exercise extends SyncMeta {
  id: string
  name: string
  category: string
  /** posição dentro da progressão da categoria (1 = mais fácil) */
  level: number
  /** reps = repetições; time = segundos (isométricos) */
  measure: Measure
  builtin?: boolean
}

export interface SetEntry {
  id: string
  /** repetições ou segundos, conforme o exercício */
  value: number
  /** carga extra em kg (0 = peso corporal) */
  load: number
  rpe?: number
}

export interface SessionExercise {
  exerciseId: string
  sets: SetEntry[]
}

export interface Session extends SyncMeta {
  id: string
  date: string
  name: string
  routineId?: string
  notes: string
  entries: SessionExercise[]
  createdAt: number
  finishedAt?: number
}

export interface Routine extends SyncMeta {
  id: string
  name: string
  exerciseIds: string[]
}

export interface Food extends SyncMeta {
  id: string
  name: string
  /** porção de referência, ex.: "100 g" */
  qty: string
  kcal: number
  p: number
  c: number
  g: number
  favorite: boolean
  builtin?: boolean
}

export interface MealItem {
  name: string
  qty: string
  kcal: number
  p: number
  c: number
  g: number
}

export type MealType = 'cafe' | 'almoco' | 'jantar' | 'lanche'

export interface Meal extends SyncMeta {
  id: string
  date: string
  type: MealType
  items: MealItem[]
  createdAt: number
}

export interface BodyEntry extends SyncMeta {
  /** um registro por data: id = "body-AAAA-MM-DD" */
  id: string
  date: string
  weight?: number
  measures: Record<string, number>
}

export type ExpenseOrigin = 'manual' | 'assistant' | 'wallet'

export interface Expense extends SyncMeta {
  id: string
  amountCents: number
  category: string
  merchantNote?: string
  date: string
  origin: ExpenseOrigin
}

export interface ExpenseLimit extends SyncMeta {
  id: string
  category: string
  monthlyLimitCents: number
}

export interface RecurringExpense extends SyncMeta {
  id: string
  name: string
  amountCents: number
  dayOfMonth: number
  category: string
  reminderId?: string
  reminderTriggerAt?: string
}

export interface Setting extends SyncMeta {
  key: string
  value: unknown
}

export type SnapshotKind = 'auto' | 'seguranca' | 'manual'

export interface Snapshot {
  id: string
  createdAt: number
  kind: SnapshotKind
  reason: string
  data: Backup
}

export const TABLE_NAMES = [
  'exercises',
  'routines',
  'sessions',
  'foods',
  'meals',
  'body',
  'expenses',
  'expenseLimits',
  'recurringExpenses',
  'settings',
] as const
export type TableName = (typeof TABLE_NAMES)[number]

/** Entrada na fila de envio (outbox) para sincronização com o Firestore. */
export interface OutboxEntry {
  /** Identificador único no formato "${table}:${pk}" */
  id: string
  table: TableName
  pk: string
  updatedAt: number
  attempts: number
}

/** Documento em users/{uid}/records/{id} no Firestore. */
export interface CloudRecord {
  id: string
  table: TableName
  pk: string
  updatedAt: number
  deleted: boolean
  payload: Record<string, any>
}

export interface Backup {
  app: string
  schemaVersion: number
  exportedAt: string
  tables: Record<TableName, any[]>
}

export interface Goals {
  kcal: number
  p: number
  c: number
  g: number
}
