import { ASSISTANT_WORKER_URL, OWNER_UID } from '../assistantConfig'
import { db, getRawRecord, getSetting, runApplyingRemote, setSetting, uid } from '../data/db'
import { DEFAULT_GOALS } from '../data/seed'
import { addDays, dayTotals, exerciseHistory, movingAverage, parseDate, personalRecord, setLabel, today, totalVolume } from '../data/stats'
import { getFirebaseAuth, getSyncStatus } from '../data/sync'
import type { BodyEntry, Exercise, Goals, Meal, MealItem, MealType, Routine, Session } from '../data/types'
import { buildDays, prSetIds, streaks } from './panel'
import {
  EMPTY_FACULTY_DATA,
  FACULDADE_SETTING_KEY,
  type FacultyData,
  type FacultyDeadline,
} from './faculty'
import { replaceFacultyDeadlineReminders } from './facultyReminders'

/** Chave local-only na tabela settings para o histórico do chat (fora do backup e do Firestore). */
export const ASSISTANT_HISTORY_KEY = 'assistantHistory'

export const SYSTEM_PROMPT = `Você é o assistente técnico de calistenia e nutrição integrado ao app "Meu Treino" (PWA).
Responda SEMPRE em português do Brasil, de forma prática, direta, concisa e sem rodeios (estilo terminal / atleta disciplinado).

Estrutura do app que você conhece:
- Treinos (sessions): contêm exercícios de calistenia organizados em progressões por categoria (empurrar, puxar, paralelas/dips, muscle-up, front lever, planche, handstand, pernas, core). Cada série registra repetições ("reps") ou segundos ("time") + carga extra opcional em kg ("load") + RPE opcional.
- Dieta (meals): refeições diárias separadas em "cafe", "almoco", "jantar" e "lanche", somando calorias (kcal), proteínas (p), carboidratos (c) e gorduras (g) comparadas às metas diárias.
- Corpo (body): registro diário de peso (kg, com média móvel de 7 dias) e medidas em cm (cintura, braço, peito, etc.).
- Faculdade: grade semanal, disciplinas, avaliações e prazos são dados pessoais do usuário. Use as ferramentas de Faculdade para listar prazos ou criar um prazo quando o pedido for explícito. Interprete "dia N" como a próxima ocorrência futura desse dia do mês. Para datas sem horário, use 23:59 e informe essa escolha; se a data continuar ambígua, pergunte antes de criar.

Regras obrigatórias:
1. Baseie suas análises EXCLUSIVAMENTE nos dados reais do usuário obtidos pelas ferramentas de leitura. Consulte as ferramentas antes de responder sobre evolução, volume, dieta ou peso.
2. Quando não houver dados suficientes registrados no período, diga claramente que ainda não há registros suficientes — NUNCA invente números, séries, pesos ou calorias.
3. NUNCA dê diagnóstico médico nem prescreva tratamento clínico. Se o usuário relatar dor aguda, lesão ou condição clínica, recomende consultar um médico, fisioterapeuta ou nutricionista.
4. Para refeição, rotina de treino e peso/medidas, você NÃO grava dados diretamente: chame a ferramenta de proposta correspondente (propose_meal, propose_routine ou propose_body_weight) e avise que o rascunho foi gerado abaixo para ele conferir e confirmar. Para prazos de Faculdade, crie diretamente com a ferramenta de Faculdade quando o pedido do usuário for explícito.

Agenda (Google Calendar): você também gerencia a agenda do usuário no fuso America/Sao_Paulo (usando a data e hora atuais informadas abaixo) com as ferramentas criar_evento, editar_evento, listar_eventos e apagar_evento. Use duração padrão de 1h quando o término não for informado, pergunte ao usuário se faltar data ou hora para criar um evento, e extraia automaticamente título, data, horário, local e descrição de e-mails e convites colados na conversa (lembrando que editar e apagar exigem confirmação pelo botão Confirmar).

Lembretes Push (Notificações Web Push via FCM): você também cria, lista e cancela lembretes de notificação push no fuso America/Sao_Paulo usando create_push_reminder, list_push_reminders e cancel_push_reminder. Diferencie claramente: quando o usuário pedir para agendar um evento ou compromisso na agenda, use as ferramentas do Google Calendar (criar_evento); quando o usuário pedir para lembrar, mandar notificação ou avisar por push (ex.: "me lembra às 18h de ir pro Jiu-Jitsu", "manda um push amanhã às 7h30 pra tomar creatina"), use create_push_reminder (somente Web Push, sem criar evento no Google Calendar).`

const WEEKDAYS_PT = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
]

/**
 * Formata o fuso horário local do aparelho (ex.: "America/Sao_Paulo (UTC-03:00)").
 */
export function formatLocalTimeZone(now = new Date()): string {
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  const utcLabel = `UTC${sign}${hh}:${mm}`
  const tzName =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : ''
  return tzName ? `${tzName} (${utcLabel})` : utcLabel
}

export const CALENDAR_TOOL_NAMES = new Set([
  'criar_evento',
  'listar_eventos',
  'editar_evento',
  'apagar_evento',
])

/**
 * Verifica se o usuário autenticado atual é o proprietário (`OWNER_UID`).
 * Para qualquer outro `uid` autenticado, as ferramentas do Google Calendar ficam desativadas e ocultas.
 */
export function isCurrentUserOwner(explicitUid?: string | null): boolean {
  if (typeof explicitUid === 'string' && explicitUid.trim()) {
    return explicitUid.trim() === OWNER_UID
  }
  const syncUid = getSyncStatus().user?.uid?.trim()
  if (syncUid) {
    return syncUid === OWNER_UID
  }
  try {
    const authUid = getFirebaseAuth().currentUser?.uid?.trim()
    if (authUid) {
      return authUid === OWNER_UID
    }
  } catch {
    // ambiente de teste sem Firebase Auth inicializado
  }
  return true
}

const CALENDAR_SYSTEM_PROMPT_PARAGRAPH =
  'Agenda (Google Calendar): você também gerencia a agenda do usuário no fuso America/Sao_Paulo (usando a data e hora atuais informadas abaixo) com as ferramentas criar_evento, editar_evento, listar_eventos e apagar_evento. Use duração padrão de 1h quando o término não for informado, pergunte ao usuário se faltar data ou hora para criar um evento, e extraia automaticamente título, data, horário, local e descrição de e-mails e convites colados na conversa (lembrando que editar e apagar exigem confirmação pelo botão Confirmar).'

const PUSH_REMINDERS_OWNER_PARAGRAPH =
  'Lembretes Push (Notificações Web Push via FCM): você também cria, lista e cancela lembretes de notificação push no fuso America/Sao_Paulo usando create_push_reminder, list_push_reminders e cancel_push_reminder. Diferencie claramente: quando o usuário pedir para agendar um evento ou compromisso na agenda, use as ferramentas do Google Calendar (criar_evento); quando o usuário pedir para lembrar, mandar notificação ou avisar por push (ex.: "me lembra às 18h de ir pro Jiu-Jitsu", "manda um push amanhã às 7h30 pra tomar creatina"), use create_push_reminder (somente Web Push, sem criar evento no Google Calendar).'

const PUSH_REMINDERS_SECONDARY_PARAGRAPH =
  'Lembretes Push (Notificações Web Push via FCM): você também cria, lista e cancela lembretes de notificação push no fuso America/Sao_Paulo usando create_push_reminder, list_push_reminders e cancel_push_reminder quando o usuário pedir para lembrar, mandar notificação ou avisar por push (ex.: "me lembra às 18h de treinar", "manda um push amanhã às 7h30 pra tomar creatina").'

