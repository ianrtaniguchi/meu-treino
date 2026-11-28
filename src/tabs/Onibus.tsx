import { useEffect, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import IntegrationsFaresView from '../components/onibus/IntegrationsFaresView'
import LinesSchedulesView from '../components/onibus/LinesSchedulesView'
import RouteCalculatorView from '../components/onibus/RouteCalculatorView'
import {
  FALLBACK_CETURB_LINES_RAW,
  fetchLines,
  getFavoriteLineIds,
  mapRawLineToCeturbLine,
  toggleFavoriteLineId,
} from '../services/ceturbService'
import type { CeturbLine } from '../types/ceturb'

type OnibusSubTab = 'horarios' | 'integracoes' | 'rota'

export default function Onibus() {
  const [subTab, setSubTab] = useState<OnibusSubTab>('horarios')
  const [lines, setLines] = useState<CeturbLine[]>(() =>
    FALLBACK_CETURB_LINES_RAW.map(mapRawLineToCeturbLine),
  )
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => getFavoriteLineIds())
  const [selectedLine, setSelectedLine] = useState<CeturbLine | null>(null)

  const loadLines = async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchLines({ forceRefresh })
      setLines(list)
    } catch (e) {
      setError((e as Error)?.message || 'Modo offline: exibindo linhas salvas no dispositivo.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLines(false)
  }, [])

  const handleToggleFavorite = (lineId: string) => {
    const updated = toggleFavoriteLineId(lineId)
    setFavoriteIds(updated)
  }

  const handleOpenLineFromRoute = (line: CeturbLine) => {
    setSelectedLine(line)
    setSubTab('horarios')
  }

  return (
    <div>
      <PromptTitle path="~/onibus" />

      <div className="statusline">
        <div className="statusline-seg">
          <span className="muted">Ceturb-ES · Transcol</span>
          <span className="sep">·</span>
          <span className="muted">{lines.length} linhas</span>
        </div>
        <div className="statusline-seg">
          <span className="sync-pill">
            {favoriteIds.length} {favoriteIds.length === 1 ? 'favorita' : 'favoritas'}
          </span>
        </div>
      </div>

      {/* 3 Sub-abas internas da seção de Transporte Público */}
      <div className="tabs" role="tablist" aria-label="Seções de Transporte Público">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'horarios'}
          className={subTab === 'horarios' ? 'on' : ''}
          onClick={() => setSubTab('horarios')}
        >
          Horários & Linhas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'integracoes'}
          className={subTab === 'integracoes' ? 'on' : ''}
          onClick={() => setSubTab('integracoes')}
        >
          Integrações & Tarifas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'rota'}
          className={subTab === 'rota' ? 'on' : ''}
          onClick={() => setSubTab('rota')}
        >
          Calcular Rota
        </button>
      </div>

      {subTab === 'horarios' && (
        <LinesSchedulesView
          lines={lines}
          loading={loading}
          error={error}
          favoriteIds={favoriteIds}
          onToggleFavorite={handleToggleFavorite}
          onRefreshLines={() => void loadLines(true)}
          selectedLine={selectedLine}
          onSelectLine={setSelectedLine}
        />
      )}

      {subTab === 'integracoes' && <IntegrationsFaresView />}

      {subTab === 'rota' && (
        <RouteCalculatorView lines={lines} onOpenLine={handleOpenLineFromRoute} />
      )}
    </div>
  )
}
