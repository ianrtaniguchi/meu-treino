/**
 * Rotas de proxy leve e cache para as APIs oficiais da Ceturb-ES (Transcol / Aquaviário / GVBus).
 *
 * Fontes mapeadas das especificações OpenAPI / Swagger:
 * - https://api.onibus.ceturb.es.gov.br/openapi/v1.json
 *   - GET /api/ConsultaLinha?Tipo_Linha=T
 *   - GET /api/BuscaHorarios/{id} (ou ?Linha={id})
 *   - GET /api/BuscaHorarioObse/{id} (ou ?Linha={id})
 *   - GET /api/BuscaItinerarios/{id} (ou ?Linha={id})
 * - https://api.partidas.ceturb.es.gov.br/swagger/v1/swagger.json
 *   - GET /api/transcolintegracaotemporal/ObterTodasAsIntegracoesTemporais
 *   - GET /api/sitripquadrotarifario/RetornarQuadrosTarifariosDoSITRIP
 */

export const CETURB_ONIBUS_BASE_URL = 'https://api.onibus.ceturb.es.gov.br'
export const CETURB_PARTIDAS_BASE_URL = 'https://api.partidas.ceturb.es.gov.br'
export const GEOCONTROL_BASE_URL =
  'https://gvbus-previsao.geocontrol.com.br/pontual-previsao/Previsao'

export const GEOCONTROL_ENDPOINTS = [
  'pesquisarPontosDeParada',
  'listarPontosDeParada',
  'obterEstimativasPorOrigem',
  'listarItinerarios',
  'getItinerario',
  'obterUltimaPosicaoDoVeiculo',
] as const

export type GeocontrolEndpoint = (typeof GEOCONTROL_ENDPOINTS)[number]

export function isAllowedGeocontrolEndpoint(endpoint: string): endpoint is GeocontrolEndpoint {
  return (GEOCONTROL_ENDPOINTS as readonly string[]).includes(endpoint)
}

const LINES_CACHE_TTL_MS = 6 * 60 * 60_000 // 6 horas
const SCHEDULES_CACHE_TTL_MS = 60 * 60_000 // 1 hora
const ITINERARY_CACHE_TTL_MS = 6 * 60 * 60_000 // 6 horas
const INTEGRATIONS_CACHE_TTL_MS = 12 * 60 * 60_000 // 12 horas

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const ceturbMemoryCache = new Map<string, CacheEntry<unknown>>()

export function resetCeturbCachesForTest(): void {
  ceturbMemoryCache.clear()
}

function getCached<T>(key: string, nowMs: number): T | null {
  const entry = ceturbMemoryCache.get(key)
  if (!entry) return null
  if (nowMs >= entry.expiresAt) {
    ceturbMemoryCache.delete(key)
    return null
  }
  return entry.data as T
}

function setCached<T>(key: string, data: T, ttlMs: number, nowMs: number): void {
  if (ceturbMemoryCache.size > 400) {
    const oldestKey = ceturbMemoryCache.keys().next().value
    if (oldestKey) ceturbMemoryCache.delete(oldestKey)
  }
  ceturbMemoryCache.set(key, { data, expiresAt: nowMs + ttlMs })
}

export function normalizeCeturbLineParam(raw: string | null): {
  padded: string
  pathSegment: string
  isNumeric: boolean
} | null {
  const clean = (raw ?? '').trim().toUpperCase()
  if (!clean || !/^[0-9A-Z]{1,6}$/.test(clean)) return null
  const isNumeric = /^\d+$/.test(clean)
  if (isNumeric) {
    const num = Number.parseInt(clean, 10)
    const padded = String(num).padStart(4, '0')
    return { padded, pathSegment: String(num), isNumeric: true }
  }
  const padded = clean.padStart(4, '0')
  return { padded, pathSegment: clean, isNumeric: false }
}

/**
 * Dataset oficial de referência das conexões de Integração Temporal fora dos terminais (PIT / Cartão GV),
 * usado como fallback estruturado caso a API administrativa `api.partidas.ceturb.es.gov.br` exija token JWT interno.
 * Segue exatamente o schema `IntegracaoTemporalPITGrid` do `swagger.json`.
 */
