import { describe, expect, it } from 'vitest'
import {
  SPLASH_MIN_INTERVAL_MS,
  SPLASH_UNLOCK_MIN_INTERVAL_MS,
  shouldShowSplash,
  splashIntervalFor,
} from '../src/lib/splash'

describe('Regras da saudação de abertura', () => {
  const now = 1_800_000_000_000

  it('mostra na primeira vez (nunca exibida)', () => {
    expect(shouldShowSplash(now, SPLASH_MIN_INTERVAL_MS, null)).toBe(true)
  })

  it('respeita o intervalo mínimo de 30 min sem trava', () => {
    expect(shouldShowSplash(now, SPLASH_MIN_INTERVAL_MS, now - 29 * 60_000)).toBe(false)
    expect(shouldShowSplash(now, SPLASH_MIN_INTERVAL_MS, now - 30 * 60_000)).toBe(true)
  })

  it('desbloqueio e login usam o intervalo próprio (0 = sempre mostra logo depois do Face ID)', () => {
    expect(splashIntervalFor('unlock')).toBe(SPLASH_UNLOCK_MIN_INTERVAL_MS)
    expect(splashIntervalFor('login')).toBe(SPLASH_UNLOCK_MIN_INTERVAL_MS)
    expect(splashIntervalFor('cold-start')).toBe(SPLASH_MIN_INTERVAL_MS)
    expect(splashIntervalFor('resume')).toBe(SPLASH_MIN_INTERVAL_MS)
    // mesmo tendo aparecido há 1 segundo, o desbloqueio mostra de novo
    expect(shouldShowSplash(now, splashIntervalFor('unlock'), now - 1000)).toBe(true)
  })

  it('se o relógio andou para trás, não trava a saudação', () => {
    expect(shouldShowSplash(now, SPLASH_MIN_INTERVAL_MS, now + 60_000)).toBe(true)
  })
})
