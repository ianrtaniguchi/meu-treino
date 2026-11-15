import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db, setSetting, uid } from '../data/db'
import { lastPerformance, num, setLabel, fmtShort } from '../data/stats'
import type { Exercise, Session } from '../data/types'
import { useSetting } from '../hooks'
import { ExercisePicker } from './ExerciseViews'
import RestTimer, { primeAudio } from './RestTimer'
import { Field, useUi } from './ui'

/** Leitura-modificação-gravação da sessão numa transação (cada ação grava na hora). */
async function updateSession(id: string, fn: (s: Session) => void) {
  await db.transaction('rw', db.sessions, async () => {
    const s = await db.sessions.get(id)
    if (!s) return
    fn(s)
    await db.sessions.put(s)
  })
}

export default function SessionEditor({ id, active, onClose }: { id: string; active: boolean; onClose: () => void }) {
  const { confirm, toast } = useUi()
  const session = useLiveQuery(() => db.sessions.get(id), [id], undefined)
  const [loaded, setLoaded] = useState(false)
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[])
  const allSessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const restSeconds = useSetting<number>('restSeconds', 90) ?? 90
  const [restEnd, setRestEnd] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)
  const byId = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises])

  useEffect(() => { if (session !== undefined) setLoaded(true) }, [session])
  // sessão sumiu (ex.: restauração de backup): sai da edição
  useEffect(() => { if (loaded && session === undefined) onClose() }, [loaded, session, onClose])
  if (!session) return null

  const totalSets = session.entries.reduce((n, e) => n + e.sets.length, 0)

  const finish = async () => {
    if (totalSets === 0) {
      if (!(await confirm('Nenhuma série registrada. Descartar este treino?', 'Descartar'))) return
      await db.sessions.delete(id)
    } else {
      await updateSession(id, (s) => { s.finishedAt = Date.now() })
    }
    await setSetting('activeSessionId', null)
    onClose()
  }
  const discard = async () => {
    if (!(await confirm('Descartar este treino e todas as séries?', 'Descartar'))) return
    const copy = session
    await db.sessions.delete(id)
    if (active) await setSetting('activeSessionId', null)
    onClose()
    toast('Treino descartado', { label: 'Desfazer', run: () => void db.sessions.put(copy) })
  }

  const addSet = (exerciseId: string, value: number, load: number, rpe?: number) => {
    primeAudio()
    void updateSession(id, (s) => {
      s.entries.find((e) => e.exerciseId === exerciseId)?.sets.push({ id: uid(), value, load, ...(rpe ? { rpe } : {}) })
    })
    setRestEnd(Date.now() + restSeconds * 1000)
  }

  return (
    <div>
      {restEnd && <RestTimer endAt={restEnd} onChange={setRestEnd} onClear={() => setRestEnd(null)} />}
      <div className="row between">
        <div className="grow">
          <h1 style={{ margin: 0 }}>{session.name}</h1>
          <div className="muted">{fmtShort(session.date)} · {totalSets} séries</div>
        </div>
        {active ? <button className="primary" onClick={finish}>Finalizar</button> : <button onClick={onClose}>Fechar</button>}
      </div>

      {session.entries.map((entry) => {
        const ex = byId.get(entry.exerciseId)
        return (
          <ExerciseBlock
            key={entry.exerciseId}
            exercise={ex}
            entry={entry}
            last={lastPerformance(allSessions, entry.exerciseId, id)}
            onAdd={(v, l, r) => addSet(entry.exerciseId, v, l, r)}
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

      <button className="block" style={{ margin: '6px 0 12px' }} onClick={() => setPicking(true)}>+ Adicionar exercício</button>
      <label className="f">
        Notas do treino
        <textarea value={session.notes} onChange={(e) => void updateSession(id, (s) => { s.notes = e.target.value })} />
      </label>
      {active && <button className="danger block" style={{ marginTop: 12 }} onClick={discard}>Descartar treino</button>}
      {!active && <button className="danger block" style={{ marginTop: 12 }} onClick={discard}>Excluir treino</button>}

      {picking && (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(e) => {
            if (session.entries.some((x) => x.exerciseId === e.id)) return toast('Esse exercício já está no treino')
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
  // pré-preenche com a última série deste treino, ou com a da última vez
  const ref = entry.sets[entry.sets.length - 1] ?? last?.sets[0]
  const [value, setValue] = useState('')
  const [load, setLoad] = useState('')
  const [rpe, setRpe] = useState('')
  useEffect(() => {
    if (ref && value === '' && load === '') { setValue(String(ref.value)); setLoad(ref.load ? String(ref.load) : '') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.id])

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row between">
        <div className="grow">
          <h3 style={{ margin: 0 }}>{exercise?.name ?? '(exercício removido)'}</h3>
          <div className="muted small">
            {last
              ? <>Última vez ({fmtShort(last.date)}): {last.sets.map((s) => setLabel(s, measure)).join(' · ')}</>
              : 'Primeira vez neste exercício'}
          </div>
        </div>
        <button className="ghost small" aria-label="Remover exercício" onClick={onRemove}>🗑️</button>
      </div>
      <div className="sets">
        {entry.sets.map((s, i) => (
          <button key={s.id} className="set" onClick={() => onDeleteSet(s.id)} title="Toque para excluir">
            <span className="muted">{i + 1}.</span> {setLabel(s, measure)}{s.rpe ? ` @${s.rpe}` : ''}
          </button>
        ))}
      </div>
      <div className="grid3">
        <Field label={measure === 'time' ? 'Segundos' : 'Reps'} value={value} onChange={setValue} mode="numeric" />
        <Field label="Carga (kg)" value={load} onChange={setLoad} />
        <label className="f">
          RPE
          <select value={rpe} onChange={(e) => setRpe(e.target.value)}>
            <option value="">—</option>
            {[6, 7, 8, 9, 10].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <button className="primary block" style={{ marginTop: 8 }} disabled={num(value) <= 0}
        onClick={() => onAdd(num(value), num(load), rpe ? Number(rpe) : undefined)}>
        + Série
      </button>
    </div>
  )
}