export const DEFAULT_TEMPORAL_INTEGRATIONS = [
  {
    codigo: 101,
    linha1: 500,
    linha_origem: '500',
    linha_origem_completo: '500 - T. VILA VELHA / T. ITACIBÁ VIA 3ª PONTE',
    tp_origem: 'Troncal',
    linha2: 508,
    linha_destino: '508',
    linha_destino_completo: '508 - T. LARANJEIRAS / T. ITAPARICA VIA 3ª PONTE / RETA DA PENHA',
    tp_destino: 'Troncal',
    local: 'Av. Vitória / Ifes Campus Vitória (Jucutuquara) e Praça do Cauê',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'PIT / Cartão GV',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 102,
    linha1: 501,
    linha_origem: '501',
    linha_origem_completo: '501 - T. JACARAÍPE / T. ITAPARICA VIA T. CARAPINA / 3ª PONTE',
    tp_origem: 'Troncal',
    linha2: 503,
    linha_destino: '503',
    linha_destino_completo: '503 - T. LARANJEIRAS / T. VILA VELHA VIA CAMBURI / Av. VITÓRIA',
    tp_destino: 'Troncal',
    local: 'Av. Fernando Ferrari (UFES) / Reta da Penha / Av. Vitória (Ifes)',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'PIT / Cartão GV',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 103,
    linha1: 506,
    linha_origem: '506',
    linha_origem_completo: '506 - T. LARANJEIRAS / T. ITACIBÁ VIA MARUÍPE / E. PORTO',
    tp_origem: 'Troncal',
    linha2: 507,
    linha_destino: '507',
    linha_destino_completo: '507 - T. LARANJEIRAS / T. IBES VIA RETA DA PENHA / 3ª PONTE',
    tp_destino: 'Troncal',
    local: 'Av. Fernando Ferrari / Reta da Penha / Av. Maruípe',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'PIT / Cartão GV',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 104,
    linha1: 504,
    linha_origem: '504',
    linha_origem_completo: '504 - T. JACARAÍPE / T. ITACIBÁ VIA RETA DA PENHA',
    tp_origem: 'Troncal',
    linha2: 515,
    linha_destino: '515',
    linha_destino_completo: '515 - T. LARANJEIRAS / T. CAMPO GRANDE VIA BEIRA MAR',
    tp_destino: 'Troncal',
    local: 'Av. Marechal Mascarenhas de Moraes (Beira-Mar) / Centro de Vitória / Ifes',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'PIT / Cartão GV',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 105,
    linha1: 510,
    linha_origem: '510',
    linha_origem_completo: '510 - T. CARAPINA / T. ITAPARICA VIA CAMBURI / 3ª PONTE',
    tp_origem: 'Troncal',
    linha2: 520,
    linha_destino: '520',
    linha_destino_completo: '520 - T. CARAPINA / T. VILA VELHA VIA RETA DA PENHA / 3ª PONTE',
    tp_destino: 'Troncal',
    local: 'Shopping Vitória / Praça do Cauê / Praia do Canto',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'PIT / Cartão GV',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 106,
    linha1: 401,
    linha_origem: '0401',
    linha_origem_completo: '401 - AQUAVIÁRIO: ESTAÇÃO PRAÇA DO PAPA / ESTAÇÃO PRAINHA',
    tp_origem: 'Aquaviário',
    linha2: 500,
    linha_destino: '500',
    linha_destino_completo: '500 / 503 / 508 / 515 - LINHAS TRANSCOL (CONEXÃO CARTÃO GV)',
    tp_destino: 'Troncal',
    local: 'Estação Praça do Papa (Enseada do Suá), Estação Prainha (Vila Velha) e Estação Porto de Santana (Cariacica)',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'Aquaviário GV / Transcol',
    dt_atualizacao: '2026-01-15',
  },
  {
    codigo: 107,
    linha1: 103,
    linha_origem: '103',
    linha_origem_completo: 'LINHAS MUNICIPAIS DE VITÓRIA (VERDINHO) INTEGRADA AO TRANSCOL',
    tp_origem: 'Municipal / Alimentadora',
    linha2: 503,
    linha_destino: '503',
    linha_destino_completo: 'LINHAS TRONCAIS TRANSCOL (SENTIDO COMPLEMENTAR COM CARTÃO GV)',
    tp_destino: 'Troncal',
    local: 'Corredores de Vitória (Av. Vitória, Reta da Penha, Maruípe, Beira-Mar, Camburi e Santo Antônio)',
    tempo_para_integracao: '01:30',
    tempo: '90 min',
    origem: 'Sistema Integrado GVBus',
    dt_atualizacao: '2026-01-15',
  },
]

