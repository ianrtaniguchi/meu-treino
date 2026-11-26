import { useState } from 'react'
import { calculateRoute } from '../../services/ceturbService'
import type { CeturbLine, RouteCalculationResult } from '../../types/ceturb'

interface RouteCalculatorViewProps {
  lines: CeturbLine[]
  onOpenLine: (line: CeturbLine) => void
}

const QUICK_PLACES = [
  'Ifes Campus Vitória',
  'UFES Goiabeiras',
  'T. Laranjeiras',
  'T. Vila Velha',
  'T. Carapina',
  'T. Itaparica',
  'T. Campo Grande',
  'Praça do Papa (Aquaviário)',
]

export default function RouteCalculatorView({ lines, onOpenLine }: RouteCalculatorViewProps) {
  const [origin, setOrigin] = useState<string>('')
  const [destination, setDestination] = useState<string>('')
  const [result, setResult] = useState<RouteCalculationResult | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleCalculate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await calculateRoute(origin, destination, { availableLines: lines })
      setResult(res)
    } catch (err) {
      setError((err as Error)?.message || 'Informe origem e destino.')
    } finally {
      setLoading(false)
    }
  }

  const handleSwap = () => {
    setOrigin(destination)
    setDestination(origin)
    setResult(null)
  }

  const applyQuickPlace = (place: string) => {
    if (!origin.trim()) {
      setOrigin(place)
    } else {
      setDestination(place)
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <b>Planejador de Rota</b>
          <span className="tag-pr">Em breve</span>
        </div>

        <form className="stack" onSubmit={handleCalculate}>
          <label className="field">
            Origem
            <input
              type="text"
              placeholder="Ex.: T. Laranjeiras, Vila Velha..."
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            />
          </label>

          <label className="field">
            Destino
            <input
              type="text"
              placeholder="Ex.: Ifes Vitória, UFES, T. Itaparica..."
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </label>

          <div className="chips">
            {QUICK_PLACES.map((place) => (
              <button
                key={place}
                type="button"
                className="small"
                onClick={() => applyQuickPlace(place)}
              >
                + {place}
              </button>
            ))}
          </div>

          {error && <div className="red small">{error}</div>}

          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="small"
              onClick={handleSwap}
              disabled={!origin && !destination}
              title="Inverter origem e destino"
            >
              ⇅ inverter
            </button>
            <button
              type="submit"
              className="primary grow"
              disabled={loading || !origin.trim() || !destination.trim()}
            >
              {loading ? 'Consultando eixos...' : 'Simular Linhas Compatíveis'}
            </button>
          </div>
        </form>
      </div>

      {result && (
        <div className="card stack">
          <div className="row between">
            <b>
              {result.origin} → {result.destination}
            </b>
            <span className="chip">janela Cartão GV: {result.estimatedIntegrationMinutes} min</span>
          </div>
          <div className="muted small">{result.engineMessage}</div>

          {result.suggestedDirectLines.length === 0 ? (
            <div className="muted small">
              Nenhuma linha direta localizada pelo nome curto. Consulte a aba Horários & Linhas para
              verificar conexões via terminal.
            </div>
          ) : (
            result.suggestedDirectLines.map((sug) => (
              <div
                key={sug.line.id}
                className="item tap"
                onClick={() => onOpenLine(sug.line)}
                role="button"
                tabIndex={0}
              >
                <span className="bus-badge">{sug.line.code}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{sug.line.name}</div>
                  <div className="muted small">{sug.matchReason}</div>
                </div>
                <span className="green small">ver horários →</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
