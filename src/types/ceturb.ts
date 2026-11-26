/**
 * Tipagem forte baseada nos schemas reais das APIs oficiais da Ceturb-ES:
 * 1) https://api.onibus.ceturb.es.gov.br/openapi/v1.json
 *    - /api/ConsultaLinha
 *    - /api/BuscaHorarios/{id}
 *    - /api/BuscaHorarioObse/{id}
 *    - /api/BuscaItinerarios/{id}
 * 2) https://api.partidas.ceturb.es.gov.br/swagger/v1/swagger.json
 *    - IntegracaoTemporalPITGrid (/api/transcolintegracaotemporal/ObterTodasAsIntegracoesTemporais)
 *    - SITRIPQuadroTarifarioGrid (/api/sitripquadrotarifario/RetornarQuadrosTarifariosDoSITRIP)
 */

// ---------- Schemas Brutos da API (api.onibus.ceturb.es.gov.br) ----------

/** Resposta de `GET /api/ConsultaLinha?Tipo_Linha=T` */
export interface CeturbLineRaw {
  /** Código da linha com zero à esquerda (ex.: "0500", "0501", "0073", "073N", "0401") */
  Linha: string
  /** Descrição oficial da linha (ex.: "T. VILA VELHA / T. ITACIBÁ VIA 3ª PONTE") */
  Descricao: string
}

/** Resposta de `GET /api/BuscaHorarios/{id}` */
export interface CeturbScheduleRaw {
  /** Nome do terminal de partida (ex.: "TERMINAL JACARAIPE") */
  Desc_Terminal: string
  /** Descrição do grupo de dia (ex.: "DIAS ÚTEIS", "SÁBADO", "DOMINGOS", "ATÍPICOS") */
  Descricao_Hora: string
  /** Nome completo da linha */
  Descricao_Linha: string
  /** Data de início da vigência do quadro de horários (ex.: "12/08/2026") */
  Dt_Inicio: string
  /** Horário de partida no formato "HH:MM" (ex.: "05:15", "16:33") */
  Hora_Saida: string
  /** Código da linha (ex.: "0501") */
  Linha: string
  /** Código numérico do tipo de dia: 1 = Dias Úteis, 2 = Sábado, 3 = Domingos/Feriados, 4+ = Atípicos */
  TP_Horario: number
  /** Sequência do terminal (1 = terminal principal, 2 = terminal secundário/retorno) */
  Terminal_Seq: number
  /** Letra de observação associada à partida (ex.: " ", "L", "W") */
  Tipo_Orientacao: string
}

/** Resposta de `GET /api/BuscaHorarioObse/{id}` */
export interface CeturbObservationRaw {
  /** Código de 1 caractere da observação (ex.: "L", "W") */
  Tipo_Orientacao: string
  /** Texto explicativo da observação (ex.: "VOLTA DIRETO DO T. JACARAÍPE PARA O POSTO COLISEU") */
  Descricao_Orientacao: string
}

/** Resposta de `GET /api/BuscaItinerarios/{id}` */
export interface CeturbItineraryRaw {
  /** Nome do logradouro/via (pode vir com espaços à direita na API original) */
  Desc_Via: string
  /** Nome completo da linha */
  Descricao_Linha: string
  /** Código da linha */
  Linha: string
  /** Mensagem de status do processamento (ex.: "Processamento sem Erro") */
  Mensagem?: string
  /** Sentido da viagem: "I" = Ida, "V" = Volta */
  Sentido: 'I' | 'V' | string
  /** Ordem numérica da via no trajeto */
  Sequencia: number
  /** Tipo de registro (ex.: "D") */
  Tipo?: string
}

// ---------- Schemas Brutos da API (api.partidas.ceturb.es.gov.br) ----------

/** Schema exato `IntegracaoTemporalPITGrid` do `swagger/v1/swagger.json` */
export interface IntegracaoTemporalPITGrid {
  codigo: number
  linha1: number
  linha_origem: string | null
  linha_origem_completo: string | null
  tp_origem: string | null
  linha2: number
  linha_destino: string | null
  linha_destino_completo: string | null
  tp_destino: string | null
  local: string | null
  tempo_para_integracao: string | null
  tempo: string | null
  origem: string | null
  dt_atualizacao: string | null
}

// ---------- Modelos Normalizados para a UI do PWA ----------

export type CeturbModalCategory = 'transcol' | 'aquaviario' | 'bikegv' | 'alimentadora'

export interface CeturbLine {
  /** Código original com 4 caracteres (ex.: "0500") */
  id: string
  /** Código curto exibido para o usuário sem zeros supérfluos (ex.: "500", "73N", "401") */
  code: string
  /** Nome limpo e legível da linha */
  name: string
  /** Modal / categoria inferida */
  category: CeturbModalCategory
}

export type CeturbDayTab = 'uteis' | 'sabado' | 'domingo'

export interface CeturbDepartureSlot {
  /** Horário "HH:MM" */
  time: string
  /** Minutos desde 00:00 (0 a 1439) para cálculo rápido do próximo ônibus */
  minutesFromMidnight: number
  /** Letra de observação opcional (ex.: "L", "W"), ou null quando normal */
  noteCode: string | null
}

export interface CeturbTerminalSchedule {
  terminalName: string
  terminalSeq: number
  departures: CeturbDepartureSlot[]
}

export interface CeturbDayScheduleGroup {
  dayTab: CeturbDayTab
  label: string
  terminals: CeturbTerminalSchedule[]
}

export interface CeturbObservation {
  code: string
  description: string
}

export interface CeturbLineScheduleBundle {
  lineId: string
  lineCode: string
  lineName: string
  effectiveDate: string | null
  days: Record<CeturbDayTab, CeturbDayScheduleGroup>
  observations: CeturbObservation[]
  fetchedAt: number
  fromCache?: boolean
}

export interface CeturbStreetStop {
  sequence: number
  street: string
}

export interface CeturbLineItineraryBundle {
  lineId: string
  lineCode: string
  lineName: string
  ida: CeturbStreetStop[]
  volta: CeturbStreetStop[]
  fetchedAt: number
  fromCache?: boolean
}

export interface CeturbFareModal {
  id: string
  modal: string
  category: 'Transcol' | 'Aquaviário' | 'Bike GV' | 'SITRIP'
  price: number
  studentPrice: number
  integrationWindowMinutes: number
  paymentMethods: string[]
  notes: string
}

export interface CeturbFareBundle {
  updatedAt: string
  currency: string
  rulesSummary: string[]
  modals: CeturbFareModal[]
}

export interface RouteCalculationSuggestion {
  line: CeturbLine
  matchReason: string
}

export interface RouteCalculationResult {
  origin: string
  destination: string
  status: 'preview' | 'ready'
  engineMessage: string
  suggestedDirectLines: RouteCalculationSuggestion[]
  estimatedIntegrationMinutes: number
  calculatedAt: number
}
