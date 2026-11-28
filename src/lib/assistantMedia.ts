import { ASSISTANT_WORKER_URL, OWNER_UID } from '../assistantConfig'
import { db, getSetting } from '../data/db'
import { getFirebaseAuth } from '../data/sync'
import { EMPTY_FACULTY_DATA, FACULDADE_SETTING_KEY, getNextFacultyDeadline } from './faculty'
import { containsFinancialIdentifier } from './expenses'
import { MAX_DATA_URL_CHARS, resizeImageToJpeg } from './mealPhoto'
import { today } from '../data/stats'

export interface AssistantSuggestionContext {
  timeOfDay: 'manhã' | 'tarde' | 'noite'
  workoutLogged: boolean
  mealsLogged: number
  deadlineInDays?: number | null
  expenseEntriesThisMonth?: number
}

export interface AssistantPhotoAnalysis {
  intent: 'meal' | 'expense' | 'event' | 'unclear'
  meal?: {
    date: string
    type: 'cafe' | 'almoco' | 'jantar' | 'lanche'
    items: Array<{ name: string; qty: string; kcal: number; p: number; c: number; g: number }>
  }
  expense?: {
    date: string
    amountCents: number
    category: string
    merchant?: string
  }
  event?: {
    title: string
    startAt: string
    endAt?: string
    location?: string
    description?: string
  }
  message?: string
}

interface AssistantMediaOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
  prepareImage?: (file: Blob) => Promise<string>
}

const suggestionCache = new Map<string, { expiresAt: number; items: string[] }>()
const SUGGESTIONS_TTL_MS = 15 * 60_000

async function defaultGetToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser
  return user ? user.getIdToken() : null
}

function workerUrl(override?: string): string {
  return (override ?? ASSISTANT_WORKER_URL).trim().replace(/\/+$/, '')
}

export async function buildAssistantSuggestionContext(
  userUid: string,
  now = new Date(),
): Promise<AssistantSuggestionContext> {
  const localDate = today(now)
  const [workouts, meals] = await Promise.all([
    db.sessions.where('date').equals(localDate).count(),
    db.meals.where('date').equals(localDate).count(),
  ])
  const context: AssistantSuggestionContext = {
    timeOfDay: now.getHours() < 12 ? 'manhã' : now.getHours() < 18 ? 'tarde' : 'noite',
    workoutLogged: workouts > 0,
    mealsLogged: meals,
  }

  if (userUid === OWNER_UID) {
    const [faculty, expenseEntriesThisMonth] = await Promise.all([
      getSetting(FACULDADE_SETTING_KEY, EMPTY_FACULTY_DATA),
      db.expenses
        .where('date')
        .between(`${localDate.slice(0, 7)}-01`, `${localDate.slice(0, 7)}-31`, true, true)
        .count(),
    ])
    const deadline = getNextFacultyDeadline(faculty.deadlines, faculty.courses, now)
    context.deadlineInDays = deadline
      ? Math.max(0, Math.ceil((deadline.dueAt.getTime() - now.getTime()) / 86_400_000))
      : null
    context.expenseEntriesThisMonth = expenseEntriesThisMonth
  }
  return context
}

export async function fetchAssistantSuggestions(
  userUid: string,
  options: AssistantMediaOptions & { now?: Date } = {},
): Promise<string[]> {
  const now = options.now ?? new Date()
  const bucket = Math.floor(now.getHours() / 4)
  const cacheKey = `${userUid}:${today(now)}:${bucket}`
  const cached = suggestionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.items

  const getToken = options.getToken ?? defaultGetToken
  const token = await getToken()
  if (!token) throw new Error('Entre na sua conta para gerar sugestões do assistente.')

  const response = await (options.fetcher ?? fetch)(`${workerUrl(options.workerUrl)}/suggestions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ context: await buildAssistantSuggestionContext(userUid, now) }),
  })
  const payload = (await response.json()) as { suggestions?: unknown; error?: string }
  if (!response.ok) throw new Error(payload.error || `Falha ao gerar sugestões (HTTP ${response.status}).`)

  const items = Array.isArray(payload.suggestions)
    ? payload.suggestions
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 100))
        .filter((item) => item.length > 0)
        .slice(0, 4)
    : []
  if (items.length < 2) throw new Error('O assistente não retornou sugestões suficientes.')
  suggestionCache.set(cacheKey, { expiresAt: Date.now() + SUGGESTIONS_TTL_MS, items })
  return items
}

export async function analyzeAssistantPhoto(
  file: File,
  text: string,
  options: AssistantMediaOptions = {},
): Promise<AssistantPhotoAnalysis> {
  if (containsFinancialIdentifier(text)) {
    throw new Error('Não envie números de cartão, banco ou conta ao assistente.')
  }
  if (text.length > 500) throw new Error('O texto junto da foto pode ter até 500 caracteres.')

  const image = await (options.prepareImage ?? ((blob: Blob) => resizeImageToJpeg(blob)))(file)
  if (!image || image.length > MAX_DATA_URL_CHARS) {
    throw new Error('A foto ainda ficou grande demais após a compressão.')
  }

  const token = await (options.getToken ?? defaultGetToken)()
  if (!token) throw new Error('Entre na sua conta em Configurações para analisar fotos.')

  const response = await (options.fetcher ?? fetch)(
    `${workerUrl(options.workerUrl)}/analyze-assistant-photo`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image, text: text.trim() }),
    },
  )
  const payload = (await response.json()) as AssistantPhotoAnalysis & { error?: string }
  if (!response.ok) throw new Error(payload.error || `Falha ao analisar foto (HTTP ${response.status}).`)
  return payload
}
