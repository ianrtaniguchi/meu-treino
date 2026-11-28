import { OWNER_UID } from '../assistantConfig'

export type MainNavTab =
  | 'hoje'
  | 'treino'
  | 'dieta'
  | 'corpo'
  | 'noticias'
  | 'onibus'
  | 'faculdade'
  | 'gastos'
  | 'config'

export const MAIN_NAV_TABS_SETTING = 'mainNavTabs'
export const DEFAULT_MAIN_NAV_TABS: MainNavTab[] = ['hoje', 'treino', 'onibus', 'config']

const PUBLIC_MAIN_NAV_TABS: MainNavTab[] = ['hoje', 'treino', 'dieta', 'corpo', 'onibus', 'config']
const OWNER_MAIN_NAV_TABS: MainNavTab[] = ['noticias', 'faculdade', 'gastos']

export function getMainNavTabsSettingKey(uid?: string | null): string {
  return `${MAIN_NAV_TABS_SETTING}:${uid?.trim() || 'guest'}`
}

export function getAllowedMainNavTabs(uid?: string | null): MainNavTab[] {
  return uid === OWNER_UID
    ? [...PUBLIC_MAIN_NAV_TABS, ...OWNER_MAIN_NAV_TABS]
    : [...PUBLIC_MAIN_NAV_TABS]
}

export function normalizeMainNavTabs(value: unknown, uid?: string | null): MainNavTab[] {
  const allowed = getAllowedMainNavTabs(uid)
  const allowedSet = new Set(allowed)
  const selected = Array.isArray(value)
    ? value.filter((tab): tab is MainNavTab => typeof tab === 'string' && allowedSet.has(tab as MainNavTab))
    : []
  const unique = [...new Set(selected)].slice(0, 4)
  for (const tab of DEFAULT_MAIN_NAV_TABS) {
    if (unique.length === 4) break
    if (allowedSet.has(tab) && !unique.includes(tab)) unique.push(tab)
  }
  for (const tab of allowed) {
    if (unique.length === 4) break
    if (!unique.includes(tab)) unique.push(tab)
  }
  return unique
}
