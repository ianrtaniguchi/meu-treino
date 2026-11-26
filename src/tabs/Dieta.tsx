import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { Field, Progress, Seg, Sheet, useUi } from '../components/ui'
import { db, setSetting, uid } from '../data/db'
import { DEFAULT_GOALS } from '../data/seed'
import { addDays, dayTotals, fmtLong, fmtNum, fmtShort, num, sumItems, today } from '../data/stats'
import type { Food, Goals, Meal, MealItem, MealType } from '../data/types'
import { useSetting } from '../hooks'
import { addItems, analyzeMealPhoto, MealAnalysisError, mealTypeForHour, NoFoodError, undoAddItems } from '../lib/mealPhoto'

const TYPES: [MealType, string][] = [['cafe', 'café da manhã'], ['almoco', 'almoço'], ['jantar', 'jantar'], ['lanche', 'lanches']]

export default function Dieta() {
  const { confirm, toast } = useUi()
  const [date, setDate] = useState(today())
  const goals = useSetting<Goals>('goals', DEFAULT_GOALS) ?? DEFAULT_GOALS
  const meals = useLiveQuery(() => db.meals.where('date').between(addDays(date, -6), date, true, true).toArray(), [date], [] as Meal[])
  const yesterday = useLiveQuery(() => db.meals.where('date').equals(addDays(date, -1)).toArray(), [date], [] as Meal[])
  const [adding, setAdding] = useState<MealType | null>(null)
  const [showGoals, setShowGoals] = useState(false)
  const [showFoods, setShowFoods] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [editing, setEditing] = useState<{ m: Meal; idx: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Foto do prato: analisa, valida e salva direto na refeição do horário atual (com "desfazer")
  const onPhoto = async (file?: File) => {
    if (!file || photoBusy) return
    setPhotoBusy(true)
    try {
      const items = await analyzeMealPhoto(file)
      const type = mealTypeForHour(new Date())
      const day = today()
      await addItems(day, type, items)
      setDate(day)
      const kcal = Math.round(items.reduce((a, i) => a + i.kcal, 0))
      toast(`Registrado: ${fmtNum(kcal)} kcal`, { label: 'desfazer', run: () => void undoAddItems(day, type, items.length) })
    } catch (e) {
      if (e instanceof NoFoodError) toast('Não encontrei comida na foto. Nada foi salvo.')
      else toast(`error: ${e instanceof MealAnalysisError ? e.message : 'falha ao analisar a foto.'} Nada foi salvo.`)
    } finally {
      setPhotoBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const dayMeals = meals.filter((m) => m.date === date)
  const tot = dayTotals(dayMeals)
  const week = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6))
    return days.map((d) => ({ d, ...dayTotals(meals.filter((m) => m.date === d)) }))
  }, [meals, date])
  const logged = week.filter((w) => w.kcal > 0)
  const avg = (k: 'kcal' | 'p') => (logged.length ? logged.reduce((a, w) => a + w[k], 0) / logged.length : 0)

  const removeItem = async (m: Meal, idx: number) => {
    if (!(await confirm(`Excluir "${m.items[idx].name}"?`))) return
    const before = m
    const items = m.items.filter((_, i) => i !== idx)
    if (items.length) await db.meals.put({ ...m, items })
    else await db.meals.delete(m.id)
    toast('Alimento excluído', { label: 'desfazer', run: () => void db.meals.put(before) })
  }
  const removeMeal = async (m: Meal, label: string) => {
    if (!(await confirm(`Excluir toda a refeição "${label}" deste dia?`))) return
    await db.meals.delete(m.id)
    toast('Refeição excluída', { label: 'desfazer', run: () => void db.meals.put(m) })
  }
  const repeat = async (type: MealType) => {
    const y = yesterday.find((m) => m.type === type)
    if (!y) return
    await addItems(date, type, y.items)
    toast('Refeição de ontem copiada')
  }

  return (
    <>
      <PromptTitle path="~/dieta" />
      <div className="date-nav">
        <button onClick={() => setDate(addDays(date, -1))} aria-label="dia anterior">‹</button>
        <b>{date === today() ? 'hoje' : fmtLong(date)}</b>
        <button onClick={() => setDate(addDays(date, 1))} aria-label="próximo dia">›</button>
      </div>

      <button className="ai block" style={{ marginTop: 10 }} disabled={photoBusy} onClick={() => fileRef.current?.click()}>
        {photoBusy ? 'analisando prato…' : 'foto do prato (IA)'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void onPhoto(e.target.files?.[0])}
      />

      <div className="card" style={{ marginTop: 10 }}>
        <div className="row between" style={{ alignItems: 'baseline' }}>
          <span className="muted small">kcal</span>
          <span className="muted small">meta {fmtNum(goals.kcal)}</span>
        </div>
        <div className={`big ${tot.kcal > goals.kcal * 1.05 ? 'amber' : ''}`}>{fmtNum(tot.kcal)}</div>
        <div style={{ margin: '8px 0 14px' }}><Progress value={tot.kcal} max={goals.kcal} /></div>
        <div className="grid3">
          {([['proteína', tot.p, goals.p], ['carbo', tot.c, goals.c], ['gordura', tot.g, goals.g]] as [string, number, number][]).map(([label, v, max]) => (
            <div key={label}>
              <div className="muted small">{label}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }} className={v > max * 1.05 ? 'amber' : ''}>{fmtNum(v)}<span className="muted small">/{fmtNum(max)}g</span></div>
              <div style={{ marginTop: 4 }}><Progress value={v} max={max} /></div>
            </div>
          ))}
        </div>
        <button className="small" style={{ marginTop: 12 }} onClick={() => setShowGoals(true)}>editar metas</button>
      </div>

      {TYPES.map(([type, label]) => {
        const m = dayMeals.find((x) => x.type === type)
        const t = m ? sumItems(m.items) : null
        const canRepeat = !m && yesterday.some((y) => y.type === type)
        return (
          <div key={type} className="card">
            <div className="row between">
              <h3>{label}</h3>
              <span className="muted small">{t ? `${fmtNum(t.kcal)} kcal` : ''}</span>
            </div>
            {m?.items.map((it, i) => (
              <div key={i} className="item">
                <div className="grow tap" style={{ cursor: 'pointer' }} onClick={() => setEditing({ m, idx: i })}>
                  <div>{it.name} <span className="muted small">· {it.qty}</span></div>
                  <div className="muted small">{fmtNum(it.kcal)} kcal · P {fmtNum(it.p)} · C {fmtNum(it.c)} · G {fmtNum(it.g)}</div>
                </div>
                <button className="ghost danger" aria-label="Excluir alimento" onClick={() => removeItem(m, i)}>✕</button>
              </div>
            ))}
            <div className="row wrap" style={{ marginTop: 6 }}>
              <button className="small primary" onClick={() => setAdding(type)}>+ alimento</button>
              {canRepeat && <button className="small" onClick={() => repeat(type)}>repetir de ontem</button>}
              {m && <button className="small danger" onClick={() => removeMeal(m, label)}>excluir refeição</button>}
            </div>
          </div>
        )
      })}

      <h2>últimos 7 dias</h2>
      <div className="card">
        {week.map((w) => (
          <div key={w.d} className="row" style={{ margin: '4px 0' }}>
            <span className="muted small" style={{ width: 48 }}>{fmtShort(w.d)}</span>
            <div className="grow"><Progress value={w.kcal} max={goals.kcal} /></div>
            <span className="small" style={{ width: 70, textAlign: 'right' }}>{fmtNum(w.kcal)}</span>
          </div>
        ))}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Média: {fmtNum(avg('kcal'))} kcal · {fmtNum(avg('p'))}g prot
        </p>
      </div>

      <button className="block" onClick={() => setShowFoods(true)}>Alimentos salvos</button>

      {adding && <AddFood type={adding} date={date} onClose={() => setAdding(null)} />}
      {showGoals && <GoalsSheet goals={goals} onClose={() => setShowGoals(false)} />}
      {showFoods && <FoodsManager onClose={() => setShowFoods(false)} />}
      {editing && <EditItemSheet meal={editing.m} idx={editing.idx} onClose={() => setEditing(null)} />}
    </>
  )
}

