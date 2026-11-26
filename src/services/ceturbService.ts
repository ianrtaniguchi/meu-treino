import { ASSISTANT_WORKER_URL } from '../assistantConfig'
import type {
  CeturbDayScheduleGroup,
  CeturbDayTab,
  CeturbDepartureSlot,
  CeturbFareBundle,
  CeturbItineraryRaw,
  CeturbLine,
  CeturbLineItineraryBundle,
  CeturbLineRaw,
  CeturbLineScheduleBundle,
  CeturbModalCategory,
  CeturbObservation,
  CeturbObservationRaw,
  CeturbScheduleRaw,
  CeturbStreetStop,
  IntegracaoTemporalPITGrid,
  RouteCalculationResult,
  RouteCalculationSuggestion,
} from '../types/ceturb'

const DIRECT_CETURB_ONIBUS_URL = 'https://api.onibus.ceturb.es.gov.br'

const STORAGE_KEY_LINES = 'meu_treino_ceturb_lines_v1'
const STORAGE_KEY_FAVORITES = 'meu_treino_ceturb_favorites_v1'
const STORAGE_KEY_RECENTS = 'meu_treino_ceturb_recents_v1'
const STORAGE_KEY_SCHED_PREFIX = 'meu_treino_ceturb_sched_v1_'
const STORAGE_KEY_ITIN_PREFIX = 'meu_treino_ceturb_itin_v1_'
const STORAGE_KEY_INTEGRATIONS = 'meu_treino_ceturb_integrations_v1'
const STORAGE_KEY_FARES = 'meu_treino_ceturb_fares_v1'

const LOCAL_LINES_TTL_MS = 24 * 60 * 60_000 // 24h
const LOCAL_SCHED_TTL_MS = 6 * 60 * 60_000 // 6h
const LOCAL_ITIN_TTL_MS = 24 * 60 * 60_000 // 24h

/**
 * Fallback local com as principais linhas da Grande Vitória (Transcol + Aquaviário + Bike GV)
 * para garantir funcionamento imediato mesmo totalmente offline no 1º uso.
 */
export const FALLBACK_CETURB_LINES_RAW: CeturbLineRaw[] = [
  { Linha: '0500', Descricao: 'T. VILA VELHA / T. ITACIBÁ VIA 3ª PONTE' },
  { Linha: '0501', Descricao: 'T. JACARAIPE / T. ITAPARICA VIA T. CARAPINA/3ª PONTE' },
  { Linha: '0502', Descricao: 'T. LARANJEIRAS / T. ITACIBÁ VIA RETA DA PENHA' },
  { Linha: '0503', Descricao: 'T. LARANJEIRAS / T. VILA VELHA VIA CAMBURI / AV. VITÓRIA' },
  { Linha: '0504', Descricao: 'T. JACARAÍPE / T. ITACIBÁ VIA RETA DA PENHA' },
  { Linha: '0505', Descricao: 'T. LARANJEIRAS / T. ITACIBÁ VIA CAMBURI / BEIRA MAR' },
  { Linha: '0506', Descricao: 'T. LARANJEIRAS / T. ITACIBÁ VIA MARUÍPE / E. PORTO' },
  { Linha: '0507', Descricao: 'T. LARANJEIRAS / T. IBES VIA RETA DA PENHA / 3ª PONTE' },
  { Linha: '0508', Descricao: 'T. LARANJEIRAS / T. ITAPARICA VIA 3ª PONTE / RETA DA PENHA' },
  { Linha: '0509', Descricao: 'T. CARAPINA / T. CAMPO GRANDE VIA AV. VITÓRIA / BEIRA MAR' },
  { Linha: '0510', Descricao: 'T. CARAPINA / T. ITAPARICA VIA CAMBURI / 3ª PONTE' },
  { Linha: '0514', Descricao: 'T. VILA VELHA / T. IBES VIA T. SÃO TORQUATO' },
  { Linha: '0515', Descricao: 'T. LARANJEIRAS / T. CAMPO GRANDE VIA BEIRA MAR' },
  { Linha: '0516', Descricao: 'T. JACARAÍPE / T. SÃO TORQUATO VIA MARUÍPE' },
  { Linha: '0518', Descricao: 'T. LARANJEIRAS / T. IBES VIA SERAFIM DERENZI' },
  { Linha: '0519', Descricao: 'T. CARAPINA / T. IBES VIA RETA DA PENHA / 3ª PONTE' },
  { Linha: '0520', Descricao: 'T. CARAPINA / T. VILA VELHA VIA RETA DA PENHA / 3ª PONTE' },
  { Linha: '0525', Descricao: 'T. VILA VELHA / T. ITACIBÁ VIA T. JARDIM AMÉRICA' },
  { Linha: '0526', Descricao: 'T. CAMPO GRANDE / T. ITAPARICA VIA T. JARDIM AMÉRICA' },
  { Linha: '0535', Descricao: 'T. CARAPINA / T. CAMPO GRANDE VIA T. JARDIM AMÉRICA / SERAFIM DERENZI' },
  { Linha: '0551', Descricao: 'T. JACARAÍPE / T. ITAPARICA VIA 3ª PONTE - EXPRESSO' },
  { Linha: '0559', Descricao: 'T. LARANJEIRAS / T. SÃO TORQUATO VIA MARUÍPE' },
  { Linha: '0560', Descricao: 'T. LARANJEIRAS / T. ITAPARICA VIA CAMBURI / 3ª PONTE' },
  { Linha: '0572', Descricao: 'T. LARANJEIRAS / T. SÃO TORQUATO VIA CAMBURI / AV. VITÓRIA' },
  { Linha: '0591', Descricao: 'SERRA / T. CAMPO GRANDE VIA T. CARAPINA / BR-101' },
  { Linha: '0800', Descricao: 'T. LARANJEIRAS / SERRA SEDE' },
  { Linha: '0400', Descricao: 'BIKE GV' },
  { Linha: '0401', Descricao: 'ESTAÇÃO PRAÇA DO PAPA / ESTAÇÃO PRAINHA (AQUAVIÁRIO)' },
  { Linha: '0402', Descricao: 'ESTAÇÃO PORTO DE SANTANA / ESTAÇÃO PRAÇA DO PAPA (AQUAVIÁRIO)' },
  { Linha: '0403', Descricao: 'ESTAÇÃO PORTO DE SANTANA / ESTAÇÃO PRAINHA (AQUAVIÁRIO)' },
]