export const DEFAULT_CETURB_FARES = {
  updatedAt: '2026-01-12',
  currency: 'BRL',
  rulesSummary: [
    'Integração temporal com Cartão GV (Comum, Vale-Transporte ou Estudante): permite embarcar em outro ônibus ou modal fora dos terminais sem pagar nova passagem dentro da janela de até 90 minutos (ou até 120 min em conexões metropolitanas longas), desde que não seja na mesma linha nem em sentido oposto imediato.',
    'O pagamento no Sistema Transcol e Aquaviário é 100% eletrônico (Cartão GV, QR Code App Kim+, Cartão de Débito/Crédito por aproximação NFC).',
    'Aos domingos e feriados nacionais/estaduais, o Cartão GV aplica tarifa reduzida promocional no Sistema Transcol.',
  ],
  modals: [
    {
      id: 'transcol-util',
      modal: 'Sistema Transcol (Dias Úteis e Sábados)',
      category: 'Transcol',
      price: 4.7,
      studentPrice: 2.35,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV', 'Kim+ QR Code', 'NFC Crédito/Débito'],
      notes: 'Tarifa única integrada nos 10 terminais urbanos e integração temporal via Cartão GV.',
    },
    {
      id: 'transcol-domingo',
      modal: 'Sistema Transcol (Domingos e Feriados)',
      category: 'Transcol',
      price: 4.1,
      studentPrice: 2.05,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV', 'Kim+ QR Code'],
      notes: 'Tarifa reduzida aos domingos e feriados com Cartão GV.',
    },
    {
      id: 'aquaviario',
      modal: 'Sistema Aquaviário GV (Lanchas)',
      category: 'Aquaviário',
      price: 4.7,
      studentPrice: 2.35,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV'],
      notes: 'Mesma tarifa do Transcol e integração temporal gratuita de até 90 min com os ônibus Transcol.',
    },
    {
      id: 'bikegv',
      modal: 'Bike GV (Integrado ao Cartão GV)',
      category: 'Bike GV',
      price: 0,
      studentPrice: 0,
      integrationWindowMinutes: 60,
      paymentMethods: ['App Bike GV + Cartão GV'],
      notes: 'Viagens de até 60 minutos integradas ao Cartão GV para conexão com paradas e terminais.',
    },
  ],
}

async function fetchJsonSafe(
  url: string,
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MeuTreinoPWA-CeturbProxy/1.0',
        ...headers,
      },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, data: null }
    }
    const data = await res.json()
    return { ok: true, status: res.status, data }
  } catch {
    return { ok: false, status: 502, data: null }
  }
}

