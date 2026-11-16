import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { autoSnapshotIfDue } from './data/backup'
import { db, setSetting } from './data/db'
import { ensureSeed } from './data/seed'
import { initSyncManager } from './data/sync'
import { useSetting, useSyncStatus } from './hooks'
import { DEFAULT_LOCK_TIMEOUT_MINUTES, getLockConfig, shouldLockAfterBackground } from './lib/lock'
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

export default function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('treino')
  const [bootVisible, setBootVisible] = useState(true)
  const [bootLines, setBootLines] = useState<string[]>(['> loading db...'])
  const [locked, setLocked] = useState(false)
  const hiddenAtRef = useRef<number | null>(null)

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
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setBootVisible(false), BOOT_MAX_MS)
    ;(async () => {
      try {
        await db.open()
        await ensureSeed()
        const cfg = await getLockConfig()
        if (cfg.enabled) {
          setLocked(true)
          setBootVisible(false) // Nunca bloqueia a tela de bloqueio
        }
        setBootLines(['> loading db... ok', '> storage.persist...'])
        // pede ao navegador para não apagar os dados por falta de espaço
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

  // Bloqueia ao voltar ao primeiro plano após N minutos em segundo plano
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now()
      } else if (document.visibilityState === 'visible') {
        if (lockConfig.enabled && shouldLockAfterBackground(hiddenAtRef.current, Date.now(), lockConfig.timeoutMinutes)) {
          setLocked(true)
        }
        hiddenAtRef.current = null
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [lockConfig.enabled, lockConfig.timeoutMinutes])

  if (error)
    return (
      <div className="scroll">
        <PromptTitle path="~/erro" />
        <p className="red">error: {error}</p>
        <p className="muted">Se estiver em modo privado do Safari, abra o app instalado na Tela de Início.</p>
      </div>
    )
  if (!ready || onboarded === undefined) {
    return bootVisible ? <BootOverlay lines={bootLines} onSkip={() => setBootVisible(false)} /> : null
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

  return (
    <div className="app">
      {bootVisible && !locked && <BootOverlay lines={bootLines} onSkip={() => setBootVisible(false)} />}
      {locked && lockConfig.enabled && (
        <LockScreen config={lockConfig} onUnlocked={() => setLocked(false)} />
      )}
      <div className="scroll">
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
      <nav className="tabbar">
        {TABS.map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-label={k}>
            <Icon name={k} />
            {k}
          </button>
        ))}
      </nav>
      {syncStatus.firstLoginPreview && (
        <FirstLoginPrompt preview={syncStatus.firstLoginPreview} syncing={syncStatus.syncing} />
      )}
    </div>
  )
}
