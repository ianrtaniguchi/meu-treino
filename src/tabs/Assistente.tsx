import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { useUi } from '../components/ui'
import { dayTotals } from '../data/stats'
import { useSyncStatus } from '../hooks'
import {
  applyConfirmedDraft,
  cancelPushReminderCard,
  clearAssistantHistory,
  confirmCalendarCard,
  loadAssistantHistory,
  saveAssistantHistory,
  sendAssistantTurn,
  type AssistantDraft,
  type CalendarCardItem,
  type ChatTurnMessage,
  type PushReminderCardItem,
} from '../lib/assistant'
import {
  startAudioRecording,
  transcribeAudioClip,
  type ActiveAudioRecorder,
} from '../lib/audioRecorder'

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
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [recordSec, setRecordSec] = useState(0)
  const recorderRef = useRef<ActiveAudioRecorder | null>(null)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef<boolean>(false)

  const scrollToChatBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      if (chatBottomRef.current && typeof chatBottomRef.current.scrollIntoView === 'function') {
        chatBottomRef.current.scrollIntoView({ behavior, block: 'end' })
      } else {
        const docEl = document.scrollingElement || document.documentElement
        window.scrollTo({ top: docEl.scrollHeight, behavior })
      }
    })
  }

  // Auto-scroll ao montar a aba, ao enviar mensagem, ao receber resposta da IA e ao abrir teclado mobile
  useEffect(() => {
    if (history.length === 0 && !busy) return
    const behavior: ScrollBehavior = didInitialScrollRef.current ? 'smooth' : 'auto'
    didInitialScrollRef.current = true
    scrollToChatBottom(behavior)
  }, [history.length, busy, voiceState])

  useEffect(() => {
    scrollToChatBottom('auto')
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const onViewportResize = () => {
      scrollToChatBottom('smooth')
    }
    vv.addEventListener('resize', onViewportResize)
    return () => vv.removeEventListener('resize', onViewportResize)
  }, [])

  useEffect(() => {
    const onStatus = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', onStatus)
    window.addEventListener('offline', onStatus)
    return () => {
      window.removeEventListener('online', onStatus)
      window.removeEventListener('offline', onStatus)
    }
  }, [])

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

  useEffect(() => {
    if (voiceState !== 'recording') {
      setRecordSec(0)
      return
    }
    const timer = window.setInterval(() => {
      setRecordSec((s) => s + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [voiceState])

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

  const handleCancelReminderCard = async (msgId: string, card: PushReminderCardItem) => {
    try {
      const updatedRem = await cancelPushReminderCard(card)
      const updated = history.map((m) => {
        if (m.id !== msgId || !m.reminderCards) return m
        return {
          ...m,
          reminderCards: m.reminderCards.map((c) =>
            c.id === card.id
              ? {
                  ...c,
                  reminder: updatedRem ?? { ...c.reminder, status: 'cancelled' as const },
                }
              : c,
          ),
        }
      })
      await saveAssistantHistory(updated)
      toast('Lembrete push cancelado')
    } catch (e) {
      toast((e as Error).message || 'Falha ao cancelar lembrete')
    }
  }

  const fmtRecTimer = (sec: number) => {
    const mm = String(Math.floor(sec / 60)).padStart(2, '0')
    const ss = String(sec % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const handleStartVoice = async () => {
    if (!canUse || busy || voiceState !== 'idle') return
    setErr('')
    try {
      const rec = await startAudioRecording()
      recorderRef.current = rec
      setVoiceState('recording')
    } catch (e) {
      const msg = (e as Error)?.message || 'error: falha ao acessar o microfone.'
      setErr(msg.startsWith('error:') ? msg : `error: ${msg}`)
      setVoiceState('idle')
    }
  }

  const handleCancelVoice = () => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    setVoiceState('idle')
  }

  const handleStopAndTranscribe = async (autoSend: boolean) => {
    const rec = recorderRef.current
    if (!rec) {
      setVoiceState('idle')
      return
    }
    recorderRef.current = null
    setErr('')
    setVoiceState('transcribing')
    try {
      const clip = await rec.stop()
      const transcribed = await transcribeAudioClip(clip)
      setVoiceState('idle')
      if (autoSend) {
        const combined = input.trim() ? `${input.trim()} ${transcribed}` : transcribed
        await handleSend(combined)
      } else {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${transcribed}` : transcribed))
        toast('Áudio transcrito')
      }
    } catch (e) {
      setVoiceState('idle')
      const msg = (e as Error)?.message || 'error: falha ao transcrever áudio.'
      setErr(msg.startsWith('error:') ? msg : `error: ${msg}`)
    }
  }

  return (
    <>
      <PromptTitle
        path="~/assistente"
        rightSlot={
          history.length > 0 ? (
            <button className="small" disabled={busy} onClick={() => void handleClear()}>
              limpar
            </button>
          ) : undefined
        }
      />

      {!syncStatus.user && (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <div className="amber small">
            Entre na conta em <b>~/config</b> para usar o assistente.
          </div>
        </div>
      )}

      {syncStatus.user && !online && (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <div className="amber small">Offline · conecte-se para enviar mensagens.</div>
        </div>
      )}

      <div className="card">
        <div className="chips">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              className="small ai"
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
          Sem mensagens. Escolha um atalho acima ou envie abaixo.
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

              {m.reminderCards &&
                m.reminderCards.map((rc) => (
                  <PushReminderCard
                    key={rc.id}
                    card={rc}
                    onCancel={() => void handleCancelReminderCard(m.id, rc)}
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
                  contexto: {m.dataSent.join(' · ')}
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
        <textarea
          rows={2}
          value={input}
          disabled={!canUse || busy || voiceState !== 'idle'}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => scrollToChatBottom('smooth')}
          aria-label="Mensagem para o assistente"
          placeholder={
            canUse
              ? 'Pergunte sobre treinos, dieta ou crie um lembrete…'
              : 'Entre na conta em ~/config para usar o assistente'
          }
        />

        {voiceState === 'recording' && (
          <div
            className="card stack small"
            style={{ background: 'var(--bg)', borderColor: 'var(--amber)', marginBottom: 0 }}
          >
            <div className="row between">
              <b className="amber">● gravando · {fmtRecTimer(recordSec)}</b>
              <span className="muted small">whisper</span>
            </div>
            <div className="grid2">
              <button
                className="primary small"
                onClick={() => void handleStopAndTranscribe(true)}
              >
                transcrever e enviar
              </button>
              <button
                className="ai small"
                onClick={() => void handleStopAndTranscribe(false)}
              >
                só transcrever
              </button>
            </div>
            <button className="small danger block" onClick={handleCancelVoice}>
              cancelar
            </button>
          </div>
        )}

        {voiceState === 'transcribing' && (
          <div
            className="card small"
            style={{ background: 'var(--bg)', borderColor: 'var(--green)', marginBottom: 0 }}
          >
            <span className="green">&gt; transcrevendo áudio…</span>
          </div>
        )}

        {voiceState === 'idle' && (
          <div className="grid2">
            <button
              className="primary"
              disabled={!canUse || busy || !input.trim()}
              onClick={() => void handleSend()}
            >
              {busy ? 'respondendo…' : 'enviar'}
            </button>
            <button
              className="ai"
              disabled={!canUse || busy}
              onClick={() => void handleStartVoice()}
              aria-label="gravar áudio por voz"
            >
              gravar voz
            </button>
          </div>
        )}
      </div>
      <div ref={chatBottomRef} aria-hidden="true" style={{ height: 2 }} />
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
            confirmar e salvar
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

const RECURRENCE_LABELS: Record<string, string> = {
  none: 'único',
  daily: 'diário',
  weekly: 'semanal',
}

function fmtReminderTriggerAt(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const day = get('day')
    const month = get('month')
    const hour = get('hour')
    const minute = get('minute')
    if (day && month && hour && minute) {
      return `${day}/${month} às ${hour}:${minute}`
    }
  } catch {
    // fallback abaixo
  }
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
}

function PushReminderCard({
  card,
  onCancel,
}: {
  card: PushReminderCardItem
  onCancel: () => void
}) {
  const { reminder } = card
  const isPending = reminder.status === 'pending'
  const isCancelled = reminder.status === 'cancelled'

  return (
    <div
      className="card stack small"
      style={{
        background: 'var(--bg)',
        borderColor: isCancelled ? 'var(--border)' : 'var(--green)',
      }}
    >
      <div className="row between">
        <b className={isCancelled ? 'muted' : 'green'}>[push] {reminder.title}</b>
        <span className="chip">
          {isCancelled
            ? 'cancelado'
            : reminder.status === 'sent'
              ? 'enviado'
              : `agendado · ${RECURRENCE_LABELS[reminder.recurrence] ?? 'único'}`}
        </span>
      </div>
      <div>
        disparo: <b>{fmtReminderTriggerAt(reminder.triggerAt)}</b>
      </div>
      {reminder.body && <div className="muted">{reminder.body}</div>}
      {isPending && (
        <button className="small danger" onClick={onCancel}>
          cancelar lembrete
        </button>
      )}
    </div>
  )
}
