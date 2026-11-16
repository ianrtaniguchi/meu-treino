import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface Point { x: string; y?: number; y2?: number }

/** Linha fina em verde; série secundária (média móvel) pontilhada. Fundo transparente, grade discreta. */
export default function Chart({ data, name = 'valor', name2 = 'média', unit = '' }: { data: Point[]; name?: string; name2?: string; unit?: string }) {
  if (data.length < 2) return <p className="muted small"># registre ao menos 2 pontos para ver o gráfico.</p>
  const mono = { fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }
  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="#30363d" strokeOpacity={0.45} vertical={false} />
          <XAxis dataKey="x" stroke="#8b949e" tick={mono} tickLine={false} axisLine={{ stroke: '#30363d' }} />
          <YAxis stroke="#8b949e" tick={mono} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, ...mono }}
            labelStyle={{ color: '#8b949e' }}
            formatter={(v: number, n: string) => [`${Math.round(v * 10) / 10}${unit}`, n]}
          />
          <Line type="monotone" dataKey="y" name={name} stroke="#39d353" strokeWidth={1.5} dot={{ r: 2, fill: '#39d353', strokeWidth: 0 }} isAnimationActive={false} connectNulls />
          {data.some((d) => d.y2 !== undefined) && (
            <Line type="monotone" dataKey="y2" name={name2} stroke="#8b949e" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
