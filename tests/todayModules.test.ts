import { describe, expect, it } from 'vitest'
import { OWNER_UID } from '../src/assistantConfig'
import { getAllowedTodayModules, normalizeTodayModulesConfig } from '../src/tabs/Hoje'

describe('módulos da tela Hoje', () => {
  it('ativa Notícias na migração de uma configuração antiga do proprietário', () => {
    const config = normalizeTodayModulesConfig(
      { enabledMap: { noticias: false }, order: ['treino', 'noticias'] },
      OWNER_UID,
    )

    expect(config.enabledMap.noticias).toBe(true)
    expect(config.version).toBe(2)
    expect(config.order).toContain('noticias')
  })

  it('preserva a escolha do proprietário depois da migração', () => {
    const config = normalizeTodayModulesConfig(
      { enabledMap: { noticias: false }, order: ['treino', 'noticias'], version: 2 },
      OWNER_UID,
    )

    expect(config.enabledMap.noticias).toBe(false)
  })

  it('não rebaixa nem altera preferências gravadas por uma versão mais nova', () => {
    const config = normalizeTodayModulesConfig(
      { enabledMap: { noticias: false }, order: ['noticias'], version: 3 },
      OWNER_UID,
    )

    expect(config.version).toBe(3)
    expect(config.enabledMap.noticias).toBe(false)
  })

  it('não expõe Notícias nem Faculdade para outras contas', () => {
    const ids = getAllowedTodayModules('secondary-user').map((module) => module.id)

    expect(ids).not.toContain('noticias')
    expect(ids).not.toContain('faculdade')
    expect(ids).toContain('treino')
  })
})
