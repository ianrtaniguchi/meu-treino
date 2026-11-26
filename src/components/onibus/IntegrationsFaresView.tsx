import { useEffect, useMemo, useState } from 'react'
import {
  FALLBACK_FARES,
  FALLBACK_TEMPORAL_INTEGRATIONS,
  fetchFares,
  fetchTemporalIntegration,
} from '../../services/ceturbService'
import type { CeturbFareBundle, IntegracaoTemporalPITGrid } from '../../types/ceturb'

export default function IntegrationsFaresView() {
  const [integrations, setIntegrations] = useState<IntegracaoTemporalPITGrid[]>(
    FALLBACK_TEMPORAL_INTEGRATIONS,
  )
  const [fares, setFares] = useState<CeturbFareBundle>(FALLBACK_FARES)
  const [search, setSearch] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([fetchTemporalIntegration(), fetchFares()])
      .then(([intData, fareData]) => {
        if (!active) return
        setIntegrations(intData)
        setFares(fareData)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const filteredIntegrations = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return integrations
    return integrations.filter((item) => {
      const hay = [
        item.linha_origem,
        item.linha_origem_completo,
        item.linha_destino,
        item.linha_destino_completo,
        item.local,
        item.tp_origem,
        item.tp_destino,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [integrations, search])

  const formatBRL = (val: number) =>
    val === 0
      ? 'Grátis (Integrado)'
      : val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  return (
    <div className="stack">
      {/* Quadro Tarifário Atualizado */}
      <div className="card stack">
        <div className="row between">
          <b>Quadro Tarifário • Cartão GV</b>
          <span className="chip">atualizado: {fares.updatedAt}</span>
        </div>

        <div className="grid2">
          {fares.modals.map((m) => (
            <div
              key={m.id}
              className="card"
              style={{ marginBottom: 0, background: 'var(--bg)' }}
            >
              <div className="row between" style={{ marginBottom: 4 }}>
                <span className="chip">{m.category}</span>
                <span className="tag-pr">{m.integrationWindowMinutes} min</span>
              </div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{m.modal}</div>
              <div className="row between">
                <div>
                  <div className="big green" style={{ fontSize: 21 }}>
                    {formatBRL(m.price)}
                  </div>
                  <div className="muted small">
                    Estudante: <b>{formatBRL(m.studentPrice)}</b>
                  </div>
                </div>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                {m.notes}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Regras do Cartão GV & Integração Temporal */}
      <div className="card stack">
        <b>Regras de Integração Temporal (Fora dos Terminais)</b>
        {fares.rulesSummary.map((rule, idx) => (
          <div key={idx} className="small muted" style={{ lineHeight: 1.45 }}>
            • {rule}
          </div>
        ))}
      </div>

      {/* Matriz e Pontos de Conexão da Integração Temporal */}
      <div className="card stack">
        <div className="row between">
          <b>Conexões & Corredores PIT ({filteredIntegrations.length})</b>
          {loading && <span className="muted small">sincronizando...</span>}
        </div>

        <input
          type="search"
          placeholder="Filtrar por linha (ex.: 500, 503, 401) ou ponto (ex.: Ifes, UFES, Reta da Penha)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Filtrar conexões de integração temporal"
        />

        {filteredIntegrations.length === 0 ? (
          <div className="muted small">
            Nenhuma conexão encontrada para "{search}". Lembre-se de que nos 10 terminais urbanos a
            integração física também é gratuita.
          </div>
        ) : (
          filteredIntegrations.map((item) => (
            <div key={item.codigo} className="item" style={{ alignItems: 'flex-start' }}>
              <div className="stack grow" style={{ gap: 4 }}>
                <div className="row between">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="bus-badge">{item.linha_origem}</span>
                    <span className="muted small">⇄</span>
                    <span className="bus-badge">{item.linha_destino}</span>
                  </div>
                  <span className="tag-pr">
                    janela: {item.tempo || `${item.tempo_para_integracao ?? '01:30'}h`}
                  </span>
                </div>
                <div className="small" style={{ fontWeight: 600 }}>
                  {item.linha_origem_completo}
                </div>
                <div className="small muted">↳ conecta com: {item.linha_destino_completo}</div>
                {item.local && (
                  <div className="small">
                    <span className="green">Ponto de conexão:</span> {item.local}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
