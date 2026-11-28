import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  filterLines,
  getFavoriteStopIds,
  listarPontosDeParada,
  obterEstimativasPorOrigem,
  pesquisarPontosDeParada,
  toggleFavoriteStopId,
  type GeocontrolJson,
} from '../../services/ceturbService'
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

interface Stop {
  id: number
  name: string
  address: string
  reference: string
  latitude?: number
  longitude?: number
}

function isRecord(value: GeocontrolJson): value is Record<string, GeocontrolJson> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordsFrom(value: GeocontrolJson): Record<string, GeocontrolJson>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []

  const containers = [
    'dados',
    'data',
    'resultados',
    'pontos',
    'pontosDeParada',
    'estimativas',
    'previsoes',
    'items',
    'rows',
  ]
  for (const [key, nested] of Object.entries(value)) {
    if (containers.includes(key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) {
      const nestedRecords = recordsFrom(nested)
      if (nestedRecords.length > 0) return nestedRecords
    }
  }
  return [value]
}

function fieldValue(record: Record<string, GeocontrolJson>, keys: string[]): string {
  const wanted = keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''))
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!wanted.includes(normalizedKey) || value === null || typeof value === 'object') continue
    return String(value)
  }
  return ''
}

function toStop(record: Record<string, GeocontrolJson>): Stop | null {
  const idText = fieldValue(record, [
    'id',
    'pontoId',
    'pontoDeParadaId',
    'idPontoDeParada',
    'codigo',
    'codigoPonto',
  ])
  const id = Number(idText)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const latitudeText = fieldValue(record, ['latitude', 'lat', 'y']).replace(',', '.')
  const longitudeText = fieldValue(record, ['longitude', 'lon', 'lng', 'long', 'x']).replace(',', '.')
  const latitude = latitudeText ? Number(latitudeText) : Number.NaN
  const longitude = longitudeText ? Number(longitudeText) : Number.NaN
  return {
    id,
    name:
      fieldValue(record, ['nome', 'nomePonto', 'nomePontoDeParada', 'descricao']) ||
      `Ponto ${id}`,
    address: fieldValue(record, ['endereco', 'logradouro', 'rua', 'localizacao']),
    reference: fieldValue(record, ['referencia', 'pontoReferencia', 'complemento', 'bairro']),
    ...(Number.isFinite(latitude) && Math.abs(latitude) <= 90 ? { latitude } : {}),
    ...(Number.isFinite(longitude) && Math.abs(longitude) <= 180 ? { longitude } : {}),
  }
}

