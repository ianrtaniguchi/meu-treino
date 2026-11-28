import { useLiveQuery } from 'dexie-react-hooks'
import { useContext, useEffect, useRef, useState } from 'react'
import { OWNER_UID } from '../assistantConfig'
import { uid } from '../data/db'
import { ChromeNavContext, PromptTitle } from '../components/TerminalChrome'
import { useUi } from '../components/ui'
import { dayTotals } from '../data/stats'
import { useSyncStatus } from '../hooks'
import { containsFinancialIdentifier, formatCents } from '../lib/expenses'
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
  type EventDraft,
  type ExpenseDraft,
  type MealDraft,
  type PushReminderCardItem,
} from '../lib/assistant'
import {
  analyzeAssistantPhoto,
  extractVideoFrames,
  fetchAssistantSuggestions,
} from '../lib/assistantMedia'
import Icon from '../components/Icons'
import { useTheme } from '../lib/theme'
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

function fallbackSuggestions(now = new Date(), workoutLogged = false, _mealsLogged = 0): string[] {
  const hour = now.getHours()
  if (hour < 10) return ['Qual treino faço hoje?', 'Registrar meu café', 'Criar lembrete de água', 'Como está meu peso?']
  if (hour < 15) return ['Registrar meu almoço', 'Quanto falta de proteína hoje?', workoutLogged ? 'Como foi meu treino hoje?' : 'Qual treino faço hoje?', 'Criar lembrete de água']
  if (hour < 18) return ['Registrar meu lanche', 'Quanto falta de proteína hoje?', workoutLogged ? 'Revisar meu treino' : 'Qual treino faço hoje?', 'Criar lembrete de treino']
  return ['Registrar meu jantar', workoutLogged ? 'Como foi meu treino hoje?' : 'Qual treino faço hoje?', 'Quanto falta de proteína hoje?', 'Criar lembrete de amanhã']
}

function AssistantMarkdown({ content }: { content: string }) {
  const lines = content.split(/\r?\n/)
  return (
    <div className="assistant-markdown">
      {lines.map((line, index) => {
        const isList = /^\s*[-*]\s+/.test(line)
        const clean = isList ? line.replace(/^\s*[-*]\s+/, '') : line
        const parts = clean.split(/(\*\*[^*]+\*\*)/g)
        const rendered = parts.map((part, partIndex) =>
          part.startsWith('**') && part.endsWith('**')
            ? <strong key={partIndex}>{part.slice(2, -2)}</strong>
            : part,
        )
        if (isList) return <div className="assistant-markdown-list" key={index}><span>•</span><span>{rendered}</span></div>
        if (!clean) return <div className="assistant-markdown-break" key={index} />
        return <div key={index}>{rendered}</div>
      })}
    </div>
  )
}