export const FALLBACK_TEMPORAL_INTEGRATIONS: IntegracaoTemporalPITGrid[] = [
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
    linha_destino_completo: '503 - T. LARANJEIRAS / T. VILA VELHA VIA CAMBURI / AV. VITÓRIA',
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
    linha_origem_completo: 'LINHAS MUNICIPAIS DE VITÓRIA (VERDINHO) INTEGRADAS AO TRANSCOL',
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

export const FALLBACK_FARES: CeturbFareBundle = {
  updatedAt: '2026-01-12',
  currency: 'BRL',
  rulesSummary: [
    'Cartão GV: integração gratuita em até 90 min fora dos terminais (linhas e sentidos complementares).',
    'Pagamento 100% eletrônico (Cartão GV, QR Code Kim+ e NFC).',
    'Domingos e feriados: tarifa reduzida no Transcol com Cartão GV.',
  ],
  modals: [
    {
      id: 'transcol-util',
      modal: 'Transcol (Dias Úteis / Sábados)',
      category: 'Transcol',
      price: 4.7,
      studentPrice: 2.35,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV', 'Kim+ QR Code', 'NFC'],
      notes: 'Integração nos 10 terminais e temporal via Cartão GV.',
    },
    {
      id: 'transcol-domingo',
      modal: 'Transcol (Domingos / Feriados)',
      category: 'Transcol',
      price: 4.1,
      studentPrice: 2.05,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV', 'Kim+ QR Code'],
      notes: 'Tarifa reduzida aos domingos e feriados.',
    },
    {
      id: 'aquaviario',
      modal: 'Aquaviário GV',
      category: 'Aquaviário',
      price: 4.7,
      studentPrice: 2.35,
      integrationWindowMinutes: 90,
      paymentMethods: ['Cartão GV'],
      notes: 'Integrado ao Transcol com Cartão GV.',
    },
    {
      id: 'bikegv',
      modal: 'Bike GV',
      category: 'Bike GV',
      price: 0,
      studentPrice: 0,
      integrationWindowMinutes: 60,
      paymentMethods: ['App Bike GV + Cartão GV'],
      notes: 'Viagens de até 60 min integradas ao Cartão GV.',
    },
  ],
}

// ---------- Utilitários de Normalização e Storage ----------

function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
      return (globalThis as any).localStorage as Storage
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
  } catch {
    // ignore
  }
  return null
}