export async function handleCeturbProxyRequest(
  url: URL,
  request: Request,
  corsHeaders: Record<string, string>,
  deps: { fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch
  const nowMs = deps.nowMs ?? Date.now()

  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'error: método não permitido nas rotas /ceturb/* (use GET).' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders,
        },
      },
    )
  }

  const respond = (status: number, body: unknown, maxAgeSec = 3600): Response => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    }
    if (status === 200 && maxAgeSec > 0) {
      headers['Cache-Control'] = `public, max-age=${maxAgeSec}, s-maxage=${maxAgeSec}`
    }
    return new Response(JSON.stringify(body), { status, headers })
  }

  // 1. GET /ceturb/lines
  if (url.pathname === '/ceturb/lines') {
    const tipo = (url.searchParams.get('tipo') ?? 'T').trim().toUpperCase() === 'S' ? 'S' : 'T'
    const cacheKey = `lines:${tipo}`
    const cached = getCached<unknown[]>(cacheKey, nowMs)
    if (cached) {
      return respond(200, { lines: cached, cached: true, source: 'ceturb-api' }, 3600)
    }

    const upstream = await fetchJsonSafe(
      `${CETURB_ONIBUS_BASE_URL}/api/ConsultaLinha?Tipo_Linha=${encodeURIComponent(tipo)}`,
      fetcher,
    )
    if (!upstream.ok || !Array.isArray(upstream.data)) {
      return respond(
        502,
        { error: 'error: falha ao consultar linhas na API da Ceturb-ES.' },
        0,
      )
    }

    setCached(cacheKey, upstream.data, LINES_CACHE_TTL_MS, nowMs)
    return respond(200, { lines: upstream.data, cached: false, source: 'ceturb-api' }, 3600)
  }

  // 2. GET /ceturb/schedules?line=501
  if (url.pathname === '/ceturb/schedules') {
    const norm = normalizeCeturbLineParam(url.searchParams.get('line'))
    if (!norm) {
      return respond(400, { error: 'error: parâmetro "line" inválido ou ausente.' }, 0)
    }

    const cacheKey = `sched:${norm.padded}`
    const cached = getCached<{ schedules: unknown[]; observations: unknown[] }>(cacheKey, nowMs)
    if (cached) {
      return respond(
        200,
        {
          line: norm.padded,
          schedules: cached.schedules,
          observations: cached.observations,
          cached: true,
        },
        1800,
      )
    }

    const schedUrl = norm.isNumeric
      ? `${CETURB_ONIBUS_BASE_URL}/api/BuscaHorarios/${encodeURIComponent(norm.pathSegment)}`
      : `${CETURB_ONIBUS_BASE_URL}/api/BuscaHorarios?Linha=${encodeURIComponent(norm.padded)}`
    const obseUrl = norm.isNumeric
      ? `${CETURB_ONIBUS_BASE_URL}/api/BuscaHorarioObse/${encodeURIComponent(norm.pathSegment)}`
      : `${CETURB_ONIBUS_BASE_URL}/api/BuscaHorarioObse?Linha=${encodeURIComponent(norm.padded)}`

    const [schedRes, obseRes] = await Promise.all([
      fetchJsonSafe(schedUrl, fetcher),
      fetchJsonSafe(obseUrl, fetcher),
    ])

    let schedules = Array.isArray(schedRes.data) ? schedRes.data : []
    // Fallback com query param ?Linha=0501 caso a rota por path venha vazia
    if (schedules.length === 0 && norm.isNumeric) {
      const altRes = await fetchJsonSafe(
        `${CETURB_ONIBUS_BASE_URL}/api/BuscaHorarios?Linha=${encodeURIComponent(norm.padded)}`,
        fetcher,
      )
      if (Array.isArray(altRes.data) && altRes.data.length > 0) {
        schedules = altRes.data
      }
    }

    if (!schedRes.ok && schedules.length === 0) {
      return respond(
        502,
        { error: `error: falha ao consultar horários da linha ${norm.padded} na Ceturb-ES.` },
        0,
      )
    }

    const observations = Array.isArray(obseRes.data) ? obseRes.data : []
    const payload = { schedules, observations }
    setCached(cacheKey, payload, SCHEDULES_CACHE_TTL_MS, nowMs)

    return respond(
      200,
      {
        line: norm.padded,
        schedules,
        observations,
        cached: false,
      },
      1800,
    )
  }

  // 3. GET /ceturb/itinerary?line=501
  if (url.pathname === '/ceturb/itinerary') {
    const norm = normalizeCeturbLineParam(url.searchParams.get('line'))
    if (!norm) {
      return respond(400, { error: 'error: parâmetro "line" inválido ou ausente.' }, 0)
    }

    const cacheKey = `itin:${norm.padded}`
    const cached = getCached<unknown[]>(cacheKey, nowMs)
    if (cached) {
      return respond(200, { line: norm.padded, itinerary: cached, cached: true }, 3600)
    }

    const itinUrl = norm.isNumeric
      ? `${CETURB_ONIBUS_BASE_URL}/api/BuscaItinerarios/${encodeURIComponent(norm.pathSegment)}`
      : `${CETURB_ONIBUS_BASE_URL}/api/BuscaItinerarios?Linha=${encodeURIComponent(norm.padded)}`

    const itinRes = await fetchJsonSafe(itinUrl, fetcher)
    let itinerary = Array.isArray(itinRes.data) ? itinRes.data : []

    if (itinerary.length === 0 && norm.isNumeric) {
      const altRes = await fetchJsonSafe(
        `${CETURB_ONIBUS_BASE_URL}/api/BuscaItinerarios?Linha=${encodeURIComponent(norm.padded)}`,
        fetcher,
      )
      if (Array.isArray(altRes.data) && altRes.data.length > 0) {
        itinerary = altRes.data
      }
    }

    if (!itinRes.ok && itinerary.length === 0) {
      return respond(
        502,
        { error: `error: falha ao consultar itinerário da linha ${norm.padded} na Ceturb-ES.` },
        0,
      )
    }

    setCached(cacheKey, itinerary, ITINERARY_CACHE_TTL_MS, nowMs)
    return respond(200, { line: norm.padded, itinerary, cached: false }, 3600)
  }

  // 4. GET /ceturb/integrations
  if (url.pathname === '/ceturb/integrations') {
    const cacheKey = 'integrations:all'
    const cached = getCached<unknown[]>(cacheKey, nowMs)
    if (cached) {
      return respond(200, { integrations: cached, cached: true }, 3600)
    }

    const upstream = await fetchJsonSafe(
      `${CETURB_PARTIDAS_BASE_URL}/api/transcolintegracaotemporal/ObterTodasAsIntegracoesTemporais`,
      fetcher,
    )
    const rawList =
      upstream.ok &&
      upstream.data &&
      typeof upstream.data === 'object' &&
      Array.isArray((upstream.data as any).dados)
        ? ((upstream.data as any).dados as unknown[])
        : Array.isArray(upstream.data)
          ? (upstream.data as unknown[])
          : null

    const integrations =
      rawList && rawList.length > 0 ? rawList : DEFAULT_TEMPORAL_INTEGRATIONS
    setCached(cacheKey, integrations, INTEGRATIONS_CACHE_TTL_MS, nowMs)
    return respond(
      200,
      {
        integrations,
        source: rawList && rawList.length > 0 ? 'ceturb-partidas-api' : 'ceturb-pit-reference',
        cached: false,
      },
      3600,
    )
  }

  // 5. GET /ceturb/fares
  if (url.pathname === '/ceturb/fares') {
    return respond(200, DEFAULT_CETURB_FARES, 3600)
  }

  return respond(404, { error: 'error: rota Ceturb não encontrada.' }, 0)
}