/**
 * Monta o prompt de sistema incluindo o fuso horário e a data local atual do aparelho.
 * Remove qualquer menção ao Google Calendar quando o usuário não é o `OWNER_UID`.
 */
export function buildSystemPrompt(now = new Date(), explicitUid?: string | null): string {
  const localToday = today(now)
  const weekday = WEEKDAYS_PT[parseDate(localToday).getDay()] ?? ''
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const tz = formatLocalTimeZone(now)
  const basePrompt = isCurrentUserOwner(explicitUid)
    ? SYSTEM_PROMPT
    : SYSTEM_PROMPT.replace(CALENDAR_SYSTEM_PROMPT_PARAGRAPH, '')
        .replace(PUSH_REMINDERS_OWNER_PARAGRAPH, PUSH_REMINDERS_SECONDARY_PARAGRAPH)
        .replace(/\n{3,}/g, '\n\n')
  return `${basePrompt}

Data e fuso horário locais do aparelho neste momento:
- Data local atual ("hoje"): ${localToday} (${weekday})
- Horário local: ${hh}:${mm}
- Fuso horário: ${tz}
IMPORTANTE: Use SEMPRE a data local ${localToday} como "hoje" (nunca use UTC). A semana atual corresponde aos últimos 7 dias terminando hoje (${addDays(localToday, -6)} a ${localToday}).`
}

// ---------- Tipos de rascunho (ações de escrita aguardando confirmação do usuário) ----------

export interface MealDraft {
  id: string
  kind: 'meal'
  status: 'pending' | 'confirmed' | 'discarded'
  date: string
  mealType: MealType
  items: MealItem[]
}

export interface RoutineDraft {
  id: string
  kind: 'routine'
  status: 'pending' | 'confirmed' | 'discarded'
  name: string
  exerciseIds: string[]
  exerciseNames: string[]
}

export interface BodyDraft {
  id: string
  kind: 'body'
  status: 'pending' | 'confirmed' | 'discarded'
  date: string
  weight?: number
  measures: Record<string, number>
}

export type AssistantDraft = MealDraft | RoutineDraft | BodyDraft

export interface CalendarEventInfo {
  id: string
  titulo: string
  inicio: string
  fim?: string
  local?: string
  descricao?: string
  htmlLink?: string
}

export interface CalendarCardItem {
  id: string
  action: 'criar_evento' | 'listar_eventos' | 'editar_evento' | 'apagar_evento'
  status: 'created' | 'listed' | 'pending_confirmation' | 'confirmed'
  event: CalendarEventInfo
  pendingAction?: {
    tool: 'editar_evento' | 'apagar_evento'
    id: string
    campos?: Record<string, unknown>
  }
}

export interface PushReminderInfo {
  id: string
  uid?: string
  title: string
  body?: string
  triggerAt: string
  timezone?: string
  recurrence: 'none' | 'daily' | 'weekly'
  status: 'pending' | 'sent' | 'cancelled'
  url?: string
}

export interface PushReminderCardItem {
  id: string
  action: 'create_push_reminder' | 'list_push_reminders' | 'cancel_push_reminder'
  reminder: PushReminderInfo
}

export interface ChatTurnMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** Rótulos legíveis indicando quais dados locais foram enviados ao assistente neste turno */
  dataSent?: string[]
  /** Rascunhos propostos pelo assistente aguardando confirmação do usuário */
  drafts?: AssistantDraft[]
  /** Cards de eventos da agenda (Google Calendar) exibidos na conversa */
  calendarCards?: CalendarCardItem[]
  /** Cards de lembretes Web Push (FCM) exibidos na conversa */
  reminderCards?: PushReminderCardItem[]
}

