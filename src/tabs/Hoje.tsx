import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { OWNER_UID } from '../assistantConfig'
import { db, setSetting } from '../data/db'
import { DEFAULT_GOALS } from '../data/seed'
import { useSetting, useSyncStatus } from '../hooks'
import { getContextualGreeting, PromptTitle } from '../components/TerminalChrome'
import Icon, { type IconName } from '../components/Icons'
import { Sheet } from '../components/ui'
import { countUnreadNoticias, type IfesNoticia } from '../lib/notifications'
import { getFavoriteLineIds } from '../services/ceturbService'
import { today, dayTotals, fmtNum } from '../data/stats'
import type { Goals } from '../data/types'
import {
  EMPTY_FACULTY_DATA,
  FACULDADE_SETTING_KEY,
  getLowestFacultyCourseMargin,
  getNextFacultyClass,
  getNextFacultyDeadline,
  type FacultyData,
} from '../lib/faculty'

export interface TodayModuleDef {
  id: string
  title: string
  icon: IconName
  targetTab: 'treino' | 'dieta' | 'corpo' | 'noticias' | 'onibus' | 'assistente' | 'faculdade'
  defaultActive: boolean
  allowedUids?: string[]
}

export const TODAY_MODULES: TodayModuleDef[] = [
  { id: 'treino', title: 'Treino do Dia', icon: 'treino', targetTab: 'treino', defaultActive: true },
  { id: 'dieta', title: 'Dieta e Macros', icon: 'dieta', targetTab: 'dieta', defaultActive: true },
  { id: 'faculdade', title: 'Faculdade', icon: 'faculdade', targetTab: 'faculdade', defaultActive: true },
  { id: 'onibus', title: 'Próximo Ônibus Favorito', icon: 'onibus', targetTab: 'onibus', defaultActive: true, allowedUids: [OWNER_UID] },
  { id: 'noticias', title: 'Notícias do IFES', icon: 'noticias', targetTab: 'noticias', defaultActive: true, allowedUids: [OWNER_UID] },
  { id: 'agenda', title: 'Agenda Google', icon: 'assistente', targetTab: 'assistente', defaultActive: true, allowedUids: [OWNER_UID] },
  { id: 'push', title: 'Lembretes Push', icon: 'assistente', targetTab: 'assistente', defaultActive: true, allowedUids: [OWNER_UID] },
]

export interface TodayModulesConfigRecord {
  enabledMap: Record<string, boolean>
  order: string[]
}

const DEFAULT_ENABLED_MAP = TODAY_MODULES.reduce<Record<string, boolean>>((enabledMap, module) => {
  enabledMap[module.id] = module.defaultActive
  return enabledMap
}, {})