function readStorageJson<T>(key: string): T | null {
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeStorageJson(key: string, value: unknown): void {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignora QuotaExceededError
  }
}

/**
 * Converte código da Ceturb (ex.: "0500", "0073", "073N", "501") em formato padronizado:
 * - `id`: 4 caracteres com zero à esquerda ("0500", "0073", "073N")
 * - `code`: sem zeros à esquerda desnecessários ("500", "73", "73N")
 */
export function normalizeLineCode(rawCode: string): { id: string; code: string } {
  const trimmed = String(rawCode ?? '').trim().toUpperCase()
  if (!trimmed) return { id: '0000', code: '0' }
  const id = trimmed.padStart(4, '0')
  const stripped = trimmed.replace(/^0+(?=[1-9A-Z])/, '') || '0'
  return { id, code: stripped }
}

export function inferModalCategory(id: string, name: string): CeturbModalCategory {
  const upperName = name.toUpperCase()
  if (id === '0400' || upperName.includes('BIKE GV')) return 'bikegv'
  if (id === '0401' || id === '0402' || id === '0403' || upperName.includes('ESTAÇÃO ')) {
    return 'aquaviario'
  }
  const num = Number.parseInt(id.replace(/\D/g, ''), 10)
  if (Number.isFinite(num) && num >= 500 && num <= 599) return 'transcol'
  return 'alimentadora'
}

export function mapRawLineToCeturbLine(raw: CeturbLineRaw): CeturbLine {
  const { id, code } = normalizeLineCode(raw.Linha)
  const name = String(raw.Descricao ?? '').trim().replace(/\s+/g, ' ')
  return {
    id,
    code,
    name,
    category: inferModalCategory(id, name),
  }
}

export function removeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function filterLines(lines: CeturbLine[], query: string): CeturbLine[] {
  const q = removeAccents(query.trim())
  if (!q) return lines

  // Expansão inteligente para termos populares como "ifes", "ufes", "3 ponte", "camburi"
  const aliases: Record<string, string[]> = {
    ifes: ['av. vitoria', 'jucutuquara', '500', '503', '504', '506', '509', '515', '572'],
    ufes: ['reta da penha', 'fernando ferrari', '501', '502', '504', '506', '507', '508', '520'],
    aquaviario: ['0401', '0402', '0403', 'estacao praca do papa', 'estacao prainha', 'porto de santana'],
  }
  const extraMatches = aliases[q] ?? []

  return lines.filter((line) => {
    const codeNorm = line.code.toLowerCase()
    const idNorm = line.id.toLowerCase()
    const nameNorm = removeAccents(line.name)
    if (codeNorm.includes(q) || idNorm.includes(q) || nameNorm.includes(q)) {
      return true
    }
    return extraMatches.some(
      (alias) => codeNorm === alias || idNorm === alias || nameNorm.includes(alias),
    )
  })
}

// ---------- Favoritos e Recentes (localStorage isolado por UID quando autenticado) ----------

function getScopedFavoritesKey(): string {
  const storage = getStorage()
  const activeUid = storage?.getItem('meu_treino_active_uid')?.trim()
  return activeUid ? `${STORAGE_KEY_FAVORITES}_${activeUid}` : STORAGE_KEY_FAVORITES
}

export function getFavoriteLineIds(): string[] {
  const key = getScopedFavoritesKey()
  const list = readStorageJson<unknown>(key) ?? readStorageJson<unknown>(STORAGE_KEY_FAVORITES)
  if (!Array.isArray(list)) return []
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => normalizeLineCode(x).id)
}

export function toggleFavoriteLineId(lineId: string): string[] {
  const normId = normalizeLineCode(lineId).id
  const current = getFavoriteLineIds()
  const next = current.includes(normId)
    ? current.filter((id) => id !== normId)
    : [normId, ...current]
  writeStorageJson(getScopedFavoritesKey(), next)
  return next
}

export function getRecentLineIds(): string[] {
  const list = readStorageJson<unknown>(STORAGE_KEY_RECENTS)
  if (!Array.isArray(list)) return []
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => normalizeLineCode(x).id)
}

