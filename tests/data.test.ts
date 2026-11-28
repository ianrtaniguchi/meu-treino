import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BackupError, autoSnapshotIfDue, buildBackup, createSnapshot, importBackup, listSnapshots,
  parseBackup, previewBackup, restoreSnapshot,
} from '../src/data/backup'
import { DB_NAME, DB_VERSION, db, setSetting } from '../src/data/db'
import { ensureSeed } from '../src/data/seed'
import type { BodyEntry, Meal, Session } from '../src/data/types'

const session = (id: string, date = '2026-11-01'): Session => ({
  id, date, name: 'Treino A', notes: 'ok', createdAt: 1,
  entries: [{ exerciseId: 'ex-1', sets: [{ id: 's1', value: 10, load: 5, rpe: 8 }] }],
})
const meal = (id: string, date = '2026-11-01'): Meal => ({
  id, date, type: 'almoco', createdAt: 1, items: [{ name: 'Arroz', qty: '100 g', kcal: 128, p: 2.5, c: 28, g: 0.2 }],
})
const body = (date: string, weight: number): BodyEntry => ({ id: `body-${date}`, date, weight, measures: { cintura: 80 } })

async function fill() {
  await db.sessions.bulkAdd([session('a'), session('b', '2026-11-02')])
  await db.meals.add(meal('m1'))
  await db.body.add(body('2026-11-01', 80.5))
  await db.expenses.add({
    id: 'expense-1',
    date: '2026-11-01',
    amountCents: 3099,
    category: 'Alimentação',
    merchantNote: 'Mercado',
    origin: 'manual',
  })
  await db.expenseLimits.add({ id: 'limit-1', category: 'Alimentação', monthlyLimitCents: 50000 })
  await db.recurringExpenses.add({
    id: 'recurring-1',
    name: 'Internet',
    amountCents: 9900,
    dayOfMonth: 10,
    category: 'Moradia',
  })
  await setSetting('goals', { kcal: 2000, p: 100, c: 200, g: 60 })
  await setSetting('expenseCategories', ['Alimentação', 'Moradia'])
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('migração de schema', () => {
  it('atualiza um banco v1 para v2 preservando dados e preenchendo campos novos', async () => {
    await db.delete()
    // Banco criado com o schema v1 original (como estava no aparelho de alguém)
    const old = new Dexie(DB_NAME)
    old.version(1).stores({
      exercises: 'id, category, name', routines: 'id', sessions: 'id, date', foods: 'id, name',
      meals: 'id, date', body: 'id, date', settings: 'key', snapshots: 'id, kind, createdAt',
    })
    await old.open()
    await old.table('sessions').add({ id: 'x', date: '2026-01-01', name: 'Antigo', createdAt: 1 })
    await old.table('body').add({ id: 'body-2026-01-01', date: '2026-01-01', weight: 90 })
    old.close()

    await db.open()
    expect(db.verno).toBe(DB_VERSION)
    const s = await db.sessions.get('x')
    expect(s?.name).toBe('Antigo')
    expect(s?.notes).toBe('')
    expect(s?.entries).toEqual([])
    const b = await db.body.get('body-2026-01-01')
    expect(b?.weight).toBe(90)
    expect(b?.measures).toEqual({})
  })

  it('migra backups com schemaVersion 1 ao importar', async () => {
    const v1 = JSON.stringify({
      app: 'meu-treino-pwa', schemaVersion: 1, exportedAt: 'x',
      tables: {
        exercises: [], routines: [], foods: [], settings: [], meals: [],
        sessions: [{ id: 'x', date: '2026-01-01', name: 'A', createdAt: 1 }],
        body: [{ id: 'body-1', date: '2026-01-01', weight: 70 }],
      },
    })
    const b = parseBackup(v1)
    expect(b.schemaVersion).toBe(DB_VERSION)
    expect(b.tables.sessions[0].entries).toEqual([])
    expect(b.tables.body[0].measures).toEqual({})
    expect(b.tables.expenses).toEqual([])
    expect(b.tables.expenseLimits).toEqual([])
    expect(b.tables.recurringExpenses).toEqual([])
  })
})

describe('validação de backup', () => {
  it('rejeita JSON inválido, app errado, schema futuro e tabelas ausentes', async () => {
    expect(() => parseBackup('não é json')).toThrow(BackupError)
    expect(() => parseBackup('{"app":"outro"}')).toThrow(BackupError)
    const good = await buildBackup()
    expect(() => parseBackup(JSON.stringify({ ...good, schemaVersion: DB_VERSION + 1 }))).toThrow(/mais nova/)
    const noTable = { ...good, tables: { ...good.tables, sessions: undefined } }
    expect(() => parseBackup(JSON.stringify(noTable))).toThrow(BackupError)
  })

  it('rejeita notas de gastos que contenham possíveis identificadores financeiros', async () => {
    const backup = await buildBackup()
    backup.tables.expenses = [{
      id: 'unsafe-expense',
      date: '2026-11-01',
      amountCents: 3099,
      category: 'Alimentação',
      merchantNote: 'Cartão 1234',
      origin: 'manual',
    }]
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/gasto inválido/i)
  })
})

