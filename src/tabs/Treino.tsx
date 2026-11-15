import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { ExerciseDetail, ExerciseForm, ExerciseList, ExercisePicker } from '../components/ExerciseViews'
import SessionEditor from '../components/SessionEditor'
import { Seg, Sheet, useUi } from '../components/ui'
import { db, setSetting, uid } from '../data/db'
import { fmtLong, fmtShort, parseDate, today, toDateStr, weeklyCounts } from '../data/stats'
import type { Exercise, Routine, Session } from '../data/types'
import { useSetting } from '../hooks'

type Sub = 'hoje' | 'historico' | 'exercicios' | 'rotinas'

export default function Treino() {
  const [sub, setSub] = useState<Sub>('hoje')
  return (
    <>
      <Seg<Sub>
        value={sub}
        onChange={setSub}
        options={[['hoje', 'Treinar'], ['historico', 'Histórico'], ['exercicios', 'Exercícios'], ['rotinas', 'Rotinas']]}
      />
      {sub === 'hoje' && <Hoje />}
      {sub === 'historico' && <Historico />}
      {sub === 'exercicios' && <Exercicios />}
      {sub === 'rotinas' && <Rotinas />}
    </>
  )
}

function Hoje() {
  const activeId = useSetting<string | null>('activeSessionId', null)
  const active = useLiveQuery(async () => (activeId ? await db.sessions.get(activeId) : undefined), [activeId], undefined)
  const routines = useLiveQuery(() => db.routines.toArray(), [], [] as Routine[])
  const restSeconds = useSetting<number>('restSeconds', 90)
  const recent = useLiveQuery(() => db.sessions.orderBy('date').reverse().limit(1).toArray(), [], [] as Session[])

  const start = async (r?: Routine) => {
    const s: Session = {
      id: uid(), date: today(), name: r?.name ?? 'Treino livre', routineId: r?.id, notes: '', createdAt: Date.now(),
      entries: (r?.exerciseIds ?? []).map((exerciseId) => ({ exerciseId, sets: [] })),
    }
    await db.transaction('rw', db.sessions, db.settings, async () => {
      await db.sessions.add(s)
      await setSetting('activeSessionId', s.id)
    })
  }

  if (activeId === undefined) return null
  if (activeId && active) return <SessionEditor id={activeId} active onClose={() => void setSetting('activeSessionId', null)} />

  return (
    <>
      <h1>Treinar</h1>
      <button className="primary block" onClick={() => start()}>▶ Começar treino livre</button>
      <h2>Começar uma rotina</h2>
      {routines.length === 0 && <p className="muted">Crie rotinas na aba “Rotinas”.</p>}
      {routines.map((r) => (
        <button key={r.id} className="block" style={{ marginBottom: 8, textAlign: 'left' }} onClick={() => start(r)}>
          ▶ {r.name} <span className="muted small">· {r.exerciseIds.length} exercícios</span>
        </button>
      ))}
      <h2>Descanso entre séries</h2>
      <div className="row">
        {[60, 90, 120, 180].map((s) => (
          <button key={s} className={restSeconds === s ? 'primary' : ''} onClick={() => setSetting('restSeconds', s)}>{s}s</button>
        ))}
      </div>
      {recent[0] && <p className="muted" style={{ marginTop: 16 }}>Último treino: {recent[0].name} em {fmtShort(recent[0].date)}</p>}
    </>
  )
}

