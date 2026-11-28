import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import CommitLog from '../components/CommitLog'
import { ExerciseDetail, ExerciseForm, ExerciseList, ExercisePicker } from '../components/ExerciseViews'
import FocusMode from '../components/FocusMode'
import Heatmap, { heatRange } from '../components/Heatmap'
import SessionEditor from '../components/SessionEditor'
import { PromptTitle, Statusline } from '../components/TerminalChrome'
import { Seg, Sheet, useUi } from '../components/ui'
import { db, setSetting, uid } from '../data/db'
import { DEFAULT_GOALS } from '../data/seed'
import { fmtNum, parseDate, today, toDateStr, weeklyCounts, fmtShort } from '../data/stats'
import type { BodyEntry, Exercise, Goals, Meal, Routine, Session } from '../data/types'
import { useSetting } from '../hooks'
import { buildDays, streaks } from '../lib/panel'

type Sub = 'painel' | 'historico' | 'exercicios' | 'rotinas'

export default function Treino() {
  const [sub, setSub] = useState<Sub>('painel')
  return (
    <>
      <PromptTitle path="~/treino" />
      <Statusline />
      <Seg<Sub>
        value={sub}
        onChange={setSub}
        options={[['painel', 'painel'], ['historico', 'histórico'], ['exercicios', 'exercícios'], ['rotinas', 'rotinas']]}
      />
      {sub === 'painel' && <Painel />}
      {sub === 'historico' && <Historico />}
      {sub === 'exercicios' && <Exercicios />}
      {sub === 'rotinas' && <Rotinas />}
    </>
  )
}

function Painel() {
  const activeId = useSetting<string | null>('activeSessionId', null)
  const active = useLiveQuery(async () => (activeId ? await db.sessions.get(activeId) : undefined), [activeId], undefined)
  const routines = useLiveQuery(() => db.routines.toArray(), [], [] as Routine[])
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const meals = useLiveQuery(() => db.meals.toArray(), [], [] as Meal[])
  const body = useLiveQuery(() => db.body.toArray(), [], [] as BodyEntry[])
  const goals = useSetting<Goals>('goals', DEFAULT_GOALS) ?? DEFAULT_GOALS
  const gap = useSetting<number>('streakGap', 2) ?? 2
  const restSeconds = useSetting<number>('restSeconds', 90)
  const [focus, setFocus] = useState(false)
  const [sel, setSel] = useState<string>(today())

  const t = today()
  const { from, to } = heatRange(t)
  const days = useMemo(() => buildDays(from, to, sessions, meals, body, goals), [from, to, sessions, meals, body, goals])

  const trained = sessions.filter((s) => s.entries.some((e) => e.sets.length > 0))
  const st = streaks(trained.map((s) => s.date), gap, t)
  const inMonth = trained.filter((s) => s.date.startsWith(t.slice(0, 7))).length
  const inYear = trained.filter((s) => s.date.startsWith(t.slice(0, 4))).length

  const start = async (r?: Routine) => {
    const s: Session = {
      id: uid(), date: today(), name: r?.name ?? 'Treino livre', routineId: r?.id, notes: '', createdAt: Date.now(),
      entries: (r?.exerciseIds ?? []).map((exerciseId) => ({ exerciseId, sets: [] })),
    }
    await db.transaction('rw', db.sessions, db.settings, async () => {
      await db.sessions.add(s)
      await setSetting('activeSessionId', s.id)
    })
    setFocus(true)
  }

  if (activeId === undefined) return null
  const hasActive = !!(activeId && active)
  if (hasActive && focus) return <FocusMode id={activeId!} onMinimize={() => setFocus(false)} />

  const day = days.get(sel)
  return (
    <>
      <div className="card">
        <Heatmap days={days} selected={sel} onSelect={setSel} />
      </div>
      <div className="card small" style={{ minHeight: 70 }}>
        <div className="muted">{sel}{sel === t ? ' (hoje)' : ''} · {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][parseDate(sel).getDay()]}</div>
        {day ? (
          <div className="stack" style={{ marginTop: 4 }}>
            <div>treino: {day.sets ? `${day.sessions.map((s) => s.name.toLowerCase()).join(', ')} · ${day.sets} séries` : <span className="muted">—</span>}</div>
            <div>dieta: {day.mealCount ? `${fmtNum(day.kcal)} kcal · ${fmtNum(day.protein)}g prot (meta ${goals.p}g)` : <span className="muted">—</span>}</div>
            <div>peso: {day.weight !== undefined ? `${fmtNum(day.weight)} kg` : <span className="muted">—</span>}</div>
          </div>
        ) : <div className="muted" style={{ marginTop: 4 }}>sem registros.</div>}
      </div>

      <div className="grid4" style={{ margin: '14px 0' }}>
        <div className="stat"><b className={st.current ? 'green' : ''}>{st.current}</b><span>streak atual</span></div>
        <div className="stat"><b>{st.longest}</b><span>maior streak</span></div>
        <div className="stat"><b>{inMonth}</b><span>treinos no mês</span></div>
        <div className="stat"><b>{inYear}</b><span>total no ano</span></div>
      </div>

      {hasActive ? (
        <button className="primary block" style={{ minHeight: 52 }} onClick={() => setFocus(true)}>continuar treino ({active!.name.toLowerCase()})</button>
      ) : (
        <button className="primary block" style={{ minHeight: 52 }} onClick={() => start()}>iniciar treino</button>
      )}

      {!hasActive && routines.length > 0 && (
        <>
          <h2>rotinas</h2>
          {routines.map((r) => (
            <button key={r.id} className="block" style={{ marginBottom: 6, textAlign: 'left' }} onClick={() => start(r)}>
              {r.name} <span className="muted">· {r.exerciseIds.length} ex</span>
            </button>
          ))}
        </>
      )}

      <h2>descanso entre séries</h2>
      <div className="row">
        {[60, 90, 120, 180].map((s) => (
          <button key={s} className={restSeconds === s ? 'on' : ''} onClick={() => setSetting('restSeconds', s)}>{s}s</button>
        ))}
      </div>

      <h2>sessões recentes</h2>
      <CommitLog limit={12} />
    </>
  )
}

