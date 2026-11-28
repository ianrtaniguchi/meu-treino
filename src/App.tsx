import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { OWNER_UID } from './assistantConfig'
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
import Onibus from './tabs/Onibus'
import Config from './tabs/Config'
import Icon from './components/Icons'
import FirstLoginPrompt from './components/FirstLoginPrompt'
import {
  BootOverlay,
  ChromeNavContext,
  LockScreen,
  PromptTitle,
  recordSplashShown,
  shouldShowSplashOnColdStart,
} from './components/TerminalChrome'
import { useUi } from './components/ui'
import {
  countUnreadNoticias,
  fetchIfesNoticiasOnce,
  initForegroundPushListener,
  recordLastNotificationReceived,
  subscribeIfesNoticias,
  type IfesNoticia,
} from './lib/notifications'

type Tab = 'treino' | 'dieta' | 'corpo' | 'assistente' | 'noticias' | 'onibus' | 'config'
const ALL_TABS: Tab[] = ['treino', 'dieta', 'corpo', 'assistente', 'noticias', 'onibus', 'config']
/**
 * Barra inferior Liquid Glass com o Agente de IA (`assistente`) posicionado exatamente
 * no centro geométrico (50%) da cápsula:
 * - Asa esquerda (42%): treino, dieta, corpo
 * - Centro (16%, de 42% a 58%): assistente (IA)
 * - Asa direita (42%): noticias, onibus
 * - Configurações (`config`) movida para o gatilho implícito no topo.
 */
const NAV_TABS: Tab[] = ['treino', 'dieta', 'corpo', 'assistente', 'noticias', 'onibus']
const NAV_SLOTS: Array<{ tab: Tab; left: number; width: number }> = [
  { tab: 'treino', left: 0, width: 0.1333 },
  { tab: 'dieta', left: 0.1333, width: 0.1333 },
  { tab: 'corpo', left: 0.2666, width: 0.1334 },
  { tab: 'assistente', left: 0.4, width: 0.2 },
  { tab: 'noticias', left: 0.6, width: 0.2 },
  { tab: 'onibus', left: 0.8, width: 0.2 },
]
const TAB_LABELS: Record<Tab, string> = {
  treino: 'Treino (~/treino)',
  dieta: 'Dieta (~/dieta)',
  corpo: 'Corpo (~/corpo)',
  assistente: 'Agente IA (~/assistente)',
  noticias: 'Notícias do Ifes (~/noticias)',
  onibus: 'Ônibus Transcol / Ceturb-ES (~/onibus)',
  config: 'Configurações (~/config)',
}
const WEEK = 7 * 24 * 3600 * 1000
const SPLASH_HOLD_MS = 1950
const SPLASH_FADEOUT_MS = 520

