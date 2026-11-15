import type { BodyEntry, Goals, Meal, Session } from '../data/types'
import { parseDate } from '../data/stats'

/*
 * Lógica de apresentação do painel (heatmap, streaks, log estilo commit).
 * Só lê dados já carregados; não escreve no banco.
 *
 * Pontuação diária (ver README):
 *   treino: 0 (nenhuma série) | 2 (>= 1 série) | 3 (>= 12 séries)
 *   dieta:  0 (sem refeições) | 1 (refeições registradas) | 2 (+ meta de proteína atingida)
 *   peso:   0 | 1 (peso registrado)
 *   nível:  0 → 0 | 1–2 → 1 | 3 → 2 | 4–5 → 3 | 6 → 4
 */
export const BIG_SESSION_SETS = 12

export const trainPoints = (sets: number) => (sets <= 0 ? 0 : sets >= BIG_SESSION_SETS ? 3 : 2)
export const dietPoints = (mealCount: number, protein: number, goalProtein: number) =>
  mealCount === 0 ? 0 : goalProtein > 0 && protein >= goalProtein ? 2 : 1
export const weightPoints = (hasWeight: boolean) => (hasWeight ? 1 : 0)
export type Level = 0 | 1 | 2 | 3 | 4
export const scoreToLevel = (s: number): Level => (s <= 0 ? 0 : s <= 2 ? 1 : s === 3 ? 2 : s <= 5 ? 3 : 4)

export interface DayInfo {
  date: string
  sessions: Session[]
  sets: number
  mealCount: number
  kcal: number
  protein: number
  weight?: number
  score: number
  level: Level
}

export function buildDays(from: string, to: string, sessions: Session[], meals: Meal[], body: BodyEntry[], goals: Goals) {
  const map = new Map<string, DayInfo>()
  const get = (date: string) => {
    let d = map.get(date)
    if (!d) map.set(date, (d = { date, sessions: [], sets: 0, mealCount: 0, kcal: 0, protein: 0, score: 0, level: 0 }))
    return d
  }
  for (const s of sessions) {
    if (s.date < from || s.date > to) continue
    const n = s.entries.reduce((a, e) => a + e.sets.length, 0)
    if (n === 0) continue
    const d = get(s.date)
    d.sessions.push(s)
    d.sets += n
  }
  for (const m of meals) {
    if (m.date < from || m.date > to || m.items.length === 0) continue
    const d = get(m.date)
    d.mealCount++
    for (const i of m.items) { d.kcal += i.kcal; d.protein += i.p }
  }
  for (const b of body) {
    if (b.date < from || b.date > to || b.weight === undefined) continue
    get(b.date).weight = b.weight
  }
  for (const d of map.values()) {
    d.score = trainPoints(d.sets) + dietPoints(d.mealCount, d.protein, goals.p) + weightPoints(d.weight !== undefined)
    d.level = scoreToLevel(d.score)
  }
  return map
}

export const daysBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000)

/**
 * Streak de treino com tolerância: dois treinos fazem parte da mesma sequência se houver
 * no máximo `gap` dias de descanso entre eles. A sequência atual continua viva enquanto os dias
 * sem treino desde o último treino não passarem de `gap`. Conta dias de treino.
 */
export function streaks(trainDates: string[], gap: number, today: string) {
  const dates = [...new Set(trainDates)].sort()
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const d of dates) {
    run = prev && daysBetween(prev, d) - 1 <= gap ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = d
  }
  const current = prev && Math.max(0, daysBetween(prev, today) - 1) <= gap ? run : 0
  return { current, longest }
}

/** Ids das séries que eram PR (maior carga, depois reps/segundos) na hora em que foram feitas. A 1ª vez de um exercício não conta. */
export function prSetIds(sessions: Session[]): Set<string> {
  const best = new Map<string, { load: number; value: number }>()
  const out = new Set<string>()
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
  for (const s of sorted)
    for (const e of s.entries)
      for (const set of e.sets) {
        const b = best.get(e.exerciseId)
        if (b && (set.load > b.load || (set.load === b.load && set.value > b.value))) out.add(set.id)
        if (!b || set.load > b.load || (set.load === b.load && set.value > b.value)) best.set(e.exerciseId, { load: set.load, value: set.value })
      }
  return out
}

export function relDate(date: string, today: string): string {
  const n = daysBetween(date, today)
  if (n <= 0) return 'hoje'
  if (n === 1) return 'ontem'
  if (n < 7) return `há ${n} dias`
  if (n < 30) return `há ${Math.floor(n / 7)} sem`
  return `há ${Math.floor(n / 30)} mes`
}
