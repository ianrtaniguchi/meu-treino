import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db, uid } from '../data/db'
import { exerciseHistory, fmtNum, fmtShort, num, personalRecord, setLabel, totalVolume } from '../data/stats'
import type { Exercise, Measure } from '../data/types'
import Chart from './Chart'
import { Field, Sheet, useUi } from './ui'

/** Agrupa exercícios por categoria, em ordem de progressão. */
export function groupByCategory(list: Exercise[]): [string, Exercise[]][] {
  const m = new Map<string, Exercise[]>()
  for (const e of [...list].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) {
    if (!m.has(e.category)) m.set(e.category, [])
    m.get(e.category)!.push(e)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

export function ExerciseList({ onPick, filterText }: { onPick: (e: Exercise) => void; filterText: string }) {
  const all = useLiveQuery(() => db.exercises.toArray(), [])
  const groups = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    return groupByCategory((all ?? []).filter((e) => !q || (e.name + ' ' + e.category).toLowerCase().includes(q)))
  }, [all, filterText])
  return (
    <>
      {groups.map(([cat, items]) => (
        <div key={cat}>
          <h2>{cat}</h2>
          <div className="card" style={{ padding: '4px 12px' }}>
            {items.map((e) => (
              <div key={e.id} className="item tap" onClick={() => onPick(e)}>
                <span className="muted" style={{ width: 20 }}>{e.level}</span>
                <span className="grow">{e.name}</span>
                <span className="chip">{e.measure === 'time' ? 'tempo' : 'reps'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {all && groups.length === 0 && <p className="muted">Nenhum exercício encontrado.</p>}
    </>
  )
}

/** Seleção de exercício (para sessões e rotinas). */
export function ExercisePicker({ onPick, onClose }: { onPick: (e: Exercise) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  return (
    <Sheet title="Escolher exercício" onClose={onClose}>
      <input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ExerciseList filterText={q} onPick={(e) => { onPick(e); onClose() }} />
    </Sheet>
  )
}

export function ExerciseForm({ exercise, onClose }: { exercise?: Exercise; onClose: () => void }) {
  const [name, setName] = useState(exercise?.name ?? '')
  const [category, setCategory] = useState(exercise?.category ?? 'Personalizados')
  const [level, setLevel] = useState(String(exercise?.level ?? 1))
  const [measure, setMeasure] = useState<Measure>(exercise?.measure ?? 'reps')
  const cats = useLiveQuery(async () => [...new Set((await db.exercises.toArray()).map((e) => e.category))].sort(), [], [] as string[])
  const submit = async () => {
    if (!name.trim()) return
    const ex: Exercise = {
      ...(exercise ?? { id: uid() }),
      name: name.trim(), category: category.trim() || 'Personalizados', level: Math.max(1, Math.round(num(level)) || 1), measure,
    } as Exercise
    await db.exercises.put(ex)
    onClose()
  }
  return (
    <Sheet title={exercise ? 'Editar exercício' : 'Novo exercício'} onClose={onClose}>
      <div className="stack">
        <Field label="Nome" value={name} onChange={setName} mode="text" />
        <label className="f">
          Categoria
          <input list="cats" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <Field label="Nível na progressão (1 = mais fácil)" value={level} onChange={setLevel} mode="numeric" />
        <label className="f">
          Medição
          <select value={measure} onChange={(e) => setMeasure(e.target.value as Measure)}>
            <option value="reps">Repetições</option>
            <option value="time">Tempo (segundos)</option>
          </select>
        </label>
        <button className="primary block" onClick={submit}>{exercise ? 'Salvar alterações' : 'Criar exercício'}</button>
      </div>
    </Sheet>
  )
}

/** Detalhe: histórico, PR, volume e gráfico de evolução. */
export function ExerciseDetail({ exercise, onClose }: { exercise: Exercise; onClose: () => void }) {
  const { confirm, toast } = useUi()
  const [editing, setEditing] = useState(false)
  const sessions = useLiveQuery(() => db.sessions.toArray(), [])
  const history = useMemo(() => exerciseHistory(sessions ?? [], exercise.id), [sessions, exercise.id])
  const pr = personalRecord(history)
  const vol = totalVolume(history)
  const unit = exercise.measure === 'time' ? 's' : ''
  // melhor série de cada dia (maior valor)
  const chartData = history.map((d) => ({ x: fmtShort(d.date), y: Math.max(...d.sets.map((s) => s.value)) }))

  const remove = async () => {
    if (!(await confirm(`Excluir "${exercise.name}"? O histórico de treinos continua salvo.`))) return
    await db.exercises.delete(exercise.id)
    onClose()
    toast('Exercício excluído', { label: 'Desfazer', run: () => void db.exercises.put(exercise) })
  }

  if (editing) return <ExerciseForm exercise={exercise} onClose={() => { setEditing(false); onClose() }} />
  return (
    <Sheet title={exercise.name} onClose={onClose}>
      <p className="muted">{exercise.category} · nível {exercise.level} · {exercise.measure === 'time' ? 'tempo' : 'repetições'}</p>
      <div className="grid3">
        <div className="stat"><span className="muted small">PR</span><b>{pr ? setLabel(pr, exercise.measure) : '—'}</b></div>
        <div className="stat"><span className="muted small">Total {exercise.measure === 'time' ? 'seg.' : 'reps'}</span><b>{vol.total}</b></div>
        <div className="stat"><span className="muted small">Carga (kg×rep)</span><b>{fmtNum(vol.tonnage)}</b></div>
      </div>
      <h2>Evolução (melhor série)</h2>
      <Chart data={chartData} name="Melhor série" unit={unit} />
      <h2>Histórico</h2>
      {history.length === 0 && <p className="muted">Ainda sem registros.</p>}
      {[...history].reverse().map((d) => (
        <div key={d.sessionId} className="card">
          <div className="muted small">{fmtShort(d.date)}</div>
          <div className="row wrap" style={{ margin: '6px 0' }}>
            {d.sets.map((s) => (
              <span key={s.id} className="chip">
                {setLabel(s, exercise.measure)}
                {pr && s.id === pr.id && <span className="tag-pr">[PR]</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="grid2" style={{ marginTop: 12 }}>
        <button onClick={() => setEditing(true)}>Editar</button>
        <button className="danger" onClick={remove}>Excluir</button>
      </div>
    </Sheet>
  )
}