// ---------- Definições das ferramentas (OpenAI / Groq function calling schema) ----------

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weekly_summary',
      description:
        'Lê o resumo dos últimos 7 dias: treinos realizados, séries totais, PRs batidos, sequência atual (streak), médias de dieta vs. metas e último peso.',
      parameters: {
        type: 'object',
        properties: {
          referenceDate: {
            type: 'string',
            description: 'Data final de referência no formato AAAA-MM-DD (opcional, padrão hoje).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_exercise_history',
      description:
        'Lê o histórico de um exercício específico de calistenia (busca por nome ou ID), retornando PR, volume total e as últimas sessões realizadas.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome ou ID do exercício (ex.: "barra fixa", "flexão diamante", "front lever").',
          },
          limit: {
            type: 'number',
            description: 'Quantidade máxima de sessões recentes a retornar (padrão 8, máx. 15).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diet_summary',
      description:
        'Lê o resumo da dieta (kcal, proteína, carboidrato, gordura e refeições) para uma data ou intervalo de datas, junto com as metas atuais.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data única no formato AAAA-MM-DD (opcional).',
          },
          startDate: {
            type: 'string',
            description: 'Data inicial no formato AAAA-MM-DD (opcional, padrão últimos 7 dias).',
          },
          endDate: {
            type: 'string',
            description: 'Data final no formato AAAA-MM-DD (opcional, padrão hoje).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_body_evolution',
      description:
        'Lê a evolução recente do peso corporal (com média móvel de 7 dias) e medidas corporais nos últimos N dias.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Quantidade de dias para buscar (padrão 30, máx. 90).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_exercises_and_routines',
      description:
        'Lista os exercícios cadastrados na biblioteca (com categoria, nível de progressão e tipo de medição) e as rotinas de treino salvas.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filtro opcional por categoria de exercício.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_meal',
      description:
        'Propõe um rascunho de refeição para o usuário revisar e confirmar antes de salvar no app. NÃO grava automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data da refeição em AAAA-MM-DD (opcional, padrão hoje).',
          },
          type: {
            type: 'string',
            enum: ['cafe', 'almoco', 'jantar', 'lanche'],
            description: 'Tipo da refeição: cafe, almoco, jantar ou lanche.',
          },
          items: {
            type: 'array',
            description: 'Lista de alimentos da refeição.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Nome do alimento' },
                qty: { type: 'string', description: 'Quantidade/porção (ex.: "150 g", "2 unid")' },
                kcal: { type: 'number', description: 'Calorias totais do item' },
                p: { type: 'number', description: 'Proteínas em gramas' },
                c: { type: 'number', description: 'Carboidratos em gramas' },
                g: { type: 'number', description: 'Gorduras em gramas' },
              },
              required: ['name', 'qty', 'kcal', 'p', 'c', 'g'],
            },
          },
        },
        required: ['type', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_routine',
      description:
        'Propõe um rascunho de nova rotina de treino com exercícios da biblioteca para o usuário confirmar antes de salvar.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Nome da rotina (ex.: "Empurrar + Core", "Upper A").',
          },
          exercises: {
            type: 'array',
            description: 'Lista de nomes ou IDs dos exercícios que compõem a rotina.',
            items: { type: 'string' },
          },
        },
        required: ['name', 'exercises'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_body_weight',
      description:
        'Propõe um rascunho de registro de peso corporal (kg) e/ou medidas (cm) para o usuário confirmar antes de salvar.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data do registro em AAAA-MM-DD (opcional, padrão hoje).',
          },
          weight: {
            type: 'number',
            description: 'Peso corporal em kg (ex.: 74.5).',
          },
          measures: {
            type: 'object',
            description: 'Medidas corporais opcionais em cm (ex.: {"cintura": 78, "braco": 37}).',
            additionalProperties: { type: 'number' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_evento',
      description:
        'Cria um evento no Google Calendar (calendário primary, fuso America/Sao_Paulo). Se fim for omitido, usa duração padrão de 1h.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título do evento' },
          inicio: {
            type: 'string',
            description: 'Data e hora de início em ISO 8601 no fuso America/Sao_Paulo (ex.: "2026-11-17T14:00:00-03:00")',
          },
          fim: {
            type: 'string',
            description: 'Data e hora de término em ISO 8601 (opcional; padrão +1h após o início)',
          },
          local: { type: 'string', description: 'Local ou endereço do evento (opcional)' },
          descricao: { type: 'string', description: 'Descrição ou observações do evento (opcional)' },
        },
        required: ['titulo', 'inicio'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_evento',
      description:
        'Solicita edição de um evento existente no Google Calendar pelo id. A primeira chamada devolve o evento e pede confirmação do usuário.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do evento no Google Calendar' },
          campos: {
            type: 'object',
            description: 'Campos a atualizar no evento (titulo, inicio, fim, local, descricao)',
            properties: {
              titulo: { type: 'string' },
              inicio: { type: 'string' },
              fim: { type: 'string' },
              local: { type: 'string' },
              descricao: { type: 'string' },
            },
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_eventos',
      description: 'Lista eventos do Google Calendar (primary) no intervalo entre inicio e fim.',
      parameters: {
        type: 'object',
        properties: {
          inicio: {
            type: 'string',
            description: 'Início do intervalo em ISO 8601 (ex.: "2026-11-17T00:00:00-03:00")',
          },
          fim: {
            type: 'string',
            description: 'Fim do intervalo em ISO 8601 (ex.: "2026-11-17T23:59:59-03:00")',
          },
        },
        required: ['inicio', 'fim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apagar_evento',
      description:
        'Solicita exclusão de um evento no Google Calendar pelo id. A primeira chamada devolve o evento e pede confirmação do usuário.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do evento no Google Calendar' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_push_reminder',
      description:
        'Agenda um lembrete de notificação Web Push (FCM) para o usuário no fuso America/Sao_Paulo, SEM criar evento no Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Título curto do lembrete (ex.: "Tomar creatina", "Ir pro Jiu-Jitsu")',
          },
          body: {
            type: 'string',
            description: 'Descrição ou detalhe opcional da notificação',
          },
          dateTime: {
            type: 'string',
            description:
              'Data e hora do disparo em ISO 8601 no fuso America/Sao_Paulo (ex.: "2026-11-26T18:00:00-03:00")',
          },
          recurrence: {
            type: 'string',
            enum: ['none', 'daily', 'weekly'],
            description: 'Recorrência opcional do lembrete: "none" (padrão), "daily" ou "weekly"',
          },
        },
        required: ['title', 'dateTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_push_reminders',
      description: 'Lista todos os lembretes de notificação Web Push pendentes do usuário.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_push_reminder',
      description: 'Cancela um lembrete de notificação Web Push pendente pelo ID ou pelo título.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do lembrete (ex.: "rem_...")' },
          title: { type: 'string', description: 'Título do lembrete caso o ID não seja informado' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_faculty_deadline',
      description: 'Cria uma prova, lista ou trabalho nos prazos pessoais de Faculdade do usuário e agenda lembretes push dois dias antes e no dia do prazo.',
      parameters: {
        type: 'object',
        properties: {
          courseName: { type: 'string', description: 'Nome da disciplina.' },
          type: { type: 'string', enum: ['prova', 'lista', 'trabalho'] },
          date: { type: 'string', description: 'Data local no formato AAAA-MM-DD.' },
          time: { type: 'string', description: 'Horário local HH:mm. Se não informado pelo usuário, use 23:59.' },
        },
        required: ['courseName', 'type', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_faculty_deadlines',
      description: 'Lista provas, listas e trabalhos pessoais do usuário, ordenados por data.',
      parameters: {
        type: 'object',
        properties: {
          courseName: { type: 'string', description: 'Filtre pelo nome da disciplina (opcional).' },
          status: { type: 'string', enum: ['pendente', 'feito'], description: 'Filtre pelo status (opcional).' },
          limit: { type: 'number', description: 'Quantidade máxima de resultados, até 50 (padrão 20).' },
        },
      },
    },
  },
]

// ---------- Validação e gravação mediante confirmação explícita do rascunho ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VALID_MEAL_TYPES: Set<MealType> = new Set(['cafe', 'almoco', 'jantar', 'lanche'])

export function validateDraft(draft: AssistantDraft): void {
  if (!draft || typeof draft !== 'object') {
    throw new Error('Rascunho inválido.')
  }

  if (draft.kind === 'meal') {
    if (!DATE_RE.test(draft.date)) {
      throw new Error('Data da refeição inválida (use AAAA-MM-DD).')
    }
    if (!VALID_MEAL_TYPES.has(draft.mealType)) {
      throw new Error('Tipo de refeição inválido (use cafe, almoco, jantar ou lanche).')
    }
    if (!Array.isArray(draft.items) || draft.items.length === 0) {
      throw new Error('A refeição proposta precisa ter pelo menos 1 item.')
    }
    for (const it of draft.items) {
      if (!it || typeof it.name !== 'string' || !it.name.trim()) {
        throw new Error('Item da refeição sem nome.')
      }
      if (typeof it.qty !== 'string' || !it.qty.trim()) {
        throw new Error(`Informe a porção do item "${it.name}".`)
      }
      for (const field of ['kcal', 'p', 'c', 'g'] as const) {
        const val = it[field]
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 10_000) {
          throw new Error(`Valor nutricional inválido (${field}) no item "${it.name}".`)
        }
      }
    }
    return
  }

  if (draft.kind === 'routine') {
    if (typeof draft.name !== 'string' || !draft.name.trim()) {
      throw new Error('O nome da rotina não pode ficar vazio.')
    }
    if (!Array.isArray(draft.exerciseIds) || draft.exerciseIds.length === 0) {
      throw new Error('A rotina proposta precisa ter pelo menos 1 exercício válido.')
    }
    return
  }

  if (draft.kind === 'body') {
    if (!DATE_RE.test(draft.date)) {
      throw new Error('Data do registro corporal inválida (use AAAA-MM-DD).')
    }
    const hasWeight = draft.weight !== undefined
    const measureKeys = Object.keys(draft.measures ?? {})
    if (!hasWeight && measureKeys.length === 0) {
      throw new Error('Informe ao menos o peso ou uma medida corporal.')
    }
    if (hasWeight) {
      if (typeof draft.weight !== 'number' || !Number.isFinite(draft.weight) || draft.weight < 20 || draft.weight > 350) {
        throw new Error('Peso corporal fora da faixa válida (20 a 350 kg).')
      }
    }
    for (const k of measureKeys) {
      const v = draft.measures[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 300) {
        throw new Error(`Medida "${k}" inválida.`)
      }
    }
    return
  }

  throw new Error('Tipo de rascunho desconhecido.')
}

/**
 * Grava no Dexie um rascunho SOMENTE após o toque de confirmação do usuário.
 */
