import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { useUi } from '../components/ui'
import { dayTotals } from '../data/stats'
import { useSyncStatus } from '../hooks'
import {
  applyConfirmedDraft,
  clearAssistantHistory,
  confirmCalendarCard,
  loadAssistantHistory,
  saveAssistantHistory,
  sendAssistantTurn,
  type AssistantDraft,
  type CalendarCardItem,
  type ChatTurnMessage,
} from '../lib/assistant'

const MEAL_LABELS: Record<string, string> = {
  cafe: 'café da manhã',
  almoco: 'almoço',
  jantar: 'jantar',
  lanche: 'lanche',
}

const QUICK_PROMPTS = [
  'Como foi minha semana de treinos e dieta?',
  'Qual minha evolução na barra fixa e flexões?',
  'Como está a evolução do meu peso nos últimos 30 dias?',
]

export default function Assistente() {
  const { toast, confirm } = useUi()
  const syncStatus = useSyncStatus()
  const history = useLiveQuery(() => loadAssistantHistory(), [], [] as ChatTurnMessage[])

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  )

  useEffect(() => {
    const onStatus = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', onStatus)
    window.addEventListener('offline', onStatus)
    return () => {
      window.removeEventListener('online', onStatus)
      window.removeEventListener('offline', onStatus)
    }
  }, [])

  const canUse = Boolean(syncStatus.user && online)

  const handleSend = async (promptText?: string) => {
    const text = (promptText ?? input).trim()
    if (!text || busy) return
    setErr('')

    if (!online) {
      setErr('error: sem conexão com a internet. O assistente funciona apenas online.')
      return
    }
    if (!syncStatus.user) {
      setErr('error: entre na sua conta na aba ~/config para autenticar no assistente.')
      return
    }

    const userMsg: ChatTurnMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }

    const nextHistory = [...history, userMsg]
    setInput('')
    setBusy(true)
    await saveAssistantHistory(nextHistory)

    try {
      const reply = await sendAssistantTurn(text, history)
      await saveAssistantHistory([...nextHistory, reply])
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao consultar o assistente.'
      setErr(msg.startsWith('error:') ? msg : `error: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (history.length === 0) return
    if (!(await confirm('Limpar todo o histórico local de conversa com o assistente?', 'limpar', false))) return
    await clearAssistantHistory()
    setErr('')
    toast('Histórico do assistente limpo')
  }

  const handleConfirmDraft = async (msgId: string, draft: AssistantDraft) => {
    try {
      await applyConfirmedDraft(draft)
      const updated = history.map((m) => {
        if (m.id !== msgId || !m.drafts) return m
        return {
          ...m,
          drafts: m.drafts.map((d) => (d.id === draft.id ? { ...d, status: 'confirmed' as const } : d)),
        }
      })
      await saveAssistantHistory(updated)
      toast('Rascunho confirmado e salvo')
    } catch (e) {
      toast((e as Error).message || 'Falha ao validar rascunho')
    }
  }

  const handleDiscardDraft = async (msgId: string, draftId: string) => {
    const updated = history.map((m) => {
      if (m.id !== msgId || !m.drafts) return m
      return {
        ...m,
        drafts: m.drafts.map((d) => (d.id === draftId ? { ...d, status: 'discarded' as const } : d)),
      }
    })
    await saveAssistantHistory(updated)
    toast('Rascunho descartado')
  }

  const handleConfirmCalendarCard = async (msgId: string, card: CalendarCardItem) => {
    try {
      const updatedEvent = await confirmCalendarCard(card)
      const updated = history.map((m) => {
        if (m.id !== msgId || !m.calendarCards) return m
        return {
          ...m,
          calendarCards: m.calendarCards.map((c) =>
            c.id === card.id
              ? {
                  ...c,
                  status: 'confirmed' as const,
                  event: updatedEvent ?? c.event,
                  pendingAction: undefined,
                }
              : c,
          ),
        }
      })
      await saveAssistantHistory(updated)
      toast(card.action === 'apagar_evento' ? 'Evento apagado da agenda' : 'Evento atualizado na agenda')
    } catch (e) {
      toast((e as Error).message || 'Falha ao confirmar na agenda')
    }
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <PromptTitle path="~/assistente" />
        {history.length > 0 && (
          <button className="small" disabled={busy} onClick={() => void handleClear()}>
            $ limpar
          </button>
        )}
      </div>

      {!syncStatus.user && (
        <div className="card stack" style={{ borderColor: 'var(--amber)' }}>
          <div className="amber small">
            warn: você está deslogado. O assistente exige autenticação na nuvem (token Firebase).
          </div>
          <div className="muted small">
            Acesse a aba <b>~/config</b> e entre com seu e-mail e senha para usar o assistente.
          </div>
        </div>
      )}

      {syncStatus.user && !online && (
        <div className="card stack" style={{ borderColor: 'var(--amber)' }}>
          <div className="amber small">
            warn: aparelho offline. Conecte-se à internet para enviar mensagens ao assistente.
          </div>
        </div>
      )}

      <div className="card stack">
        <div className="muted small">
          Coach de calistenia e nutrição conectado aos seus dados locais (leitura sob demanda). Nenhuma alteração é salva sem sua confirmação.
        </div>
        <div className="chips">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              className="small"
              disabled={!canUse || busy}
              onClick={() => void handleSend(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {history.length === 0 ? (
        <div className="card muted small">
          Nenhuma mensagem no histórico local. Pergunte sobre sua evolução nos exercícios, volume da semana, metas de proteína ou peça para montar um rascunho de refeição/rotina.
        </div>
      ) : (
        <div className="stack">
          {history.map((m) => (
            <div
              key={m.id}
              className="card stack"
              style={{
                borderColor: m.role === 'user' ? 'var(--border)' : 'rgba(57, 211, 83, 0.35)',
              }}
            >
              <div className="row between">
                <b className={m.role === 'user' ? 'muted small' : 'green small'}>
                  {m.role === 'user' ? '$ você' : '> assistente'}
                </b>
                <span className="muted small">
                  {new Date(m.createdAt).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{m.content}</div>

              {m.drafts &&
                m.drafts.map((d) => (
                  <DraftCard
                    key={d.id}
                    draft={d}
                    onConfirm={() => void handleConfirmDraft(m.id, d)}
                    onDiscard={() => void handleDiscardDraft(m.id, d.id)}
                  />
                ))}

              {m.calendarCards &&
                m.calendarCards.map((c) => (
                  <CalendarEventCard
                    key={c.id}
                    card={c}
                    onConfirm={() => void handleConfirmCalendarCard(m.id, c)}
                  />
                ))}

              {m.role === 'assistant' && m.dataSent && m.dataSent.length > 0 && (
                <div
                  className="muted small"
                  style={{
                    borderTop: '1px solid var(--border)',
                    paddingTop: 6,
                    fontSize: 11,
                  }}
                >
                  dados enviados ao assistente: {m.dataSent.join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {err && (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <div className="small red">{err}</div>
        </div>
      )}

      <div className="card stack" style={{ marginTop: 10 }}>
        <label className="field">
          <span className="muted small">mensagem</span>
          <textarea
            rows={2}
            value={input}
            disabled={!canUse || busy}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              canUse
                ? 'Ex.: Analise meu treino da semana ou proponha meu jantar com 45g de proteína…'
                : 'Entre na conta em ~/config e fique online para usar o assistente'
            }
          />
        </label>
        <button
          className="primary block"
          disabled={!canUse || busy || !input.trim()}
          onClick={() => void handleSend()}
        >
          {busy ? 'consultando assistente…' : '$ enviar'}
        </button>
      </div>
    </>
  )
}

function DraftCard({
  draft,
  onConfirm,
  onDiscard,
}: {
  draft: AssistantDraft
  onConfirm: () => void
  onDiscard: () => void
}) {
  const isPending = draft.status === 'pending'

  return (
    <div
      className="card stack"
      style={{
        background: 'var(--bg)',
        borderColor:
          draft.status === 'confirmed'
            ? 'var(--green)'
            : draft.status === 'discarded'
              ? 'var(--border)'
              : 'var(--amber)',
      }}
    >
      <div className="row between">
        <b className="small amber">
          [rascunho: {draft.kind === 'meal' ? 'refeição' : draft.kind === 'routine' ? 'rotina' : 'peso / medidas'}]
        </b>
        <span className="chip">
          {draft.status === 'pending'
            ? 'aguardando confirmação'
            : draft.status === 'confirmed'
              ? 'salvo'
              : 'descartado'}
        </span>
      </div>

      {draft.kind === 'meal' && (
        <div className="stack small">
          <div>
            data: <b>{draft.date}</b> · tipo: <b>{MEAL_LABELS[draft.mealType] ?? draft.mealType}</b>
          </div>
          {draft.items.map((it, i) => (
            <div key={i} className="muted">
              - {it.name} ({it.qty}): {Math.round(it.kcal)} kcal · P {Math.round(it.p)}g · C {Math.round(it.c)}g · G{' '}
              {Math.round(it.g)}g
            </div>
          ))}
          {(() => {
            const t = dayTotals([{ id: 'tmp', date: draft.date, type: draft.mealType, items: draft.items, createdAt: 0 }])
            return (
              <div>
                total: <b>{Math.round(t.kcal)} kcal</b> · P <b>{Math.round(t.p)}g</b> · C {Math.round(t.c)}g · G{' '}
                {Math.round(t.g)}g
              </div>
            )
          })()}
        </div>
      )}

      {draft.kind === 'routine' && (
        <div className="stack small">
          <div>
            rotina: <b>{draft.name}</b>
          </div>
          <div className="muted">exercícios ({draft.exerciseNames.length}): {draft.exerciseNames.join(' → ')}</div>
        </div>
      )}

      {draft.kind === 'body' && (
        <div className="stack small">
          <div>
            data: <b>{draft.date}</b>
            {draft.weight !== undefined && (
              <>
                {' '}
                · peso: <b>{draft.weight} kg</b>
              </>
            )}
          </div>
          {Object.keys(draft.measures).length > 0 && (
            <div className="muted">
              medidas:{' '}
              {Object.entries(draft.measures)
                .map(([k, v]) => `${k}: ${v}cm`)
                .join(' · ')}
            </div>
          )}
        </div>
      )}

      {isPending && (
        <div className="grid2">
          <button className="primary small" onClick={onConfirm}>
            $ confirmar e salvar
          </button>
          <button className="small" onClick={onDiscard}>
            descartar
          </button>
        </div>
      )}
    </div>
  )
}

function fmtCalendarDateTime(iso: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '—' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' }
  return {
    date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  }
}

function CalendarEventCard({
  card,
  onConfirm,
}: {
  card: CalendarCardItem
  onConfirm: () => void
}) {
  const { event, status, action } = card
  const startFmt = fmtCalendarDateTime(event.inicio)
  const endFmt = event.fim ? fmtCalendarDateTime(event.fim) : null
  const isPending = status === 'pending_confirmation'

  return (
    <div
      className="card stack small"
      style={{
        background: 'var(--bg)',
        borderColor: isPending ? 'var(--amber)' : 'var(--green)',
      }}
    >
      <div className="row between">
        <b className={isPending ? 'amber' : 'green'}>{event.titulo}</b>
        <span className="chip">
          {isPending
            ? action === 'apagar_evento'
              ? 'confirmar exclusão'
              : 'confirmar edição'
            : status === 'confirmed'
              ? 'confirmado'
              : 'agenda'}
        </span>
      </div>
      <div>
        data: <b>{startFmt.date}</b> · hora:{' '}
        <b>
          {startFmt.time}
          {endFmt?.time ? ` – ${endFmt.time}` : ''}
        </b>
      </div>
      {event.local && (
        <div className="muted">
          local: <b>{event.local}</b>
        </div>
      )}
      {event.htmlLink && (
        <div>
          <a
            href={event.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="green"
            style={{ textDecoration: 'underline' }}
          >
            abrir no Google Calendar
          </a>
        </div>
      )}
      {isPending && (
        <button className="primary small block" onClick={onConfirm}>
          Confirmar
        </button>
      )}
    </div>
  )
}
