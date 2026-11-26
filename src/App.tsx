import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
import Noticias from './tabs/Noticias'
import Config from './tabs/Config'
import Icon from './components/Icons'
import FirstLoginPrompt from './components/FirstLoginPrompt'
import { BootOverlay, LockScreen, PromptTitle } from './components/TerminalChrome'
import { useUi } from './components/ui'
import {
  countUnreadNoticias,
  fetchIfesNoticiasOnce,
  initForegroundPushListener,
  recordLastNotificationReceived,
  subscribeIfesNoticias,
  type IfesNoticia,
} from './lib/notifications'

type Tab = 'treino' | 'dieta' | 'corpo' | 'assistente' | 'noticias' | 'config'
const TABS: Tab[] = ['treino', 'dieta', 'corpo', 'assistente', 'noticias', 'config']
const TAB_LABELS: Record<Tab, string> = {
  treino: 'Treino (~/treino)',
  dieta: 'Dieta (~/dieta)',
  corpo: 'Corpo (~/corpo)',
  assistente: 'Assistente IA (~/assistente)',
  noticias: 'Notícias do Ifes (~/noticias)',
  config: 'Configurações (~/config)',
}
const WEEK = 7 * 24 * 3600 * 1000
const BOOT_MAX_MS = 520

export default function App() {
  const { toast } = useUi()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('tab')
      if (param && (TABS as string[]).includes(param)) {
        return param as Tab
      }
    }
    return 'treino'
  })
  const [bootVisible, setBootVisible] = useState(true)
  const [bootLines, setBootLines] = useState<string[]>(['> loading db...'])
  // Na abertura a frio, a tranca começa ATIVA por padrão até confirmar getLockConfig()
  const [locked, setLocked] = useState<boolean>(true)
  const [hasUnlockedThisSession, setHasUnlockedThisSession] = useState<boolean>(false)
  const [tabPressing, setTabPressing] = useState<boolean>(false)
  const navRef = useRef<HTMLElement | null>(null)
  const pointerDownRef = useRef<boolean>(false)

  // Estado compartilhado de notícias do Ifes para badge de não lidas + aba ~/noticias
  const [noticiasItems, setNoticiasItems] = useState<IfesNoticia[]>([])
  const [noticiasLoading, setNoticiasLoading] = useState<boolean>(false)
  const [noticiasError, setNoticiasError] = useState<string | null>(null)

  const onboarded = useSetting<boolean>('onboardingDone', false)
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const firstUse = useSetting<number | null>('firstUseAt', null)
  const ifesReadIdsRaw = useSetting<string[]>('ifesReadIds', [])
  const ifesReadIds = Array.isArray(ifesReadIdsRaw) ? ifesReadIdsRaw : []
  const unreadNoticiasCount = countUnreadNoticias(noticiasItems, ifesReadIds)
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

  // Assinatura em tempo real da coleção ifesNoticias para o badge e para a aba ~/noticias
  useEffect(() => {
    if (!ready || !syncStatus.user) {
      setNoticiasItems([])
      setNoticiasLoading(false)
      setNoticiasError(null)
      return
    }
    setNoticiasLoading(true)
    setNoticiasError(null)
    const unsub = subscribeIfesNoticias(
      (list) => {
        setNoticiasItems(list)
        setNoticiasLoading(false)
        setNoticiasError(null)
      },
      (err) => {
        setNoticiasLoading(false)
        setNoticiasError(err.message || 'Falha ao carregar notícias.')
      },
      50,
    )
    return () => unsub()
  }, [ready, syncStatus.user?.uid])

  // Listener de mensagens do Service Worker (clique na notificação ou push recebido) e FCM em primeiro plano
  useEffect(() => {
    if (!ready || typeof window === 'undefined') return

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'IFES_OPEN_TAB') {
        const targetTab = typeof data.tab === 'string' && (TABS as string[]).includes(data.tab) ? (data.tab as Tab) : 'noticias'
        setTab(targetTab)
      } else if (data.type === 'IFES_PUSH_RECEIVED') {
        const ts = typeof data.receivedAt === 'number' ? data.receivedAt : Date.now()
        void recordLastNotificationReceived(ts)
        const title = typeof data.title === 'string' ? data.title : 'Nova notícia do Ifes'
        toast(`[ifes] ${title}`, { label: 'abrir', run: () => setTab('noticias') })
      }
    }

    navigator.serviceWorker?.addEventListener?.('message', onSwMessage)
    const unsubFg = initForegroundPushListener(({ title }) => {
      toast(`[ifes] ${title}`, { label: 'abrir', run: () => setTab('noticias') })
    })

    return () => {
      navigator.serviceWorker?.removeEventListener?.('message', onSwMessage)
      unsubFg()
    }
  }, [ready, toast])

  const refreshNoticiasManual = async () => {
    const fresh = await fetchIfesNoticiasOnce(50)
    setNoticiasItems(fresh)
    setNoticiasError(null)
  }

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
  const activeTabIndex = Math.max(0, TABS.indexOf(tab))

  const pickTabFromClientX = (clientX: number) => {
    const navEl = navRef.current
    if (!navEl) return
    const rect = navEl.getBoundingClientRect()
    const innerLeft = rect.left + 5
    const innerWidth = Math.max(1, rect.width - 10)
    const rel = Math.min(0.9999, Math.max(0, (clientX - innerLeft) / innerWidth))
    const idx = Math.floor(rel * TABS.length)
    const nextTab = TABS[idx]
    if (nextTab && nextTab !== tab) {
      setTab(nextTab)
    }
  }

  return (
    <div className="app">
      {bootVisible && !isCurrentlyLocked && <BootOverlay lines={bootLines} onSkip={() => setBootVisible(false)} />}
      {isCurrentlyLocked && (
        <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
      )}
      <main
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
        {tab === 'noticias' && (
          <Noticias
            items={noticiasItems}
            loading={noticiasLoading}
            error={noticiasError}
            onManualRefresh={refreshNoticiasManual}
          />
        )}
        {tab === 'config' && <Config />}
      </main>
      <nav
        ref={navRef}
        className={`tabbar${tabPressing ? ' pressing' : ''}`}
        style={
          {
            '--active-idx': activeTabIndex,
            '--tab-count': TABS.length,
            ...(isCurrentlyLocked ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
          } as CSSProperties
        }
        aria-label="Navegação principal"
        aria-hidden={isCurrentlyLocked}
        onPointerDown={() => {
          pointerDownRef.current = true
          setTabPressing(true)
        }}
        onPointerMove={(e) => {
          if (!pointerDownRef.current) return
          pickTabFromClientX(e.clientX)
        }}
        onPointerUp={() => {
          pointerDownRef.current = false
          setTabPressing(false)
        }}
        onPointerCancel={() => {
          pointerDownRef.current = false
          setTabPressing(false)
        }}
        onPointerLeave={() => {
          pointerDownRef.current = false
          setTabPressing(false)
        }}
      >
        <span className="tabbar-lens" aria-hidden="true" />
        {TABS.map((k) => {
          const isActive = tab === k
          const label = TAB_LABELS[k]
          return (
            <button
              key={k}
              type="button"
              className={isActive ? 'on' : ''}
              onClick={() => setTab(k)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              title={label}
            >
              <span className="tabbar-icon-wrap">
                <Icon name={k} />
                {k === 'noticias' && unreadNoticiasCount > 0 && (
                  <span className="tab-badge" aria-label={`${unreadNoticiasCount} não lidas`}>
                    {unreadNoticiasCount > 99 ? '99+' : unreadNoticiasCount}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </nav>
      {syncStatus.firstLoginPreview && !isCurrentlyLocked && (
        <FirstLoginPrompt preview={syncStatus.firstLoginPreview} syncing={syncStatus.syncing} />
      )}
    </div>
  )
}