const DEFAULT_ORDER = ['treino', 'dieta', 'faculdade', 'onibus', 'noticias', 'agenda', 'push']

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
    const savedOrder = Array.isArray(saved.order) && saved.order.length > 0 ? saved.order : DEFAULT_ORDER
    const order = [...savedOrder, ...TODAY_MODULES.map((module) => module.id).filter((id) => !savedOrder.includes(id))]
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
  onNavigateTab?: (tab: 'treino' | 'dieta' | 'corpo' | 'noticias' | 'onibus' | 'assistente' | 'faculdade' | 'config') => void
  noticiasItems?: IfesNoticia[]
}) {
  const syncStatus = useSyncStatus()
  const profileName = useSetting<string>('profileName', '')
  const goals = useSetting<Goals>('goals', DEFAULT_GOALS) ?? DEFAULT_GOALS
  const { config, setEnabled } = useTodayModulesConfig()
  const [modulesConfigOpen, setModulesConfigOpen] = useState(false)
  const facultyData = useSetting<FacultyData>(FACULDADE_SETTING_KEY, EMPTY_FACULTY_DATA) ?? EMPTY_FACULTY_DATA

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
  const allowedModules = useMemo(
    () => TODAY_MODULES.filter((module) => !module.allowedUids || module.allowedUids.includes(syncStatus.user?.uid ?? '')),
    [syncStatus.user?.uid],
  )

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
      .map((id) => allowedModules.find((m) => m.id === id))
      .filter((m): m is TodayModuleDef => {
        if (!m) return false
        return Boolean(config.enabledMap[m.id])
      })
  }, [allowedModules, config])
  const nextFacultyClass = getNextFacultyClass(facultyData.classes, facultyData.courses)
  const nextFacultyDeadline = getNextFacultyDeadline(facultyData.deadlines, facultyData.courses)
  const lowestFacultyMargin = getLowestFacultyCourseMargin(facultyData.courses, facultyData.assessments)

  return (
    <div className="scroll">
      <PromptTitle
        path="~/hoje"
        rightSlot={
          <button
            type="button"
            className="ghost small"
            aria-label="Personalizar cards de Hoje"
            title="Personalizar cards"
            onClick={() => setModulesConfigOpen(true)}
          >
            <span style={{ display: 'block', width: 18, height: 18 }}>
              <Icon name="config" />
            </span>
          </button>
        }
      />
      
      <div className="card" style={{ marginBottom: 16, padding: '16px 18px', background: 'var(--surface2)' }}>
        <div className="big" style={{ fontSize: 22, fontFamily: 'var(--serif)', marginBottom: 4 }}>
          {greeting.phrase}
        </div>
        <div className="muted small">{greeting.meta}</div>
      </div>

      {activeModules.length === 0 ? (
        <div className="card stack" style={{ textAlign: 'center', padding: 28 }}>
          <div className="muted">Nenhum card ativo no momento.</div>
          <div className="small muted">Ative os cards que deseja ver no Hoje.</div>
          <div>
            <button className="small" onClick={() => setModulesConfigOpen(true)}>Personalizar cards</button>
          </div>
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
                    <span style={{ display: 'block', flexShrink: 0, width: 18, height: 18, color: 'var(--accent)' }}>
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
                      <span>Calorias: <b>{fmtNum(totals.kcal)}</b> / {goals.kcal} kcal</span>
                      <span>Prot: <b>{fmtNum(totals.p)}g</b> / {goals.p}g</span>
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

                {mod.id === 'faculdade' && (
                  <div className="stack small" style={{ marginTop: 6 }}>
                    <div className="muted">
                      Próxima aula:{' '}
                      {nextFacultyClass
                        ? `${nextFacultyClass.course.name} · ${nextFacultyClass.startsAt.toLocaleDateString('pt-BR', { weekday: 'short' })} ${nextFacultyClass.facultyClass.startTime} · ${nextFacultyClass.facultyClass.room}`
                        : 'nenhuma cadastrada'}
                    </div>
                    <div className="muted">
                      Próximo prazo:{' '}
                      {nextFacultyDeadline
                        ? `${nextFacultyDeadline.course.name} · ${nextFacultyDeadline.deadline.date} ${nextFacultyDeadline.deadline.time}`
                        : 'nenhum pendente'}
                    </div>
                    <div className="muted">
                      Menor margem:{' '}
                      {lowestFacultyMargin
                        ? `${lowestFacultyMargin.course.name} · ${lowestFacultyMargin.margin >= 0 ? '+' : ''}${lowestFacultyMargin.margin.toFixed(1)}`
                        : 'sem notas registradas'}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {modulesConfigOpen && (
        <Sheet title="Personalizar Hoje" onClose={() => setModulesConfigOpen(false)}>
          <div className="stack">
            {allowedModules.map((module) => (
              <label key={module.id} className="row between">
                <span>{module.title}</span>
                <input
                  type="checkbox"
                  style={{ width: 24, minHeight: 24 }}
                  checked={Boolean(config.enabledMap[module.id])}
                  onChange={(event) => setEnabled(module.id, event.target.checked)}
                />
              </label>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  )
}