export function recordRecentLineId(lineId: string): string[] {
  const normId = normalizeLineCode(lineId).id
  const current = getRecentLineIds().filter((id) => id !== normId)
  const next = [normId, ...current].slice(0, 8)
  writeStorageJson(STORAGE_KEY_RECENTS, next)
  return next
}

// ---------- Cálculo de Horários e Próxima Saída ----------

export function parseTimeToMinutes(timeStr: string): number | null {
  const m = String(timeStr ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hh = Number.parseInt(m[1], 10)
  const mm = Number.parseInt(m[2], 10)
  if (hh < 0 || hh > 29 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

export function getActiveDayTabForDate(now = new Date()): CeturbDayTab {
  const day = now.getDay() // 0 = Domingo, 6 = Sábado
  if (day === 0) return 'domingo'
  if (day === 6) return 'sabado'
  return 'uteis'
}

export function mapRawDayToTab(tpHorario: number, descricaoHora: string): CeturbDayTab | null {
  if (tpHorario === 1) return 'uteis'
  if (tpHorario === 2) return 'sabado'
  if (tpHorario === 3) return 'domingo'
  const desc = removeAccents(String(descricaoHora ?? ''))
  if (desc.includes('uteis') || desc.includes('util')) return 'uteis'
  if (desc.includes('sabado')) return 'sabado'
  if (desc.includes('domingo') || desc.includes('feriado')) return 'domingo'
  return null
}

/**
 * Encontra o próximo horário de saída com base no relógio atual.
 * Retorna o slot, quantos minutos faltam e o índice na lista ordenada.
 */
export function findNextDeparture(
  departures: CeturbDepartureSlot[],
  now = new Date(),
): {
  slot: CeturbDepartureSlot
  index: number
  minutesUntil: number
  isTomorrow: boolean
} | null {
  if (!departures || departures.length === 0) return null
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  for (let i = 0; i < departures.length; i++) {
    const slot = departures[i]
    if (slot.minutesFromMidnight >= currentMinutes) {
      return {
        slot,
        index: i,
        minutesUntil: slot.minutesFromMidnight - currentMinutes,
        isTomorrow: false,
      }
    }
  }

  // Se já passaram todos os ônibus do dia, aponta o primeiro do próximo ciclo
  const first = departures[0]
  return {
    slot: first,
    index: 0,
    minutesUntil: 24 * 60 - currentMinutes + first.minutesFromMidnight,
    isTomorrow: true,
  }
}

export function normalizeScheduleBundle(
  lineId: string,
  rawSchedules: CeturbScheduleRaw[],
  rawObservations: CeturbObservationRaw[],
  fallbackLineName = '',
  nowMs = Date.now(),
): CeturbLineScheduleBundle {
  const { id, code } = normalizeLineCode(lineId)

  const emptyDays: Record<CeturbDayTab, CeturbDayScheduleGroup> = {
    uteis: { dayTab: 'uteis', label: 'Dias Úteis', terminals: [] },
    sabado: { dayTab: 'sabado', label: 'Sábados', terminals: [] },
    domingo: { dayTab: 'domingo', label: 'Domingos e Feriados', terminals: [] },
  }

  const terminalBuckets: Record<
    CeturbDayTab,
    Map<string, { terminalName: string; terminalSeq: number; slots: Map<string, CeturbDepartureSlot> }>
  > = {
    uteis: new Map(),
    sabado: new Map(),
    domingo: new Map(),
  }

  let lineName = fallbackLineName
  let effectiveDate: string | null = null

  for (const row of rawSchedules) {
    if (!row || typeof row !== 'object') continue
    if (!lineName && typeof row.Descricao_Linha === 'string' && row.Descricao_Linha.trim()) {
      lineName = row.Descricao_Linha.trim()
    }
    if (!effectiveDate && typeof row.Dt_Inicio === 'string' && row.Dt_Inicio.trim()) {
      effectiveDate = row.Dt_Inicio.trim()
    }

    const dayTab = mapRawDayToTab(Number(row.TP_Horario), String(row.Descricao_Hora ?? ''))
    if (!dayTab) continue

    const time = String(row.Hora_Saida ?? '').trim()
    const mins = parseTimeToMinutes(time)
    if (mins === null) continue

    const terminalName = String(row.Desc_Terminal ?? 'TERMINAL').trim() || 'TERMINAL'
    const terminalSeq = Number(row.Terminal_Seq) || 1
    const rawNote = String(row.Tipo_Orientacao ?? '').trim()
    const noteCode = rawNote.length > 0 ? rawNote : null

    const dayMap = terminalBuckets[dayTab]
    const termKey = `${terminalSeq}:${terminalName}`
    let termGroup = dayMap.get(termKey)
    if (!termGroup) {
      termGroup = { terminalName, terminalSeq, slots: new Map() }
      dayMap.set(termKey, termGroup)
    }

    const slotKey = `${time}:${noteCode ?? ''}`
    if (!termGroup.slots.has(slotKey)) {
      termGroup.slots.set(slotKey, {
        time,
        minutesFromMidnight: mins,
        noteCode,
      })
    }
  }

  for (const dayTab of ['uteis', 'sabado', 'domingo'] as CeturbDayTab[]) {
    const groups = Array.from(terminalBuckets[dayTab].values()).sort(
      (a, b) => a.terminalSeq - b.terminalSeq || a.terminalName.localeCompare(b.terminalName),
    )
    emptyDays[dayTab].terminals = groups.map((g) => ({
      terminalName: g.terminalName,
      terminalSeq: g.terminalSeq,
      departures: Array.from(g.slots.values()).sort(
        (a, b) => a.minutesFromMidnight - b.minutesFromMidnight,
      ),
    }))
  }

  const obsMap = new Map<string, CeturbObservation>()
  for (const ob of rawObservations) {
    if (!ob || typeof ob !== 'object') continue
    const codeStr = String(ob.Tipo_Orientacao ?? '').trim()
    const descStr = String(ob.Descricao_Orientacao ?? '').trim().replace(/\s+/g, ' ')
    if (codeStr && descStr && !obsMap.has(codeStr)) {
      obsMap.set(codeStr, { code: codeStr, description: descStr })
    }
  }

  return {
    lineId: id,
    lineCode: code,
    lineName: lineName || `Linha ${code}`,
    effectiveDate,
    days: emptyDays,
    observations: Array.from(obsMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
    fetchedAt: nowMs,
  }
}

export function normalizeItineraryBundle(
  lineId: string,
  rawList: CeturbItineraryRaw[],
  fallbackLineName = '',
  nowMs = Date.now(),
): CeturbLineItineraryBundle {
  const { id, code } = normalizeLineCode(lineId)
  let lineName = fallbackLineName

  const ida: CeturbStreetStop[] = []
  const volta: CeturbStreetStop[] = []

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    if (!lineName && typeof item.Descricao_Linha === 'string' && item.Descricao_Linha.trim()) {
      lineName = item.Descricao_Linha.trim()
    }
    const street = String(item.Desc_Via ?? '').trim().replace(/\s+/g, ' ')
    if (!street) continue
    const sequence = Number(item.Sequencia) || 0
    const sentido = String(item.Sentido ?? 'I').trim().toUpperCase()
    if (sentido === 'V') {
      volta.push({ sequence, street })
    } else {
      ida.push({ sequence, street })
    }
  }

  ida.sort((a, b) => a.sequence - b.sequence)
  volta.sort((a, b) => a.sequence - b.sequence)

  return {
    lineId: id,
    lineCode: code,
    lineName: lineName || `Linha ${code}`,
    ida,
    volta,
    fetchedAt: nowMs,
  }
}

// ---------- Funções Principais de Serviço (ceturbService) ----------

export interface CeturbServiceOptions {
  fetcher?: typeof fetch
  forceRefresh?: boolean
  workerBaseUrl?: string
}

function getWorkerBaseUrl(override?: string): string {
  return (override ?? ASSISTANT_WORKER_URL ?? '').trim().replace(/\/+$/, '')
}

/**
 * 1. `fetchLines()`: Lista todas as linhas do sistema Transcol / Aquaviário / Bike GV.
 * Usa cache local (`localStorage`), proxy com cache do Cloudflare Worker e fallback direto/offline.
 */
export async function fetchLines(options: CeturbServiceOptions = {}): Promise<CeturbLine[]> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = Date.now()

  if (!options.forceRefresh) {
    const cached = readStorageJson<{ lines: CeturbLine[]; savedAt: number }>(STORAGE_KEY_LINES)
    if (cached && Array.isArray(cached.lines) && cached.lines.length > 0) {
      if (nowMs - cached.savedAt < LOCAL_LINES_TTL_MS) {
        return cached.lines
      }
    }
  }

  const workerUrl = getWorkerBaseUrl(options.workerBaseUrl)
  let rawLines: CeturbLineRaw[] | null = null

  // Tenta via proxy do Cloudflare Worker primeiro (evita bloqueio de CORS no navegador)
  if (workerUrl) {
    try {
      const res = await fetcher(`${workerUrl}/ceturb/lines?tipo=T`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { lines?: unknown }
        if (Array.isArray(json?.lines) && json.lines.length > 0) {
          rawLines = json.lines as CeturbLineRaw[]
        }
      }
    } catch {
      // prossegue para fallback direto ou cache
    }
  }

  // Fallback direto na API da Ceturb caso o Worker não esteja acessível no ambiente
  if (!rawLines) {
    try {
      const res = await fetcher(`${DIRECT_CETURB_ONIBUS_URL}/api/ConsultaLinha?Tipo_Linha=T`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as unknown
        if (Array.isArray(json) && json.length > 0) {
          rawLines = json as CeturbLineRaw[]
        }
      }
    } catch {
      // usa cache local expirado ou fallback embutido
    }
  }

  if (rawLines && rawLines.length > 0) {
    const normalized = rawLines
      .filter((r) => r && typeof r.Linha === 'string' && typeof r.Descricao === 'string')
      .map(mapRawLineToCeturbLine)
      .sort((a, b) => a.id.localeCompare(b.id))
    writeStorageJson(STORAGE_KEY_LINES, { lines: normalized, savedAt: nowMs })
    return normalized
  }

  const staleCached = readStorageJson<{ lines: CeturbLine[]; savedAt: number }>(STORAGE_KEY_LINES)
  if (staleCached && Array.isArray(staleCached.lines) && staleCached.lines.length > 0) {
    return staleCached.lines
  }

  return FALLBACK_CETURB_LINES_RAW.map(mapRawLineToCeturbLine)
}

/**
 * 2. `fetchSchedules(lineId)`: Busca quadro completo de horários (Dias Úteis, Sábados, Domingos)
 * e observações de partida (`/api/BuscaHorarios/{id}` + `/api/BuscaHorarioObse/{id}`).
 */
export async function fetchSchedules(
  lineId: string,
  options: CeturbServiceOptions & { lineName?: string } = {},
): Promise<CeturbLineScheduleBundle> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = Date.now()
  const { id, code } = normalizeLineCode(lineId)
  const storageKey = `${STORAGE_KEY_SCHED_PREFIX}${id}`

  if (!options.forceRefresh) {
    const cached = readStorageJson<CeturbLineScheduleBundle>(storageKey)
    if (cached && cached.lineId === id && nowMs - cached.fetchedAt < LOCAL_SCHED_TTL_MS) {
      return { ...cached, fromCache: true }
    }
  }

  const workerUrl = getWorkerBaseUrl(options.workerBaseUrl)
  let rawSchedules: CeturbScheduleRaw[] | null = null
  let rawObservations: CeturbObservationRaw[] = []

  if (workerUrl) {
    try {
      const res = await fetcher(`${workerUrl}/ceturb/schedules?line=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as {
          schedules?: unknown
          observations?: unknown
        }
        if (Array.isArray(json?.schedules)) {
          rawSchedules = json.schedules as CeturbScheduleRaw[]
          rawObservations = Array.isArray(json?.observations)
            ? (json.observations as CeturbObservationRaw[])
            : []
        }
      }
    } catch {
      // Tenta chamada direta ou cache local
    }
  }

  if (!rawSchedules) {
    try {
      const isNum = /^\d+$/.test(code)
      const schedUrl = isNum
        ? `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaHorarios/${encodeURIComponent(code)}`
        : `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaHorarios?Linha=${encodeURIComponent(id)}`
      const obseUrl = isNum
        ? `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaHorarioObse/${encodeURIComponent(code)}`
        : `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaHorarioObse?Linha=${encodeURIComponent(id)}`

      const [sRes, oRes] = await Promise.all([
        fetcher(schedUrl, { method: 'GET', headers: { Accept: 'application/json' } }),
        fetcher(obseUrl, { method: 'GET', headers: { Accept: 'application/json' } }).catch(
          () => null,
        ),
      ])
      if (sRes.ok) {
        const sJson = (await sRes.json()) as unknown
        if (Array.isArray(sJson)) {
          rawSchedules = sJson as CeturbScheduleRaw[]
        }
      }
      if (oRes && oRes.ok) {
        const oJson = (await oRes.json()) as unknown
        if (Array.isArray(oJson)) {
          rawObservations = oJson as CeturbObservationRaw[]
        }
      }
    } catch {
      // Fallback para cache local se offline
    }
  }

  if (rawSchedules) {
    const bundle = normalizeScheduleBundle(
      id,
      rawSchedules,
      rawObservations,
      options.lineName ?? '',
      nowMs,
    )
    writeStorageJson(storageKey, bundle)
    recordRecentLineId(id)
    return bundle
  }

  const stale = readStorageJson<CeturbLineScheduleBundle>(storageKey)
  if (stale) {
    return { ...stale, fromCache: true }
  }

  throw new Error(
    `Não foi possível carregar os horários da linha ${code}. Verifique sua conexão ou tente novamente.`,
  )
}

/**
 * 3. `fetchItinerary(lineId)`: Busca o itinerário rua a rua (Ida e Volta) da linha
 * (`/api/BuscaItinerarios/{id}`).
 */
export async function fetchItinerary(
  lineId: string,
  options: CeturbServiceOptions & { lineName?: string } = {},
): Promise<CeturbLineItineraryBundle> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = Date.now()
  const { id, code } = normalizeLineCode(lineId)
  const storageKey = `${STORAGE_KEY_ITIN_PREFIX}${id}`

  if (!options.forceRefresh) {
    const cached = readStorageJson<CeturbLineItineraryBundle>(storageKey)
    if (cached && cached.lineId === id && nowMs - cached.fetchedAt < LOCAL_ITIN_TTL_MS) {
      return { ...cached, fromCache: true }
    }
  }

  const workerUrl = getWorkerBaseUrl(options.workerBaseUrl)
  let rawItinerary: CeturbItineraryRaw[] | null = null

  if (workerUrl) {
    try {
      const res = await fetcher(`${workerUrl}/ceturb/itinerary?line=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { itinerary?: unknown }
        if (Array.isArray(json?.itinerary)) {
          rawItinerary = json.itinerary as CeturbItineraryRaw[]
        }
      }
    } catch {
      // Fallback direto
    }
  }

  if (!rawItinerary) {
    try {
      const isNum = /^\d+$/.test(code)
      const itinUrl = isNum
        ? `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaItinerarios/${encodeURIComponent(code)}`
        : `${DIRECT_CETURB_ONIBUS_URL}/api/BuscaItinerarios?Linha=${encodeURIComponent(id)}`
      const res = await fetcher(itinUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as unknown
        if (Array.isArray(json)) {
          rawItinerary = json as CeturbItineraryRaw[]
        }
      }
    } catch {
      // Fallback cache
    }
  }

  if (rawItinerary) {
    const bundle = normalizeItineraryBundle(id, rawItinerary, options.lineName ?? '', nowMs)
    writeStorageJson(storageKey, bundle)
    return bundle
  }

  const stale = readStorageJson<CeturbLineItineraryBundle>(storageKey)
  if (stale) {
    return { ...stale, fromCache: true }
  }

  throw new Error(`Não foi possível carregar o itinerário da linha ${code}.`)
}

/**
 * 4. `fetchTemporalIntegration()`: Consulta regras e matriz de conexões de integração temporal.
 */
export async function fetchTemporalIntegration(
  options: CeturbServiceOptions = {},
): Promise<IntegracaoTemporalPITGrid[]> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = Date.now()

  if (!options.forceRefresh) {
    const cached = readStorageJson<{ items: IntegracaoTemporalPITGrid[]; savedAt: number }>(
      STORAGE_KEY_INTEGRATIONS,
    )
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      if (nowMs - cached.savedAt < LOCAL_LINES_TTL_MS) {
        return cached.items
      }
    }
  }

  const workerUrl = getWorkerBaseUrl(options.workerBaseUrl)
  if (workerUrl) {
    try {
      const res = await fetcher(`${workerUrl}/ceturb/integrations`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { integrations?: unknown }
        if (Array.isArray(json?.integrations) && json.integrations.length > 0) {
          const items = json.integrations as IntegracaoTemporalPITGrid[]
          writeStorageJson(STORAGE_KEY_INTEGRATIONS, { items, savedAt: nowMs })
          return items
        }
      }
    } catch {
      // Usa cache ou fallback
    }
  }

  const stale = readStorageJson<{ items: IntegracaoTemporalPITGrid[]; savedAt: number }>(
    STORAGE_KEY_INTEGRATIONS,
  )
  if (stale && Array.isArray(stale.items) && stale.items.length > 0) {
    return stale.items
  }

  return FALLBACK_TEMPORAL_INTEGRATIONS
}

