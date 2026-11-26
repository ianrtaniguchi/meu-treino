import { useEffect, useMemo, useState } from 'react'
import {
  fetchItinerary,
  fetchSchedules,
  findNextDeparture,
  getActiveDayTabForDate,
} from '../../services/ceturbService'
import type {
  CeturbDayTab,
  CeturbLine,
  CeturbLineItineraryBundle,
  CeturbLineScheduleBundle,
} from '../../types/ceturb'

interface LineDetailViewProps {
  line: CeturbLine
  isFavorite: boolean
  onToggleFavorite: (lineId: string) => void
  onBack: () => void
}

const DAY_TABS: Array<{ key: CeturbDayTab; label: string }> = [
  { key: 'uteis', label: 'Dias Úteis' },
  { key: 'sabado', label: 'Sábados' },
  { key: 'domingo', label: 'Domingos/Feriados' },
]

export default function LineDetailView({
  line,
  isFavorite,
  onToggleFavorite,
  onBack,
}: LineDetailViewProps) {
  const [now, setNow] = useState<Date>(() => new Date())
  const [dayTab, setDayTab] = useState<CeturbDayTab>(() => getActiveDayTabForDate(new Date()))
  const [terminalIdx, setTerminalIdx] = useState<number>(0)
  const [sectionView, setSectionView] = useState<'horarios' | 'itinerario'>('horarios')
  const [itineraryDir, setItineraryDir] = useState<'ida' | 'volta'>('ida')
  const [streetFilter, setStreetFilter] = useState<string>('')

  const [scheduleBundle, setScheduleBundle] = useState<CeturbLineScheduleBundle | null>(null)
  const [schedLoading, setSchedLoading] = useState<boolean>(true)
  const [schedError, setSchedError] = useState<string | null>(null)

  const [itineraryBundle, setItineraryBundle] = useState<CeturbLineItineraryBundle | null>(null)
  const [itinLoading, setItinLoading] = useState<boolean>(false)
  const [itinError, setItinError] = useState<string | null>(null)

  // Atualiza o relógio a cada 30 segundos para manter o destaque da próxima partida em tempo real
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const loadSchedules = async (force = false) => {
    setSchedLoading(true)
    setSchedError(null)
    try {
      const data = await fetchSchedules(line.id, { forceRefresh: force, lineName: line.name })
      setScheduleBundle(data)
      setTerminalIdx(0)
    } catch (e) {
      setSchedError((e as Error)?.message || 'Falha ao carregar horários.')
    } finally {
      setSchedLoading(false)
    }
  }

  const loadItinerary = async (force = false) => {
    setItinLoading(true)
    setItinError(null)
    try {
      const data = await fetchItinerary(line.id, { forceRefresh: force, lineName: line.name })
      setItineraryBundle(data)
    } catch (e) {
      setItinError((e as Error)?.message || 'Falha ao carregar itinerário.')
    } finally {
      setItinLoading(false)
    }
  }

  useEffect(() => {
    setDayTab(getActiveDayTabForDate(new Date()))
    setSectionView('horarios')
    setItineraryBundle(null)
    void loadSchedules(false)
  }, [line.id])

  useEffect(() => {
    if (sectionView === 'itinerario' && !itineraryBundle && !itinLoading) {
      void loadItinerary(false)
    }
  }, [sectionView, line.id])

  const dayGroup = scheduleBundle?.days[dayTab]
  const terminals = dayGroup?.terminals ?? []
  const activeTerminal = terminals[terminalIdx] ?? terminals[0] ?? null
  const departures = activeTerminal?.departures ?? []

  const todayAutoTab = getActiveDayTabForDate(now)
  const isViewingTodayTab = dayTab === todayAutoTab

  const nextDeparture = useMemo(() => {
    if (!activeTerminal || departures.length === 0) return null
    return findNextDeparture(departures, now)
  }, [activeTerminal, departures, now])

  const observationsMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const ob of scheduleBundle?.observations ?? []) {
      map.set(ob.code, ob.description)
    }
    return map
  }, [scheduleBundle?.observations])

  const filteredStreets = useMemo(() => {
    if (!itineraryBundle) return []
    const list = itineraryDir === 'ida' ? itineraryBundle.ida : itineraryBundle.volta
    const q = streetFilter.trim().toLowerCase()
    if (!q) return list
    return list.filter((s) => s.street.toLowerCase().includes(q))
  }, [itineraryBundle, itineraryDir, streetFilter])

  return (
    <div className="stack">
      {/* Cabeçalho da Linha selecionada */}
      <div className="card stack">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <button type="button" className="small" onClick={onBack}>
            ← linhas
          </button>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="small"
              onClick={() =>
                sectionView === 'horarios' ? void loadSchedules(true) : void loadItinerary(true)
              }
              disabled={schedLoading || itinLoading}
              title="Atualizar dados da Ceturb-ES"
            >
              atualizar
            </button>
            <button
              type="button"
              className={`small ${isFavorite ? 'on' : ''}`}
              onClick={() => onToggleFavorite(line.id)}
              aria-label={isFavorite ? 'Remover dos favoritos' : 'Fixar nos favoritos'}
              title={isFavorite ? 'Linha favorita' : 'Favoritar linha'}
            >
              {isFavorite ? '★ favorita' : '☆ favoritar'}
            </button>
          </div>
        </div>

        <div>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span className="bus-badge">{line.code}</span>
            {scheduleBundle?.effectiveDate && (
              <span className="chip">vigência: {scheduleBundle.effectiveDate}</span>
            )}
            {scheduleBundle?.fromCache && <span className="chip">cache local</span>}
          </div>
          <h3 style={{ fontSize: 15, lineHeight: 1.35 }}>
            {scheduleBundle?.lineName || line.name}
          </h3>
        </div>

        {/* Alternador Horários vs Itinerário */}
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={`small grow ${sectionView === 'horarios' ? 'on' : ''}`}
            onClick={() => setSectionView('horarios')}
          >
            Horários ({departures.length})
          </button>
          <button
            type="button"
            className={`small grow ${sectionView === 'itinerario' ? 'on' : ''}`}
            onClick={() => setSectionView('itinerario')}
          >
            Itinerário (Ida / Volta)
          </button>
        </div>
      </div>

      {sectionView === 'horarios' && (
        <>
          {/* Seletor de Dia: Dias Úteis, Sábados, Domingos/Feriados */}
          <div className="tabs" role="tablist" aria-label="Tipo de dia">
            {DAY_TABS.map((t) => {
              const count =
                scheduleBundle?.days[t.key]?.terminals?.reduce(
                  (acc, term) => acc + term.departures.length,
                  0,
                ) ?? 0
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={dayTab === t.key}
                  className={dayTab === t.key ? 'on' : ''}
                  onClick={() => {
                    setDayTab(t.key)
                    setTerminalIdx(0)
                  }}
                >
                  {t.label} {scheduleBundle ? `(${count})` : ''}
                </button>
              )
            })}
          </div>

          {schedLoading && (
            <div className="card muted small">
              Consultando horários oficiais da linha {line.code} na Ceturb-ES...
            </div>
          )}

          {schedError && !schedLoading && (
            <div className="card stack">
              <div className="red small">{schedError}</div>
              <button type="button" className="small" onClick={() => void loadSchedules(true)}>
                tentar novamente
              </button>
            </div>
          )}

          {!schedLoading && !schedError && scheduleBundle && (
            <>
              {/* Seletor de Terminal de Saída (quando a linha possui partidas de 2 terminais) */}
              {terminals.length > 1 && (
                <div className="card stack">
                  <div className="muted small">Terminal de saída:</div>
                  <div className="chips">
                    {terminals.map((term, idx) => (
                      <button
                        key={`${term.terminalSeq}-${term.terminalName}`}
                        type="button"
                        className={`small ${terminalIdx === idx ? 'on' : ''}`}
                        onClick={() => setTerminalIdx(idx)}
                      >
                        {term.terminalName} ({term.departures.length})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Card em destaque da Próxima Saída com base no horário atual */}
              {activeTerminal && nextDeparture && (
                <div className="card bus-next-card">
                  <div className="row between">
                    <div>
                      <div className="muted small">
                        Próxima saída • {activeTerminal.terminalName}
                      </div>
                      <div className="row" style={{ gap: 10, marginTop: 4 }}>
                        <span className="big green">{nextDeparture.slot.time}</span>
                        {nextDeparture.slot.noteCode && (
                          <span
                            className="bus-note-badge"
                            title={
                              observationsMap.get(nextDeparture.slot.noteCode) ??
                              `Observação ${nextDeparture.slot.noteCode}`
                            }
                          >
                            obs {nextDeparture.slot.noteCode}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="tag-pr">
                        {!isViewingTodayTab
                          ? DAY_TABS.find((d) => d.key === dayTab)?.label
                          : nextDeparture.isTomorrow
                            ? '1º de amanhã'
                            : nextDeparture.minutesUntil === 0
                              ? 'saindo agora'
                              : nextDeparture.minutesUntil < 60
                                ? `em ${nextDeparture.minutesUntil} min`
                                : `em ${Math.floor(nextDeparture.minutesUntil / 60)}h ${nextDeparture.minutesUntil % 60}min`}
                      </span>
                      <div className="muted small" style={{ marginTop: 4 }}>
                        agora:{' '}
                        {now.toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                  {nextDeparture.slot.noteCode &&
                    observationsMap.has(nextDeparture.slot.noteCode) && (
                      <div className="muted small" style={{ marginTop: 8 }}>
                        [{nextDeparture.slot.noteCode}]{' '}
                        {observationsMap.get(nextDeparture.slot.noteCode)}
                      </div>
                    )}
                </div>
              )}

              {/* Grade de Horários */}
              {!activeTerminal || departures.length === 0 ? (
                <div className="card muted small">
                  Nenhuma partida cadastrada para {DAY_TABS.find((d) => d.key === dayTab)?.label}{' '}
                  nesta linha.
                </div>
              ) : (
                <div className="card stack">
                  <div className="row between">
                    <b>Saídas de {activeTerminal.terminalName}</b>
                    <span className="muted small">{departures.length} partidas</span>
                  </div>
                  <div className="bus-time-grid">
                    {departures.map((slot, idx) => {
                      const isNext = nextDeparture?.index === idx
                      const isPast =
                        isViewingTodayTab &&
                        !nextDeparture?.isTomorrow &&
                        nextDeparture !== null &&
                        idx < nextDeparture.index
                      return (
                        <div
                          key={`${slot.time}-${slot.noteCode ?? ''}-${idx}`}
                          className={`bus-time-pill${isNext ? ' next' : ''}${isPast ? ' past' : ''}`}
                          title={
                            slot.noteCode
                              ? `${slot.time} — [${slot.noteCode}] ${observationsMap.get(slot.noteCode) ?? ''}`
                              : slot.time
                          }
                        >
                          <span>{slot.time}</span>
                          {slot.noteCode && <sup className="bus-time-sup">{slot.noteCode}</sup>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Legenda / Observações da Linha (/api/BuscaHorarioObse) */}
              {scheduleBundle.observations.length > 0 && (
                <div className="card stack">
                  <b>Observações de partida</b>
                  {scheduleBundle.observations.map((ob) => (
                    <div key={ob.code} className="row" style={{ alignItems: 'baseline', gap: 8 }}>
                      <span className="bus-note-badge">{ob.code}</span>
                      <span className="small grow">{ob.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {sectionView === 'itinerario' && (
        <>
          <div className="card stack">
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className={`small grow ${itineraryDir === 'ida' ? 'on' : ''}`}
                onClick={() => setItineraryDir('ida')}
              >
                Sentido Ida ({itineraryBundle?.ida.length ?? 0})
              </button>
              <button
                type="button"
                className={`small grow ${itineraryDir === 'volta' ? 'on' : ''}`}
                onClick={() => setItineraryDir('volta')}
              >
                Sentido Volta ({itineraryBundle?.volta.length ?? 0})
              </button>
            </div>
            <input
              type="search"
              placeholder="Filtrar rua, avenida ou bairro no trajeto..."
              value={streetFilter}
              onChange={(e) => setStreetFilter(e.target.value)}
              aria-label="Filtrar rua no itinerário"
            />
          </div>

          {itinLoading && (
            <div className="card muted small">
              Carregando itinerário da linha {line.code} na Ceturb-ES...
            </div>
          )}

          {itinError && !itinLoading && (
            <div className="card stack">
              <div className="red small">{itinError}</div>
              <button type="button" className="small" onClick={() => void loadItinerary(true)}>
                tentar novamente
              </button>
            </div>
          )}

          {!itinLoading && !itinError && itineraryBundle && (
            <div className="card">
              {filteredStreets.length === 0 ? (
                <div className="muted small">
                  Nenhuma via encontrada para o filtro informado neste sentido.
                </div>
              ) : (
                filteredStreets.map((st) => (
                  <div key={`${itineraryDir}-${st.sequence}-${st.street}`} className="item">
                    <span className="chip" style={{ minWidth: 34, textAlign: 'center' }}>
                      {st.sequence}
                    </span>
                    <span className="small grow">{st.street}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