export default function Assistente() {
  const { toast, confirm } = useUi()
  const [theme, applyTheme] = useTheme()
  const { onNavigateTab } = useContext(ChromeNavContext)
  const syncStatus = useSyncStatus()
  const activeUid = syncStatus.user?.uid ?? null
  const history = useLiveQuery(
    () => loadAssistantHistory(activeUid),
    [activeUid],
    [] as ChatTurnMessage[],
  )

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>(QUICK_PROMPTS)
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [videoFrames, setVideoFrames] = useState<Blob[]>([])
  const [mediaMenuOpen, setMediaMenuOpen] = useState(false)
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  )
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [recordSec, setRecordSec] = useState(0)
  const recorderRef = useRef<ActiveAudioRecorder | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const galleryInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
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
      const keyboardOffset = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      )
      document.documentElement.style.setProperty(
        '--assistant-composer-bottom',
        keyboardOffset > 40
          ? `${keyboardOffset + 8}px`
          : `calc(8px + var(--tabbar-h) + var(--sab))`,
      )
      scrollToChatBottom('smooth')
    }
    onViewportResize()
    vv.addEventListener('resize', onViewportResize)
    vv.addEventListener('scroll', onViewportResize)
    return () => {
      vv.removeEventListener('resize', onViewportResize)
      vv.removeEventListener('scroll', onViewportResize)
      document.documentElement.style.removeProperty('--assistant-composer-bottom')
    }
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

  useEffect(() => {
    if (!photoPreview) return
    return () => URL.revokeObjectURL(photoPreview)
  }, [photoPreview])

  useEffect(() => {
    if (!videoPreview) return
    return () => URL.revokeObjectURL(videoPreview)
  }, [videoPreview])

  useEffect(() => {
    if (!activeUid || !canUse) {
      setSuggestions(fallbackSuggestions())
      return
    }
    let active = true
    setSuggestions([])
    void fetchAssistantSuggestions(activeUid, {
      lastMessages: history.slice(-4).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    })
      .then((items) => {
        if (active) setSuggestions(items)
      })
      .catch(() => {
        if (!active) return
        setSuggestions(fallbackSuggestions())
      })
    return () => {
      active = false
    }
  }, [activeUid, canUse, history.length, busy])

  const handlePhotoSelection = (file?: File) => {
    if (!file) return
    setSelectedVideo(null)
    setVideoPreview(null)
    setSelectedPhoto(file)
    setPhotoPreview(URL.createObjectURL(file))
    setErr('')
    if (photoInputRef.current) photoInputRef.current.value = ''
  }

  const handleVideoSelection = async (file?: File) => {
    if (!file) return
    setMediaMenuOpen(false)
    setErr('')
    setSelectedPhoto(null)
    setPhotoPreview(null)
    try {
      const frames = await extractVideoFrames(file)
      setSelectedVideo(file)
      setVideoFrames(frames)
      setVideoPreview(URL.createObjectURL(frames[0]))
      if (videoInputRef.current) videoInputRef.current.value = ''
    } catch (error) {
      setSelectedVideo(null)
      setVideoPreview(null)
      const message = error instanceof Error ? error.message : 'Não consegui processar o vídeo.'
      setErr(message.startsWith('error:') ? message : `error: ${message}`)
    }
  }

  const handleSendPhoto = async () => {
    if (!selectedPhoto || !canUse || busy || !activeUid) return
    const text = input.trim()
    if (containsFinancialIdentifier(text)) {
      setErr('error: não envie números de cartão, banco ou conta ao assistente.')
      return
    }
    setErr('')
    setBusy(true)
    try {
      const analysis = await analyzeAssistantPhoto(selectedPhoto, text)
      let draft: MealDraft | ExpenseDraft | EventDraft | null = null
      let replyText = analysis.message || 'Não consegui identificar dados suficientes para uma proposta.'

      if (analysis.intent === 'meal' && analysis.meal) {
        draft = {
          id: uid(),
          kind: 'meal',
          status: 'pending',
          date: analysis.meal.date,
          mealType: analysis.meal.type,
          items: analysis.meal.items,
        }
        replyText = 'Identifiquei uma refeição. Confira os alimentos e confirme para registrar.'
      } else if (analysis.intent === 'expense' && analysis.expense) {
        if (activeUid !== OWNER_UID) throw new Error('Propostas de Gastos estão disponíveis apenas para o proprietário.')
        draft = {
          id: uid(),
          kind: 'expense',
          status: 'pending',
          date: analysis.expense.date,
          amountCents: analysis.expense.amountCents,
          category: analysis.expense.category,
          merchantNote: analysis.expense.merchant,
        }
        replyText = 'Li os dados essenciais do comprovante. Confira e confirme para salvar; a imagem não fica no histórico.'
      } else if (analysis.intent === 'event' && analysis.event) {
        if (activeUid !== OWNER_UID) throw new Error('Propostas de Agenda estão disponíveis apenas para o proprietário.')
        draft = {
          id: uid(),
          kind: 'event',
          status: 'pending',
          title: analysis.event.title,
          startAt: analysis.event.startAt,
          endAt: analysis.event.endAt,
          location: analysis.event.location,
          description: analysis.event.description,
        }
        replyText = 'Identifiquei um compromisso. Revise os detalhes e confirme para criar o evento na agenda.'
      }

      const userMessage: ChatTurnMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: text || 'Foto enviada para análise.',
        createdAt: Date.now(),
      }
      const assistantMessage: ChatTurnMessage = {
        id: uid(),
        role: 'assistant',
        content: replyText,
        createdAt: Date.now(),
        dataSent: ['foto processada temporariamente no Worker'],
        drafts: draft ? [draft] : undefined,
      }
      await saveAssistantHistory([...history, userMessage, assistantMessage], activeUid)
      setInput('')
      setSelectedPhoto(null)
      setPhotoPreview(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao analisar a foto.'
      setErr(message.startsWith('error:') ? message : `error: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSendVideo = async () => {
    if (!selectedVideo || videoFrames.length === 0 || !canUse || busy || !activeUid) return
    const text = input.trim()
    setErr('')
    setBusy(true)
    try {
      const images = await Promise.all(videoFrames.map((frame) => {
        const url = URL.createObjectURL(frame)
        return new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('Não consegui preparar os frames do vídeo.'))
          img.src = url
        }).finally(() => URL.revokeObjectURL(url))
      }))
      const columns = images.length <= 2 ? images.length : 2
      const rows = Math.ceil(images.length / columns)
      const cellWidth = 480
      const cellHeight = 270
      const canvas = document.createElement('canvas')
      canvas.width = cellWidth * columns
      canvas.height = cellHeight * rows
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Não consegui montar os frames do vídeo.')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      images.forEach((img, index) => {
        const x = (index % columns) * cellWidth
        const y = Math.floor(index / columns) * cellHeight
        const scale = Math.min(cellWidth / img.naturalWidth, cellHeight / img.naturalHeight)
        const width = img.naturalWidth * scale
        const height = img.naturalHeight * scale
        ctx.drawImage(img, x + (cellWidth - width) / 2, y + (cellHeight - height) / 2, width, height)
      })
      const collageBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.78),
      )
      if (!collageBlob) throw new Error('Não consegui preparar o vídeo para análise.')
      const collage = new File([collageBlob], 'video-frames.jpg', { type: 'image/jpeg' })
      const analysis = await analyzeAssistantPhoto(
        collage,
        text || 'Analise estes frames extraídos de um vídeo.',
      )
      const userMessage: ChatTurnMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: text || 'Vídeo enviado para análise.',
        createdAt: Date.now(),
      }
      const assistantMessage: ChatTurnMessage = {
        id: uid(),
        role: 'assistant',
        content: analysis.message || 'Analisei os frames do vídeo.',
        createdAt: Date.now(),
        dataSent: ['3–5 frames do vídeo processados temporariamente'],
      }
      await saveAssistantHistory([...history, userMessage, assistantMessage], activeUid)
      setInput('')
      setSelectedVideo(null)
      setVideoPreview(null)
      setVideoFrames([])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao analisar o vídeo.'
      setErr(message.startsWith('error:') ? message : `error: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSend = async (promptText?: string) => {
    const text = (promptText ?? input).trim()
    if (!text || busy) return
    setErr('')

    if (containsFinancialIdentifier(text)) {
      setErr('error: não envie números de cartão, banco ou conta ao assistente.')
      return
    }

    if (!online) {
      setErr('error: sem conexão com a internet. O assistente funciona apenas online.')
      return
    }
    if (!syncStatus.user) {
      setErr('error: entre na sua conta na aba Configurações para autenticar no assistente.')
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
      const reply = await sendAssistantTurn(text, history, { userUid: activeUid })
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
      const limitAlerts = await applyConfirmedDraft(draft)
      const updated = history.map((m) => {
        if (m.id !== msgId || !m.drafts) return m
        return {
          ...m,
          drafts: m.drafts.map((d) => (d.id === draft.id ? { ...d, status: 'confirmed' as const } : d)),
        }
      })
      await saveAssistantHistory(updated)
      const targetTab =
        draft.kind === 'event'
          ? 'assistente'
          : draft.kind === 'expense'
          ? 'gastos'
          : draft.kind === 'meal'
            ? 'dieta'
            : draft.kind === 'body'
              ? 'corpo'
              : 'treino'
      toast(
        limitAlerts.length > 0 ? limitAlerts.join(' ') : 'Rascunho confirmado e salvo',
        onNavigateTab
          ? {
              label: 'abrir',
              run: () => onNavigateTab(targetTab),
            }
          : undefined,
      )
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
          <div className="assistant-header-actions">
            {history.length > 0 && (
              <button
                type="button"
                className="assistant-icon-button"
                disabled={busy}
                onClick={() => void handleClear()}
                aria-label="Limpar conversa"
                title="Nova conversa"
              >
                <Icon name="close" />
              </button>
            )}
            <button
              type="button"
              className="assistant-icon-button"
              onClick={() => applyTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'baby' : 'dark')}
              aria-label="Alterar tema"
              title="Tema"
            >
              <Icon name="theme" />
            </button>
            <button
              type="button"
              className="assistant-icon-button"
              onClick={() => onNavigateTab?.('config')}
              aria-label="Abrir configurações"
              title="Configurações"
            >
              <Icon name="settings" />
            </button>
          </div>
        }
      />
      <div className="assistant-page">
        <div className="assistant-messages" role="log" aria-live="polite">
          {history.length === 0 && (
            <div className="assistant-empty">Como posso ajudar hoje?</div>
          )}
          {history.map((m) => (
            <div key={m.id} className={`assistant-message-row ${m.role}`}>
              <div className={`assistant-bubble ${m.role}`}>
                {m.role === 'assistant' ? (
                  <AssistantMarkdown content={m.content} />
                ) : (
                  <div>{m.content}</div>
                )}
                {m.drafts && m.drafts.map((d) => (
                  <DraftCard
                    key={d.id}
                    draft={d}
                    onConfirm={() => void handleConfirmDraft(m.id, d)}
                    onDiscard={() => void handleDiscardDraft(m.id, d.id)}
                    onOpenSection={
                      onNavigateTab
                        ? () => onNavigateTab(
                            d.kind === 'event' ? 'assistente' : d.kind === 'expense' ? 'gastos' : d.kind === 'meal' ? 'dieta' : d.kind === 'body' ? 'corpo' : 'treino',
                          )
                        : undefined
                    }
                  />
                ))}
                {m.calendarCards?.map((c) => (
                  <CalendarEventCard key={c.id} card={c} onConfirm={() => void handleConfirmCalendarCard(m.id, c)} />
                ))}
                {m.reminderCards?.map((rc) => (
                  <PushReminderCard key={rc.id} card={rc} onCancel={() => void handleCancelReminderCard(m.id, rc)} />
                ))}
              </div>
            </div>
          ))}
          {busy && (
            <div className="assistant-message-row assistant">
              <div className="assistant-typing" aria-label="O assistente está digitando">
                <span /><span /><span />
              </div>
            </div>
          )}
          <div ref={chatBottomRef} aria-hidden="true" />
        </div>

        {(!syncStatus.user || (syncStatus.user && !online) || err) && (
          <div className="assistant-status">
            {!syncStatus.user && 'Entre em Configurações para usar o assistente.'}
            {syncStatus.user && !online && 'Offline · conecte-se para enviar mensagens.'}
            {err && <span className="assistant-error">{err}</span>}
          </div>
        )}

        <div className="assistant-composer-wrap">
          <div className="assistant-suggestions" aria-label="Sugestões">
            {suggestions.length === 0
              ? [0, 1, 2].map((index) => <span className="assistant-chip-skeleton" key={index} />)
              : suggestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="assistant-chip"
                    disabled={!canUse || busy}
                    onClick={() => void handleSend(q)}
                  >
                    {q}
                  </button>
                ))}
          </div>

          {mediaMenuOpen && (
            <div className="assistant-media-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => {
                setMediaMenuOpen(false)
                photoInputRef.current?.click()
              }}>
                <Icon name="camera" /> Tirar foto
              </button>
              <button type="button" role="menuitem" onClick={() => {
                setMediaMenuOpen(false)
                galleryInputRef.current?.click()
              }}>
                <Icon name="image" /> Escolher da galeria
              </button>
              <button type="button" role="menuitem" onClick={() => {
                setMediaMenuOpen(false)
                videoInputRef.current?.click()
              }}>
                <Icon name="video" /> Vídeo
              </button>
            </div>
          )}

          <input ref={photoInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => handlePhotoSelection(event.target.files?.[0])} />
          <input ref={galleryInputRef} type="file" accept="image/*" hidden onChange={(event) => handlePhotoSelection(event.target.files?.[0])} />
          <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={(event) => void handleVideoSelection(event.target.files?.[0])} />

          <div className="assistant-composer">
            {(selectedPhoto || selectedVideo) && (
              <div className="assistant-attachments">
                <div className="assistant-attachment">
                  <img src={selectedPhoto ? photoPreview ?? undefined : videoPreview ?? undefined} alt={selectedPhoto ? 'Foto anexada' : 'Vídeo anexado'} />
                  <button
                    type="button"
                    aria-label="Remover anexo"
                    onClick={() => {
                      setSelectedPhoto(null)
                      setPhotoPreview(null)
                      setSelectedVideo(null)
                      setVideoPreview(null)
                      setVideoFrames([])
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
            )}

            {voiceState === 'recording' ? (
              <div className="assistant-recording">
                <button type="button" aria-label="Cancelar gravação" onClick={handleCancelVoice}>
                  <Icon name="trash" />
                </button>
                <div className="assistant-wave" aria-hidden="true"><span /><span /><span /><span /><span /></div>
                <span className="assistant-record-time">{fmtRecTimer(recordSec)}</span>
                <button
                  type="button"
                  className="assistant-send-button"
                  aria-label="Enviar áudio"
                  onClick={() => void handleStopAndTranscribe(true)}
                >
                  <Icon name="send" />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="assistant-add-button"
                  aria-label="Adicionar anexo"
                  aria-expanded={mediaMenuOpen}
                  disabled={!canUse || busy}
                  onClick={() => setMediaMenuOpen((open) => !open)}
                >
                  <Icon name="plus" />
                </button>
                <textarea
                  rows={1}
                  value={input}
                  disabled={!canUse || busy || voiceState === 'transcribing'}
                  onChange={(event) => {
                    setInput(event.target.value)
                    event.target.style.height = '24px'
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`
                  }}
                  onFocus={() => scrollToChatBottom('smooth')}
                  aria-label="Mensagem para o assistente"
                  placeholder="Pergunte sobre treinos, dieta ou crie um lembrete…"
                />
                {input.trim() || selectedPhoto || selectedVideo ? (
                  <button
                    type="button"
                    className="assistant-send-button"
                    aria-label="Enviar mensagem"
                    disabled={!canUse || busy}
                    onClick={() => {
                      if (selectedPhoto) void handleSendPhoto()
                      else if (selectedVideo) void handleSendVideo()
                      else void handleSend()
                    }}
                  >
                    <Icon name="send" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="assistant-mic-button"
                    aria-label="Gravar áudio"
                    disabled={!canUse || busy}
                    onClick={() => void handleStartVoice()}
                  >
                    <Icon name="mic" />
                  </button>
                )}
              </>
            )}
          </div>
          {voiceState === 'transcribing' && (
            <div className="assistant-transcribing">Transcrevendo áudio…</div>
          )}
        </div>
      </div>
    </>
  )
}

function DraftCard({
  draft,
  onConfirm,
  onDiscard,
  onOpenSection,
}: {
  draft: AssistantDraft
  onConfirm: () => void
  onDiscard: () => void
  onOpenSection?: () => void
}) {
  const isPending = draft.status === 'pending'
  const isConfirmed = draft.status === 'confirmed'
  const sectionLabel =
    draft.kind === 'event'
      ? 'Assistente › Agenda'
      : draft.kind === 'expense'
      ? 'Hoje › Gastos'
      : draft.kind === 'meal'
      ? 'Treino › Dieta'
      : draft.kind === 'body'
        ? 'Treino › Corpo'
        : 'Treino › Rotinas'

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
          [rascunho: {draft.kind === 'event' ? 'evento' : draft.kind === 'expense' ? 'gasto' : draft.kind === 'meal' ? 'refeição' : draft.kind === 'routine' ? 'rotina' : 'peso / medidas'}]
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

      {draft.kind === 'expense' && (
        <div className="stack small">
          <div>
            data: <b>{draft.date}</b> · categoria: <b>{draft.category}</b> · valor: <b>{formatCents(draft.amountCents)}</b>
          </div>
          {draft.merchantNote && <div className="muted">nota: {draft.merchantNote}</div>}
        </div>
      )}

      {draft.kind === 'event' && (
        <div className="stack small">
          <div>evento: <b>{draft.title}</b></div>
          <div>
            início: <b>{fmtCalendarDateTime(draft.startAt).date} · {fmtCalendarDateTime(draft.startAt).time}</b>
          </div>
          {draft.endAt && (
            <div>
              fim: <b>{fmtCalendarDateTime(draft.endAt).date} · {fmtCalendarDateTime(draft.endAt).time}</b>
            </div>
          )}
          {draft.location && <div className="muted">local: {draft.location}</div>}
          {draft.description && <div className="muted">{draft.description}</div>}
        </div>
      )}

      {isPending && (
        <div className="grid2">
          <button className="primary small" onClick={onConfirm} style={{ minHeight: 44 }}>
            {draft.kind === 'event' ? 'confirmar e criar evento' : 'confirmar e salvar'}
          </button>
          <button className="small" onClick={onDiscard} style={{ minHeight: 44 }}>
            descartar
          </button>
        </div>
      )}
      {isConfirmed && onOpenSection && (
        <button className="small" onClick={onOpenSection}>
          abrir em {sectionLabel}
        </button>
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
