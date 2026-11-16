import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { DB_VERSION, db } from '../data/db'
import { useSyncStatus } from '../hooks'
import { authenticateBiometricCredential, computePinBackoffMs, verifyPin, type LockConfig } from '../lib/lock'

export const APP_VERSION = `1.0.${DB_VERSION}`

function fmtClock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Barra de status estilo statusline do tmux/vim no topo do painel, com dados reais do app. */
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

  return (
    <div className="statusline" role="status" aria-label="Status do sistema">
      <div className="statusline-seg">
        <span className="branch">main</span>
        <span className="sep">│</span>
        <span className="muted">v{APP_VERSION}</span>
      </div>
      <div className="statusline-seg">
        <span className={`sync-pill ${syncIndicator.cls}`}>
          <span className="status-dot" aria-hidden="true">{syncIndicator.dot}</span> {syncIndicator.label}
        </span>
        <span className="sep">│</span>
        <span>{clock}</span>
      </div>
    </div>
  )
}

/** Título em formato de prompt de comando (ex.: "~/treino $") com cursor piscando. */
export function PromptTitle({ path }: { path: string }) {
  return (
    <h1 className="prompt-title">
      <span>{path}</span> <span className="prompt-dollar">$</span>
      <span className="prompt-cursor" aria-hidden="true" />
    </h1>
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

  const handleBiometric = async () => {
    if (!config.credentialId) {
      setShowPin(true)
      setError('credencial biométrica ausente; use o PIN.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await authenticateBiometricCredential(config.credentialId)
      if (ok) {
        onUnlocked()
      } else {
        setShowPin(true)
        setError('verificação falhou; tente novamente ou use o PIN.')
      }
    } catch {
      setShowPin(true)
      setError('biometria cancelada ou indisponível; use o PIN.')
    } finally {
      setBusy(false)
    }
  }

  const handlePin = async () => {
    if (waitSec > 0) return
    if (!config.pinSalt || !config.pinHash) {
      setError('PIN de reserva não configurado.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await verifyPin(pin.trim(), config.pinSalt, config.pinHash)
      if (ok) {
        setPin('')
        setFailedAttempts(0)
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
          setError(`PIN incorreto (${nextFails}x). aguarde ${Math.ceil(delayMs / 1000)}s.`)
        } else {
          setError('PIN incorreto.')
        }
      }
    } catch {
      setError('PIN deve ter de 4 a 6 dígitos.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen" role="dialog" aria-label="Tela de bloqueio">
      <div className="lock-panel stack">
        <div className="muted small"># session locked</div>
        <div className="lock-cmd">$ auth --biometric</div>
        {error && <div className="lock-err">error: {error}</div>}
        <button className="primary block" disabled={busy} onClick={() => void handleBiometric()}>
          {busy ? 'verificando…' : '$ desbloquear'}
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
              {waitSec > 0 ? `aguarde ${waitSec}s…` : '$ autenticar com PIN'}
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
