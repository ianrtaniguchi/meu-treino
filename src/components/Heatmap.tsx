import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { addDays, today as todayStr, weekStart, parseDate } from '../data/stats'
import type { DayInfo } from '../lib/panel'

const WEEKS = 26 // ~6 meses
const CELL = 11
const STEP = 14
const LEFT = 24
const TOP = 16
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export const heatRange = (today = todayStr()) => ({ from: addDays(weekStart(today), -(WEEKS - 1) * 7), to: today })

/** Heatmap em SVG próprio: colunas = semanas (seg→dom), linhas = dias. Rola para o dia de hoje. */
export default function Heatmap({ days, selected, onSelect }: { days: Map<string, DayInfo>; selected: string | null; onSelect: (d: string) => void }) {
  const today = todayStr()
  const { from } = heatRange(today)
  const ref = useRef<HTMLDivElement>(null)
  // Posição de rolagem horizontal: rótulos de mês que começam à esquerda da área visível seriam cortados, então são ocultados
  const [scrollX, setScrollX] = useState(0)
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.scrollLeft = ref.current.scrollWidth
      setScrollX(ref.current.scrollLeft)
    }
  }, [])

  const { cells, months } = useMemo(() => {
    const cells: { date: string; x: number; y: number; level: number; label: string }[] = []
    const months: { x: number; label: string }[] = []
    let lastMonth = -1
    for (let w = 0; w < WEEKS; w++) {
      const monday = addDays(from, w * 7)
      const m = parseDate(monday).getMonth()
      if (m !== lastMonth) { months.push({ x: LEFT + w * STEP, label: MONTHS[m] }); lastMonth = m }
      for (let d = 0; d < 7; d++) {
        const date = addDays(monday, d)
        if (date > today) continue
        const info = days.get(date)
        cells.push({
          date, x: LEFT + w * STEP, y: TOP + d * STEP, level: info?.level ?? 0,
          label: `${date}: ${info ? `pontuação ${info.score}` : 'sem registros'}`,
        })
      }
    }
    return { cells, months }
  }, [days, from, today])

  const width = LEFT + WEEKS * STEP
  const height = TOP + 7 * STEP
  return (
    <div>
      <div className="heat-scroll" ref={ref} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
        <svg width={width} height={height} role="img" aria-label="Mapa de atividade dos últimos 6 meses">
          {months.filter((m) => m.x >= scrollX).map((m, i) => <text key={i} className="svg-lbl" x={m.x} y={10}>{m.label}</text>)}
          {scrollX < 1 && ['seg', '', 'qua', '', 'sex', '', ''].map((l, i) => l && <text key={i} className="svg-lbl" x={0} y={TOP + i * STEP + 9}>{l}</text>)}
          {cells.map((c) => (
            <rect key={c.date} className={`cell l${c.level} ${selected === c.date ? 'sel' : ''} ${c.date === today ? 'today' : ''}`} x={c.x} y={c.y} width={CELL} height={CELL} rx={3}
              onClick={() => onSelect(c.date)}>
              <title>{c.label}</title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="legend" style={{ marginTop: 6 }}>
        menos <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> mais
      </div>
    </div>
  )
}