function EditItemSheet({ meal, idx, onClose }: { meal: Meal; idx: number; onClose: () => void }) {
  const it = meal.items[idx]
  const [s, setS] = useState({ name: it.name, qty: it.qty, kcal: String(it.kcal), p: String(it.p), c: String(it.c), g: String(it.g) })
  const save = async () => {
    if (!s.name.trim()) return
    const items = meal.items.map((x, i) => (i === idx ? { name: s.name.trim(), qty: s.qty.trim() || '1 porção', kcal: num(s.kcal), p: num(s.p), c: num(s.c), g: num(s.g) } : x))
    await db.meals.put({ ...meal, items })
    onClose()
  }
  return (
    <Sheet title="Editar alimento" onClose={onClose}>
      <div className="stack">
        <Field label="Nome" value={s.name} mode="text" onChange={(v) => setS({ ...s, name: v })} />
        <Field label="Quantidade (ex.: 150 g)" value={s.qty} mode="text" onChange={(v) => setS({ ...s, qty: v })} />
        <div className="grid2">
          <Field label="kcal" value={s.kcal} onChange={(v) => setS({ ...s, kcal: v })} />
          <Field label="Proteína (g)" value={s.p} onChange={(v) => setS({ ...s, p: v })} />
          <Field label="Carboidrato (g)" value={s.c} onChange={(v) => setS({ ...s, c: v })} />
          <Field label="Gordura (g)" value={s.g} onChange={(v) => setS({ ...s, g: v })} />
        </div>
        <button className="primary block" onClick={save}>Salvar</button>
      </div>
    </Sheet>
  )
}

