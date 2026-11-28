import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { OWNER_UID } from '../assistantConfig'
import { db } from '../data/db'
import { useSetting, useSyncStatus } from '../hooks'
import { getContextualGreeting, PromptTitle } from '../components/TerminalChrome'
import Icon, { type IconName } from '../components/Icons'
import { countUnreadNoticias, type IfesNoticia } from '../lib/notifications'
import { getFavoriteLineIds } from '../services/ceturbService'
import { today, dayTotals, fmtNum } from '../data/stats'

export interface TodayModuleDef {
  id: string
  title: string
  icon: IconName
  targetTab: 'treino' | 'dieta' | 'corpo' | 'noticias' | 'onibus' | 'assistente'
  defaultActive: boolean
  ownerOnly?: boolean
}

export const TODAY_MODULES: TodayModuleDef[] = [
  { id: 'treino', title: 'Treino do Dia', icon: 'treino', targetTab: 'treino', defaultActive: true },
  { id: 'dieta', title: 'Dieta e Macros', icon: 'dieta', targetTab: 'dieta', defaultActive: true },
  { id: 'onibus', title: 'Próximo Ônibus', icon: 'onibus', targetTab: 'onibus', defaultActive: false },
  { id: 'noticias', title: 'Notícias do IFES', icon: 'noticias', targetTab: 'noticias', defaultActive: false },
  { id: 'agenda', title: 'Agenda Google', icon: 'assistente', targetTab: 'assistente', defaultActive: false, ownerOnly: true },
  { id: 'push', title: 'Lembretes Push', icon: 'assistente', targetTab: 'assistente', defaultActive: false },
]

export interface TodayModulesConfigRecord {
  enabledMap: Record<string, boolean>
  order: string[]
}

const DEFAULT_ENABLED_MAP: Record<string, boolean> = {
  treino: true,
  dieta: true,
  onibus: false,
  noticias: false,
  agenda: false,
  push: false,
}

const DEFAULT_ORDER = ['treino', 'dieta', 'onibus', 'noticias', 'agenda', 'push']

