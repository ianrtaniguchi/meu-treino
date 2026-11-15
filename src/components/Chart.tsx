import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface Point { x: string; y?: number; y2?: number }

/** Gráfico de linha simples (y = série principal, y2 = série secundária, ex.: média móvel). */
export default function Chart({ data, name = 'Valor', name2 = 'Média', unit = '' }: { data: Point[]; name?: string; name2?: string; unit?: string }) {
  if (data.length < 2) return <p className="muted small">Registre ao menos 2 pontos para ver o gráfico.</p>
  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="#262d3d" vertical={false} />
          <XAxis dataKey="x" stroke="#8b94a8" fontSize={11} />
          <YAxis stroke="#8b94a8" fontSize={11} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#1d2330', border: '1px solid #262d3d', borderRadius: 10 }}
            formatter={(v: number, n: string) => [`${Math.round(v * 10) / 10}${unit}`, n]}
          />
          <Line type="monotone" dataKey="y" name={name} stroke="#b8f55a" strokeWidth={2} dot={{ r: 3 }} connectNulls />
          {data.some((d) => d.y2 !== undefined) && (
            <Line type="monotone" dataKey="y2" name={name2} stroke="#6ea8ff" strokeWidth={2} dot={false} connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
