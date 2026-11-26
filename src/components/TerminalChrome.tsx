import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DB_VERSION, db } from '../data/db'
import { useSyncStatus } from '../hooks'
import Icon from './Icons'
import {
  authenticateBiometricCredential,
  computePinBackoffMs,
  getLockConfig,
  getLockedState,
  recordUnlockTimestamp,
  subscribeLockedState,
  verifyPin,
  type LockConfig,
} from '../lib/lock'

export interface ChromeNavContextValue {
  isConfigActive: boolean
  hasConfigAlert?: boolean
  onToggleConfig?: () => void
}

export const ChromeNavContext = createContext<ChromeNavContextValue>({
  isConfigActive: false,
})

export const APP_VERSION = `1.0.${DB_VERSION}`

function fmtClock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Barra de status estilo statusline do tmux/vim no topo do painel, com dados reais do app. */
export function Statusline() {
  const syncStatus = useSyncStatus()
  const pending = useLiveQuery(() => db.outbox.count(), [], 0)
  const lockConfig = useLiveQuery(() => getLockConfig(), [])
  const [locked, setLocked] = useState(() => getLockedState())
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true))
  const [clock, setClock] = useState(() => fmtClock())

  useEffect(() => {
    const unsubLock = subscribeLockedState(setLocked)
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const timer = window.setInterval(() => setClock(fmtClock()), 15_000)
    return () => {
      unsubLock()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.clearInterval(timer)
    }
  }, [])

  let syncIndicator: { dot: string; label: string; cls: string }
  if (!online) {
    syncIndicator = { dot: '○', label: 'offline', cls: 'muted' }
  } else if (!syncStatus.user) {
    syncIndicator = pending > 0 ? { dot: '○', label: `pending (${pending})`, cls: 'amber' } : { dot: '○', label: 'local', cls: 'muted' }
  } else if (syncStatus.syncing || pending > 0) {
    syncIndicator = { dot: '○', label: pending > 0 ? `pending (${pending})` : 'pending', cls: 'amber' }
  } else {
    syncIndicator = { dot: '●', label: 'synced', cls: 'green' }
  }

  const isLockedNow = Boolean(lockConfig?.enabled && locked)
  const lockIndicator = isLockedNow
    ? { dot: '●', label: 'locked', cls: 'amber' }
    : { dot: '○', label: 'unlocked', cls: lockConfig?.enabled ? 'green' : 'muted' }

  return (
    <div className="statusline" role="status" aria-label="Status do sistema">
      <div className="statusline-seg">
        <span className="branch">main</span>
        <span className="sep">│</span>
        <span className="muted">v{APP_VERSION}</span>
      </div>
      <div className="statusline-seg">
        <span className={`sync-pill ${lockIndicator.cls}`} aria-label="Estado da tranca">
          <span className="status-dot" aria-hidden="true">{lockIndicator.dot}</span> {lockIndicator.label}
        </span>
        <span className={`sync-pill ${syncIndicator.cls}`}>
          <span className="status-dot" aria-hidden="true">{syncIndicator.dot}</span> {syncIndicator.label}
        </span>
        <span className="sep">│</span>
        <span>{clock}</span>
      </div>
    </div>
  )
}

/** Título em formato de prompt de comando (ex.: "~/treino $") com gatilho implícito de Configurações no topo. */
export function PromptTitle({
  path,
  rightSlot,
}: {
  path: string
  rightSlot?: ReactNode
}) {
  const { isConfigActive, hasConfigAlert, onToggleConfig } = useContext(ChromeNavContext)

  return (
    <div className="prompt-header-bar">
      <h1 className="prompt-title">
        <span>{path}</span> <span className="prompt-dollar">$</span>
        <span className="prompt-cursor" aria-hidden="true" />
      </h1>
      <div className="prompt-header-actions">
        {rightSlot}
        {onToggleConfig && (
          <button
            type="button"
            className={`implicit-config-btn${isConfigActive ? ' on' : ''}`}
            onClick={onToggleConfig}
            aria-label={isConfigActive ? 'Voltar da tela de configurações' : 'Configurações (~/config)'}
            title={isConfigActive ? 'Voltar' : 'Configurações (~/config)'}
          >
            <Icon name="config" />
            {hasConfigAlert && !isConfigActive && (
              <span className="implicit-config-dot" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Tela de bloqueio com cara de terminal:
 * "$ auth --biometric", botão "$ desbloquear" (chamada WebAuthn por toque do usuário)
 * e reserva por PIN de 4 a 6 dígitos com atraso crescente após tentativas incorretas.
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
        <div className="muted small"># session locked · ● locked</div>
        <div className="lock-cmd">$ auth --biometric</div>
        {error && <div className="lock-err">{error}</div>}
        <button className="primary block" disabled={busy} onClick={() => void handleBiometric()}>
          {busy ? 'verificando…' : 'desbloquear'}
        </button>

        {!showPin && config.pinHash && (
          <button className="ghost small block" onClick={() => setShowPin(true)}>
            usar PIN de reserva
          </button>
        )}

        {showPin && config.pinHash && (
          <div className="stack" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <label className="f">
              pin de reserva (4–6 dígitos)
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
              {waitSec > 0 ? `aguarde ${waitSec}s…` : 'autenticar com PIN'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Sequência de boot leve (máx. 600ms, pulável com um toque) apenas na abertura a frio,
 * exibindo etapas reais do carregamento sem atrasar a abertura.
 */
export function BootOverlay({ lines, onSkip }: { lines: string[]; onSkip: () => void }) {
  return (
    <div className="boot-overlay" onClick={onSkip} role="status" aria-label="Inicializando">
      <div className="boot-box">
        <div className="muted small"># boot sequence (toque para pular)</div>
        {lines.map((l, i) => (
          <div key={i} className="boot-line">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}