export function useTodayModulesConfig(): {
  config: TodayModulesConfigRecord
  setEnabled: (id: string, active: boolean) => void
  reorder: (nextOrder: string[]) => void
} {
  const saved = useSetting<TodayModulesConfigRecord | null>('todayModulesConfig', null)
  const config = useMemo<TodayModulesConfigRecord>(() => {
    if (!saved || typeof saved !== 'object') {
      return { enabledMap: DEFAULT_ENABLED_MAP, order: DEFAULT_ORDER }
    }
    const enabledMap = { ...DEFAULT_ENABLED_MAP, ...(saved.enabledMap ?? {}) }
    const order = Array.isArray(saved.order) && saved.order.length > 0 ? saved.order : DEFAULT_ORDER
    return { enabledMap, order }
  }, [saved])

  const setEnabled = (id: string, active: boolean) => {
    const nextMap = { ...config.enabledMap, [id]: active }
    void setSetting('todayModulesConfig', { ...config, enabledMap: nextMap })
  }

  const reorder = (nextOrder: string[]) => {
    void setSetting('todayModulesConfig', { ...config, order: nextOrder })
  }

  return { config, setEnabled, reorder }
}
export default function Hoje({
  onNavigateTab,
  noticiasItems = [],
}: {
  onNavigateTab?: (tab: 'treino' | 'dieta' | 'corpo' | 'noticias' | 'onibus' | 'assistente' | 'config') => void
  noticiasItems?: IfesNoticia[]
}) {
  const syncStatus = useSyncStatus()
  const profileName = useSetting<string>('profileName', '')
  const goals = useSetting('goals', { p: 160, c: 250, f: 70, e: 2500 })
  const { config } = useTodayModulesConfig()

  const resolvedGreetingName = (() => {
    const custom = (profileName ?? '').trim()
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

  const greeting = useMemo(() => getContextualGreeting(new Date(), resolvedGreetingName), [resolvedGreetingName])

  const todayStr = useMemo(() => today(), [])
  const isOwner = syncStatus.user?.uid === OWNER_UID

  const todaySession = useLiveQuery(
    async () => await db.sessions.where('date').equals(todayStr).toArray(),
    [todayStr],
    [],
  )
  const hasTrained = todaySession && todaySession.length > 0
  const sessionNames = todaySession?.map((s) => s.name).join(', ') || ''

  const todayMeals = useLiveQuery(
    async () => await db.meals.where('date').equals(todayStr).toArray(),
    [todayStr],
    [],
  )
  const totals = useMemo(() => dayTotals(todayMeals ?? []), [todayMeals])

  const ifesReadIdsRaw = useSetting<string[]>('ifesReadIds', [])
  const ifesReadIds = Array.isArray(ifesReadIdsRaw) ? ifesReadIdsRaw : []
  const unreadNewsCount = countUnreadNoticias(noticiasItems, ifesReadIds)
  const latestNews = noticiasItems[0] ?? null

  const [favoriteBusLine, setFavoriteBusLine] = useState<string | null>(null)
  useEffect(() => {
    const favs = getFavoriteLineIds()
    if (favs.length > 0) {
      setFavoriteBusLine(favs[0] ?? null)
    }
  }, [])

  const activeModules = useMemo(() => {
    return config.order
      .map((id) => TODAY_MODULES.find((m) => m.id === id))
      .filter((m): m is TodayModuleDef => {
        if (!m) return false
        if (m.ownerOnly && !isOwner) return false
        return Boolean(config.enabledMap[m.id])
      })
  }, [config, isOwner])


  return (
    <div className="scroll">
      <PromptTitle path="~/hoje" />
      
      <div className="card" style={{ marginBottom: 16, padding: '16px 18px', background: 'var(--surface2)' }}>
        <div className="big" style={{ fontSize: 22, fontFamily: 'var(--serif)', marginBottom: 4 }}>
          {greeting.phrase}
        </div>
        <div className="muted small">{greeting.meta}</div>
      </div>

      {activeModules.length === 0 ? (
        <div className="card stack" style={{ textAlign: 'center', padding: 28 }}>
          <div className="muted">Nenhum card ativo no momento.</div>
          <div className="small muted">Ative módulos e defina suas preferências em Configurações.</div>
          {onNavigateTab && (
            <div>
              <button className="small" onClick={() => onNavigateTab('config')}>Abrir Configurações</button>
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          {activeModules.map((mod) => {
            return (
              <div
                key={mod.id}
                className="card tap"
                style={{ padding: '16px 18px', cursor: 'pointer', transition: 'border-color 0.15s ease' }}
                onClick={() => {
                  if (onNavigateTab) onNavigateTab(mod.targetTab)
                }}
              >
                <div className="row between" style={{ marginBottom: 8 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ width: 18, height: 18, color: 'var(--accent)' }}>
                      <Icon name={mod.icon} />
                    </span>
                    <b>{mod.title}</b>
                  </div>
                  <span className="muted small">abrir →</span>
                </div>

                {mod.id === 'treino' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    <div>
                      {hasTrained ? (
                        <span className="green">✓ Treinou hoje: {sessionNames}</span>
                      ) : (
                        <span className="muted">Nenhum treino registrado hoje. Toque para iniciar.</span>
                      )}
                    </div>
                  </div>
                )}

                {mod.id === 'dieta' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    <div className="row between small">
                      <span>Calorias: <b>{fmtNum(totals.kcal)}</b> / {goals.e} kcal</span>
                      <span>Prot: <b>{fmtNum(totals.protein)}g</b> / {goals.p}g</span>
                    </div>
                  </div>
                )}

                {mod.id === 'onibus' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    <div className="small muted">
                      {favoriteBusLine ? (
                        <span>Linha favorita fixada: <b>{favoriteBusLine}</b>. Toque para ver horários.</span>
                      ) : (
                        <span>Nenhuma linha de ônibus fixada nos favoritos. Toque para buscar horários.</span>
                      )}
                    </div>
                  </div>
                )}

                {mod.id === 'noticias' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    {latestNews ? (
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13.5 }}>{latestNews.title}</div>
                        <div className="muted small" style={{ marginTop: 2 }}>
                          {unreadNewsCount > 0 ? `${unreadNewsCount} notícias não lidas` : 'Todas as notícias lidas'}
                        </div>
                      </div>
                    ) : (
                      <div className="muted small">Nenhuma notícia recente do IFES Campus Vitória.</div>
                    )}
                  </div>
                )}

                {mod.id === 'agenda' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    <div className="muted small">
                      {isOwner ? 'Agenda do Google Calendar conectada (proprietário).' : 'Recurso restrito ao proprietário.'}
                    </div>
                  </div>
                )}

                {mod.id === 'push' && (
                  <div className="stack" style={{ marginTop: 6 }}>
                    <div className="muted small">Toque para verificar lembretes push e notificações agendadas.</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