function stopsFrom(value: GeocontrolJson): Stop[] {
  return recordsFrom(value)
    .map(toStop)
    .filter((stop): stop is Stop => stop !== null)
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none">
      <circle cx="10.8" cy="10.8" r="6.3" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.5 15.5 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none">
      <path
        d="M20 7v5h-5M4.6 9a7.5 7.5 0 0 1 12.8-2L20 12M4 17v-5h5m10.4 3a7.5 7.5 0 0 1-12.8 2L4 12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StarIcon({ active }: { active: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path
        d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BusStopsMap({
  stops,
  onSelectStop,
}: {
  stops: Stop[]
  onSelectStop: (stop: Stop) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const [locating, setLocating] = useState(false)
  const [mapError, setMapError] = useState('')
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const locatedStops = useMemo(() => {
    if (!userLocation) return stops
    return stops.filter((stop) => {
      if (stop.latitude === undefined || stop.longitude === undefined) return false
      return L.latLng(userLocation).distanceTo([stop.latitude, stop.longitude]) <= 8000
    })
  }, [stops, userLocation])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const map = L.map(node, {
      center: [-20.3155, -40.3128],
      zoom: 12,
      scrollWheelZoom: false,
    })
    const tileStyle = () => document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark_all'
      : 'light_all'
    const tileUrl = () => `https://{s}.basemaps.cartocdn.com/${tileStyle()}/{z}/{x}/{y}{r}.png`
    const tileLayer = L.tileLayer(tileUrl(), {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map)
    const updateTiles = () => tileLayer.setUrl(tileUrl())
    updateTiles()
    const themeObserver = new MutationObserver(updateTiles)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    mapRef.current = map
    markerLayerRef.current = L.layerGroup().addTo(map)
    window.setTimeout(() => map.invalidateSize(), 0)
    return () => {
      themeObserver.disconnect()
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = markerLayerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const mappedStops = locatedStops.filter(
      (stop) => stop.latitude !== undefined && stop.longitude !== undefined,
    )
    const pin = L.divIcon({
      className: 'bus-stop-pin',
      html: '<span></span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    })
    const bounds: L.LatLngTuple[] = []
    for (const stop of mappedStops) {
      const point: L.LatLngTuple = [stop.latitude!, stop.longitude!]
      bounds.push(point)
      L.marker(point, { icon: pin })
        .bindTooltip(stop.name, { direction: 'top', offset: [0, -10] })
        .on('click', () => onSelectStop(stop))
        .addTo(layer)
    }
    if (bounds.length > 1 && !userLocation) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 })
    else if (bounds.length === 1 && !userLocation) map.setView(bounds[0], 14)
    else if (userLocation) map.setView(userLocation, 14)
  }, [locatedStops, onSelectStop, userLocation])

  const centerOnUser = () => {
    if (!navigator.geolocation || locating) {
      if (!navigator.geolocation) setMapError('A localização não está disponível neste aparelho.')
      return
    }
    setLocating(true)
    setMapError('')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const location: [number, number] = [coords.latitude, coords.longitude]
        setUserLocation(location)
        mapRef.current?.flyTo(location, 14, { duration: 0.6 })
        setLocating(false)
      },
      (error) => {
        setMapError(
          error.code === error.PERMISSION_DENIED
            ? 'Permita a localização nos Ajustes para centralizar o mapa.'
            : 'Não foi possível obter sua localização. Tente novamente.',
        )
        setLocating(false)
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    )
  }

  return (
    <section className="card stack bus-map-card" aria-label="Mapa de pontos de parada">
      <div className="row between">
        <div>
          <b>Mapa de paradas</b>
          <div className="muted small">
            {locatedStops.filter((stop) => stop.latitude !== undefined && stop.longitude !== undefined).length} pontos no mapa
            {userLocation ? ' · raio de 8 km' : ' · Grande Vitória'}
          </div>
        </div>
        <button
          type="button"
          className="small"
          style={{ minHeight: 44 }}
          disabled={locating}
          onClick={centerOnUser}
          aria-label="Centralizar mapa na minha localização"
        >
          {locating ? 'localizando…' : 'minha localização'}
        </button>
      </div>
      <div ref={containerRef} className="bus-stops-map" role="application" aria-label="Mapa interativo de paradas" />
      {mapError && <div className="small amber" role="status">{mapError}</div>}
      {userLocation && locatedStops.length === 0 && (
        <div className="muted small">Nenhum ponto próximo entre os resultados carregados. Pesquise uma parada para exibi-la no mapa.</div>
      )}
      <div className="muted small bus-map-attribution">
        Mapa © OpenStreetMap contributors · tiles © CARTO
      </div>
    </section>
  )
}

function LiveStopsView() {
  const [query, setQuery] = useState('')
  const [stops, setStops] = useState<Stop[]>([])
  const [favoriteIds, setFavoriteIds] = useState<number[]>(() => getFavoriteStopIds())
  const [favoriteStops, setFavoriteStops] = useState<Stop[]>([])
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const [estimates, setEstimates] = useState<Record<string, GeocontrolJson>[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [loadingEstimates, setLoadingEstimates] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const favoriteIdsKey = favoriteIds.join(',')
  const mapStops = useMemo(
    () => [...new Map([...favoriteStops, ...stops].map((stop) => [stop.id, stop])).values()],
    [favoriteStops, stops],
  )

  useEffect(() => {
    let active = true
    const ids = favoriteIdsKey ? favoriteIdsKey.split(',').map(Number) : []
    if (ids.length === 0) {
      setFavoriteStops([])
      setFavoriteError(null)
      return () => {
        active = false
      }
    }
    void listarPontosDeParada(ids)
      .then((response) => {
        if (active) {
          setFavoriteStops(stopsFrom(response))
          setFavoriteError(null)
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFavoriteError(
            error instanceof Error ? error.message : 'Não foi possível carregar os pontos favoritos.',
          )
        }
      })
    return () => {
      active = false
    }
  }, [favoriteIdsKey])

  const selectedStopId = selectedStop?.id
  useEffect(() => {
    if (!selectedStopId) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      setLoadingEstimates(true)
      try {
        const response = await obterEstimativasPorOrigem(selectedStopId)
        if (active) {
          setEstimates(recordsFrom(response))
          setEstimateError(null)
          setRefreshedAt(new Date())
        }
      } catch (error) {
        if (active) {
          setEstimateError(
            error instanceof Error ? error.message : 'Não foi possível atualizar as previsões.',
          )
        }
      } finally {
        inFlight = false
        if (active) setLoadingEstimates(false)
      }
    }
    void refresh()
    const intervalId = window.setInterval(() => void refresh(), 30_000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [selectedStopId, refreshVersion])

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) {
      setSearchError('Digite um nome, rua ou referência para buscar.')
      return
    }
    setSearching(true)
    setSearchError(null)
    setHasSearched(true)
    setSelectedStop(null)
    setEstimates([])
    try {
      setStops(stopsFrom(await pesquisarPontosDeParada(text)))
    } catch (error) {
      setStops([])
      setSearchError(
        error instanceof Error ? error.message : 'Não foi possível pesquisar pontos de parada.',
      )
    } finally {
      setSearching(false)
    }
  }

  const toggleFavorite = (stop: Stop) => {
    const next = toggleFavoriteStopId(stop.id)
    setFavoriteIds(next)
    setFavoriteError(null)
  }

  const selectStop = useCallback((stop: Stop) => {
    setSelectedStop(stop)
    setEstimates([])
    setEstimateError(null)
    setRefreshedAt(null)
  }, [])

  return (
    <div className="stack">
      <div className="card stack">
        <form className="row" onSubmit={search} style={{ gap: 8 }}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por ponto, rua ou referência"
            aria-label="Buscar pontos de parada por nome, rua ou referência"
            style={{ minHeight: 44, flex: 1, minWidth: 0 }}
          />
          <button
            type="submit"
            aria-label="Buscar pontos de parada"
            title="Buscar pontos de parada"
            disabled={searching}
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {searching ? '...' : <SearchIcon />}
          </button>
        </form>
        {searchError && <div className="red small">{searchError}</div>}
        <div className="muted small">
          Procure pelo nome da parada, endereço ou ponto de referência.
        </div>
      </div>

      <BusStopsMap stops={mapStops} onSelectStop={selectStop} />

      {favoriteIds.length > 0 && (
        <div className="card stack">
          <div className="row between">
            <b>Pontos favoritos</b>
            <span className="muted small">{favoriteIds.length}</span>
          </div>
          {favoriteError && <div className="amber small">{favoriteError}</div>}
          {favoriteStops.length > 0 ? (
            <div className="chips">
              {favoriteStops.map((stop) => (
                <button
                  key={stop.id}
                  type="button"
                  className={`small ${selectedStop?.id === stop.id ? 'on' : ''}`}
                  onClick={() => selectStop(stop)}
                  style={{ minHeight: 44 }}
                >
                  {stop.name}
                </button>
              ))}
            </div>
          ) : !favoriteError ? (
            <div className="muted small">Carregando os detalhes dos pontos favoritos...</div>
          ) : null}
        </div>
      )}

      {stops.length > 0 && (
        <div className="card stack">
          <b>Resultados ({stops.length})</b>
          {stops.map((stop) => {
            const favorite = favoriteIds.includes(stop.id)
            return (
              <div key={stop.id} className="item" style={{ justifyContent: 'space-between', gap: 8 }}>
                <button
                  type="button"
                  className="grow"
                  onClick={() => selectStop(stop)}
                  aria-pressed={selectedStop?.id === stop.id}
                  style={{
                    minHeight: 44,
                    padding: '6px 8px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'block', fontWeight: 600 }}>{stop.name}</span>
                  {(stop.address || stop.reference) && (
                    <span className="muted small">
                      {[stop.address, stop.reference].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className={`small ${favorite ? 'on' : 'ghost'}`}
                  onClick={() => toggleFavorite(stop)}
                  aria-label={
                    favorite
                      ? `Remover ${stop.name} dos favoritos`
                      : `Favoritar ${stop.name}`
                  }
                  title={favorite ? 'Remover dos favoritos' : 'Favoritar ponto'}
                  style={{ minHeight: 44, minWidth: 44 }}
                >
                  <StarIcon active={favorite} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {hasSearched && !searching && !searchError && stops.length === 0 && (
        <div className="card muted small">
          Nenhum ponto encontrado. Tente outra rua, nome ou referência.
        </div>
      )}

      {selectedStop && (
        <div className="card stack bus-stop-sheet" role="region" aria-label="Detalhes e previsões do ponto">
          <div className="row between" style={{ gap: 8 }}>
            <div>
              <b>{selectedStop.name}</b>
              {(selectedStop.address || selectedStop.reference) && (
                <div className="muted small">
                  {[selectedStop.address, selectedStop.reference].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={`small ${favoriteIds.includes(selectedStop.id) ? 'on' : 'ghost'}`}
                onClick={() => toggleFavorite(selectedStop)}
                aria-label={favoriteIds.includes(selectedStop.id) ? 'Remover ponto dos favoritos' : 'Favoritar ponto'}
                style={{ minHeight: 44, minWidth: 44 }}
              >
                <StarIcon active={favoriteIds.includes(selectedStop.id)} />
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={loadingEstimates}
                onClick={() => setRefreshVersion((version) => version + 1)}
                aria-label="Atualizar previsões de chegada"
                title="Atualizar previsões"
                style={{ minHeight: 44, minWidth: 44 }}
              >
                <RefreshIcon />
              </button>
              <button
                type="button"
                className="small ghost"
                onClick={() => setSelectedStop(null)}
                aria-label="Fechar detalhes do ponto"
                style={{ minHeight: 44, minWidth: 44 }}
              >
                ×
              </button>
            </div>
          </div>
          <div className="muted small">
            Previsões de chegada
            {refreshedAt && (
              <> · atualizado às {refreshedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>
            )}
          </div>
          {loadingEstimates && estimates.length === 0 && (
            <div className="muted small">Consultando previsões em tempo real...</div>
          )}
          {estimateError && <div className="red small">{estimateError}</div>}
          {!loadingEstimates && !estimateError && estimates.length === 0 && (
            <div className="muted small">Nenhuma previsão disponível para este ponto agora.</div>
          )}
          {estimates.map((estimate, index) => {
            const line =
              fieldValue(estimate, ['linha', 'codigoLinha', 'numeroLinha', 'nomeLinha']) ||
              'Linha não identificada'
            const arrival = fieldValue(estimate, [
              'estimativa',
              'previsao',
              'previsaoChegada',
              'horarioPrevisto',
              'tempoChegada',
              'minutos',
            ])
            const destination = fieldValue(estimate, [
              'destino',
              'descricaoLinha',
              'itinerario',
              'sentido',
            ])
            return (
              <div key={`${line}-${arrival}-${index}`} className="item row between">
                <div className="row grow" style={{ gap: 10 }}>
                  <span className="bus-badge">{line}</span>
                  {destination && <span className="muted small">{destination}</span>}
                </div>
                <b>{arrival || 'Previsão indisponível'}</b>
              </div>
            )
          })}
          <div className="muted small">Atualização automática a cada 30 segundos.</div>
          <div className="muted small">Dados em tempo real: Geocontrol / GVBus / Ceturb-ES</div>
        </div>
      )}

      <div className="muted small" style={{ textAlign: 'center', padding: '4px 8px' }}>
        Dados em tempo real: Geocontrol / GVBus / Ceturb-ES
      </div>
    </div>
  )
}

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
  const [activeView, setActiveView] = useState<'linhas' | 'ao-vivo'>('linhas')

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

  if (activeView === 'ao-vivo') {
    return (
      <div className="stack">
        <div className="tabs" role="tablist" aria-label="Consulta de ônibus">
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => setActiveView('linhas')}
            style={{ minHeight: 44 }}
          >
            Linhas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={true}
            className="on"
            style={{ minHeight: 44 }}
          >
            Ao Vivo / Pontos
          </button>
        </div>
        <LiveStopsView />
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Consulta de ônibus">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className="on"
          style={{ minHeight: 44 }}
        >
          Linhas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          onClick={() => setActiveView('ao-vivo')}
          style={{ minHeight: 44 }}
        >
          Ao Vivo / Pontos
        </button>
      </div>
      {/* Linhas Favoritas fixadas no topo para acesso em 1 toque */}
      <div className="card stack">
        <div className="row between">
          <b>Favoritas</b>
          <span className="muted small">{favoriteLines.length}</span>
        </div>
        {favoriteLines.length === 0 ? (
          <div className="muted small">Selecione linhas abaixo para fixar no topo.</div>
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
                {fav.code} · {fav.name.length > 26 ? `${fav.name.slice(0, 26)}…` : fav.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Campo de Busca Rápida por número ou nome/bairro/terminal */}
      <div className="card stack">
        <input
          type="search"
          placeholder="Buscar linha, terminal ou bairro (ex.: 500, Ifes)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar linha de ônibus"
        />
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
                  {fav ? 'Fixada' : 'Fixar'}
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
