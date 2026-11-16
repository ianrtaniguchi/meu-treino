import type { Exercise, Meal, MealItem, Session, SetEntry } from './types'

// ---------- Datas (locais, "AAAA-MM-DD") ----------
const p2 = (n: number) => String(n).padStart(2, '0')
export const toDateStr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
export const today = (d = new Date()) => toDateStr(d)
export const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const addDays = (s: string, n: number) => {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}
export const fmtShort = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`
export const fmtLong = (s: string) =>
  parseDate(s).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
/** Segunda-feira da semana da data. */
export const weekStart = (s: string) => {
  const d = parseDate(s)
  const dow = (d.getDay() + 6) % 7
  return addDays(s, -dow)
}

// ---------- Treino ----------
export const num = (s: string): number => {
  const n = parseFloat(s.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
export const fmtNum = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',')

export const setLabel = (s: SetEntry, measure: Exercise['measure']) =>
  `${s.value}${measure === 'time' ? 's' : ''}${s.load ? ` +${fmtNum(s.load)}kg` : ''}`

export interface ExerciseDay {
  sessionId: string
  date: string
  sets: SetEntry[]
}

/** Histórico de um exercício (ordem cronológica). */
export function exerciseHistory(sessions: Session[], exerciseId: string): ExerciseDay[] {
  return sessions
    .map((s) => ({
      sessionId: s.id,
      date: s.date,
      sets: s.entries.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets),
    }))
    .filter((d) => d.sets.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** PR: maior carga extra; em empate, mais reps (ou segundos). */
export function personalRecord(history: ExerciseDay[]): (SetEntry & { date: string }) | null {
  let best: (SetEntry & { date: string }) | null = null
  for (const d of history)
    for (const s of d.sets) {
      if (!best || s.load > best.load || (s.load === best.load && s.value > best.value)) best = { ...s, date: d.date }
    }
  return best
}

/** Volume: total de reps/segundos e tonelagem (kg × reps) das séries com carga. */
export function totalVolume(history: ExerciseDay[]) {
  let total = 0
  let tonnage = 0
  for (const d of history)
    for (const s of d.sets) {
      total += s.value
      tonnage += s.value * s.load
    }
  return { total, tonnage }
}

/** Última vez que o exercício foi feito, excluindo a sessão atual. */
export function lastPerformance(sessions: Session[], exerciseId: string, excludeSessionId?: string): ExerciseDay | null {
  const h = exerciseHistory(
    sessions.filter((s) => s.id !== excludeSessionId),
    exerciseId,
  )
  return h.length ? h[h.length - 1] : null
}

/** Contagem de treinos por semana (últimas n semanas, mais antiga primeiro). */
export function weeklyCounts(sessions: Session[], n: number, ref = today()) {
  const start = weekStart(ref)
  const out: { week: string; count: number }[] = []
  for (let i = n - 1; i >= 0; i--) out.push({ week: addDays(start, -7 * i), count: 0 })
  for (const s of sessions) {
    const w = weekStart(s.date)
    const row = out.find((o) => o.week === w)
    if (row) row.count++
  }
  return out
}

// ---------- Dieta ----------
export const sumItems = (items: MealItem[]) =>
  items.reduce((a, i) => ({ kcal: a.kcal + i.kcal, p: a.p + i.p, c: a.c + i.c, g: a.g + i.g }), { kcal: 0, p: 0, c: 0, g: 0 })
export const dayTotals = (meals: Meal[]) => sumItems(meals.flatMap((m) => m.items))

// ---------- Corpo ----------
/** Média móvel do peso: média dos registros dentro dos últimos `days` dias (inclusive). */
export function movingAverage(points: { date: string; value: number }[], days = 7) {
  return points.map((pt) => {
    const from = addDays(pt.date, -(days - 1))
    const w = points.filter((q) => q.date >= from && q.date <= pt.date)
    return { date: pt.date, value: w.reduce((a, q) => a + q.value, 0) / w.length }
  })
}