export default function App() {
  const { toast } = useUi()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('tab')
      if (param && (ALL_TABS as string[]).includes(param)) {
        return param as Tab
      }
    }
    return 'treino'
  })
  const [lastNonConfigTab, setLastNonConfigTab] = useState<Tab>('treino')
  const [bootVisible, setBootVisible] = useState<boolean>(() => {
    const show = shouldShowSplashOnColdStart(Date.now())
    if (show) recordSplashShown(Date.now())
    return show
  })
  const [bootFading, setBootFading] = useState<boolean>(false)
  const [bootLines, setBootLines] = useState<string[]>(['> loading db...'])
  const [locked, setLocked] = useState<boolean>(true)
  const [hasUnlockedThisSession, setHasUnlockedThisSession] = useState<boolean>(false)
  const [tabPressing, setTabPressing] = useState<boolean>(false)
  const navRef = useRef<HTMLElement | null>(null)
  const pointerDownRef = useRef<boolean>(false)

  const [noticiasItems, setNoticiasItems] = useState<IfesNoticia[]>([])
  const [noticiasLoading, setNoticiasLoading] = useState<boolean>(false)
  const [noticiasError, setNoticiasError] = useState<string | null>(null)

  const onboarded = useSetting<boolean>('onboardingDone', false)
  const lastBackup = useSetting<number | null>('lastBackupAt', null)
  const firstUse = useSetting<number | null>('firstUseAt', null)
  const profileNameSetting = useSetting<string>('profileName', '')
  const ifesReadIdsRaw = useSetting<string[]>('ifesReadIds', [])
  const ifesReadIds = Array.isArray(ifesReadIdsRaw) ? ifesReadIdsRaw : []
  const unreadNoticiasCount = countUnreadNoticias(noticiasItems, ifesReadIds)
  const syncStatus = useSyncStatus()

  const resolvedGreetingName = (() => {
    const custom = (profileNameSetting ?? '').trim()
    if (custom) return custom
    const display = (syncStatus.user?.displayName ?? '').trim()
    if (display) return display
    if (syncStatus.user?.uid === OWNER_UID) return 'Ian'
    const emailPrefix = (syncStatus.user?.email ?? '').split('@')[0]?.trim()
    if (emailPrefix) {
      return emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1)
    }
    return syncStatus.user ? 'Atleta' : 'Ian'
  })()
  const lockConfig = useLiveQuery(() => getLockConfig(), [], {
    enabled: false,
    credentialId: null,
    pinHash: null,
    pinSalt: null,
    timeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES,
    lastUnlockedAt: null,
    hiddenAt: null,
  })

  const selectTab = (next: Tab) => {
    if (next !== 'config') {
      setLastNonConfigTab(next)
    }
    setTab(next)
  }

  const toggleConfigTab = () => {
    if (tab === 'config') {
      setTab(lastNonConfigTab)
    } else {
      setLastNonConfigTab(tab)
      setTab('config')
    }
  }

  useEffect(() => {
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const fadeTimer = window.setTimeout(
      () => {
        if (reducedMotion) {
          setBootVisible(false)
        } else {
          setBootFading(true)
        }
      },
      reducedMotion ? 1400 : SPLASH_HOLD_MS,
    )
    const hideTimer = window.setTimeout(
      () => setBootVisible(false),
      reducedMotion ? 1400 : SPLASH_HOLD_MS + SPLASH_FADEOUT_MS,
    )
    ;(async () => {
      try {
        await db.open()
        const cfg = await getLockConfig()
        const coldLocked = shouldLockOnColdStart(cfg.enabled)
        setLocked(coldLocked)
        setLockedState(coldLocked)
        if (coldLocked) {
          setBootVisible(false)
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
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(hideTimer)
    }
  }, [])

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

  useEffect(() => {
    if (!ready || typeof window === 'undefined') return

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'IFES_OPEN_TAB') {
        const targetTab =
          typeof data.tab === 'string' && (ALL_TABS as string[]).includes(data.tab)
            ? (data.tab as Tab)
            : 'noticias'
        selectTab(targetTab)
      } else if (data.type === 'IFES_PUSH_RECEIVED') {
        const ts = typeof data.receivedAt === 'number' ? data.receivedAt : Date.now()
        void recordLastNotificationReceived(ts)
        const title = typeof data.title === 'string' ? data.title : 'Nova notícia do Ifes'
        toast(`[ifes] ${title}`, { label: 'abrir', run: () => selectTab('noticias') })
      }
    }

    navigator.serviceWorker?.addEventListener?.('message', onSwMessage)
    const unsubFg = initForegroundPushListener(({ title }) => {
      toast(`[ifes] ${title}`, { label: 'abrir', run: () => selectTab('noticias') })
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
        <p className="muted">Abra pelo ícone instalado na Tela de Início.</p>
      </div>
    )

  if (!ready || onboarded === undefined) {
    if (locked && lockConfig.enabled) {
      return <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
    }
    return bootVisible ? (
      <BootOverlay
        lines={bootLines}
        userName={resolvedGreetingName}
        fadingOut={bootFading}
        onSkip={() => setBootVisible(false)}
      />
    ) : null
  }

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
        <PromptTitle path="~/inicio" />
        <div className="card stack">
          <div><b>Adicione o app à Tela de Início antes de usar.</b></div>
          <div className="muted small">Safari → Compartilhar → Adicionar à Tela de Início.</div>
        </div>
        <button className="primary block" onClick={() => setSetting('onboardingDone', true)}>começar</button>
      </div>
    )

  const ref = lastBackup ?? firstUse ?? Date.now()
  const stale = Date.now() - ref > WEEK
  const days = Math.floor((Date.now() - ref) / 86400000)
  const isCurrentlyLocked = Boolean(locked && lockConfig.enabled)
  const navIdx = NAV_TABS.indexOf(tab)
  const activeTabIndex = navIdx >= 0 ? navIdx : Math.max(0, NAV_TABS.indexOf(lastNonConfigTab))
  const activeSlot = NAV_SLOTS[activeTabIndex] ?? NAV_SLOTS[0]

  const pickTabFromClientX = (clientX: number) => {
    const navEl = navRef.current
    if (!navEl) return
    const rect = navEl.getBoundingClientRect()
    const innerLeft = rect.left + 5
    const innerWidth = Math.max(1, rect.width - 10)
    const rel = Math.min(0.9999, Math.max(0, (clientX - innerLeft) / innerWidth))
    const hit =
      NAV_SLOTS.find((s) => rel >= s.left && rel < s.left + s.width) ??
      NAV_SLOTS[NAV_SLOTS.length - 1]
    if (hit && hit.tab !== tab) {
      selectTab(hit.tab)
    }
  }

  return (
    <ChromeNavContext.Provider
      value={{
        isConfigActive: tab === 'config',
        hasConfigAlert: stale,
        onToggleConfig: toggleConfigTab,
      }}
    >
      <div className="app">
        {bootVisible && !isCurrentlyLocked && (
          <BootOverlay
            lines={bootLines}
            userName={resolvedGreetingName}
            fadingOut={bootFading}
            onSkip={() => setBootVisible(false)}
          />
        )}
        {isCurrentlyLocked && (
          <LockScreen config={lockConfig} onUnlocked={handleUnlocked} />
        )}
        <main
          className="scroll"
          style={isCurrentlyLocked ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
          aria-hidden={isCurrentlyLocked}
        >
          {stale && tab !== 'config' && (
            <div className="banner" onClick={() => selectTab('config')}>
              {lastBackup ? `Backup há ${days}d` : 'Sem backup exportado'} · exportar agora
            </div>
          )}
          <div key={tab} className="tab-view-enter">
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
            {tab === 'onibus' && <Onibus />}
            {tab === 'config' && <Config />}
          </div>
        </main>
        <nav
          ref={navRef}
          className={`tabbar${tabPressing ? ' pressing' : ''}`}
          style={
            {
              '--active-idx': activeTabIndex,
              '--tab-count': NAV_TABS.length,
              '--lens-left': activeSlot.left,
              '--lens-width': activeSlot.width,
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
          <span
            className={`tabbar-lens${navIdx < 0 ? ' hidden' : ''}`}
            aria-hidden="true"
          />
          {NAV_SLOTS.map(({ tab: k, width }) => {
            const isActive = tab === k
            const isAi = k === 'assistente'
            const label = TAB_LABELS[k]
            return (
              <button
                key={k}
                type="button"
                className={`${isActive ? 'on' : ''}${isAi ? ' ai-center' : ''}`.trim()}
                style={{ flex: `0 0 ${width * 100}%` }}
                onClick={() => selectTab(k)}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                title={label}
              >
                <span className={`tabbar-icon-wrap${isAi ? ' ai-halo' : ''}`}>
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
    </ChromeNavContext.Provider>
  )
}
