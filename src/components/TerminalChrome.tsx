import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DB_VERSION, db } from '../data/db'
import { useSyncStatus } from '../hooks'
import {
  authenticateBiometricCredential,
  computePinBackoffMs,
  recordUnlockTimestamp,
  verifyPin,
  type LockConfig,
} from '../lib/lock'

export type FitnessSection = 'treino' | 'dieta' | 'corpo'

export interface ChromeNavContextValue {
  isConfigActive: boolean
  hasConfigAlert?: boolean
  onToggleConfig?: () => void
  fitnessSection?: FitnessSection
  onSelectFitnessSection?: (section: FitnessSection) => void
  onNavigateTab?: (tab: 'treino' | 'dieta' | 'corpo' | 'assistente' | 'noticias' | 'onibus' | 'config') => void
}

export const ChromeNavContext = createContext<ChromeNavContextValue>({
  isConfigActive: false,
})

export const APP_VERSION = `1.0.${DB_VERSION}`

const PATH_TITLES: Record<string, string> = {
  '~/treino': 'Treino',
  '~/dieta': 'Dieta',
  '~/corpo': 'Corpo',
  '~/assistente': 'Assistente',
  '~/noticias': 'Notícias',
  '~/onibus': 'Transporte',
  '~/config': 'Configurações',
  '~/inicio': 'Início',
  '~/erro': 'Erro',
}

function fmtClock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Gera uma saudação curta, seca e confiante em português de acordo com a faixa de horário.
 */
export function getContextualGreeting(now = new Date(), rawName?: string | null): {
  phrase: string
  meta: string
} {
  const firstName = (rawName ?? '').trim().split(/\s+/)[0] || 'Atleta'
  const h = now.getHours()
  const dayNames = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
  const weekday = dayNames[now.getDay()] ?? ''
  const clock = fmtClock(now)

  // Seleciona de forma determinística pelo dia do mês para variar com sobriedade
  const seed = now.getDate() + h

  let pool: string[]
  if (h >= 0 && h < 5) {
    pool = [
      `Acordado até tarde, ${firstName}?`,
      `Madrugada silenciosa, ${firstName}.`,
      `A cidade dorme, ${firstName}.`,
    ]
  } else if (h >= 5 && h < 9) {
    pool = [
      `Cedo no posto, ${firstName}.`,
      `Bom dia, ${firstName}. Foco no essencial.`,
      `Manhã limpa, ${firstName}.`,
    ]
  } else if (h >= 9 && h < 12) {
    pool = [
      `Bom dia, ${firstName}. Constância.`,
      `Manhã em curso, ${firstName}.`,
      `Bom dia, ${firstName}.`,
    ]
  } else if (h >= 12 && h < 18) {
    pool = [
      `Boa tarde, ${firstName}. Sem desvios.`,
      `Tarde em andamento, ${firstName}.`,
      `Disciplina silenciosa, ${firstName}.`,
    ]
  } else if (h >= 18 && h < 22) {
    pool = [
      `Boa noite, ${firstName}.`,
      `Noite calma, ${firstName}.`,
      `Boa noite, ${firstName}. Feche o dia.`,
    ]
  } else {
    pool = [
      `Noite avançada, ${firstName}.`,
      `Fim de noite, ${firstName}.`,
      `Acordado até tarde, ${firstName}?`,
    ]
  }

  return {
    phrase: pool[seed % pool.length],
    meta: `${clock} · ${weekday}`,
  }
}

/** Barra de status discreta no topo do painel. */
export function Statusline() {
  const syncStatus = useSyncStatus()
  const pending = useLiveQuery(() => db.outbox.count(), [], 0)
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true))
  const [clock, setClock] = useState(() => fmtClock())

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const timer = window.setInterval(() => setClock(fmtClock()), 15_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.clearInterval(timer)
    }
  }, [])

  let syncLabel: string
  let syncCls = 'muted'
  if (!online) {
    syncLabel = 'offline'
  } else if (!syncStatus.user) {
    syncLabel = pending > 0 ? `${pending} pendente(s)` : 'local'
  } else if (syncStatus.syncing || pending > 0) {
    syncLabel = pending > 0 ? `sincronizando (${pending})` : 'sincronizando'
    syncCls = 'amber'
  } else {
    syncLabel = 'sincronizado'
    syncCls = 'green'
  }

  return (
    <div className="statusline" role="status" aria-label="Status do sistema">
      <div className="statusline-seg">
        <span className={`sync-pill ${syncCls}`}>{syncLabel}</span>
      </div>
      <div className="statusline-seg">
        <span className="muted" style={{ fontFamily: 'var(--mono)' }}>{clock}</span>
      </div>
    </div>
  )
}

const FITNESS_SECTIONS: Array<{ key: FitnessSection; label: string }> = [
  { key: 'treino', label: 'Treino' },
  { key: 'dieta', label: 'Dieta' },
  { key: 'corpo', label: 'Corpo' },
]

/**
 * Cabeçalho editorial da página: título direto em serifa (`Newsreader`)
 * e, na aba unificada, o seletor segmentado `Treino | Dieta | Corpo`.
 * `path` é só um identificador interno (define o título); não é exibido.
 */