function Historico() {
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const [month, setMonth] = useState(() => today().slice(0, 7))
  const [sel, setSel] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const dates = useMemo(() => new Set(sessions.map((s) => s.date)), [sessions])
  const weeks = useMemo(() => weeklyCounts(sessions, 8), [sessions])
  const maxW = Math.max(1, ...weeks.map((w) => w.count))
  const monthCount = sessions.filter((s) => s.date.startsWith(month)).length

  const first = parseDate(month + '-01')
  const lead = (first.getDay() + 6) % 7
  const nDays = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const shift = (n: number) => setMonth(toDateStr(new Date(first.getFullYear(), first.getMonth() + n, 1)).slice(0, 7))
  const onDay = sel ? sessions.filter((s) => s.date === sel) : []

  return (
    <>
      <div className="date-nav">
        <button onClick={() => shift(-1)} aria-label="mês anterior">‹</button>
        <b>{month}</b>
        <button onClick={() => shift(1)} aria-label="próximo mês">›</button>
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}>{monthCount} treino(s) no mês</p>
      <div className="cal">
        {['s', 't', 'q', 'q', 's', 's', 'd'].map((d, i) => <div key={i} className="h">{d}</div>)}
        {Array.from({ length: lead }).map((_, i) => <div key={'b' + i} />)}
        {Array.from({ length: nDays }).map((_, i) => {
          const ds = `${month}-${String(i + 1).padStart(2, '0')}`
          return (
            <button key={ds} className={`d ${dates.has(ds) ? 'has' : ''} ${sel === ds ? 'sel' : ''} ${ds === today() ? 'today' : ''}`}
              onClick={() => setSel(sel === ds ? null : ds)}>{i + 1}</button>
          )
        })}
      </div>
      {sel && onDay.length > 0 && (
        <div className="card" style={{ marginTop: 10 }}>
          {onDay.map((s) => (
            <div key={s.id} className="item tap" onClick={() => setOpen(s.id)}>
              <span className="grow">{s.name.toLowerCase()}</span>
              <span className="muted small">{fmtShort(s.date)} · {s.entries.reduce((n, e) => n + e.sets.length, 0)} séries</span>
            </div>
          ))}
        </div>
      )}

      <h2>treinos por semana</h2>
      <div className="card">
        {weeks.map((w) => (
          <div key={w.week} className="row" style={{ margin: '4px 0' }}>
            <span className="muted small" style={{ width: 48 }}>{fmtShort(w.week)}</span>
            <div className="bar grow"><i style={{ transform: `scaleX(${w.count / maxW})` }} /></div>
            <b style={{ width: 20, textAlign: 'right' }}>{w.count}</b>
          </div>
        ))}
      </div>

      <h2>git log</h2>
      <CommitLog limit={sel ? undefined : 60} />
      {open && (
        <Sheet title="git show" onClose={() => setOpen(null)}>
          <SessionEditor id={open} onClose={() => setOpen(null)} />
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
        <input placeholder="buscar exercício…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" aria-label="Novo exercício" onClick={() => setCreating(true)}>+</button>
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
    toast('Rotina excluída', { label: 'desfazer', run: () => void db.routines.put(r) })
  }
  return (
    <>
      <button className="primary block" onClick={create}>+ nova rotina</button>
      <div style={{ height: 12 }} />
      {routines.length === 0 && <p className="muted"># ex.: "Treino A - Empurrar"</p>}
      {routines.map((r) => (
        <div key={r.id} className="card row">
          <div className="grow" onClick={() => setEditId(r.id)} style={{ cursor: 'pointer' }}>
            <b>{r.name}</b>
            <div className="muted small">{r.exerciseIds.length} exercícios</div>
          </div>
          <button className="ghost danger" aria-label="Excluir rotina" onClick={() => remove(r)}>rm</button>
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
    <Sheet title="rotina" onClose={onClose}>
      <label className="f">
        nome
        <input value={routine.name} onChange={(e) => save({ name: e.target.value })} />
      </label>
      <h2>exercícios</h2>
      {routine.exerciseIds.map((eid, i) => (
        <div key={eid} className="item">
          <span className="grow">{byId.get(eid)?.name ?? '(removido)'}</span>
          <button className="small" aria-label="Subir" onClick={() => move(i, -1)}>↑</button>
          <button className="small" aria-label="Descer" onClick={() => move(i, 1)}>↓</button>
          <button className="small danger" aria-label="Tirar da rotina" onClick={() => save({ exerciseIds: routine.exerciseIds.filter((x) => x !== eid) })}>×</button>
        </div>
      ))}
      <button className="block" style={{ marginTop: 10 }} onClick={() => setPicking(true)}>+ exercício</button>
      {picking && (
        <ExercisePicker onClose={() => setPicking(false)}
          onPick={(e) => !routine.exerciseIds.includes(e.id) && save({ exerciseIds: [...routine.exerciseIds, e.id] })} />
      )}
    </Sheet>
  )
}
