import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import Chart from '../components/Chart'
import { Field, useUi } from '../components/ui'
import { db } from '../data/db'
import { fmtNum, fmtShort, movingAverage, num, today } from '../data/stats'
import type { BodyEntry } from '../data/types'

const MEASURES: [string, string][] = [
  ['peito', 'Peito'], ['cintura', 'Cintura'], ['quadril', 'Quadril'], ['braco', 'Braço'],
  ['antebraco', 'Antebraço'], ['coxa', 'Coxa'], ['panturrilha', 'Panturrilha'], ['ombros', 'Ombros'],
]

export default function Corpo() {
  const { confirm, toast } = useUi()
  const entries = useLiveQuery(() => db.body.orderBy('date').toArray(), [], [] as BodyEntry[])
  const [date, setDate] = useState(today())
  const [weight, setWeight] = useState('')
  const [m, setM] = useState<Record<string, string>>({})
  const [metric, setMetric] = useState('peso')

  const existing = entries.find((e) => e.date === date)

  const save = async () => {
    const measures: Record<string, number> = { ...(existing?.measures ?? {}) }
    for (const [k] of MEASURES) if (m[k]?.trim()) measures[k] = num(m[k])
    const w = weight.trim() ? num(weight) : existing?.weight
    if (w === undefined && Object.keys(measures).length === 0) return toast('Informe o peso ou alguma medida')
    await db.body.put({ id: `body-${date}`, date, weight: w, measures })
    setWeight(''); setM({})
    toast('Registro salvo')
  }
  const remove = async (e: BodyEntry) => {
    if (!(await confirm(`Excluir o registro de ${fmtShort(e.date)}?`))) return
    await db.body.delete(e.id)
    toast('Registro excluído', { label: 'desfazer', run: () => void db.body.put(e) })
  }

  const series = useMemo(() => {
    const pts = entries
      .map((e) => ({ date: e.date, value: metric === 'peso' ? e.weight : e.measures[metric] }))
      .filter((p): p is { date: string; value: number } => typeof p.value === 'number')
    const ma = metric === 'peso' ? movingAverage(pts, 7) : []
    return pts.map((p, i) => ({ x: fmtShort(p.date), y: p.value, y2: ma[i]?.value }))
  }, [entries, metric])

  const weights = entries.filter((e) => e.weight !== undefined)
  const last = weights[weights.length - 1]
  const prev = weights[weights.length - 2]

  return (
    <>
      <h1>~/corpo</h1>
      <div className="card stack">
        <Field label="Data" type="date" value={date} mode="text" onChange={setDate} />
        <Field label={`Peso (kg)${existing?.weight ? ` — atual: ${fmtNum(existing.weight)}` : ''}`} value={weight} onChange={setWeight} />
        <details>
          <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>Medidas (cm) — opcional</summary>
          <div className="grid2">
            {MEASURES.map(([k, label]) => (
              <Field key={k} label={label} value={m[k] ?? ''} placeholder={existing?.measures[k] ? String(existing.measures[k]) : ''}
                onChange={(v) => setM({ ...m, [k]: v })} />
            ))}
          </div>
        </details>
        <button className="primary block" onClick={save}>{existing ? 'Atualizar registro do dia' : 'Salvar registro'}</button>
      </div>

      {last && (
        <div className="grid2">
          <div className="stat"><span className="muted small">Último peso</span><b>{fmtNum(last.weight!)} kg</b></div>
          <div className="stat"><span className="muted small">Variação</span><b>{prev ? `${last.weight! - prev.weight! > 0 ? '+' : ''}${fmtNum(last.weight! - prev.weight!)} kg` : '—'}</b></div>
        </div>
      )}

      <h2>evolução</h2>
      <label className="f">
        <select value={metric} onChange={(e) => setMetric(e.target.value)}>
          <option value="peso">Peso (com média móvel de 7 dias)</option>
          {MEASURES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <div style={{ marginTop: 8 }}>
        <Chart data={series} name={metric === 'peso' ? 'Peso' : 'Medida'} name2="Média 7d" unit={metric === 'peso' ? ' kg' : ' cm'} />
      </div>

      <h2>registros</h2>
      {entries.length === 0 && <p className="muted">Nenhum registro ainda.</p>}
      {[...entries].reverse().map((e) => (
        <div key={e.id} className="card row">
          <div className="grow" onClick={() => { setDate(e.date); window.scrollTo(0, 0) }}>
            <b>{fmtShort(e.date)}</b> {e.weight !== undefined && <span>· {fmtNum(e.weight)} kg</span>}
            <div className="muted small">
              {Object.entries(e.measures).map(([k, v]) => `${MEASURES.find((x) => x[0] === k)?.[1] ?? k}: ${fmtNum(v)}`).join(' · ')}
            </div>
          </div>
          <button className="ghost danger" aria-label="Excluir registro" onClick={() => remove(e)}>rm</button>
        </div>
      ))}
    </>
  )
}