function GoalsSheet({ goals, onClose }: { goals: Goals; onClose: () => void }) {
  // grava a cada alteração
  const set = (k: keyof Goals, v: string) => void setSetting('goals', { ...goals, [k]: num(v) })
  return (
    <Sheet title="Metas diárias" onClose={onClose}>
      <div className="grid2">
        <Field label="Calorias (kcal)" value={String(goals.kcal)} mode="numeric" onChange={(v) => set('kcal', v)} />
        <Field label="Proteína (g)" value={String(goals.p)} mode="numeric" onChange={(v) => set('p', v)} />
        <Field label="Carboidrato (g)" value={String(goals.c)} mode="numeric" onChange={(v) => set('c', v)} />
        <Field label="Gordura (g)" value={String(goals.g)} mode="numeric" onChange={(v) => set('g', v)} />
      </div>
      <p className="muted small">As alterações são salvas automaticamente.</p>
    </Sheet>
  )
}

const scale = (f: Food, mult: number, units = f.qty): MealItem => ({
  name: f.name, qty: mult === 1 ? units : `${fmtNum(mult)} × ${units}`,
  kcal: f.kcal * mult, p: f.p * mult, c: f.c * mult, g: f.g * mult,
})

function AddFood({ type, date, onClose }: { type: MealType; date: string; onClose: () => void }) {
  const { toast } = useUi()
  const [tab, setTab] = useState<'salvos' | 'manual'>('salvos')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Food | null>(null)
  const [mult, setMult] = useState('1')
  const foods = useLiveQuery(() => db.foods.toArray(), [], [] as Food[])
  const list = foods
    .filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  const [m, setM] = useState({ name: '', qty: '', kcal: '', p: '', c: '', g: '', fav: true })

  const addSaved = async () => {
    if (!sel) return
    await addItems(date, type, [scale(sel, num(mult) || 1)])
    toast(`${sel.name} adicionado`)
    setSel(null); setMult('1')
  }
  const addManual = async () => {
    if (!m.name.trim()) return
    const item: MealItem = { name: m.name.trim(), qty: m.qty.trim() || '1 porção', kcal: num(m.kcal), p: num(m.p), c: num(m.c), g: num(m.g) }
    await db.transaction('rw', db.meals, db.foods, async () => {
      await addItems(date, type, [item])
      if (m.fav) await db.foods.add({ id: uid(), name: item.name, qty: item.qty, kcal: item.kcal, p: item.p, c: item.c, g: item.g, favorite: true })
    })
    toast(`${item.name} adicionado`)
    setM({ name: '', qty: '', kcal: '', p: '', c: '', g: '', fav: true })
  }

  return (
    <Sheet title={TYPES.find((t) => t[0] === type)![1]} onClose={onClose}>
      <Seg value={tab} onChange={setTab} options={[['salvos', 'Salvos'], ['manual', 'Novo alimento']]} />
      {tab === 'salvos' ? (
        <>
          <input placeholder="Buscar alimento…" value={q} onChange={(e) => setQ(e.target.value)} />
          {sel && (
            <div className="card" style={{ marginTop: 10, borderColor: 'var(--accent)' }}>
              <b>{sel.name}</b> <span className="muted small">({sel.qty})</span>
              <div className="row" style={{ marginTop: 6 }}>
                <div className="grow"><Field label="Porções" value={mult} onChange={setMult} /></div>
                <div className="muted small grow">{fmtNum(sel.kcal * (num(mult) || 1))} kcal</div>
                <button className="primary" onClick={addSaved}>Adicionar</button>
              </div>
            </div>
          )}
          {list.map((f) => (
            <div key={f.id} className="item tap" onClick={() => { setSel(f); setMult('1') }}>
              <div className="grow">
                <div>{f.favorite ? '* ' : ''}{f.name}</div>
                <div className="muted small">{f.qty} · {fmtNum(f.kcal)} kcal · P {fmtNum(f.p)} C {fmtNum(f.c)} G {fmtNum(f.g)}{f.builtin ? ' · aprox.' : ''}</div>
              </div>
            </div>
          ))}
          <p className="muted small">Valores aproximados, editáveis em “Gerenciar alimentos salvos”.</p>
        </>
      ) : (
        <div className="stack">
          <Field label="Nome" value={m.name} mode="text" onChange={(v) => setM({ ...m, name: v })} />
          <Field label="Quantidade (ex.: 150 g)" value={m.qty} mode="text" onChange={(v) => setM({ ...m, qty: v })} />
          <div className="grid2">
            <Field label="kcal" value={m.kcal} onChange={(v) => setM({ ...m, kcal: v })} />
            <Field label="Proteína (g)" value={m.p} onChange={(v) => setM({ ...m, p: v })} />
            <Field label="Carboidrato (g)" value={m.c} onChange={(v) => setM({ ...m, c: v })} />
            <Field label="Gordura (g)" value={m.g} onChange={(v) => setM({ ...m, g: v })} />
          </div>
          <label className="row"><input type="checkbox" style={{ width: 24, minHeight: 24 }} checked={m.fav} onChange={(e) => setM({ ...m, fav: e.target.checked })} /> Salvar nos favoritos</label>
          <button className="primary block" onClick={addManual}>Adicionar à refeição</button>
        </div>
      )}
    </Sheet>
  )
}

