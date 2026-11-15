import { describe, expect, it } from 'vitest'
import { buildDays, prSetIds, relDate, scoreToLevel, streaks } from '../src/lib/panel'
import type { Session } from '../src/data/types'

const goals = { kcal: 2000, p: 100, c: 200, g: 60 }
const sess = (id: string, date: string, sets: number, load = 0, value = 10): Session => ({
  id, date, name: 'A', notes: '', createdAt: Date.parse(date),
  entries: [{ exerciseId: 'e', sets: Array.from({ length: sets }, (_, i) => ({ id: `${id}-${i}`, value, load })) }],
})

describe('heatmap', () => {
  it('níveis a partir da pontuação', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(scoreToLevel)).toEqual([0, 1, 1, 2, 3, 3, 4])
  })
  it('combina treino, dieta e peso', () => {
    const meals = [{ id: 'm', date: '2026-11-01', type: 'almoco' as const, createdAt: 1, items: [{ name: 'x', qty: '', kcal: 500, p: 120, c: 0, g: 0 }] }]
    const body = [{ id: 'b', date: '2026-11-01', weight: 80, measures: {} }]
    const days = buildDays('2026-10-01', '2026-11-30', [sess('s', '2026-11-01', 12), sess('t', '2026-11-02', 3)], meals, body, goals)
    expect(days.get('2026-11-01')).toMatchObject({ score: 6, level: 4 }) // 3 + 2 + 1
    expect(days.get('2026-11-02')).toMatchObject({ score: 2, level: 1 })
    expect(days.get('2026-11-05')).toBeUndefined()
  })
})

describe('streaks', () => {
  it('tolera dias de descanso até o limite', () => {
    const d = ['2026-11-01', '2026-11-04', '2026-11-05'] // descanso de 2 dias entre 1 e 4
    expect(streaks(d, 2, '2026-11-06')).toEqual({ current: 3, longest: 3 })
    expect(streaks(d, 1, '2026-11-06')).toEqual({ current: 2, longest: 2 })
  })
  it('zera a sequência atual quando passa da tolerância', () => {
    expect(streaks(['2026-11-01', '2026-11-02'], 2, '2026-11-10')).toEqual({ current: 0, longest: 2 })
    expect(streaks([], 2, '2026-11-10')).toEqual({ current: 0, longest: 0 })
  })
})

describe('log', () => {
  it('marca PR só quando supera o histórico', () => {
    const prs = prSetIds([sess('a', '2026-11-01', 1, 0, 10), sess('b', '2026-11-03', 1, 0, 12), sess('c', '2026-11-05', 1, 0, 11)])
    expect([...prs]).toEqual(['b-0'])
  })
  it('data relativa', () => {
    expect(relDate('2026-11-10', '2026-11-10')).toBe('hoje')
    expect(relDate('2026-11-09', '2026-11-10')).toBe('ontem')
    expect(relDate('2026-11-07', '2026-11-10')).toBe('há 3 dias')
  })
})