function Historico() {
  const { confirm, toast } = useUi()
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const [month, setMonth] = useState(() => today().slice(0, 7))
  const [sel, setSel] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const dates = useMemo(() => new Set(sessions.map((s) => s.date)), [sessions])
  const weeks = useMemo(() => weeklyCounts(sessions, 8), [sessions])
  const maxW = Math.max(1, ...weeks.map((w) => w.count))
  const monthCount = sessions.filter((s) => s.date.startsWith(month)).length

  const first = parseDate(month + '-01')
  const lead = (first.getDay() + 6) % 7 // semana começa na segunda
  const nDays = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const shift = (n: number) => setMonth(toDateStr(new Date(first.getFullYear(), first.getMonth() + n, 1)).slice(0, 7))

  const list = (sel ? sessions.filter((s) => s.date === sel) : [...sessions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 30))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)

  const remove = async (s: Session) => {
    if (!(await confirm(`Excluir o treino "${s.name}" de ${fmtShort(s.date)}?`))) return
    await db.sessions.delete(s.id)
    toast('Treino excluído', { label: 'Desfazer', run: () => void db.sessions.put(s) })
  }

  return (
    <>
      <div className="row between">
        <button onClick={() => shift(-1)}>‹</button>
        <b style={{ textTransform: 'capitalize' }}>{first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</b>
        <button onClick={() => shift(1)}>›</button>
      </div>
      <p className="muted" style={{ textAlign: 'center' }}>{monthCount} treino(s) no mês</p>
      <div className="cal">
        {['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map((d, i) => <div key={i} className="h">{d}</div>)}
        {Array.from({ length: lead }).map((_, i) => <div key={'b' + i} />)}
        {Array.from({ length: nDays }).map((_, i) => {
          const ds = `${month}-${String(i + 1).padStart(2, '0')}`
          return (
            <button key={ds} className={`d ${dates.has(ds) ? 'has' : ''} ${sel === ds ? 'sel' : ''} ${ds === today() ? 'today' : ''}`}
              onClick={() => setSel(sel === ds ? null : ds)}>{i + 1}</button>
          )
        })}
      </div>

      <h2>Treinos por semana</h2>
      <div className="card">
        {weeks.map((w) => (
          <div key={w.week} className="row" style={{ margin: '4px 0' }}>
            <span className="muted small" style={{ width: 48 }}>{fmtShort(w.week)}</span>
            <div className="bar grow"><i style={{ width: `${(w.count / maxW) * 100}%` }} /></div>
            <b style={{ width: 20, textAlign: 'right' }}>{w.count}</b>
          </div>
        ))}
      </div>

      <h2>{sel ? `Treinos em ${fmtLong(sel)}` : 'Últimos treinos'}</h2>
      {list.length === 0 && <p className="muted">Nenhum treino.</p>}
      {list.map((s) => (
        <div key={s.id} className="card row">
          <div className="grow" onClick={() => setOpen(s.id)} style={{ cursor: 'pointer' }}>
            <b>{s.name}</b>
            <div className="muted small">{fmtLong(s.date)} · {s.entries.length} exercícios · {s.entries.reduce((n, e) => n + e.sets.length, 0)} séries</div>
          </div>
          <button className="ghost danger" aria-label="Excluir treino" onClick={() => remove(s)}>🗑️</button>
        </div>
      ))}
      {open && (
        <Sheet title="Treino" onClose={() => setOpen(null)}>
          <SessionEditor id={open} active={false} onClose={() => setOpen(null)} />
        </Sheet>
      )}
    </>
  )
}

function Exercicios() {
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<Exercise | null>(null)
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="row">
        <input placeholder="Buscar exercício…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={() => setCreating(true)}>＋</button>
      </div>
      <ExerciseList filterText={q} onPick={setDetail} />
      {detail && <ExerciseDetail exercise={detail} onClose={() => setDetail(null)} />}
      {creating && <ExerciseForm onClose={() => setCreating(false)} />}
    </>
  )
}

function Rotinas() {
  const { confirm, toast } = useUi()
  const routines = useLiveQuery(() => db.routines.toArray(), [], [] as Routine[])
  const [editId, setEditId] = useState<string | null>(null)
  const create = async () => {
    const r: Routine = { id: uid(), name: 'Nova rotina', exerciseIds: [] }
    await db.routines.add(r)
    setEditId(r.id)
  }
  const remove = async (r: Routine) => {
    if (!(await confirm(`Excluir a rotina "${r.name}"?`))) return
    await db.routines.delete(r.id)
    toast('Rotina excluída', { label: 'Desfazer', run: () => void db.routines.put(r) })
  }
  return (
    <>
      <button className="primary block" onClick={create}>＋ Nova rotina</button>
      <div style={{ height: 12 }} />
      {routines.length === 0 && <p className="muted">Ex.: “Treino A - Empurrar”.</p>}
      {routines.map((r) => (
        <div key={r.id} className="card row">
          <div className="grow" onClick={() => setEditId(r.id)} style={{ cursor: 'pointer' }}>
            <b>{r.name}</b>
            <div className="muted small">{r.exerciseIds.length} exercícios</div>
          </div>
          <button className="ghost danger" aria-label="Excluir rotina" onClick={() => remove(r)}>🗑️</button>
        </div>
      ))}
      {editId && <RoutineEditor id={editId} onClose={() => setEditId(null)} />}
    </>
  )
}

/** Edita a rotina com gravação imediata a cada alteração. */
function RoutineEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const routine = useLiveQuery(() => db.routines.get(id), [id])
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[])
  const [picking, setPicking] = useState(false)
  const byId = new Map(exercises.map((e) => [e.id, e]))
  if (!routine) return null
  const save = (patch: Partial<Routine>) => void db.routines.update(id, patch)
  const move = (i: number, d: number) => {
    const a = [...routine.exerciseIds]
    const j = i + d
    if (j < 0 || j >= a.length) return
    ;[a[i], a[j]] = [a[j], a[i]]
    save({ exerciseIds: a })
  }
  return (
    <Sheet title="Rotina" onClose={onClose}>
      <label className="f">
        Nome
        <input value={routine.name} onChange={(e) => save({ name: e.target.value })} />
      </label>
      <h2>Exercícios</h2>
      {routine.exerciseIds.map((eid, i) => (
        <div key={eid} className="item">
          <span className="grow">{byId.get(eid)?.name ?? '(removido)'}</span>
          <button className="small" aria-label="Subir" onClick={() => move(i, -1)}>↑</button>
          <button className="small" aria-label="Descer" onClick={() => move(i, 1)}>↓</button>
          <button className="small danger" aria-label="Tirar da rotina" onClick={() => save({ exerciseIds: routine.exerciseIds.filter((x) => x !== eid) })}>✕</button>
        </div>
      ))}
      <button className="block" style={{ marginTop: 10 }} onClick={() => setPicking(true)}>+ Adicionar exercício</button>
      {picking && (
        <ExercisePicker onClose={() => setPicking(false)}
          onPick={(e) => !routine.exerciseIds.includes(e.id) && save({ exerciseIds: [...routine.exerciseIds, e.id] })} />
      )}
    </Sheet>
  )
}