export function PromptTitle({
  path,
  title,
  rightSlot,
}: {
  path: string
  title?: string
  rightSlot?: ReactNode
}) {
  const { fitnessSection, onSelectFitnessSection } = useContext(ChromeNavContext)
  const resolvedTitle = title ?? PATH_TITLES[path] ?? path.replace(/^~\//, '')
  const isFitnessGroup =
    (path === '~/treino' || path === '~/dieta' || path === '~/corpo') &&
    Boolean(onSelectFitnessSection)
  const activeSection: FitnessSection =
    fitnessSection ?? (path === '~/dieta' ? 'dieta' : path === '~/corpo' ? 'corpo' : 'treino')

  return (
    <header className="prompt-header-bar">
      <div className="prompt-header-top">
        <div className="prompt-heading-group">
          <h1 className="prompt-title">{resolvedTitle}</h1>
        </div>
        {rightSlot ? <div className="prompt-header-actions">{rightSlot}</div> : null}
      </div>
      {isFitnessGroup && onSelectFitnessSection && (
        <div className="fitness-seg" role="tablist" aria-label="Seção de Treino, Dieta e Corpo">
          {FITNESS_SECTIONS.map((sec) => {
            const on = activeSection === sec.key
            return (
              <button
                key={sec.key}
                type="button"
                role="tab"
                aria-selected={on}
                className={on ? 'on' : ''}
                onClick={() => onSelectFitnessSection(sec.key)}
              >
                {sec.label}
              </button>
            )
          })}
        </div>
      )}
    </header>
  )
}

/**
 * Tela de bloqueio sóbria e contida:
 * WebAuthn / Face ID por toque do usuário e reserva por PIN de 4 a 6 dígitos.
 */
export function LockScreen({
  config,
  onUnlocked,
}: {
  config: LockConfig
  onUnlocked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPin, setShowPin] = useState(false)
  const [pin, setPin] = useState('')
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [cooldownUntil])

  const waitSec = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  const fmtErr = (msg: string) => (msg.startsWith('error:') ? msg : `error: ${msg}`)

  const handleBiometric = async () => {
    if (!config.credentialId) {
      setShowPin(true)
      setError('error: credencial biométrica ausente; use o PIN.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await authenticateBiometricCredential(config.credentialId)
      if (ok) {
        await recordUnlockTimestamp()
        onUnlocked()
      } else {
        setShowPin(true)
        setError('error: verificação falhou; tente novamente ou use o PIN.')
      }
    } catch (e) {
      setShowPin(true)
      const msg = (e as Error)?.message || 'biometria cancelada ou indisponível; use o PIN.'
      setError(fmtErr(msg))
    } finally {
      setBusy(false)
    }
  }

  const handlePin = async () => {
    if (waitSec > 0) return
    if (!config.pinSalt || !config.pinHash) {
      setError('error: PIN de reserva não configurado.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await verifyPin(pin.trim(), config.pinSalt, config.pinHash)
      if (ok) {
        setPin('')
        setFailedAttempts(0)
        await recordUnlockTimestamp()
        onUnlocked()
      } else {
        const nextFails = failedAttempts + 1
        setFailedAttempts(nextFails)
        setPin('')
        const delayMs = computePinBackoffMs(nextFails)
        if (delayMs > 0) {
          const until = Date.now() + delayMs
          setCooldownUntil(until)
          setNow(Date.now())
          setError(`error: PIN incorreto (${nextFails}x). aguarde ${Math.ceil(delayMs / 1000)}s.`)
        } else {
          setError('error: PIN incorreto.')
        }
      }
    } catch {
      setError('error: PIN deve ter de 4 a 6 dígitos.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen" role="dialog" aria-label="Tela de bloqueio">
      <div className="lock-panel stack">
        <div className="lock-cmd">Sessão bloqueada</div>
        {error && <div className="lock-err">{error}</div>}
        <button className="primary block" disabled={busy} onClick={() => void handleBiometric()}>
          {busy ? 'Verificando…' : 'Desbloquear'}
        </button>

        {!showPin && config.pinHash && (
          <button className="ghost small block" onClick={() => setShowPin(true)}>
            Usar PIN de reserva
          </button>
        )}

        {showPin && config.pinHash && (
          <div className="stack" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <label className="f">
              PIN de reserva (4–6 dígitos)
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••"
                value={pin}
                disabled={busy || waitSec > 0}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button
              className="block"
              disabled={busy || waitSec > 0 || pin.length < 4}
              onClick={() => void handlePin()}
            >
              {waitSec > 0 ? `Aguarde ${waitSec}s…` : 'Confirmar PIN'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Tela de abertura (Splash de Saudação Contextual em Newsreader):
 * Fundo escuro #0B0D11, frase curta e seca por horário com o nome do usuário,
 * fade-in → pausa → fade-out (~2.4s no total, ou corte seco com prefers-reduced-motion),
 * pulável imediatamente com um toque enquanto o app carrega por baixo.
 */
export function BootOverlay({
  userName,
  fadingOut,
  onSkip,
}: {
  lines?: string[]
  userName?: string | null
  fadingOut?: boolean
  onSkip: () => void
}) {
  const [openedAt] = useState(() => new Date())
  const { phrase, meta } = getContextualGreeting(openedAt, userName)

  return (
    <div
      className={`splash-overlay${fadingOut ? ' fading-out' : ''}`}
      onClick={onSkip}
      role="status"
      aria-label="Saudação inicial"
    >
      <div className="splash-inner">
        <p className="splash-greeting">{phrase}</p>
        <div className="splash-meta">{meta}</div>
      </div>
    </div>
  )
}