export async function applyConfirmedDraft(draft: AssistantDraft): Promise<void> {
  validateDraft(draft)

  if (draft.kind === 'meal') {
    const existing = (await db.meals.where('date').equals(draft.date).toArray()).find(
      (m) => m.type === draft.mealType,
    )
    const sanitizedItems: MealItem[] = draft.items.map((i) => ({
      name: i.name.trim(),
      qty: i.qty.trim(),
      kcal: Math.round(i.kcal),
      p: Math.round(i.p * 10) / 10,
      c: Math.round(i.c * 10) / 10,
      g: Math.round(i.g * 10) / 10,
    }))
    if (existing) {
      await db.meals.put({
        ...existing,
        items: [...existing.items, ...sanitizedItems],
      })
    } else {
      const meal: Meal = {
        id: uid(),
        date: draft.date,
        type: draft.mealType,
        items: sanitizedItems,
        createdAt: Date.now(),
      }
      await db.meals.put(meal)
    }
    return
  }

  if (draft.kind === 'routine') {
    const routine: Routine = {
      id: uid(),
      name: draft.name.trim(),
      exerciseIds: [...draft.exerciseIds],
    }
    await db.routines.put(routine)
    return
  }

  if (draft.kind === 'body') {
    const id = `body-${draft.date}`
    const existing = await db.body.get(id)
    const entry: BodyEntry = {
      id,
      date: draft.date,
      weight: draft.weight !== undefined ? Math.round(draft.weight * 10) / 10 : existing?.weight,
      measures: { ...(existing?.measures ?? {}), ...(draft.measures ?? {}) },
    }
    await db.body.put(entry)
  }
}

// ---------- Execução das ferramentas (leitura, propostas e prazos de Faculdade) ----------

export interface ToolExecutionOutput {
  result: Record<string, unknown>
  dataLabel: string
  draft?: AssistantDraft
  calendarCards?: CalendarCardItem[]
  reminderCards?: PushReminderCardItem[]
}

export interface ExecuteToolRuntimeOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
}

const REMINDER_TOOL_NAMES = new Set([
  'create_push_reminder',
  'list_push_reminders',
  'cancel_push_reminder',
])
const FACULTY_TOOL_NAMES = new Set(['create_faculty_deadline', 'list_faculty_deadlines'])

function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function findMatchingExercise(exercises: Exercise[], query: string): Exercise | undefined {
  const q = normalizeStr(query)
  if (!q) return undefined
  const exactId = exercises.find((e) => normalizeStr(e.id) === q)
  if (exactId) return exactId
  const exactName = exercises.find((e) => normalizeStr(e.name) === q)
  if (exactName) return exactName
  return exercises.find((e) => normalizeStr(e.name).includes(q) || normalizeStr(e.category).includes(q))
}

/**
 * Lê os registros corporais da mesma tabela (`db.body`) usada pelo Painel principal e pela aba Corpo,
 * filtrando explicitamente registros com `deleted === true` e normalizando `weight` numérico.
 */