/**
 * 5. `fetchFares()`: Consulta tabela tarifária atualizada (Transcol, Aquaviário, Bike GV).
 */
export async function fetchFares(options: CeturbServiceOptions = {}): Promise<CeturbFareBundle> {
  const fetcher = options.fetcher ?? fetch
  const nowMs = Date.now()

  if (!options.forceRefresh) {
    const cached = readStorageJson<{ bundle: CeturbFareBundle; savedAt: number }>(STORAGE_KEY_FARES)
    if (cached && cached.bundle && Array.isArray(cached.bundle.modals)) {
      if (nowMs - cached.savedAt < LOCAL_LINES_TTL_MS) {
        return cached.bundle
      }
    }
  }

  const workerUrl = getWorkerBaseUrl(options.workerBaseUrl)
  if (workerUrl) {
    try {
      const res = await fetcher(`${workerUrl}/ceturb/fares`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as CeturbFareBundle
        if (json && Array.isArray(json.modals)) {
          writeStorageJson(STORAGE_KEY_FARES, { bundle: json, savedAt: nowMs })
          return json
        }
      }
    } catch {
      // Usa fallback
    }
  }

  return FALLBACK_FARES
}

/**
 * 6. `calculateRoute(origin, destination)`: Serviço desacoplado de cálculo de rota,
 * pronto para plugar motor de roteirização multi-trecho / grafo GTFS no futuro,
 * já entregando sugestões diretas baseadas nos corredores e terminais conhecidos.
 */