describe('exportar → importar', () => {
  it('ida e volta (substituir) não perde nada', async () => {
    await ensureSeed()
    await fill()
    const exported = await buildBackup()
    expect(exported.tables.expenses).toHaveLength(1)
    expect(exported.tables.expenseLimits).toHaveLength(1)
    expect(exported.tables.recurringExpenses).toHaveLength(1)
    expect(exported.tables.settings.find((row) => row.key === 'expenseCategories')?.value).toEqual(['Alimentação', 'Moradia'])
    const text = JSON.stringify(exported)

    await db.delete()
    await db.open()
    expect(await db.sessions.count()).toBe(0)

    const parsed = parseBackup(text)
    expect(previewBackup(parsed)).toMatchObject({ sessions: 2, meals: 1, body: 1 })
    await importBackup(parsed, 'replace')

    const again = await buildBackup()
    for (const t of Object.keys(exported.tables) as (keyof typeof exported.tables)[]) {
      const sortBy = (r: any) => (r.id ?? r.key) as string
      const norm = (rows: any[]) => [...rows].sort((a, b) => sortBy(a).localeCompare(sortBy(b)))
      expect(norm(again.tables[t])).toEqual(norm(exported.tables[t]))
    }
  })

  it('substituir apaga o que não está no backup e cria snapshot de segurança antes', async () => {
    await fill()
    const backup = await buildBackup()
    await db.sessions.add(session('extra', '2026-12-01'))
    await importBackup(backup, 'replace')
    expect(await db.sessions.get('extra')).toBeUndefined()
    expect(await db.sessions.count()).toBe(2)
    const snaps = await listSnapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].kind).toBe('seguranca')
    // o snapshot guarda o estado anterior (com a sessão "extra")
    expect(snaps[0].data.tables.sessions.map((s: Session) => s.id)).toContain('extra')
  })

  it('mesclar mantém dados atuais e adiciona só o que falta', async () => {
    await fill()
    const backup = await buildBackup()
    // estado atual: diverge do backup
    await db.sessions.delete('b')
    await db.sessions.update('a', { notes: 'editado depois' })
    await db.sessions.add(session('novo', '2026-12-05'))
    await importBackup(backup, 'merge')
    const ids = (await db.sessions.toArray()).map((s) => s.id).sort()
    expect(ids).toEqual(['a', 'b', 'novo']) // 'b' voltou, 'novo' ficou
    expect((await db.sessions.get('a'))?.notes).toBe('editado depois') // existente prevalece
    expect(await db.snapshots.count()).toBe(0) // mesclar não cria snapshot
  })
})

describe('snapshots', () => {
  it('cria, restaura e mantém só os 5 mais recentes por tipo', async () => {
    await fill()
    const snap = await createSnapshot('manual', 'teste')
    await db.sessions.clear()
    await db.meals.clear()
    expect(await db.sessions.count()).toBe(0)

    await restoreSnapshot(snap.id)
    expect(await db.sessions.count()).toBe(2)
    expect(await db.meals.count()).toBe(1)
    expect((await db.body.get('body-2026-11-01'))?.weight).toBe(80.5)
    // restaurar também cria snapshot de segurança do estado anterior (vazio)
    expect((await listSnapshots()).some((s) => s.kind === 'seguranca')).toBe(true)

    for (let i = 0; i < 7; i++) await createSnapshot('auto', `n${i}`)
    expect(await db.snapshots.where('kind').equals('auto').count()).toBe(5)
  })

  it('snapshot automático: no máximo um por semana e só com dados', async () => {
    expect(await autoSnapshotIfDue()).toBeNull() // sem dados
    await fill()
    const t0 = Date.now()
    expect(await autoSnapshotIfDue(t0)).not.toBeNull()
    expect(await autoSnapshotIfDue(t0 + 3 * 86400_000)).toBeNull()
    expect(await autoSnapshotIfDue(t0 + 8 * 86400_000)).not.toBeNull()
  })
})

describe('transações', () => {
  it('uma importação que falha no meio não deixa dados pela metade', async () => {
    await fill()
    const backup = await buildBackup()
    // registro inválido (chave duplicada de tipo errado) força erro dentro da transação
    const bad = { ...backup, tables: { ...backup.tables, meals: [{ id: { x: 1 } }] } }
    await expect(importBackup(bad as any, 'replace')).rejects.toThrow()
    expect(await db.sessions.count()).toBe(2)
    expect(await db.meals.count()).toBe(1)
  })
})
