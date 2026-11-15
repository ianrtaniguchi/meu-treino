import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db, uid } from '../data/db'
import { fmtShort, lastPerformance, num, setLabel } from '../data/stats'
import type { Exercise, Session } from '../data/types'
import { ExercisePicker } from './ExerciseViews'
import { Field, useUi } from './ui'

/** Leitura-modificação-gravação da sessão numa transação (cada ação grava na hora). */
export async function updateSession(id: string, fn: (s: Session) => void) {
  await db.transaction('rw', db.sessions, async () => {
    const s = await db.sessions.get(id)
    if (!s) return
    fn(s)
    await db.sessions.put(s)
  })
}

/** Revisão/edição de um treino já registrado (o treino em andamento usa o modo foco). */
export default function SessionEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const { confirm, toast } = useUi()
  const session = useLiveQuery(() => db.sessions.get(id), [id], undefined)
  const [loaded, setLoaded] = useState(false)
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[])
  const allSessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const [picking, setPicking] = useState(false)
  const byId = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises])

  useEffect(() => { if (session !== undefined) setLoaded(true) }, [session])
  useEffect(() => { if (loaded && session === undefined) onClose() }, [loaded, session, onClose])
  if (!session) return null

  const totalSets = session.entries.reduce((n, e) => n + e.sets.length, 0)

  const remove = async () => {
    if (!(await confirm('Excluir este treino e todas as séries?'))) return
    const copy = session
    await db.sessions.delete(id)
    onClose()
    toast('Treino excluído', { label: 'desfazer', run: () => void db.sessions.put(copy) })
  }

  return (
    <div>
      <h1 style={{ marginBottom: 2 }}>{session.name.toLowerCase()}</h1>
      <div className="muted">{session.date} · {totalSets} séries</div>

      {session.entries.map((entry) => {
        const ex = byId.get(entry.exerciseId)
        return (
          <ExerciseBlock
            key={entry.exerciseId}
            exercise={ex}
            entry={entry}
            last={lastPerformance(allSessions, entry.exerciseId, id)}
            onAdd={(v, l, r) =>
              void updateSession(id, (s) => {
                s.entries.find((e) => e.exerciseId === entry.exerciseId)?.sets.push({ id: uid(), value: v, load: l, ...(r ? { rpe: r } : {}) })
              })
            }
            onDeleteSet={async (setId) => {
              if (!(await confirm('Excluir esta série?'))) return
              await updateSession(id, (s) => {
                const e = s.entries.find((x) => x.exerciseId === entry.exerciseId)
                if (e) e.sets = e.sets.filter((x) => x.id !== setId)
              })
            }}
            onRemove={async () => {
              if (!(await confirm(`Remover ${ex?.name ?? 'exercício'} deste treino${entry.sets.length ? ' (com suas séries)' : ''}?`, 'Remover'))) return
              await updateSession(id, (s) => { s.entries = s.entries.filter((x) => x.exerciseId !== entry.exerciseId) })
            }}
          />
        )
      })}

      <button className="block" style={{ margin: '4px 0 12px' }} onClick={() => setPicking(true)}>+ exercício</button>
      <label className="f">
        notas
        <textarea value={session.notes} onChange={(e) => void updateSession(id, (s) => { s.notes = e.target.value })} />
      </label>
      <div className="grid2" style={{ marginTop: 12 }}>
        <button onClick={onClose}>fechar</button>
        <button className="danger" onClick={remove}>excluir treino</button>
      </div>

      {picking && (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(e) => {
            if (session.entries.some((x) => x.exerciseId === e.id)) return toast('Exercício já está no treino')
            void updateSession(id, (s) => { s.entries.push({ exerciseId: e.id, sets: [] }) })
          }}
        />
      )}
    </div>
  )
}

function ExerciseBlock({ exercise, entry, last, onAdd, onDeleteSet, onRemove }: {
  exercise?: Exercise
  entry: Session['entries'][number]
  last: ReturnType<typeof lastPerformance>
  onAdd: (value: number, load: number, rpe?: number) => void
  onDeleteSet: (id: string) => void
  onRemove: () => void
}) {
  const measure = exercise?.measure ?? 'reps'
  const ref = entry.sets[entry.sets.length - 1] ?? last?.sets[0]
  const [value, setValue] = useState('')
  const [load, setLoad] = useState('')
  useEffect(() => {
    if (ref && value === '' && load === '') { setValue(String(ref.value)); setLoad(ref.load ? String(ref.load) : '') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.id])

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row between">
        <div className="grow">
          <h3>{exercise?.name ?? '(exercício removido)'}</h3>
          <div className="muted small">
            {last ? <>última vez ({fmtShort(last.date)}): {last.sets.map((s) => setLabel(s, measure)).join(' · ')}</> : 'primeira vez'}
          </div>
        </div>
        <button className="ghost small" aria-label="Remover exercício" onClick={onRemove}>rm</button>
      </div>
      <div className="row wrap" style={{ margin: '8px 0' }}>
        {entry.sets.map((s, i) => (
          <button key={s.id} className="small" onClick={() => onDeleteSet(s.id)} title="Toque para excluir">
            {i + 1}: {setLabel(s, measure)}{s.rpe ? ` @${s.rpe}` : ''}
          </button>
        ))}
      </div>
      <div className="grid3" style={{ alignItems: 'end' }}>
        <Field label={measure === 'time' ? 'segundos' : 'reps'} value={value} onChange={setValue} mode="numeric" />
        <Field label="carga kg" value={load} onChange={setLoad} />
        <button className="primary" disabled={num(value) <= 0} onClick={() => onAdd(num(value), num(load))}>+ série</button>
      </div>
    </div>
  )
}