async function readActiveBodyEntries(): Promise<BodyEntry[]> {
  const rows = await db.body.toArray()
  return rows
    .filter((b): b is BodyEntry => Boolean(b && b.deleted !== true && typeof b.date === 'string'))
    .map((b) => {
      const rawW = (b as any).weight
      const numW =
        typeof rawW === 'number' && Number.isFinite(rawW)
          ? rawW
          : typeof rawW === 'string' && rawW.trim() !== '' && Number.isFinite(Number(rawW))
            ? Number(rawW)
            : undefined
      return {
        ...b,
        weight: numW,
        measures: b.measures ?? {},
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Garante que uma data informada pelo modelo nunca ultrapasse o "hoje" local
 * (evita que o modelo em UTC passe o dia seguinte após as 21h no Brasil, UTC-3).
 */
function clampToLocalToday(candidate: unknown, localToday: string): string {
  if (typeof candidate !== 'string' || !DATE_RE.test(candidate)) return localToday
  return candidate > localToday ? localToday : candidate
}

export async function executeAssistantTool(
  name: string,
  rawArgs: Record<string, unknown>,
  now: Date = new Date(),
  runtime: ExecuteToolRuntimeOptions = {},
): Promise<ToolExecutionOutput> {
  // Data local de hoje calculada exatamente pela mesma função `today(now)` usada pelo Painel e Heatmap
  const localToday = today(now)

  if (CALENDAR_TOOL_NAMES.has(name)) {
    const fetcher = runtime.fetcher ?? fetch
    const getToken = runtime.getToken ?? defaultGetIdToken
    const baseUrl = (runtime.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
    const token = await getToken()
    if (!token) {
      throw new Error('Sessão não autenticada para acessar a agenda.')
    }
    const res = await fetcher(`${baseUrl}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        calendar_action: {
          tool: name,
          args: rawArgs,
        },
      }),
    })
    const data = (await res.json()) as Record<string, any>
    if (!res.ok || data.error) {
      return {
        dataLabel: `agenda (${name})`,
        result: { error: data.error || `Falha na agenda (HTTP ${res.status})` },
      }
    }

    const cards: CalendarCardItem[] = []
    if (name === 'criar_evento' && data.event) {
      cards.push({
        id: uid(),
        action: 'criar_evento',
        status: 'created',
        event: data.event as CalendarEventInfo,
      })
    } else if (name === 'listar_eventos' && Array.isArray(data.events)) {
      for (const ev of data.events) {
        cards.push({
          id: uid(),
          action: 'listar_eventos',
          status: 'listed',
          event: ev as CalendarEventInfo,
        })
      }
    } else if ((name === 'editar_evento' || name === 'apagar_evento') && data.event) {
      cards.push({
        id: uid(),
        action: name,
        status: data.requiresConfirmation ? 'pending_confirmation' : 'confirmed',
        event: data.event as CalendarEventInfo,
        pendingAction: data.pendingAction,
      })
    }

    return {
      dataLabel: `agenda (${name})`,
      result: data,
      calendarCards: cards.length > 0 ? cards : undefined,
    }
  }

  if (REMINDER_TOOL_NAMES.has(name)) {
    const fetcher = runtime.fetcher ?? fetch
    const getToken = runtime.getToken ?? defaultGetIdToken
    const baseUrl = (runtime.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
    const token = await getToken()
    if (!token) {
      throw new Error('Sessão não autenticada para gerenciar lembretes push.')
    }
    const res = await fetcher(`${baseUrl}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reminder_action: {
          tool: name,
          args: rawArgs,
        },
      }),
    })
    const data = (await res.json()) as Record<string, any>
    if (!res.ok || data.error) {
      return {
        dataLabel: `lembretes push (${name})`,
        result: { error: data.error || `Falha nos lembretes push (HTTP ${res.status})` },
      }
    }

    const reminderCards: PushReminderCardItem[] = []
    if ((name === 'create_push_reminder' || name === 'cancel_push_reminder') && data.reminder) {
      reminderCards.push({
        id: uid(),
        action: name,
        reminder: data.reminder as PushReminderInfo,
      })
    } else if (name === 'list_push_reminders' && Array.isArray(data.reminders)) {
      for (const rem of data.reminders) {
        reminderCards.push({
          id: uid(),
          action: 'list_push_reminders',
          reminder: rem as PushReminderInfo,
        })
      }
    }

    return {
      dataLabel: `lembretes push (${name})`,
      result: data,
      reminderCards: reminderCards.length > 0 ? reminderCards : undefined,
    }
  }

  if (FACULTY_TOOL_NAMES.has(name)) {
    const stored = await getSetting<FacultyData>(FACULDADE_SETTING_KEY, EMPTY_FACULTY_DATA)
    if (
      !stored ||
      !Array.isArray(stored.courses) ||
      !Array.isArray(stored.classes) ||
      !Array.isArray(stored.deadlines) ||
      !Array.isArray(stored.assessments)
    ) {
      throw new Error('Os dados locais de Faculdade estão inválidos. Abra a tela Faculdade para revisar o cadastro.')
    }

    if (name === 'list_faculty_deadlines') {
      if (rawArgs.courseName !== undefined && typeof rawArgs.courseName !== 'string') {
        throw new Error('Filtro de disciplina inválido.')
      }
      if (rawArgs.status !== undefined && rawArgs.status !== 'pendente' && rawArgs.status !== 'feito') {
        throw new Error('Status inválido. Use pendente ou feito.')
      }
      if (rawArgs.limit !== undefined && (typeof rawArgs.limit !== 'number' || !Number.isFinite(rawArgs.limit))) {
        throw new Error('Limite inválido. Informe um número de itens.')
      }
      const courseFilter = typeof rawArgs.courseName === 'string' ? normalizeStr(rawArgs.courseName) : ''
      const statusFilter = rawArgs.status === 'pendente' || rawArgs.status === 'feito' ? rawArgs.status : ''
      const limit = Math.min(50, Math.max(1, Number(rawArgs.limit) || 20))
      const courseById = new Map(stored.courses.map((course) => [course.id, course]))
      const deadlines = stored.deadlines
        .filter((deadline) => {
          const course = courseById.get(deadline.courseId)
          return (
            (!courseFilter || normalizeStr(course?.name ?? '').includes(courseFilter)) &&
            (!statusFilter || deadline.status === statusFilter)
          )
        })
        .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
        .slice(0, limit)
        .map((deadline) => ({
          ...deadline,
          courseName: courseById.get(deadline.courseId)?.name ?? 'Disciplina removida',
        }))
      return {
        dataLabel: 'prazos de Faculdade do usuário',
        result: { deadlines, count: deadlines.length },
      }
    }

    const courseName = typeof rawArgs.courseName === 'string' ? rawArgs.courseName.trim() : ''
    const date = typeof rawArgs.date === 'string' ? rawArgs.date : ''
    const time = typeof rawArgs.time === 'string' && rawArgs.time.trim() ? rawArgs.time.trim() : '23:59'
    const type = rawArgs.type
    if (!courseName || courseName.length > 100) throw new Error('Informe o nome da disciplina para criar o prazo.')
    if (type !== 'prova' && type !== 'lista' && type !== 'trabalho') {
      throw new Error('Tipo inválido. Use prova, lista ou trabalho.')
    }
    if (!DATE_RE.test(date) || today(parseDate(date)) !== date) {
      throw new Error('Data inválida. Use uma data real no formato AAAA-MM-DD.')
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      throw new Error('Horário inválido. Use HH:mm.')
    }

    let course = stored.courses.find((item) => normalizeStr(item.name) === normalizeStr(courseName))
    let courses = stored.courses
    if (!course) {
      course = { id: uid(), name: courseName, passingAverage: 60 }
      courses = [...courses, course]
    }
    const deadline: FacultyDeadline = {
      id: uid(),
      courseId: course.id,
      type,
      date,
      time,
      status: 'pendente',
    }
    const next: FacultyData = { ...stored, courses, deadlines: [...stored.deadlines, deadline] }
    await setSetting(FACULDADE_SETTING_KEY, next)

    let reminderIds: string[] = []
    let reminderError: string | undefined
    try {
      reminderIds = await replaceFacultyDeadlineReminders(deadline, course.name, [], { ...runtime, now })
      if (reminderIds.length > 0) {
        const withReminders = {
          ...next,
          deadlines: next.deadlines.map((item) => item.id === deadline.id ? { ...item, reminderIds } : item),
        }
        await setSetting(FACULDADE_SETTING_KEY, withReminders)
      }
    } catch (error) {
      reminderError = error instanceof Error ? error.message : 'erro desconhecido ao configurar os lembretes.'
    }
    return {
      dataLabel: 'prazo de Faculdade criado',
      result: {
        deadline: { ...deadline, courseName: course.name, reminderIds },
        remindersScheduled: reminderIds.length,
        ...(reminderError ? { reminderError } : {}),
      },
    }
  }

  if (name === 'get_weekly_summary') {
    const refDate = clampToLocalToday(rawArgs.referenceDate, localToday)
    const fromDate = addDays(refDate, -6)

    const [rawSessions, rawMeals, activeBody, rawExercises, goals, streakGap] = await Promise.all([
      db.sessions.toArray(),
      db.meals.toArray(),
      readActiveBodyEntries(),
      db.exercises.toArray(),
      getSetting<Goals>('goals', DEFAULT_GOALS),
      getSetting<number>('streakGap', 2),
    ])

    const allSessions = rawSessions.filter((s): s is Session => Boolean(s && s.deleted !== true))
    const allMeals = rawMeals.filter((m): m is Meal => Boolean(m && m.deleted !== true))
    const exercises = rawExercises.filter((e): e is Exercise => Boolean(e && e.deleted !== true))

    // Usa a mesma função `buildDays` do painel principal (`src/lib/panel.ts`)
    const panelDays = buildDays(fromDate, refDate, allSessions, allMeals, activeBody, goals)

    const exMap = new Map(exercises.map((e) => [e.id, e]))
    const prs = prSetIds(allSessions)
    const trainDates = allSessions
      .filter((s) => s.entries.some((e) => e.sets.length > 0))
      .map((s) => s.date)
    const streakInfo = streaks(trainDates, streakGap, refDate)

    const weekSessions = allSessions
      .filter((s) => s.date >= fromDate && s.date <= refDate)
      .sort((a, b) => a.date.localeCompare(b.date))

    let totalSets = 0
    const prHighlights: string[] = []
    const sessionSummaries = weekSessions.map((s) => {
      const exList = s.entries
        .filter((e) => e.sets.length > 0)
        .map((e) => {
          totalSets += e.sets.length
          const ex = exMap.get(e.exerciseId)
          const exName = ex?.name ?? e.exerciseId
          const measure = ex?.measure ?? 'reps'
          for (const set of e.sets) {
            if (prs.has(set.id)) {
              prHighlights.push(`${exName}: ${setLabel(set, measure)} (${s.date})`)
            }
          }
          const setsText = e.sets.map((st) => setLabel(st, measure)).join(', ')
          return `${exName} (${setsText})`
        })
      return {
        date: s.date,
        name: s.name,
        exercises: exList,
      }
    })

    // Resumo de dieta na semana por dia registrado (filtrando deleted !== true)
    const mealsInPeriod = allMeals.filter((m) => m.date >= fromDate && m.date <= refDate && m.items.length > 0)
    const mealsByDay = new Map<string, Meal[]>()
    for (const m of mealsInPeriod) {
      const list = mealsByDay.get(m.date) ?? []
      list.push(m)
      mealsByDay.set(m.date, list)
    }
    const loggedDietDays = [...mealsByDay.entries()].map(([date, ms]) => ({
      date,
      ...dayTotals(ms),
    }))
    const avgKcal =
      loggedDietDays.length > 0
        ? Math.round(loggedDietDays.reduce((a, d) => a + d.kcal, 0) / loggedDietDays.length)
        : null
    const avgProtein =
      loggedDietDays.length > 0
        ? Math.round(loggedDietDays.reduce((a, d) => a + d.p, 0) / loggedDietDays.length)
        : null

    // Peso lido da mesma fonte (`db.body` + `buildDays`) que o painel principal
    const sortedBodyWithWeight = activeBody.filter(
      (b): b is BodyEntry & { weight: number } => typeof b.weight === 'number' && b.date <= refDate,
    )
    const latestWeight =
      sortedBodyWithWeight.length > 0 ? sortedBodyWithWeight[sortedBodyWithWeight.length - 1] : null
    const weightsInWeek = sortedBodyWithWeight
      .filter((b) => b.date >= fromDate && b.date <= refDate)
      .map((b) => ({ date: b.date, weightKg: b.weight }))
    const todayWeightKg =
      panelDays.get(refDate)?.weight ??
      sortedBodyWithWeight.find((b) => b.date === refDate)?.weight ??
      null

    return {
      dataLabel: `resumo da semana (${fromDate} a ${refDate})`,
      result: {
        todayDate: localToday,
        period: { from: fromDate, to: refDate },
        workoutsCount: weekSessions.length,
        totalSets,
        streak: streakInfo,
        prsInPeriod: prHighlights,
        sessions: sessionSummaries,
        diet: {
          daysLogged: loggedDietDays.length,
          avgKcal,
          avgProtein,
          goals,
        },
        todayWeightKg,
        weightsInWeek,
        latestWeight: latestWeight ? { date: latestWeight.date, weightKg: latestWeight.weight } : null,
      },
    }
  }

  if (name === 'get_exercise_history') {
    const query = String(rawArgs.query ?? '').trim()
    const limit = Math.min(15, Math.max(1, Number(rawArgs.limit) || 8))
    const [rawExercises, rawSessions] = await Promise.all([db.exercises.toArray(), db.sessions.toArray()])
    const exercises = rawExercises.filter((e): e is Exercise => Boolean(e && e.deleted !== true))
    const sessions = rawSessions.filter(
      (s): s is Session => Boolean(s && s.deleted !== true && s.date <= localToday),
    )
    const ex = findMatchingExercise(exercises, query)
    if (!ex) {
      return {
        dataLabel: `busca de exercício ("${query}")`,
        result: {
          todayDate: localToday,
          found: false,
          message: `Nenhum exercício encontrado para "${query}".`,
        },
      }
    }

    const hist = exerciseHistory(sessions, ex.id)
    const pr = personalRecord(hist)
    const vol = totalVolume(hist)
    const recent = hist.slice(-limit).map((d) => ({
      date: d.date,
      sets: d.sets.map((s) => setLabel(s, ex.measure)),
    }))

    return {
      dataLabel: `histórico de ${ex.name}`,
      result: {
        todayDate: localToday,
        period: { from: addDays(localToday, -6), to: localToday },
        found: true,
        exercise: {
          id: ex.id,
          name: ex.name,
          category: ex.category,
          level: ex.level,
          measure: ex.measure,
        },
        totalSessions: hist.length,
        personalRecord: pr
          ? {
              date: pr.date,
              value: pr.value,
              loadKg: pr.load,
              formatted: setLabel(pr, ex.measure),
            }
          : null,
        totalVolume: vol,
        recentSessions: recent,
      },
    }
  }

  if (name === 'get_diet_summary') {
    const singleDate =
      typeof rawArgs.date === 'string' && DATE_RE.test(rawArgs.date)
        ? clampToLocalToday(rawArgs.date, localToday)
        : null
    const endDate =
      singleDate ??
      (typeof rawArgs.endDate === 'string' && DATE_RE.test(rawArgs.endDate)
        ? clampToLocalToday(rawArgs.endDate, localToday)
        : localToday)
    const rawStart =
      singleDate ??
      (typeof rawArgs.startDate === 'string' && DATE_RE.test(rawArgs.startDate)
        ? clampToLocalToday(rawArgs.startDate, endDate)
        : addDays(endDate, -6))
    const startDate = rawStart > endDate ? endDate : rawStart

    const [rawMeals, goals] = await Promise.all([
      db.meals.where('date').between(startDate, endDate, true, true).toArray(),
      getSetting<Goals>('goals', DEFAULT_GOALS),
    ])
    const meals = rawMeals.filter((m): m is Meal => Boolean(m && m.deleted !== true && m.items.length > 0))

    const byDate = new Map<string, Meal[]>()
    for (const m of meals) {
      const arr = byDate.get(m.date) ?? []
      arr.push(m)
      byDate.set(m.date, arr)
    }

    const days = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([date, ms]) => {
        const totals = dayTotals(ms)
        return {
          date,
          totals: {
            kcal: Math.round(totals.kcal),
            p: Math.round(totals.p * 10) / 10,
            c: Math.round(totals.c * 10) / 10,
            g: Math.round(totals.g * 10) / 10,
          },
          meals: ms.map((m) => ({
            type: m.type,
            items: m.items.map((i) => `${i.name} (${i.qty}: ${Math.round(i.kcal)}kcal, ${Math.round(i.p)}g P)`),
          })),
        }
      })

    return {
      dataLabel: singleDate ? `dieta de ${singleDate}` : `dieta (${startDate} a ${endDate})`,
      result: {
        todayDate: localToday,
        period: { from: startDate, to: endDate, startDate, endDate },
        goals,
        daysLogged: days.length,
        days,
      },
    }
  }

  if (name === 'get_body_evolution') {
    const daysCount = Math.min(90, Math.max(7, Number(rawArgs.days) || 30))
    const toDate = localToday
    const fromDate = addDays(toDate, -(daysCount - 1))
    const activeBody = (await readActiveBodyEntries()).filter((b) => b.date <= toDate)

    const weightPts = activeBody
      .filter((b): b is BodyEntry & { weight: number } => typeof b.weight === 'number')
      .map((b) => ({ date: b.date, value: b.weight }))
    const ma7 = new Map(movingAverage(weightPts, 7).map((p) => [p.date, Math.round(p.value * 10) / 10]))

    const filtered = activeBody.filter((b) => b.date >= fromDate && b.date <= toDate).slice(-25)
    const entries = filtered.map((b) => ({
      date: b.date,
      weightKg: b.weight ?? null,
      movingAvg7dKg: b.weight !== undefined ? (ma7.get(b.date) ?? null) : null,
      measuresCm: Object.keys(b.measures ?? {}).length > 0 ? b.measures : undefined,
    }))

    const weightsInPeriod = filtered.filter((b): b is BodyEntry & { weight: number } => typeof b.weight === 'number')
    const deltaKg =
      weightsInPeriod.length >= 2
        ? Math.round((weightsInPeriod[weightsInPeriod.length - 1].weight - weightsInPeriod[0].weight) * 10) / 10
        : null
    const todayEntry = activeBody.find((b) => b.date === toDate && typeof b.weight === 'number')
    const latestEntry = weightPts.length > 0 ? weightPts[weightPts.length - 1] : null

    return {
      dataLabel: `evolução corporal (${fromDate} a ${toDate})`,
      result: {
        todayDate: toDate,
        period: { from: fromDate, to: toDate },
        fromDate,
        toDate,
        todayWeightKg: todayEntry?.weight ?? null,
        latestWeight: latestEntry ? { date: latestEntry.date, weightKg: latestEntry.value } : null,
        totalEntriesInPeriod: entries.length,
        weightDeltaKg: deltaKg,
        entries,
      },
    }
  }

  if (name === 'list_exercises_and_routines') {
    const categoryFilter = typeof rawArgs.category === 'string' ? normalizeStr(rawArgs.category) : ''
    const [rawExercises, rawRoutines] = await Promise.all([db.exercises.toArray(), db.routines.toArray()])
    const exercises = rawExercises.filter((e): e is Exercise => Boolean(e && e.deleted !== true))
    const routines = rawRoutines.filter((r): r is Routine => Boolean(r && r.deleted !== true))
    const exMap = new Map(exercises.map((e) => [e.id, e.name]))

    const filteredEx = exercises
      .filter((e) => !categoryFilter || normalizeStr(e.category).includes(categoryFilter))
      .sort((a, b) => a.category.localeCompare(b.category) || a.level - b.level)
      .slice(0, 60)
      .map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        level: e.level,
        measure: e.measure,
      }))

    const routineList = routines.map((r) => ({
      id: r.id,
      name: r.name,
      exercises: r.exerciseIds.map((id) => exMap.get(id) ?? id),
    }))

    return {
      dataLabel: 'lista de exercícios e rotinas',
      result: {
        exercisesCount: filteredEx.length,
        exercises: filteredEx,
        routines: routineList,
      },
    }
  }

  // ---------- Ferramentas de proposta de escrita (geram rascunho sem gravar no banco) ----------

  if (name === 'propose_meal') {
    const date =
      typeof rawArgs.date === 'string' && DATE_RE.test(rawArgs.date)
        ? clampToLocalToday(rawArgs.date, localToday)
        : localToday
    const mealType = String(rawArgs.type ?? 'almoco') as MealType
    const rawItems = Array.isArray(rawArgs.items) ? rawArgs.items : []
    const items: MealItem[] = rawItems.map((it: any) => ({
      name: String(it?.name ?? '').trim(),
      qty: String(it?.qty ?? '1 porção').trim(),
      kcal: Number(it?.kcal ?? 0),
      p: Number(it?.p ?? 0),
      c: Number(it?.c ?? 0),
      g: Number(it?.g ?? 0),
    }))

    const draft: MealDraft = {
      id: uid(),
      kind: 'meal',
      status: 'pending',
      date,
      mealType,
      items,
    }
    validateDraft(draft)

    return {
      dataLabel: 'proposta de rascunho de refeição',
      draft,
      result: {
        status: 'draft_created',
        note: 'Rascunho de refeição criado na interface. O usuário precisa tocar em confirmar para salvar.',
        draftSummary: { date, mealType, itemsCount: items.length, totals: dayTotals([{ id: 'tmp', date, type: mealType, items, createdAt: 0 }]) },
      },
    }
  }

  if (name === 'propose_routine') {
    const routineName = String(rawArgs.name ?? '').trim()
    const requested = Array.isArray(rawArgs.exercises) ? rawArgs.exercises.map((x) => String(x)) : []
    const allExercises = (await db.exercises.toArray()).filter((e) => e && e.deleted !== true)

    const matchedIds: string[] = []
    const matchedNames: string[] = []
    for (const q of requested) {
      const found = findMatchingExercise(allExercises, q)
      if (found && !matchedIds.includes(found.id)) {
        matchedIds.push(found.id)
        matchedNames.push(found.name)
      }
    }

    const draft: RoutineDraft = {
      id: uid(),
      kind: 'routine',
      status: 'pending',
      name: routineName,
      exerciseIds: matchedIds,
      exerciseNames: matchedNames,
    }
    validateDraft(draft)

    return {
      dataLabel: 'proposta de rascunho de rotina',
      draft,
      result: {
        status: 'draft_created',
        note: 'Rascunho de rotina criado na interface. O usuário precisa tocar em confirmar para salvar.',
        draftSummary: { name: routineName, exercises: matchedNames },
      },
    }
  }

  if (name === 'propose_body_weight') {
    const date =
      typeof rawArgs.date === 'string' && DATE_RE.test(rawArgs.date)
        ? clampToLocalToday(rawArgs.date, localToday)
        : localToday
    const weight = rawArgs.weight !== undefined && rawArgs.weight !== null ? Number(rawArgs.weight) : undefined
    const rawMeasures = rawArgs.measures && typeof rawArgs.measures === 'object' ? (rawArgs.measures as Record<string, unknown>) : {}
    const measures: Record<string, number> = {}
    for (const [k, v] of Object.entries(rawMeasures)) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) measures[k.trim().toLowerCase()] = Math.round(n * 10) / 10
    }

    const draft: BodyDraft = {
      id: uid(),
      kind: 'body',
      status: 'pending',
      date,
      weight,
      measures,
    }
    validateDraft(draft)

    return {
      dataLabel: 'proposta de rascunho de peso/medidas',
      draft,
      result: {
        status: 'draft_created',
        note: 'Rascunho de registro corporal criado na interface. O usuário precisa tocar em confirmar para salvar.',
        draftSummary: { date, weight, measures },
      },
    }
  }

  throw new Error(`Ferramenta desconhecida: ${name}`)
}

