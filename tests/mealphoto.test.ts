import { beforeEach, describe, expect, it } from 'vitest'
import { buildBackup } from '../src/data/backup'
import { db, waitPendingOutbox } from '../src/data/db'
import {
  addItems,
  analyzeMealPhoto,
  MealAnalysisError,
  mealId,
  mealTypeForHour,
  NoFoodError,
  undoAddItems,
  validateMealAnalysis,
} from '../src/lib/mealPhoto'

const okItem = { nome: 'Arroz', gramas: 150, kcal: 195, proteina_g: 4, carbo_g: 42, gordura_g: 0.5, confianca: 'alta' }

describe('Foto do prato (validação, registro e chamada ao Worker)', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('valida o JSON da IA e converte para o formato de item do app', () => {
    const items = validateMealAnalysis({ itens: [okItem, { ...okItem, nome: 'Frango', gramas: 0, kcal: 300.4 }] })
    expect(items[0]).toEqual({ name: 'Arroz', qty: '150 g', kcal: 195, p: 4, c: 42, g: 0.5 })
    expect(items[1].qty).toBe('1 porção')
    expect(items[1].kcal).toBe(300)
  })

  it('rejeita resposta inválida e avisa quando não há comida', () => {
    expect(() => validateMealAnalysis(null)).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({})).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({ itens: [{ ...okItem, kcal: 'muito' }] })).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({ itens: [{ ...okItem, nome: '' }] })).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({ itens: [{ ...okItem, kcal: -5 }] })).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({ itens: [{ ...okItem, kcal: 999999 }] })).toThrow(MealAnalysisError)
    expect(() => validateMealAnalysis({ itens: [] })).toThrow(NoFoodError)
  })

  it('escolhe a refeição pelo horário local', () => {
    const at = (h: number) => mealTypeForHour(new Date(2026, 10, 24, h, 0))
    expect(at(7)).toBe('cafe')
    expect(at(12)).toBe('almoco')
    expect(at(16)).toBe('lanche')
    expect(at(20)).toBe('jantar')
    expect(at(2)).toBe('lanche')
  })

  it('salva no formato da dieta, entra no backup e na fila de sync, e desfaz só o que foi adicionado', async () => {
    await addItems('2026-11-24', 'jantar', [{ name: 'Ovo', qty: '2 un', kcal: 140, p: 12, c: 1, g: 10 }])
    await addItems('2026-11-24', 'jantar', validateMealAnalysis({ itens: [okItem] }))

    const m = await db.meals.get(mealId('2026-11-24', 'jantar'))
    expect(m?.id).toBe('meal-2026-11-24-jantar')
    expect(m?.items.map((i) => i.name)).toEqual(['Ovo', 'Arroz'])

    await waitPendingOutbox()
    expect((await db.outbox.toArray()).some((o) => o.id === 'meals:meal-2026-11-24-jantar')).toBe(true)
    expect((await buildBackup()).tables.meals.some((x: any) => x.id === 'meal-2026-11-24-jantar')).toBe(true)

    await undoAddItems('2026-11-24', 'jantar', 1)
    expect((await db.meals.get(mealId('2026-11-24', 'jantar')))?.items.map((i) => i.name)).toEqual(['Ovo'])
    await undoAddItems('2026-11-24', 'jantar', 1)
    expect(await db.meals.get(mealId('2026-11-24', 'jantar'))).toBeUndefined()
  })

  it('analyzeMealPhoto: envia ao /analyze-meal com Bearer, valida e não salva nada em caso de erro', async () => {
    const calls: { url: string; auth: string | null; body: any }[] = []
    const make = (status: number, payload: unknown): typeof fetch => async (input, init) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
        body: JSON.parse(String(init?.body ?? '{}')),
      })
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
    }
    const base = {
      getToken: async () => 'tok-firebase',
      workerUrl: 'https://w.example.workers.dev/',
      prepareImage: async () => 'data:image/jpeg;base64,AAAA',
    }
    const file = new Blob(['x'], { type: 'image/jpeg' })

    const items = await analyzeMealPhoto(file, { ...base, fetcher: make(200, { itens: [okItem] }) })
    expect(items).toHaveLength(1)
    expect(calls[0].url).toBe('https://w.example.workers.dev/analyze-meal')
    expect(calls[0].auth).toBe('Bearer tok-firebase')
    expect(calls[0].body).toEqual({ image: 'data:image/jpeg;base64,AAAA' })

    await expect(analyzeMealPhoto(file, { ...base, fetcher: make(200, { itens: [] }) })).rejects.toBeInstanceOf(NoFoodError)
    await expect(analyzeMealPhoto(file, { ...base, fetcher: make(200, { lixo: true }) })).rejects.toBeInstanceOf(MealAnalysisError)
    await expect(analyzeMealPhoto(file, { ...base, fetcher: make(401, { error: 'x' }) })).rejects.toThrow(/401/)
    await expect(analyzeMealPhoto(file, { ...base, getToken: async () => null, fetcher: make(200, {}) })).rejects.toThrow(/conta/)

    expect(await db.meals.count()).toBe(0)
  })
})
