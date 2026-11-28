import { describe, expect, it } from 'vitest'
import type { Expense, ExpenseLimit, RecurringExpense } from '../src/data/types'
import {
  containsFinancialIdentifier,
  getLimitThresholdCrossings,
  getNextRecurringDueDate,
  getNextRecurringReminderAt,
  parseMoneyToCents,
  shiftMonth,
  summarizeMonth,
} from '../src/lib/expenses'

const expense = (id: string, date: string, amountCents: number, category = 'Alimentação'): Expense => ({
  id,
  date,
  amountCents,
  category,
  origin: 'manual',
})

const recurring = (id: string, amountCents: number, category = 'Moradia'): RecurringExpense => ({
  id,
  name: id,
  amountCents,
  dayOfMonth: 10,
  category,
})

describe('cálculos de Gastos', () => {
  it('converte valores em reais para centavos com arredondamento comercial', () => {
    expect(parseMoneyToCents('30,00')).toBe(3000)
    expect(parseMoneyToCents('1.234,56')).toBe(123456)
    expect(parseMoneyToCents('1,005')).toBe(101)
    expect(parseMoneyToCents('0')).toBeNull()
    expect(parseMoneyToCents('inválido')).toBeNull()
  })

  it('rejeita notas com possíveis números de cartão, banco ou conta', () => {
    expect(containsFinancialIdentifier('Mercado Avenida')).toBe(false)
    expect(containsFinancialIdentifier('Cartão final 1234')).toBe(true)
    expect(containsFinancialIdentifier('1234 5678 9012 3456')).toBe(true)
    expect(containsFinancialIdentifier('conta 123456')).toBe(true)
  })

  it('soma lançamentos e recorrentes no mês escolhido, ignorando excluídos e outros meses', () => {
    const entries = [
      expense('nov-1', '2026-11-02', 1200),
      expense('dez-1', '2026-12-02', 5000),
      { ...expense('deleted', '2026-11-10', 1000), deleted: true },
    ]
    const recurringItems = [recurring('rent', 100000), recurring('music', 1500, 'Assinaturas')]
    const summary = summarizeMonth(entries, recurringItems, '2026-11')

    expect(summary).toMatchObject({ expensesCents: 1200, recurringCents: 101500, totalCents: 102700 })
    expect(summary.byCategory.map(({ category, totalCents }) => [category, totalCents])).toEqual([
      ['Moradia', 100000],
      ['Assinaturas', 1500],
      ['Alimentação', 1200],
    ])
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('sinaliza uma única vez a passagem de 80% e o estouro do limite', () => {
    const limit: ExpenseLimit = { id: 'Alimentação', category: 'Alimentação', monthlyLimitCents: 10000 }

    expect(getLimitThresholdCrossings(7000, 8000, limit)).toEqual([80])
    expect(getLimitThresholdCrossings(8000, 10001, limit)).toEqual([100])
    expect(getLimitThresholdCrossings(0, 15000, limit)).toEqual([80, 100])
    expect(getLimitThresholdCrossings(10500, 11000, limit)).toEqual([])
  })

  it('calcula o dia recorrente válido em meses curtos e agenda antes do vencimento', () => {
    expect(getNextRecurringDueDate(31, '2026-02-10')).toBe('2026-02-28')
    expect(getNextRecurringDueDate(31, '2026-03-01')).toBe('2026-03-31')
    expect(getNextRecurringReminderAt(1, new Date('2026-11-28T15:00:00.000Z'))).toBe('2026-11-30T12:00:00.000Z')
  })
})
