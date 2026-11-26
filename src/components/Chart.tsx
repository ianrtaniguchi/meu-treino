import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface Point { x: string; y?: number; y2?: number }

/** Linha fina na cor de destaque do tema; série secundária (média móvel) pontilhada. */
export default function Chart({ data, name = 'valor', name2 = 'média', unit = '' }: { data: Point[]; name?: string; name2?: string; unit?: string }) {
  if (data.length < 2) return <p className="muted small"># registre ao menos 2 pontos para ver o gráfico.</p>
  const mono = { fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }
  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeOpacity={0.55} vertical={false} />
          <XAxis dataKey="x" stroke="var(--muted)" tick={mono} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
          <YAxis stroke="var(--muted)" tick={mono} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', ...mono }}
            labelStyle={{ color: 'var(--muted)' }}
            formatter={(v: number, n: string) => [`${Math.round(v * 10) / 10}${unit}`, n]}
          />
          <Line type="monotone" dataKey="y" name={name} stroke="var(--green)" strokeWidth={1.75} dot={{ r: 2.5, fill: 'var(--green)', strokeWidth: 0 }} isAnimationActive={false} connectNulls />
          {data.some((d) => d.y2 !== undefined) && (
            <Line type="monotone" dataKey="y2" name={name2} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
