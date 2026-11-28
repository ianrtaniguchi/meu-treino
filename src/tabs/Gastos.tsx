import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LockScreen, PromptTitle } from '../components/TerminalChrome'
import { useUi } from '../components/ui'
import { db, setSetting, uid } from '../data/db'
import { today } from '../data/stats'
import { useSetting } from '../hooks'
import {
  cancelUserPushReminder,
  createUserPushReminder,
} from '../lib/notifications'
import {
  DEFAULT_EXPENSE_CATEGORIES,
  containsFinancialIdentifier,
  formatCents,
  getLimitThresholdCrossings,
  getNextRecurringDueDate,
  getNextRecurringReminderAt,
  monthKey,
  parseMoneyToCents,
  shiftMonth,
  summarizeMonth,
} from '../lib/expenses'
import type { Expense, ExpenseLimit, RecurringExpense } from '../data/types'
import type { LockConfig } from '../lib/lock'

interface ExpenseEditor {
  id?: string
  amount: string
  category: string
  merchantNote: string
  date: string
}

interface RecurringEditor {
  id?: string
  name: string
  amount: string
  category: string
  dayOfMonth: string
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function monthLabel(value: string): string {
  const [year, month] = value.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

function displayDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function active<T extends { deleted?: boolean }>(items: readonly T[] | undefined): T[] {
  return (items ?? []).filter((item) => item.deleted !== true)
}

export default function Gastos({
  lockConfig,
  globalLocked,
  onUnlocked,
  onOpenConfig,
}: {
  lockConfig?: LockConfig
  globalLocked: boolean
  onUnlocked: () => void
  onOpenConfig: () => void
}) {
  if (!lockConfig) {
    return <div className="card muted">Carregando proteção de Gastos…</div>
  }
  if (!lockConfig.enabled) {
    return (
      <div className="scroll">
        <PromptTitle path="~/gastos" />
        <div className="card stack">
          <b>Gastos exige proteção biométrica.</b>
          <div className="muted small">Ative a trava com Face ID em Configurações para abrir este módulo.</div>
          <button className="primary" onClick={onOpenConfig}>Configurar proteção</button>
        </div>
      </div>
    )
  }
  return <GastosUnlock lockConfig={lockConfig} globalLocked={globalLocked} onUnlocked={onUnlocked} />
}

function GastosUnlock({
  lockConfig,
  globalLocked,
  onUnlocked,
}: {
  lockConfig: LockConfig
  globalLocked: boolean
  onUnlocked: () => void
}) {
  const [unlocked, setUnlocked] = useState(false)
  useEffect(() => {
    if (globalLocked) setUnlocked(false)
  }, [globalLocked])
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') setUnlocked(false)
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [])
  if (!unlocked || globalLocked) {
    return <LockScreen config={lockConfig} onUnlocked={() => { setUnlocked(true); onUnlocked() }} />
  }
  return <GastosDashboard />
}

function GastosDashboard() {
  const { toast, confirm } = useUi()
  const storedCategories = useSetting<unknown>('expenseCategories', DEFAULT_EXPENSE_CATEGORIES)
  const categories = useMemo(() => {
    if (!Array.isArray(storedCategories)) return [...DEFAULT_EXPENSE_CATEGORIES]
    const valid = storedCategories.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return valid.length > 0 ? valid : [...DEFAULT_EXPENSE_CATEGORIES]
  }, [storedCategories])
  const expensesRaw = useLiveQuery(() => db.expenses.toArray(), [], [])
  const limitsRaw = useLiveQuery(() => db.expenseLimits.toArray(), [], [])
  const recurringRaw = useLiveQuery(() => db.recurringExpenses.toArray(), [], [])
  const expenses = useMemo(() => active(expensesRaw), [expensesRaw])
  const limits = useMemo(() => active(limitsRaw), [limitsRaw])
  const recurring = useMemo(() => active(recurringRaw), [recurringRaw])
  const [selectedMonth, setSelectedMonth] = useState(() => monthKey())
  const [editor, setEditor] = useState<ExpenseEditor | null>(null)
  const [recurringEditor, setRecurringEditor] = useState<RecurringEditor | null>(null)
  const [categoryDraft, setCategoryDraft] = useState('')
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({})
  const reminderJobs = useRef(new Set<string>())
  const runAction = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      toast(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const summary = useMemo(
    () => summarizeMonth(expenses, recurring, selectedMonth),
    [expenses, recurring, selectedMonth],
  )
  const monthExpenses = useMemo(
    () => expenses.filter((item) => item.date.startsWith(`${selectedMonth}-`)).sort((a, b) => b.date.localeCompare(a.date)),
    [expenses, selectedMonth],
  )
  const dueItems = useMemo(
    () => recurring
      .map((item) => ({ item, date: getNextRecurringDueDate(item.dayOfMonth, today()) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [recurring],
  )
  const totalFixedCents = recurring.reduce((total, item) => total + item.amountCents, 0)

  useEffect(() => {
    let cancelled = false
    const syncReminders = async () => {
      for (const item of recurring) {
        if (
          cancelled ||
          reminderJobs.current.has(item.id) ||
          item.reminderId
        ) continue
        reminderJobs.current.add(item.id)
        try {
          if (item.reminderId) await cancelUserPushReminder(item.reminderId)
          const triggerAt = getNextRecurringReminderAt(item.dayOfMonth)
          const reminderId = await createUserPushReminder({
            title: 'Vencimento de gasto fixo',
            body: 'Um gasto fixo vence amanhã.',
            triggerAt,
            recurrence: 'monthly',
            monthlyDayOfMonth: item.dayOfMonth,
          })
          if (cancelled) {
            await cancelUserPushReminder(reminderId)
            continue
          }
          await db.recurringExpenses.put({ ...item, reminderId, reminderTriggerAt: triggerAt })
          toast('Lembrete push do próximo vencimento agendado.')
        } catch (error) {
          if (!cancelled) {
            toast(`Gasto fixo salvo, mas o lembrete push não foi agendado. ${(error as Error).message}`)
          }
        } finally {
          reminderJobs.current.delete(item.id)
        }
      }
    }
    void syncReminders()
    return () => { cancelled = true }
  }, [recurring, toast])

  useEffect(() => {
    setLimitDrafts((current) => {
      const next = { ...current }
      for (const limit of limits) {
        if (next[limit.category] === undefined) next[limit.category] = (limit.monthlyLimitCents / 100).toFixed(2).replace('.', ',')
      }
      return next
    })
  }, [limits])

  const openNewExpense = () => {
    setEditor({ amount: '', category: categories[0] ?? 'Outros', merchantNote: '', date: today() })
  }

  const saveExpense = async () => {
    if (!editor) return
    const amountCents = parseMoneyToCents(editor.amount)
    if (amountCents === null) {
      toast('Informe um valor válido, maior que zero.')
      return
    }
    if (!categories.includes(editor.category)) {
      toast('Selecione uma categoria válida.')
      return
    }
    if (!isDate(editor.date)) {
      toast('Informe uma data válida.')
      return
    }
    const note = editor.merchantNote.trim()
    if (note.length > 120) {
      toast('Estabelecimento ou nota: máximo de 120 caracteres.')
      return
    }
    if (containsFinancialIdentifier(note)) {
      toast('Não inclua números de cartão ou dados bancários/da conta na nota.')
      return
    }
    const prior = editor.id ? expenses.find((item) => item.id === editor.id) : undefined
    const dateMonth = editor.date.slice(0, 7)
    const currentSummary = summarizeMonth(expenses, recurring, dateMonth)
    const before = summarizeMonth(
      expenses.filter((item) => item.id !== prior?.id),
      recurring,
      dateMonth,
    )
    const expense: Expense = {
      id: prior?.id ?? uid(),
      amountCents,
      category: editor.category,
      merchantNote: note || undefined,
      date: editor.date,
      origin: prior?.origin ?? 'manual',
    }
    await db.expenses.put(expense)
    setEditor(null)
    const previousCents = currentSummary.byCategory.find((item) => item.category === expense.category)?.totalCents ?? 0
    const nextCents = (before.byCategory.find((item) => item.category === expense.category)?.totalCents ?? 0) + expense.amountCents
    const limit = limits.find((item) => item.category === expense.category)
    const alerts = limit
      ? getLimitThresholdCrossings(previousCents, nextCents, limit)
      : []
    if (alerts.length === 0) {
      toast(prior ? 'Gasto atualizado.' : 'Gasto salvo.')
      return
    }
    toast(alerts.map((threshold) => threshold === 80
      ? `${expense.category}: chegou a 80% do limite mensal.`
      : `${expense.category}: limite mensal ultrapassado.`).join(' '))
  }

  const deleteExpense = async (item: Expense) => {
    if (!(await confirm(`Excluir o gasto de ${formatCents(item.amountCents)}?`, 'excluir', false))) return
    await db.expenses.delete(item.id)
    toast('Gasto excluído.')
  }

  const saveLimit = async (category: string) => {
    const rawAmount = (limitDrafts[category] ?? '').trim()
    const current = limits.find((item) => item.category === category)
    if (!rawAmount) {
      if (current) await db.expenseLimits.delete(current.id)
      toast(current ? 'Limite removido.' : 'Nenhum limite configurado.')
      return
    }
    const amountCents = parseMoneyToCents(rawAmount)
    if (amountCents === null) {
      toast('Informe um limite válido, maior que zero.')
      return
    }
    const limit: ExpenseLimit = {
      id: current?.id ?? uid(),
      category,
      monthlyLimitCents: amountCents,
    }
    await db.expenseLimits.put(limit)
    toast('Limite mensal salvo.')
  }

  const saveRecurring = async () => {
    if (!recurringEditor) return
    const name = recurringEditor.name.trim()
    const amountCents = parseMoneyToCents(recurringEditor.amount)
    const dayOfMonth = Number(recurringEditor.dayOfMonth)
    if (!name || name.length > 80 || containsFinancialIdentifier(name)) {
      toast('Informe um nome com até 80 caracteres, sem dados de cartão, banco ou conta.')
      return
    }
    if (amountCents === null) {
      toast('Informe um valor válido, maior que zero.')
      return
    }
    if (!categories.includes(recurringEditor.category) || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      toast('Confira a categoria e o dia do mês (1 a 31).')
      return
    }
    const prior = recurringEditor.id ? recurring.find((item) => item.id === recurringEditor.id) : undefined
    if (prior?.reminderId) await cancelUserPushReminder(prior.reminderId)
    const item: RecurringExpense = {
      id: prior?.id ?? uid(),
      name,
      amountCents,
      dayOfMonth,
      category: recurringEditor.category,
    }
    const currentMonth = monthKey()
    const currentSummary = summarizeMonth(expenses, recurring, currentMonth)
    const before = summarizeMonth(expenses, recurring.filter((entry) => entry.id !== prior?.id), currentMonth)
    const previousCents = currentSummary.byCategory.find((entry) => entry.category === item.category)?.totalCents ?? 0
    const nextCents = (before.byCategory.find((entry) => entry.category === item.category)?.totalCents ?? 0) + item.amountCents
    const limit = limits.find((entry) => entry.category === item.category)
    await db.recurringExpenses.put(item)
    setRecurringEditor(null)
    const alerts = limit
      ? getLimitThresholdCrossings(previousCents, nextCents, limit)
      : []
    if (alerts.length > 0) {
      toast(alerts.map((threshold) => threshold === 80
        ? `${item.category}: chegou a 80% do limite mensal.`
        : `${item.category}: limite mensal ultrapassado.`).join(' '))
    } else {
      toast(prior ? 'Gasto fixo atualizado.' : 'Gasto fixo salvo.')
    }
  }

  const deleteRecurring = async (item: RecurringExpense) => {
    if (!(await confirm(`Excluir "${item.name}" dos gastos fixos?`, 'excluir', false))) return
    if (item.reminderId) await cancelUserPushReminder(item.reminderId)
    await db.recurringExpenses.delete(item.id)
    toast('Gasto fixo excluído.')
  }

  const addCategory = async () => {
    const value = categoryDraft.trim()
    if (
      !value ||
      value.length > 40 ||
      containsFinancialIdentifier(value) ||
      categories.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())
    ) {
      toast('Informe uma categoria nova com até 40 caracteres, sem dados de cartão, banco ou conta.')
      return
    }
    await setSetting('expenseCategories', [...categories, value])
    setCategoryDraft('')
    toast('Categoria adicionada.')
  }

  const maximumCategoryTotal = summary.byCategory[0]?.totalCents ?? 0

  return (
    <div className="scroll">
      <PromptTitle path="~/gastos" />

      <section className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Resumo do mês</h2>
          <div className="row">
            <button className="small" aria-label="Mês anterior" onClick={() => setSelectedMonth((value) => shiftMonth(value, -1))}>‹</button>
            <button className="small" aria-label="Próximo mês" onClick={() => setSelectedMonth((value) => shiftMonth(value, 1))}>›</button>
          </div>
        </div>
        <div className="muted small" style={{ textTransform: 'capitalize' }}>{monthLabel(selectedMonth)}</div>
        <div className="row between">
          <span>Total previsto</span>
          <b style={{ fontSize: 22 }}>{formatCents(summary.totalCents)}</b>
        </div>
        <div className="row between small muted">
          <span>Lançamentos</span><span>{formatCents(summary.expensesCents)}</span>
        </div>
        <div className="row between small muted">
          <span>Fixos do mês</span><span>{formatCents(summary.recurringCents)}</span>
        </div>
        <div className="stack" aria-label="Gastos por categoria">
          {summary.byCategory.length === 0 ? (
            <div className="muted small">Sem gastos ou recorrentes neste mês.</div>
          ) : summary.byCategory.map((item) => {
            const width = maximumCategoryTotal > 0 ? (item.totalCents / maximumCategoryTotal) * 100 : 0
            return (
              <div key={item.category} className="stack" style={{ gap: 4 }}>
                <div className="row between small">
                  <span>{item.category}</span><b>{formatCents(item.totalCents)}</b>
                </div>
                <div className="bar" role="img" aria-label={`${item.category}: ${formatCents(item.totalCents)}`}>
                  <i style={{ transform: `scaleX(${width / 100})` }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Lançamentos</h2>
          <button className="primary small" onClick={openNewExpense}>Novo gasto</button>
        </div>
        {editor && (
          <div className="stack" aria-label="Formulário de gasto">
            <label className="stack small">
              Valor em reais
              <input inputMode="decimal" type="text" value={editor.amount} placeholder="0,00" onChange={(event) => setEditor({ ...editor, amount: event.target.value })} />
            </label>
            <div className="stack small">
              <b>Categoria</b>
              <div className="grid2">
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={editor.category === category ? 'primary' : ''}
                    aria-pressed={editor.category === category}
                    style={{ minHeight: 48 }}
                    onClick={() => setEditor({ ...editor, category })}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </div>
            <label className="stack small">
              Estabelecimento ou nota (opcional)
              <input maxLength={120} value={editor.merchantNote} onChange={(event) => setEditor({ ...editor, merchantNote: event.target.value })} />
            </label>
            <label className="stack small">
              Data
              <input type="date" value={editor.date} onChange={(event) => setEditor({ ...editor, date: event.target.value })} />
            </label>
            <div className="grid2">
              <button className="primary" onClick={() => void runAction('Não foi possível salvar o gasto', saveExpense)}>{editor.id ? 'Salvar alterações' : 'Salvar gasto'}</button>
              <button onClick={() => setEditor(null)}>Cancelar</button>
            </div>
          </div>
        )}
        {monthExpenses.length === 0 ? (
          <div className="muted small">Nenhum lançamento neste mês.</div>
        ) : monthExpenses.map((item) => (
          <div key={item.id} className="row between" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="stack" style={{ gap: 2 }}>
              <b>{item.merchantNote || item.category}</b>
              <span className="muted small">{displayDate(item.date)} · {item.category}</span>
            </div>
            <div className="row">
              <b>{formatCents(item.amountCents)}</b>
              <button className="small" aria-label={`Editar ${item.merchantNote || item.category}`} onClick={() => setEditor({
                id: item.id,
                amount: (item.amountCents / 100).toFixed(2).replace('.', ','),
                category: item.category,
                merchantNote: item.merchantNote ?? '',
                date: item.date,
              })}>editar</button>
              <button className="small danger" aria-label={`Excluir ${item.merchantNote || item.category}`} onClick={() => void runAction('Não foi possível excluir o gasto', () => deleteExpense(item))}>×</button>
            </div>
          </div>
        ))}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Limites mensais</h2>
        {categories.map((category) => {
          const total = summary.byCategory.find((item) => item.category === category)?.totalCents ?? 0
          const limit = limits.find((item) => item.category === category)
          const percent = limit ? Math.floor((total / limit.monthlyLimitCents) * 100) : 0
          return (
            <div key={category} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div className="row between small">
                <b>{category}</b>
                {limit && <span>{formatCents(total)} / {formatCents(limit.monthlyLimitCents)} · {percent}%</span>}
              </div>
              {limit && (
                <>
                  <div className={`bar${percent > 100 ? ' over' : ''}`} role="img" aria-label={`${category}: ${percent}% do limite`}>
                    <i style={{ transform: `scaleX(${Math.min(100, percent) / 100})` }} />
                  </div>
                  {percent >= 100 && <div className="small amber">Limite mensal ultrapassado.</div>}
                  {percent >= 80 && percent < 100 && <div className="small amber">Você chegou a 80% do limite.</div>}
                </>
              )}
              <div className="row">
                <input
                  inputMode="decimal"
                  type="text"
                  aria-label={`Limite mensal de ${category} em reais`}
                  placeholder="Sem limite"
                  value={limitDrafts[category] ?? ''}
                  onChange={(event) => setLimitDrafts((current) => ({ ...current, [category]: event.target.value }))}
                />
                <button className="small" onClick={() => void runAction('Não foi possível salvar o limite', () => saveLimit(category))}>Salvar</button>
              </div>
            </div>
          )
        })}
      </section>

      <section className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Fixos e assinaturas</h2>
          <button className="small" onClick={() => setRecurringEditor({
            name: '',
            amount: '',
            category: categories[0] ?? 'Outros',
            dayOfMonth: '1',
          })}>Adicionar</button>
        </div>
        <div className="row between small">
          <span>Total mensal fixo</span><b>{formatCents(totalFixedCents)}</b>
        </div>
        {dueItems.length > 0 && (
          <div className="muted small">
            Próximo vencimento: {dueItems[0].item.name} · {displayDate(dueItems[0].date)}
          </div>
        )}
        {recurringEditor && (
          <div className="stack">
            <label className="stack small">Nome
              <input maxLength={80} value={recurringEditor.name} onChange={(event) => setRecurringEditor({ ...recurringEditor, name: event.target.value })} />
            </label>
            <label className="stack small">Valor mensal
              <input inputMode="decimal" type="text" placeholder="0,00" value={recurringEditor.amount} onChange={(event) => setRecurringEditor({ ...recurringEditor, amount: event.target.value })} />
            </label>
            <label className="stack small">Dia do mês
              <input type="number" min={1} max={31} value={recurringEditor.dayOfMonth} onChange={(event) => setRecurringEditor({ ...recurringEditor, dayOfMonth: event.target.value })} />
            </label>
            <div className="grid2">
              {categories.map((category) => (
                <button key={category} type="button" className={recurringEditor.category === category ? 'primary' : ''} style={{ minHeight: 44 }} onClick={() => setRecurringEditor({ ...recurringEditor, category })}>
                  {category}
                </button>
              ))}
            </div>
            <div className="grid2">
              <button className="primary" onClick={() => void runAction('Não foi possível salvar o gasto fixo', saveRecurring)}>{recurringEditor.id ? 'Salvar alterações' : 'Salvar fixo'}</button>
              <button onClick={() => setRecurringEditor(null)}>Cancelar</button>
            </div>
          </div>
        )}
        {recurring.length === 0 ? (
          <div className="muted small">Nenhum gasto fixo cadastrado.</div>
        ) : recurring.map((item) => (
          <div key={item.id} className="row between" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="stack" style={{ gap: 2 }}>
              <b>{item.name}</b>
              <span className="muted small">{item.category} · dia {item.dayOfMonth} · vence {displayDate(getNextRecurringDueDate(item.dayOfMonth, today()))}</span>
            </div>
            <div className="row">
              <b>{formatCents(item.amountCents)}</b>
              <button className="small" onClick={() => setRecurringEditor({
                id: item.id,
                name: item.name,
                amount: (item.amountCents / 100).toFixed(2).replace('.', ','),
                category: item.category,
                dayOfMonth: String(item.dayOfMonth),
              })}>editar</button>
              <button className="small danger" aria-label={`Excluir ${item.name}`} onClick={() => void runAction('Não foi possível excluir o gasto fixo', () => deleteRecurring(item))}>×</button>
            </div>
          </div>
        ))}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Categorias</h2>
        <div className="row">
          <input aria-label="Nova categoria de gastos" maxLength={40} value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} />
          <button className="small" onClick={() => void runAction('Não foi possível adicionar a categoria', addCategory)}>Adicionar</button>
        </div>
      </section>
    </div>
  )
}
