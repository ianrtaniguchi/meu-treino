import { beforeEach, describe, expect, it } from 'vitest'
import {
  calculateRoute,
  fetchFares,
  fetchItinerary,
  fetchLines,
  fetchSchedules,
  fetchTemporalIntegration,
  filterLines,
  findNextDeparture,
  getActiveDayTabForDate,
  getFavoriteLineIds,
  normalizeLineCode,
  toggleFavoriteLineId,
} from '../src/services/ceturbService'
import { handleRequest, resetWorkerCachesForTest, type Env } from '../worker/src/index'

const TEST_ENV: Env = {
  ALLOWED_UID: 'uid-teste-123',
  ALLOWED_ORIGINS: 'https://ianrtaniguchi.github.io,http://localhost:5173',
}

const memoryStorage = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    memoryStorage.set(k, String(v))
  },
  removeItem: (k: string) => {
    memoryStorage.delete(k)
  },
  clear: () => {
    memoryStorage.clear()
  },
}

describe('Ceturb-ES Service & Worker Proxy', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = mockLocalStorage
    memoryStorage.clear()
    resetWorkerCachesForTest()
  })

  it('normaliza códigos de linha com e sem zero à esquerda ou sufixos alfanuméricos', () => {
    expect(normalizeLineCode('0500')).toEqual({ id: '0500', code: '500' })
    expect(normalizeLineCode('501')).toEqual({ id: '0501', code: '501' })
    expect(normalizeLineCode('073N')).toEqual({ id: '073N', code: '73N' })
    expect(normalizeLineCode('0401')).toEqual({ id: '0401', code: '401' })
  })

  it('persiste e alterna linhas favoritas no localStorage', () => {
    expect(getFavoriteLineIds()).toEqual([])
    const afterAdd = toggleFavoriteLineId('500')
    expect(afterAdd).toEqual(['0500'])
    expect(getFavoriteLineIds()).toEqual(['0500'])

    const afterSecond = toggleFavoriteLineId('0506')
    expect(afterSecond).toEqual(['0506', '0500'])

    const afterRemove = toggleFavoriteLineId('0500')
    expect(afterRemove).toEqual(['0506'])
  })

  it('destaca corretamente o próximo horário de saída com base no horário atual', () => {
    const slots = [
      { time: '06:00', minutesFromMidnight: 360, noteCode: null },
      { time: '12:30', minutesFromMidnight: 750, noteCode: 'L' },
      { time: '18:45', minutesFromMidnight: 1125, noteCode: null },
    ]

    const morning = new Date('2026-08-12T10:15:00-03:00')
    const nextMorning = findNextDeparture(slots, morning)
    expect(nextMorning?.slot.time).toBe('12:30')
    expect(nextMorning?.index).toBe(1)
    expect(nextMorning?.minutesUntil).toBe(135)
    expect(nextMorning?.isTomorrow).toBe(false)

    const lateNight = new Date('2026-08-12T22:00:00-03:00')
    const nextTomorrow = findNextDeparture(slots, lateNight)
    expect(nextTomorrow?.slot.time).toBe('06:00')
    expect(nextTomorrow?.index).toBe(0)
    expect(nextTomorrow?.isTomorrow).toBe(true)
  })

  it('identifica automaticamente a aba do dia (Dias Úteis, Sábados, Domingos)', () => {
    expect(getActiveDayTabForDate(new Date('2026-08-12T12:00:00-03:00'))).toBe('uteis') // Quarta
    expect(getActiveDayTabForDate(new Date('2026-08-15T12:00:00-03:00'))).toBe('sabado') // Sábado
    expect(getActiveDayTabForDate(new Date('2026-08-16T12:00:00-03:00'))).toBe('domingo') // Domingo
  })

  it('filtra linhas por número, nome de terminal e atalhos como "Ifes"', async () => {
    const lines = await fetchLines({
      fetcher: async () => new Response('erro', { status: 500 }),
    })
    expect(lines.length).toBeGreaterThan(10)

    const byCode = filterLines(lines, '500')
    expect(byCode.some((l) => l.code === '500')).toBe(true)

    const byIfes = filterLines(lines, 'ifes')
    expect(byIfes.length).toBeGreaterThan(0)
  })

  it('processa horários e observações reais do schema BuscaHorarios e BuscaHorarioObse', async () => {
    const mockFetcher: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/ceturb/schedules')) {
        return new Response(
          JSON.stringify({
            line: '0501',
            schedules: [
              {
                Desc_Terminal: 'TERMINAL JACARAIPE',
                Descricao_Hora: 'DIAS ÚTEIS',
                Descricao_Linha: 'T. JACARAIPE / T. ITAPARICA VIA T. CARAPINA/3ª PONTE',
                Dt_Inicio: '12/08/2026',
                Hora_Saida: '05:10',
                Linha: '0501',
                TP_Horario: 1,
                Terminal_Seq: 1,
                Tipo_Orientacao: ' ',
              },
              {
                Desc_Terminal: 'TERMINAL JACARAIPE',
                Descricao_Hora: 'DIAS ÚTEIS',
                Descricao_Linha: 'T. JACARAIPE / T. ITAPARICA VIA T. CARAPINA/3ª PONTE',
                Dt_Inicio: '12/08/2026',
                Hora_Saida: '16:33',
                Linha: '0501',
                TP_Horario: 1,
                Terminal_Seq: 1,
                Tipo_Orientacao: 'L',
              },
              {
                Desc_Terminal: 'TERMINAL ITAPARICA',
                Descricao_Hora: 'SÁBADO',
                Descricao_Linha: 'T. JACARAIPE / T. ITAPARICA VIA T. CARAPINA/3ª PONTE',
                Dt_Inicio: '12/08/2026',
                Hora_Saida: '07:00',
                Linha: '0501',
                TP_Horario: 2,
                Terminal_Seq: 2,
                Tipo_Orientacao: ' ',
              },
            ],
            observations: [
              {
                Tipo_Orientacao: 'L',
                Descricao_Orientacao: 'VOLTA DIRETO DO T. JACARAÍPE PARA O POSTO COLISEU',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const bundle = await fetchSchedules('501', { fetcher: mockFetcher })
    expect(bundle.lineId).toBe('0501')
    expect(bundle.lineCode).toBe('501')
    expect(bundle.effectiveDate).toBe('12/08/2026')
    expect(bundle.days.uteis.terminals).toHaveLength(1)
    expect(bundle.days.uteis.terminals[0].departures).toHaveLength(2)
    expect(bundle.days.uteis.terminals[0].departures[1].noteCode).toBe('L')
    expect(bundle.days.sabado.terminals[0].terminalName).toBe('TERMINAL ITAPARICA')
    expect(bundle.observations).toEqual([
      { code: 'L', description: 'VOLTA DIRETO DO T. JACARAÍPE PARA O POSTO COLISEU' },
    ])
  })

  it('separa itinerário em Ida (Sentido I) e Volta (Sentido V) ordenado por Sequencia', async () => {
    const mockFetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          line: '0501',
          itinerary: [
            {
              Desc_Via: 'AV. FERNANDO FERRARI          ',
              Descricao_Linha: 'LINHA 501',
              Linha: '0501',
              Sentido: 'I',
              Sequencia: 2,
            },
            {
              Desc_Via: 'TERMINAL JACARAÍPE            ',
              Descricao_Linha: 'LINHA 501',
              Linha: '0501',
              Sentido: 'I',
              Sequencia: 1,
            },
            {
              Desc_Via: 'TERMINAL ITAPARICA            ',
              Descricao_Linha: 'LINHA 501',
              Linha: '0501',
              Sentido: 'V',
              Sequencia: 1,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    const itin = await fetchItinerary('501', { fetcher: mockFetcher })
    expect(itin.ida.map((s) => s.street)).toEqual(['TERMINAL JACARAÍPE', 'AV. FERNANDO FERRARI'])
    expect(itin.volta.map((s) => s.street)).toEqual(['TERMINAL ITAPARICA'])
  })

  it('retorna integrações temporais, tarifas e sugestões desacopladas em calculateRoute', async () => {
    const failFetcher: typeof fetch = async () => new Response('err', { status: 500 })
    const integrations = await fetchTemporalIntegration({ fetcher: failFetcher })
    expect(integrations.length).toBeGreaterThan(0)
    expect(integrations[0]).toHaveProperty('tempo_para_integracao')

    const fares = await fetchFares({ fetcher: failFetcher })
    expect(fares.modals.some((m) => m.category === 'Transcol')).toBe(true)

    const route = await calculateRoute('Laranjeiras', 'Vila Velha')
    expect(route.status).toBe('preview')
    expect(route.suggestedDirectLines.length).toBeGreaterThan(0)
  })

  it('Worker faz proxy e cache em memória das rotas /ceturb/lines e /ceturb/schedules com CORS', async () => {
    let upstreamCalls = 0
    const mockFetcher: typeof fetch = async (input) => {
      upstreamCalls += 1
      const url = String(input)
      if (url.includes('ConsultaLinha')) {
        return new Response(
          JSON.stringify([{ Linha: '0500', Descricao: 'T. VILA VELHA / T. ITACIBÁ' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('[]', { status: 200 })
    }

    const req1 = new Request('https://meu-treino-assistant.workers.dev/ceturb/lines?tipo=T', {
      method: 'GET',
      headers: { Origin: 'https://ianrtaniguchi.github.io' },
    })
    const res1 = await handleRequest(req1, TEST_ENV, { fetcher: mockFetcher, nowMs: 1_000 })
    expect(res1.status).toBe(200)
    expect(res1.headers.get('Access-Control-Allow-Origin')).toBe('https://ianrtaniguchi.github.io')
    const body1 = (await res1.json()) as { lines: unknown[]; cached: boolean }
    expect(body1.cached).toBe(false)
    expect(body1.lines).toHaveLength(1)
    expect(upstreamCalls).toBe(1)

    // Segunda chamada dentro do TTL deve vir do cache em memória sem bater na API da Ceturb
    const req2 = new Request('https://meu-treino-assistant.workers.dev/ceturb/lines?tipo=T', {
      method: 'GET',
      headers: { Origin: 'https://ianrtaniguchi.github.io' },
    })
    const res2 = await handleRequest(req2, TEST_ENV, { fetcher: mockFetcher, nowMs: 5_000 })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { lines: unknown[]; cached: boolean }
    expect(body2.cached).toBe(true)
    expect(upstreamCalls).toBe(1)
  })
})