// ---------- Persistência local-only do histórico da conversa (isolada por UID quando logado) ----------

export function getAssistantHistoryKeyForUser(explicitUid?: string | null): string {
  const activeUid = (explicitUid ?? getSyncStatus().user?.uid ?? '').trim()
  return activeUid ? `${ASSISTANT_HISTORY_KEY}:${activeUid}` : ASSISTANT_HISTORY_KEY
}

export async function loadAssistantHistory(explicitUid?: string | null): Promise<ChatTurnMessage[]> {
  const key = getAssistantHistoryKeyForUser(explicitUid)
  const row = await getRawRecord('settings', key)
  if (row && !row.deleted && Array.isArray(row.value)) {
    return row.value as ChatTurnMessage[]
  }
  if (key !== ASSISTANT_HISTORY_KEY) {
    const legacy = await getRawRecord('settings', ASSISTANT_HISTORY_KEY)
    if (legacy && !legacy.deleted && Array.isArray(legacy.value)) {
      return legacy.value as ChatTurnMessage[]
    }
  }
  return []
}

export async function saveAssistantHistory(
  messages: ChatTurnMessage[],
  explicitUid?: string | null,
): Promise<void> {
  const key = getAssistantHistoryKeyForUser(explicitUid)
  const trimmed = messages.slice(-30)
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.put({
      key,
      value: trimmed,
      updatedAt: now,
      deleted: false,
    })
  })
}