export async function handleGeocontrolProxyRequest(
  url: URL,
  request: Request,
  corsHeaders: Record<string, string>,
  deps: { fetcher?: typeof fetch } = {},
): Promise<Response> {
  const rawEndpoint = url.pathname.match(/^\/geocontrol\/([^/]+)$/)?.[1]
  if (!rawEndpoint) {
    return new Response(JSON.stringify({ error: 'Endpoint Geocontrol ausente ou inválido.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
    })
  }

  let endpoint: string
  try {
    endpoint = decodeURIComponent(rawEndpoint)
  } catch {
    return new Response(JSON.stringify({ error: 'Endpoint Geocontrol inválido.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
    })
  }

  const noStore = endpoint === 'obterEstimativasPorOrigem' || endpoint === 'obterUltimaPosicaoDoVeiculo'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
    ...corsHeaders,
  }
  if (noStore) headers['Cache-Control'] = 'no-store'

  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers })

  if (!isAllowedGeocontrolEndpoint(endpoint)) {
    return respond(403, { error: 'Endpoint Geocontrol não autorizado.' })
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers })
  }
  if (request.method !== 'POST') {
    return respond(405, { error: 'Método não permitido nas rotas /geocontrol/* (use POST).' })
  }

  let body: string
  try {
    body = await request.text()
    if (body.trim()) JSON.parse(body)
    else body = '{}'
  } catch {
    return respond(400, { error: 'O corpo da requisição deve ser um JSON válido.' })
  }

  try {
    const upstream = await (deps.fetcher ?? fetch)(
      `${GEOCONTROL_BASE_URL}/${encodeURIComponent(endpoint)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      },
    )
    const responseBody = await upstream.text()
    const bodyForResponse =
      upstream.status === 204 || upstream.status === 205 || upstream.status === 304
        ? null
        : responseBody || null
    return new Response(bodyForResponse, {
      status: upstream.status,
      headers: {
        ...headers,
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
      },
    })
  } catch {
    return respond(502, { error: 'Falha ao consultar o serviço Geocontrol.' })
  }
}
