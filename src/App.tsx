import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { autoSnapshotIfDue } from './data/backup'
import { db, setSetting } from './data/db'
import { ensureSeed } from './data/seed'
import { initSyncManager } from './data/sync'
import { useSetting, useSyncStatus } from './hooks'
import {
  DEFAULT_LOCK_TIMEOUT_MINUTES,
  getLockConfig,
  getPersistedHiddenAt,
  recordHiddenTimestamp,
  setLockedState,
  shouldLockAfterBackground,
  shouldLockOnColdStart,
} from './lib/lock'
import Treino from './tabs/Treino'
import Dieta from './tabs/Dieta'
import Corpo from './tabs/Corpo'
import Assistente from './tabs/Assistente'
import Config from './tabs/Config'
import Icon from './components/Icons'
import FirstLoginPrompt from './components/FirstLoginPrompt'
import { BootOverlay, LockScreen, PromptTitle } from './components/TerminalChrome'

type Tab = 'treino' | 'dieta' | 'corpo' | 'assistente' | 'config'
const TABS: Tab[] = ['treino', 'dieta', 'corpo', 'assistente', 'config']
const WEEK = 7 * 24 * 3600 * 1000
const BOOT_MAX_MS = 520

function syncViewportHeightVar() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const h = window.visualViewport?.height ? Math.max(window.innerHeight, Math.round(window.visualViewport.height)) : window.innerHeight
  if (h > 0) {
    document.documentElement.style.setProperty('--vh', `${h}px`)
  }
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('treino')
  const [bootVisible, setBootVisible] = useState(true)
  const [bootLines, setBootLines] = useState<string[]>(['> loading db...'])
  // Na abertura a frio, a tranca começa ATIVA por padrão até confirmar getLockConfig()
  const [locked, setLocked] = useState<boolean>(true)
  const [hasUnlockedThisSession, setHasUnlockedThisSession] = useState<boolean>(false)

  const onboarded = useSetting<boolean>('onboardingDone', false)
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const firstUse = useSetting<number | null>('firstUseAt', null)
  const syncStatus = useSyncStatus()
  const lockConfig = useLiveQuery(() => getLockConfig(), [], {
    enabled: false,
    credentialId: null,
    pinHash: null,
    pinSalt: null,
    timeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES,
    lastUnlockedAt: null,
    hiddenAt: null,
  })

  // Recalcula --vh na abertura e ao voltar ao primeiro plano / redimensionar (iOS standalone)
  useEffect(() => {
    syncViewportHeightVar()
    const onViewportChange = () => {
      syncViewportHeightVar()
    }
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('orientationchange', onViewportChange)
    window.addEventListener('pageshow', onViewportChange)
    window.visualViewport?.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('orientationchange', onViewportChange)
      window.removeEventListener('pageshow', onViewportChange)
      window.visualViewport?.removeEventListener('resize', onViewportChange)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setBootVisible(false), BOOT_MAX_MS)
    ;(async () => {
      try {
        await db.open()
        const cfg = await getLockConfig()
        const coldLocked = shouldLockOnColdStart(cfg.enabled)
        setLocked(coldLocked)
        setLockedState(coldLocked)
        if (coldLocked) {
          setBootVisible(false) // Renderiza a tela de bloqueio imediatamente
        } else {
          setHasUnlockedThisSession(true)
        }
        await ensureSeed()
        setBootLines(['> loading db... ok', '> storage.persist...'])
        const persisted = navigator.storage?.persist ? await navigator.storage.persist() : false
        await autoSnapshotIfDue()
        initSyncManager()
        const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true
        setBootLines([
          '> loading db... ok',
          `> storage.persist... ${persisted ? 'ok' : 'local'}`,
          `> sync... ${online ? 'ok' : 'offline'}`,
        ])
        setReady(true)
      } catch (e) {
        setBootVisible(false)
        setError(String((e as Error)?.message ?? e))
      }
    })()
    return () => window.clearTimeout(timer)
  }, [])

  // Persiste instante de segundo plano e bloqueia ao retornar (visibilitychange, pagehide, pageshow)
  useEffect(() => {
    const onHidden = () => {
      void recordHiddenTimestamp(Date.now())
    }

    const onVisible = async () => {
      syncViewportHeightVar()
      const cfg = await getLockConfig()
      if (!cfg.enabled) return
      const hiddenAt = (await getPersistedHiddenAt()) ?? cfg.hiddenAt
      if (shouldLockAfterBackground(hiddenAt, Date.now(), cfg.timeoutMinutes)) {
        setLocked(true)
        setLockedState(true)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        onHidden()
      } else if (document.visibilityState === 'visible') {
        void onVisible()
      }
    }

    const onPageShow = () => {
      void onVisible()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onHidden)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onHidden)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  const handleUnlocked = () => {
    setLocked(false)
    setLockedState(false)
    setHasUnlockedThisSession(true)
  }

  if (error)
    return (
      <div className="scroll">
        <PromptTitle path="~/erro" />
        <p className="red">error: {error}</p>
        <p className="muted">Se estiver em modo privado do Safari, abra o app instalado na Tela de Início.</p>
      </div>
    )

  if (!ready || onboarded === undefined) {
    if (locked && lockConfig.enabled) {
      return <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
    }
    return bootVisible ? <BootOverlay lines={bootLines} onSkip={() => setBootVisible(false)} /> : null
  }

  // Na abertura a frio com tranca ativa, renderiza APENAS a tela de bloqueio antes de qualquer conteúdo
  if (locked && lockConfig.enabled && !hasUnlockedThisSession) {
    return (
      <div className="app">
        <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
      </div>
    )
  }

  if (!onboarded)
    return (
      <div className="scroll">
        <PromptTitle path="~/antes-de-comecar" />
        <div className="card stack">
          <div><b>Instale o app na Tela de Início ANTES de registrar dados.</b> No iPhone, os dados do Safari e do app instalado são separados.</div>
          <div className="muted small"># Safari: compartilhar → "Adicionar à Tela de Início". Depois abra sempre pelo ícone. Faça backups com frequência em ~/config.</div>
        </div>
        <button className="primary block" onClick={() => setSetting('onboardingDone', true)}>$ entendi</button>
      </div>
    )

  const ref = lastBackup ?? firstUse ?? Date.now()
  const stale = Date.now() - ref > WEEK
  const days = Math.floor((Date.now() - ref) / 86400000)
  const isCurrentlyLocked = Boolean(locked && lockConfig.enabled)

  return (
    <div className="app">
      {bootVisible && !isCurrentlyLocked && <BootOverlay lines={bootLines} onSkip={() => setBootVisible(false)} />}
      {isCurrentlyLocked && (
        <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
      )}
      <div
        className="scroll"
        style={isCurrentlyLocked ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
        aria-hidden={isCurrentlyLocked}
      >
        {stale && (
          <div className="banner" onClick={() => setTab('config')}>
            {lastBackup ? `warn: último backup há ${days} dias.` : 'warn: nenhum backup feito ainda.'} toque para fazer agora.
          </div>
        )}
        {tab === 'treino' && <Treino />}
        {tab === 'dieta' && <Dieta />}
        {tab === 'corpo' && <Corpo />}
        {tab === 'assistente' && <Assistente />}
        {tab === 'config' && <Config />}
      </div>
      <nav
        className="tabbar"
        style={isCurrentlyLocked ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
        aria-hidden={isCurrentlyLocked}
      >
        {TABS.map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-label={k}>
            <Icon name={k} />
            {k}
          </button>
        ))}
      </nav>
      {syncStatus.firstLoginPreview && !isCurrentlyLocked && (
        <FirstLoginPrompt preview={syncStatus.firstLoginPreview} syncing={syncStatus.syncing} />
      )}
    </div>
  )
}