function FoodsManager({ onClose }: { onClose: () => void }) {
  const { confirm, toast } = useUi()
  const foods = useLiveQuery(() => db.foods.toArray(), [], [] as Food[])
  const [edit, setEdit] = useState<Food | 'new' | null>(null)
  const sorted = [...foods].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  const remove = async (f: Food) => {
    if (!(await confirm(`Excluir "${f.name}" dos alimentos salvos?`))) return
    await db.foods.delete(f.id)
    toast('Alimento excluído', { label: 'desfazer', run: () => void db.foods.put(f) })
  }
  return (
    <Sheet title="Alimentos salvos" onClose={onClose}>
      <button className="primary block" onClick={() => setEdit('new')}>+ novo alimento</button>
      <p className="muted small">Os alimentos iniciais têm valores aproximados e podem ser editados.</p>
      {sorted.map((f) => (
        <div key={f.id} className="item">
          <button className="ghost" aria-label="Favorito" onClick={() => void db.foods.update(f.id, { favorite: !f.favorite })}>{f.favorite ? 'fav' : '---'}</button>
          <div className="grow" onClick={() => setEdit(f)}>
            <div>{f.name}</div>
            <div className="muted small">{f.qty} · {fmtNum(f.kcal)} kcal</div>
          </div>
          <button className="ghost danger" aria-label="Excluir" onClick={() => remove(f)}>rm</button>
        </div>
      ))}
      {edit && <FoodForm food={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </Sheet>
  )
}

function FoodForm({ food, onClose }: { food?: Food; onClose: () => void }) {
  const [s, setS] = useState({
    name: food?.name ?? '', qty: food?.qty ?? '100 g', kcal: String(food?.kcal ?? ''), p: String(food?.p ?? ''), c: String(food?.c ?? ''), g: String(food?.g ?? ''),
  })
  const save = async () => {
    if (!s.name.trim()) return
    await db.foods.put({
      ...(food ?? { id: uid(), favorite: true }), name: s.name.trim(), qty: s.qty.trim(), kcal: num(s.kcal), p: num(s.p), c: num(s.c), g: num(s.g),
    } as Food)
    onClose()
  }
  return (
    <Sheet title={food ? 'Editar alimento' : 'Novo alimento'} onClose={onClose}>
      <div className="stack">
        <Field label="Nome" value={s.name} mode="text" onChange={(v) => setS({ ...s, name: v })} />
        <Field label="Porção de referência" value={s.qty} mode="text" onChange={(v) => setS({ ...s, qty: v })} />
        <div className="grid2">
          <Field label="kcal" value={s.kcal} onChange={(v) => setS({ ...s, kcal: v })} />
          <Field label="Proteína (g)" value={s.p} onChange={(v) => setS({ ...s, p: v })} />
          <Field label="Carboidrato (g)" value={s.c} onChange={(v) => setS({ ...s, c: v })} />
          <Field label="Gordura (g)" value={s.g} onChange={(v) => setS({ ...s, g: v })} />
        </div>
        <button className="primary block" onClick={save}>Salvar</button>
      </div>
    </Sheet>
  )
}
