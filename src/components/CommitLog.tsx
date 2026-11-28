import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from '../data/db'
import { today } from '../data/stats'
import type { Exercise, Session } from '../data/types'
import { prSetIds, relDate } from '../lib/panel'
import SessionEditor from './SessionEditor'
import { Sheet } from './ui'

/** Histórico recente de sessões com visual limpo e editorial. */
export default function CommitLog({ limit }: { limit?: number }) {
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], [] as Session[])
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[])
  const [open, setOpen] = useState<string | null>(null)
  const prs = useMemo(() => prSetIds(sessions), [sessions])
  const byId = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises])
  const t = today()
  const list = [...sessions]
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
    .slice(0, limit)

  if (list.length === 0) return <p className="muted small">Nenhum treino registrado ainda.</p>
  return (
    <div className="card" style={{ paddingTop: 6, paddingBottom: 6 }}>
      {list.map((s) => (
        <div key={s.id} className="log-entry" onClick={() => setOpen(s.id)}>
          <div className="log-head">
            <b className="grow" style={{ fontWeight: 500 }}>
              {s.name}
              {!s.finishedAt && <span className="muted small"> · em aberto</span>}
            </b>
            <span className="muted small" style={{ fontFamily: 'var(--mono)' }}>
              {relDate(s.date, t)}
            </span>
          </div>
          {s.entries
            .filter((e) => e.sets.length)
            .map((e) => {
              const ex = byId.get(e.exerciseId)
              const top = Math.max(...e.sets.map((x) => x.value))
              const maxLoad = Math.max(...e.sets.map((x) => x.load))
              const pr = e.sets.some((x) => prs.has(x.id))
              return (
                <div key={e.exerciseId} className="log-line">
                  <b>{ex?.name ?? 'Exercício removido'}</b> · {e.sets.length}×{top}
                  {ex?.measure === 'time' ? 's' : ''}
                  {maxLoad > 0 ? ` +${maxLoad}kg` : ''}{' '}
                  {pr && <span className="tag-pr">PR</span>}
                </div>
              )
            })}
        </div>
      ))}
      {open && (
        <Sheet title="Detalhes do treino" onClose={() => setOpen(null)}>
          <SessionEditor id={open} onClose={() => setOpen(null)} />
        </Sheet>
      )}
    </div>
  )
}
