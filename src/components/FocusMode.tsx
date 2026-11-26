import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db, setSetting, uid } from '../data/db'
import { fmtNum, lastPerformance, num, setLabel } from '../data/stats'
import type { Exercise, Session } from '../data/types'
import { useSetting } from '../hooks'
import { ExercisePicker } from './ExerciseViews'
import RestPanel, { primeAudio } from './RestTimer'
import { updateSession } from './SessionEditor'
import { useUi } from './ui'

/** Modo foco: tela cheia, um exercício por vez, sem popups nem distrações. */
export default function FocusMode({ id, onMinimize }: { id: string; onMinimize: () => void }) {
  const { confirm, toast } = useUi()
  const session = useLiveQuery(() => db.sessions.get(id), [id], undefined)
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[])
  const allSessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const restSeconds = useSetting<number>('restSeconds', 90) ?? 90
  const [idx, setIdx] = useState(0)
  const [value, setValue] = useState('')
  const [load, setLoad] = useState('')
  const [rpe, setRpe] = useState(0)
  const [restEnd, setRestEnd] = useState<number | null>(null)
  const [restTotal, setRestTotal] = useState(0)
  const [notes, setNotes] = useState(false)
  const [picking, setPicking] = useState(false)

  const entries = session?.entries ?? []
  const entry = entries[Math.min(idx, Math.max(0, entries.length - 1))]
  const exercise = exercises.find((e) => e.id === entry?.exerciseId)
  const measure = exercise?.measure ?? 'reps'
  const last = entry ? lastPerformance(allSessions, entry.exerciseId, id) : null

  // ao trocar de exercício, pré-preenche com a série anterior ou com a "última vez"
  const exId = entry?.exerciseId
  useEffect(() => {
    if (!entry) return
    const ref = entry.sets[entry.sets.length - 1] ?? last?.sets[0]
    setValue(ref ? String(ref.value) : '')
    setLoad(ref && ref.load ? String(ref.load) : '')
    setRpe(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exId])

  if (!session) return null
  const totalSets = entries.reduce((n, e) => n + e.sets.length, 0)
  const step = measure === 'time' ? 5 : 1

  const conclude = () => {
    if (!entry || num(value) <= 0) return
    primeAudio()
    const v = num(value), l = num(load), r = rpe || undefined
    void updateSession(id, (s) => {
      s.entries.find((e) => e.exerciseId === entry.exerciseId)?.sets.push({ id: uid(), value: v, load: l, ...(r ? { rpe: r } : {}) })
    })
    setRestTotal(restSeconds)
    setRestEnd(Date.now() + restSeconds * 1000)
  }

  const finish = async () => {
    if (totalSets === 0) {
      if (!(await confirm('Nenhuma série registrada. Descartar este treino?', 'descartar'))) return
      await db.sessions.delete(id)
    } else {
      if (!(await confirm('Finalizar treino?', 'finalizar', false))) return
      await updateSession(id, (s) => { s.finishedAt = Date.now() })
    }
    await setSetting('activeSessionId', null)
  }
  const discard = async () => {
    if (!(await confirm('Descartar este treino e todas as séries?', 'descartar'))) return
    const copy = session
    await db.sessions.delete(id)
    await setSetting('activeSessionId', null)
    toast('Treino descartado', { label: 'desfazer', run: () => void db.sessions.put(copy) })
  }
  const deleteSet = async (setId: string) => {
    if (!(await confirm('Excluir esta série?'))) return
    await updateSession(id, (s) => {
      const e = s.entries.find((x) => x.exerciseId === entry!.exerciseId)
      if (e) e.sets = e.sets.filter((x) => x.id !== setId)
    })
  }

  return (
    <div className="focus">
      <div className="focus-top">
        <button className="ghost small" onClick={onMinimize}>‹ painel</button>
        <span className="muted small grow" style={{ textAlign: 'center' }}>{session.name.toLowerCase()} · {totalSets} séries</span>
        <button className="small" onClick={finish}>finalizar</button>
      </div>
      <div className="dots" aria-hidden="true">
        {entries.map((e, i) => <i key={e.exerciseId} className={i === idx ? 'cur' : e.sets.length ? 'done' : ''} />)}
      </div>

      {!entry ? (
        <>
          <p className="muted"># treino vazio. adicione o primeiro exercício.</p>
          <button className="primary cta" onClick={() => setPicking(true)}>+ exercício</button>
        </>
      ) : (
        <>
          <div className="muted small">exercício {Math.min(idx, entries.length - 1) + 1}/{entries.length} · {exercise?.category}</div>
          <div className="focus-name">{exercise?.name ?? '(removido)'}</div>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <span>série <b className="green">{entry.sets.length + 1}</b></span>
            <span className="muted small">
              {last ? `última vez: ${last.sets.map((s) => setLabel(s, measure)).join(' · ')}` : 'primeira vez'}
            </span>
          </div>

          {restEnd ? (
            <RestPanel endAt={restEnd} total={restTotal} onChange={setRestEnd} onClear={() => setRestEnd(null)} />
          ) : null}

          <div className="fieldlabel">{measure === 'time' ? 'segundos' : 'repetições'}</div>
          <div className="stepper">
            <button aria-label="menos" onClick={() => setValue(String(Math.max(0, num(value) - step)))}>−</button>
            <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} aria-label={measure === 'time' ? 'segundos' : 'repetições'} />
            <button aria-label="mais" onClick={() => setValue(String(num(value) + step))}>+</button>
          </div>
          <div className="fieldlabel">carga extra (kg)</div>
          <div className="stepper">
            <button aria-label="menos" onClick={() => setLoad(String(Math.max(0, num(load) - 2.5)))}>−</button>
            <input inputMode="decimal" value={load} placeholder="0" onChange={(e) => setLoad(e.target.value)} aria-label="carga extra" />
            <button aria-label="mais" onClick={() => setLoad(fmtNum(num(load) + 2.5).replace(',', '.'))}>+</button>
          </div>
          <div className="fieldlabel">rpe (opcional)</div>
          <div className="rpe">
            {[5, 6, 7, 8, 9, 10].map((n) => (
              <button key={n} className={rpe === n ? 'on' : ''} onClick={() => setRpe(rpe === n ? 0 : n)}>{n}</button>
            ))}
          </div>

          <button className="primary cta block" disabled={num(value) <= 0} onClick={conclude}>concluir série</button>

          {entry.sets.length > 0 && (
            <div className="sets-line">
              {entry.sets.map((s, i) => (
                <button key={s.id} className="small" onClick={() => deleteSet(s.id)} title="Toque para excluir">
                  {i + 1}: {setLabel(s, measure)}{s.rpe ? ` @${s.rpe}` : ''}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {notes && (
        <label className="f" style={{ marginTop: 14 }}>
          notas
          <textarea value={session.notes} onChange={(e) => void updateSession(id, (s) => { s.notes = e.target.value })} />
        </label>
      )}

      <div className="spacer" />
      <div className="grid2" style={{ marginTop: 14 }}>
        <button style={{ minHeight: 48 }} disabled={idx <= 0} onClick={() => { setIdx(idx - 1); setRestEnd(null) }}>‹ anterior</button>
        <button style={{ minHeight: 48 }} disabled={idx >= entries.length - 1} onClick={() => { setIdx(idx + 1); setRestEnd(null) }}>próximo ›</button>
      </div>
      <div className="grid3" style={{ marginTop: 8 }}>
        <button className="small" onClick={() => setPicking(true)}>+ exercício</button>
        <button className="small" onClick={() => setNotes(!notes)}>notas</button>
        <button className="small danger" onClick={discard}>descartar</button>
      </div>

      {picking && (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(e) => {
            if (entries.some((x) => x.exerciseId === e.id)) return toast('Exercício já está no treino')
            void updateSession(id, (s) => { s.entries.push({ exerciseId: e.id, sets: [] }) })
            setIdx(entries.length)
          }}
        />
      )}
    </div>
  )
}