export async function clearAssistantHistory(explicitUid?: string | null): Promise<void> {
  const key = getAssistantHistoryKeyForUser(explicitUid)
  const now = Date.now()
  await runApplyingRemote(async () => {
    await db.settings.put({
      key,
      value: [],
      updatedAt: now,
      deleted: false,
    })
    if (key !== ASSISTANT_HISTORY_KEY) {
      await db.settings.put({
        key: ASSISTANT_HISTORY_KEY,
        value: [],
        updatedAt: now,
        deleted: false,
      })
    }
  })
}

// ---------- Comunicação com o Cloudflare Worker (/chat) ----------

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface WorkerChatResponse {
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      /** Campos de raciocínio interno (ex.: gpt-oss) são sempre ignorados pelo app */
      reasoning?: unknown
      reasoning_content?: unknown
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  }>
  error?: string
}

/**
 * Extrai apenas o conteúdo final (`content`) da mensagem do modelo,
 * descartando explicitamente qualquer campo de raciocínio (`reasoning`, `reasoning_content`).
 */
export function extractFinalAssistantContent(message: {
  content?: string | null
  reasoning?: unknown
  reasoning_content?: unknown
}): string {
  if (typeof message?.content !== 'string') return ''
  return message.content.trim()
}

export interface SendAssistantOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
  now?: Date
  userUid?: string | null
}

