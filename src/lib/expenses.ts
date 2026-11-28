import type { Expense, ExpenseLimit, RecurringExpense } from '../data/types'

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Alimentação',
  'Transporte',
  'Moradia',
  'Saúde',
  'Lazer',
  'Compras',
  'Educação',
  'Assinaturas',
  'Outros',
] as const

export interface ExpenseCategoryTotal {
  category: string
  expensesCents: number
  recurringCents: number
  totalCents: number
}

export interface MonthlyExpenseSummary {
  month: string
  expensesCents: number
  recurringCents: number
  totalCents: number
  byCategory: ExpenseCategoryTotal[]
}

export function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function formatCents(amountCents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amountCents / 100)
}

export function containsFinancialIdentifier(note: string): boolean {
  const digitCount = note.replace(/\D/g, '').length
  if (digitCount >= 6) return true
  return /\b(cart[aã]o|conta|ag[eê]ncia|banco|iban|swift)\b/i.test(note) && digitCount > 0
}

export function parseMoneyToCents(raw: string): number | null {
  let value = raw.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!value || !/^[\d.,]+$/.test(value)) return null

  const comma = value.lastIndexOf(',')
  const dot = value.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) value = value.replace(/\./g, '').replace(',', '.')
    else value = value.replace(/,/g, '')
  } else if (comma >= 0) {
    value = value.replace(',', '.')
  }

  if (!/^\d+(\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const reais = Number(whole)
  if (!Number.isSafeInteger(reais)) return null
  const cents = Number((fraction + '00').slice(0, 2))
  const rounded = reais * 100 + cents + (Number(fraction[2] ?? '0') >= 5 ? 1 : 0)
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null
}

export function summarizeMonth(
  expenses: readonly Expense[],
  recurringExpenses: readonly RecurringExpense[],
  month: string,
): MonthlyExpenseSummary {
  const totals = new Map<string, { expensesCents: number; recurringCents: number }>()
  const getCategory = (category: string) => {
    let total = totals.get(category)
    if (!total) {
      total = { expensesCents: 0, recurringCents: 0 }
      totals.set(category, total)
    }
    return total
  }

  for (const expense of expenses) {
    if (expense.deleted || !expense.date.startsWith(`${month}-`)) continue
    getCategory(expense.category).expensesCents += expense.amountCents
  }
  for (const recurring of recurringExpenses) {
    if (recurring.deleted) continue
    getCategory(recurring.category).recurringCents += recurring.amountCents
  }

  const byCategory = [...totals].map(([category, values]) => ({
    category,
    ...values,
    totalCents: values.expensesCents + values.recurringCents,
  }))
  byCategory.sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category, 'pt-BR'))
  const expensesCents = byCategory.reduce((sum, item) => sum + item.expensesCents, 0)
  const recurringCents = byCategory.reduce((sum, item) => sum + item.recurringCents, 0)
  return { month, expensesCents, recurringCents, totalCents: expensesCents + recurringCents, byCategory }
}

export function getLimitThresholdCrossings(
  previousCents: number,
  nextCents: number,
  limit: ExpenseLimit,
): Array<80 | 100> {
  if (limit.monthlyLimitCents <= 0 || nextCents <= previousCents) return []
  const crossed: Array<80 | 100> = []
  if (previousCents * 5 < limit.monthlyLimitCents * 4 && nextCents * 5 >= limit.monthlyLimitCents * 4) {
    crossed.push(80)
  }
  if (previousCents <= limit.monthlyLimitCents && nextCents > limit.monthlyLimitCents) {
    crossed.push(100)
  }
  return crossed
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function getNextRecurringDueDate(dayOfMonth: number, fromDate: string): string {
  const [year, month, day] = fromDate.split('-').map(Number)
  const targetDay = Math.min(dayOfMonth, daysInMonth(year, month - 1))
  if (day <= targetDay) return `${year}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`
  const next = new Date(Date.UTC(year, month, 1))
  const nextYear = next.getUTCFullYear()
  const nextMonth = next.getUTCMonth() + 1
  const nextDay = Math.min(dayOfMonth, daysInMonth(nextYear, next.getUTCMonth()))
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`
}

function saoPauloDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function getNextRecurringReminderAt(dayOfMonth: number, now = new Date()): string {
  const [year, month] = saoPauloDate(now).split('-').map(Number)
  for (let offset = 0; offset < 3; offset++) {
    const dueMonth = new Date(Date.UTC(year, month - 1 + offset, 1))
    const dueYear = dueMonth.getUTCFullYear()
    const dueMonthIndex = dueMonth.getUTCMonth()
    const dueDay = Math.min(dayOfMonth, daysInMonth(dueYear, dueMonthIndex))
    const dueDate = `${dueYear}-${String(dueMonthIndex + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`
    const dueAt = new Date(`${dueDate}T00:00:00-03:00`)
    const reminderDate = shiftDate(dueDate, -1)
    const plannedAt = new Date(`${reminderDate}T09:00:00-03:00`)
    if (plannedAt.getTime() > now.getTime()) return plannedAt.toISOString()
    if (now.getTime() < dueAt.getTime()) return new Date(now.getTime() + 60_000).toISOString()
  }
  throw new Error('Não foi possível calcular o próximo lembrete do gasto fixo.')
}