export async function calculateRoute(
  origin: string,
  destination: string,
  options: { availableLines?: CeturbLine[] } = {},
): Promise<RouteCalculationResult> {
  const cleanOrigin = origin.trim()
  const cleanDest = destination.trim()
  if (!cleanOrigin || !cleanDest) {
    throw new Error('Informe o ponto de origem e o destino para simular a rota.')
  }

  const lines =
    options.availableLines && options.availableLines.length > 0
      ? options.availableLines
      : await fetchLines()

  const originMatches = new Set(filterLines(lines, cleanOrigin).map((l) => l.id))
  const destMatches = filterLines(lines, cleanDest)

  const suggestedDirectLines: RouteCalculationSuggestion[] = []
  for (const line of destMatches) {
    if (originMatches.has(line.id)) {
      suggestedDirectLines.push({
        line,
        matchReason: `Atende ${cleanOrigin} e ${cleanDest} no mesmo eixo/terminal`,
      })
    }
  }

  // Se não achou interseção direta pelo nome curto, sugere troncais principais que conectam os dois lados
  if (suggestedDirectLines.length === 0) {
    const topOrigin = filterLines(lines, cleanOrigin).slice(0, 2)
    const topDest = destMatches.slice(0, 2)
    for (const l of [...topOrigin, ...topDest]) {
      if (!suggestedDirectLines.some((s) => s.line.id === l.id)) {
        suggestedDirectLines.push({
          line: l,
          matchReason: 'Conexão via Terminal Urbano ou Integração Temporal (90 min Cartão GV)',
        })
      }
    }
  }

  return {
    origin: cleanOrigin,
    destination: cleanDest,
    status: 'preview',
    engineMessage: 'Linhas troncais compatíveis com os pontos informados:',
    suggestedDirectLines: suggestedDirectLines.slice(0, 5),
    estimatedIntegrationMinutes: 90,
    calculatedAt: Date.now(),
  }
}