/**
 * Retorna a lista de ferramentas disponíveis para o usuário:
 * - Proprietário (`OWNER_UID`): todas as ferramentas (incluindo Google Calendar).
 * - Contas secundárias: ferramentas de treino, dieta, corpo, prazos de Faculdade e lembretes push, SEM Google Calendar.
 */
export function getAssistantToolsForUser(explicitUid?: string | null): ToolDefinition[] {
  if (isCurrentUserOwner(explicitUid)) {
    return ASSISTANT_TOOLS
  }
  return ASSISTANT_TOOLS.filter((t) => !CALENDAR_TOOL_NAMES.has(t.function.name))
}

async function defaultGetIdToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser
  if (!user) return null
  return user.getIdToken()
}

function mapHttpError(status: number, serverError?: string): string {
  if (status === 401) {
    return 'error: sessão expirada ou não autenticada (401). Entre novamente em Configurações.'
  }
  if (status === 403) {
    return 'error: acesso negado pelo proxy (403). Verifique ALLOWED_UID e ALLOWED_ORIGINS no Worker.'
  }
  if (status === 429) {
    return 'error: limite de requisições atingido (429). Aguarde alguns segundos e tente novamente.'
  }
  if (status === 413) {
    return 'error: conversa muito longa para uma única requisição (413). Limpe o histórico e tente de novo.'
  }
  if (status === 503) {
    return 'error: chave do assistente não configurada'
  }
  if (serverError) {
    return serverError.startsWith('error:') ? serverError : `error: ${serverError}`
  }
  return `error: falha no assistente (HTTP ${status}). Tente novamente em instantes.`
}

export async function sendAssistantTurn(
  userText: string,
  priorHistory: ChatTurnMessage[],
  options: SendAssistantOptions = {},
): Promise<ChatTurnMessage> {
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? defaultGetIdToken
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
  const now = options.now ?? new Date()

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('error: sem conexão com a internet. O assistente requer conexão ativa.')
  }

  const token = await getToken()
  if (!token) {
    throw new Error('error: você precisa estar logado na nuvem (Configurações) para usar o assistente.')
  }

  const recentContext = priorHistory.slice(-10).map<ApiMessage>((m) => ({
    role: m.role,
    content: m.content,
  }))

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: buildSystemPrompt(now, options.userUid) },
    ...recentContext,
    { role: 'user', content: userText },
  ]
  const activeTools = getAssistantToolsForUser(options.userUid)

  const dataSentLabels: string[] = ['mensagem da conversa']
  const collectedDrafts: AssistantDraft[] = []
  const collectedCalendarCards: CalendarCardItem[] = []
  const collectedReminderCards: PushReminderCardItem[] = []

  const MAX_TOOL_ROUNDS = 4
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let res: Response
    try {
      res = await fetcher(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: apiMessages,
          tools: activeTools,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 800,
        }),
      })
    } catch {
      throw new Error('error: falha de rede ao conectar ao Worker do assistente. Verifique sua internet ou a URL do Worker.')
    }

    let payload: WorkerChatResponse = {}
    try {
      payload = (await res.json()) as WorkerChatResponse
    } catch {
      // ignora erro de parse se corpo vier vazio
    }

    if (!res.ok) {
      throw new Error(mapHttpError(res.status, payload.error))
    }

    const msg = payload.choices?.[0]?.message
    if (!msg) {
      throw new Error('error: resposta vazia do assistente.')
    }

    const toolCalls = msg.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = extractFinalAssistantContent(msg) || 'Sem resposta adicional.'
      return {
        id: uid(),
        role: 'assistant',
        content: finalText,
        createdAt: Date.now(),
        dataSent: [...new Set(dataSentLabels)],
        drafts: collectedDrafts.length > 0 ? collectedDrafts : undefined,
        calendarCards: collectedCalendarCards.length > 0 ? collectedCalendarCards : undefined,
        reminderCards: collectedReminderCards.length > 0 ? collectedReminderCards : undefined,
      }
    }

    // Adiciona a mensagem do assistente com tool_calls (sem repassar reasoning) e executa cada ferramenta localmente sobre o Dexie
    apiMessages.push({
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
      tool_calls: toolCalls,
    })

    for (const tc of toolCalls) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
      } catch {
        parsedArgs = {}
      }

      try {
        const out = await executeAssistantTool(tc.function.name, parsedArgs, now, {
          fetcher,
          getToken,
          workerUrl: baseUrl,
        })
        dataSentLabels.push(out.dataLabel)
        if (out.draft) {
          collectedDrafts.push(out.draft)
        }
        if (out.calendarCards) {
          collectedCalendarCards.push(...out.calendarCards)
        }
        if (out.reminderCards) {
          collectedReminderCards.push(...out.reminderCards)
        }
        apiMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(out.result),
        })
      } catch (err) {
        apiMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: (err as Error).message }),
        })
      }
    }
  }

  return {
    id: uid(),
    role: 'assistant',
    content:
      collectedDrafts.length > 0
        ? 'Preparei o rascunho abaixo com base nos seus dados. Confira os detalhes e toque em confirmar para salvar.'
        : 'Consulta concluída.',
    createdAt: Date.now(),
    dataSent: [...new Set(dataSentLabels)],
    drafts: collectedDrafts.length > 0 ? collectedDrafts : undefined,
    calendarCards: collectedCalendarCards.length > 0 ? collectedCalendarCards : undefined,
    reminderCards: collectedReminderCards.length > 0 ? collectedReminderCards : undefined,
  }
}

/**
 * Cancela um lembrete Web Push a partir do botão rápido no card exibido no chat.
 */
export async function cancelPushReminderCard(
  card: PushReminderCardItem,
  options: SendAssistantOptions = {},
): Promise<PushReminderInfo | null> {
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? defaultGetIdToken
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
  const token = await getToken()
  if (!token) {
    throw new Error('error: entre na sua conta em Configurações para cancelar o lembrete.')
  }

  const res = await fetcher(`${baseUrl}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reminder_action: {
        tool: 'cancel_push_reminder',
        args: { id: card.reminder.id },
      },
    }),
  })
  const data = (await res.json()) as Record<string, any>
  if (!res.ok || data.error) {
    throw new Error(data.error || `Falha ao cancelar lembrete (HTTP ${res.status}).`)
  }
  return (data.reminder as PushReminderInfo) ?? null
}

/**
 * Confirma no Worker uma edição ou exclusão de evento do Google Calendar
 * após o usuário tocar no botão Confirmar no card do evento.
 */
export async function confirmCalendarCard(
  card: CalendarCardItem,
  options: SendAssistantOptions = {},
): Promise<CalendarEventInfo | null> {
  if (!card.pendingAction) {
    throw new Error('Nenhuma ação pendente neste evento.')
  }
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? defaultGetIdToken
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
  const token = await getToken()
  if (!token) {
    throw new Error('error: entre na sua conta em Configurações para confirmar na agenda.')
  }

  const res = await fetcher(`${baseUrl}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      calendar_action: {
        tool: card.pendingAction.tool,
        args: {
          id: card.pendingAction.id,
          ...(card.pendingAction.campos ? { campos: card.pendingAction.campos } : {}),
          confirmado: 'confirmado',
        },
      },
    }),
  })

  const data = (await res.json()) as Record<string, any>
  if (!res.ok || data.error) {
    throw new Error(data.error || `Falha ao confirmar evento (HTTP ${res.status}).`)
  }
  return (data.event as CalendarEventInfo) ?? null
}
