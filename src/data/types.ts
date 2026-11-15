// Tipos do domínio. Datas são strings locais "AAAA-MM-DD" (sem fuso).

export type Measure = 'reps' | 'time'

export interface Exercise {
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

export interface Session {
  id: string
  date: string
  name: string
  routineId?: string
  notes: string
  entries: SessionExercise[]
  createdAt: number
  finishedAt?: number
}

export interface Routine {
  id: string
  name: string
  exerciseIds: string[]
}

export interface Food {
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

export interface Meal {
  id: string
  date: string
  type: MealType
  items: MealItem[]
  createdAt: number
}

export interface BodyEntry {
  /** um registro por data: id = "body-AAAA-MM-DD" */
  id: string
  date: string
  weight?: number
  measures: Record<string, number>
}

export interface Setting {
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

export const TABLE_NAMES = ['exercises', 'routines', 'sessions', 'foods', 'meals', 'body', 'settings'] as const
export type TableName = (typeof TABLE_NAMES)[number]

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
