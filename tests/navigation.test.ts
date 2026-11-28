import { describe, expect, it } from 'vitest'
import { OWNER_UID } from '../src/assistantConfig'
import {
  DEFAULT_MAIN_NAV_TABS,
  getAllowedMainNavTabs,
  getMainNavTabsSettingKey,
  normalizeMainNavTabs,
} from '../src/lib/navigation'

describe('atalhos da navegação', () => {
  it('mantém quatro destinos únicos e usa fallback seguro para valores inválidos', () => {
    expect(normalizeMainNavTabs(['dieta', 'dieta', 'gastos', 'assistente', null], 'other'))
      .toEqual(['dieta', 'hoje', 'treino', 'onibus'])
    expect(normalizeMainNavTabs(null, 'other')).toEqual(DEFAULT_MAIN_NAV_TABS)
  })

  it('permite abas pessoais apenas ao proprietário', () => {
    expect(getAllowedMainNavTabs('other')).not.toContain('gastos')
    expect(getAllowedMainNavTabs('other')).not.toContain('faculdade')
    expect(getAllowedMainNavTabs(OWNER_UID)).toContain('gastos')
    expect(getAllowedMainNavTabs(OWNER_UID)).toContain('faculdade')
  })

  it('armazena as preferências sob uma chave isolada por UID', () => {
    expect(getMainNavTabsSettingKey('user-a')).not.toBe(getMainNavTabsSettingKey('user-b'))
    expect(getMainNavTabsSettingKey(null)).toBe('mainNavTabs:guest')
  })
})
