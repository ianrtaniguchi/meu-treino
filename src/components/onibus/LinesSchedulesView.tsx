import { useMemo, useState } from 'react'
import { filterLines } from '../../services/ceturbService'
import type { CeturbLine } from '../../types/ceturb'
import LineDetailView from './LineDetailView'

interface LinesSchedulesViewProps {
  lines: CeturbLine[]
  loading: boolean
  error: string | null
  favoriteIds: string[]
  onToggleFavorite: (lineId: string) => void
  onRefreshLines: () => void
  selectedLine: CeturbLine | null
  onSelectLine: (line: CeturbLine | null) => void
}

const QUICK_FILTERS = ['500', '501', '503', '506', '507', '508', 'Ifes', 'Aquaviário']

export default function LinesSchedulesView({
  lines,
  loading,
  error,
  favoriteIds,
  onToggleFavorite,
  onRefreshLines,
  selectedLine,
  onSelectLine,
}: LinesSchedulesViewProps) {
  const [query, setQuery] = useState<string>('')

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  const favoriteLines = useMemo(
    () => lines.filter((l) => favoriteSet.has(l.id)),
    [lines, favoriteSet],
  )

  const filteredLines = useMemo(() => filterLines(lines, query), [lines, query])

  // Limita a renderização da lista completa quando sem busca para manter 60fps no iPhone
  const visibleLines = useMemo(
    () => (query.trim() ? filteredLines.slice(0, 80) : filteredLines.slice(0, 45)),
    [filteredLines, query],
  )

  if (selectedLine) {
    return (
      <LineDetailView
        line={selectedLine}
        isFavorite={favoriteSet.has(selectedLine.id)}
        onToggleFavorite={onToggleFavorite}
        onBack={() => onSelectLine(null)}
      />
    )
  }

  return (
    <div className="stack">
      {/* Linhas Favoritas fixadas no topo para acesso em 1 toque */}
      <div className="card stack">
        <div className="row between">
          <b>★ Linhas Favoritas</b>
          <span className="muted small">
            {favoriteLines.length > 0 ? '1 toque para abrir' : 'toque em ☆ para fixar'}
          </span>
        </div>
        {favoriteLines.length === 0 ? (
          <div className="muted small">
            Nenhuma linha favoritada ainda. Toque na estrela ao lado de qualquer linha (ex.: 500,
            503, 506) para fixá-la aqui no topo.
          </div>
        ) : (
          <div className="chips">
            {favoriteLines.map((fav) => (
              <button
                key={fav.id}
                type="button"
                className="small on"
                onClick={() => onSelectLine(fav)}
                title={fav.name}
              >
                ★ {fav.code} • {fav.name.length > 26 ? `${fav.name.slice(0, 26)}…` : fav.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Campo de Busca Rápida por número ou nome/bairro/terminal */}
      <div className="card stack">
        <label className="field">
          Buscar linha por número, terminal, bairro ou campus
          <input
            type="search"
            placeholder="Ex.: 500, 506, Laranjeiras, Vila Velha, Ifes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar linha de ônibus"
          />
        </label>
        <div className="chips">
          {QUICK_FILTERS.map((tag) => {
            const active = query.toLowerCase() === tag.toLowerCase()
            return (
              <button
                key={tag}
                type="button"
                className={`small ${active ? 'on' : ''}`}
                onClick={() => setQuery(active ? '' : tag)}
              >
                {tag}
              </button>
            )
          })}
          {query && (
            <button type="button" className="small ghost" onClick={() => setQuery('')}>
              limpar
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="card stack">
          <div className="amber small">{error}</div>
          <button type="button" className="small" onClick={onRefreshLines}>
            tentar atualizar catálogo
          </button>
        </div>
      )}

      {/* Lista de Linhas */}
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <b>
            {query.trim()
              ? `Resultados (${filteredLines.length})`
              : `Linhas Transcol & Aquaviário (${lines.length})`}
          </b>
          <button
            type="button"
            className="small ghost"
            onClick={onRefreshLines}
            disabled={loading}
          >
            {loading ? 'atualizando...' : 'sincronizar'}
          </button>
        </div>

        {visibleLines.length === 0 ? (
          <div className="muted small">
            Nenhuma linha encontrada para "{query}". Tente buscar pelo código (ex.: 500, 507) ou
            terminal (ex.: Carapina, Itaparica).
          </div>
        ) : (
          visibleLines.map((line) => {
            const fav = favoriteSet.has(line.id)
            return (
              <div key={line.id} className="item" style={{ justifyContent: 'space-between' }}>
                <div
                  className="row grow tap"
                  style={{ gap: 10, cursor: 'pointer' }}
                  onClick={() => onSelectLine(line)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectLine(line)
                    }
                  }}
                >
                  <span className="bus-badge">{line.code}</span>
                  <div className="grow">
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{line.name}</div>
                    <div className="muted small">
                      {line.category === 'aquaviario'
                        ? 'Aquaviário GV'
                        : line.category === 'bikegv'
                          ? 'Bike GV'
                          : line.category === 'transcol'
                            ? 'Troncal Transcol'
                            : 'Alimentadora / Transcol'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className={`small ${fav ? 'on' : 'ghost'}`}
                  onClick={() => onToggleFavorite(line.id)}
                  aria-label={
                    fav ? `Remover linha ${line.code} dos favoritos` : `Favoritar linha ${line.code}`
                  }
                  title={fav ? 'Remover dos favoritos' : 'Fixar nos favoritos'}
                >
                  {fav ? '★' : '☆'}
                </button>
              </div>
            )
          })
        )}

        {filteredLines.length > visibleLines.length && (
          <div className="muted small" style={{ paddingTop: 10, textAlign: 'center' }}>
            Exibindo {visibleLines.length} de {filteredLines.length} linhas. Refine a busca acima
            para filtrar.
          </div>
        )}
      </div>
    </div>
  )
}
