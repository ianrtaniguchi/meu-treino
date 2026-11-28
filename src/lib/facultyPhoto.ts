import { ASSISTANT_WORKER_URL } from '../assistantConfig'
import { uid } from '../data/db'
import { getFirebaseAuth } from '../data/sync'
import { MAX_DATA_URL_CHARS, MealAnalysisError, resizeImageToJpeg } from './mealPhoto'

export interface FacultyScheduleDraft {
  id: string
  courseName: string
  dayOfWeek: number | null
  startTime: string
  endTime: string
  room: string
  professor: string
}

export class FacultyPhotoAnalysisError extends MealAnalysisError {}

const DAY_ALIASES: Record<string, number> = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  'segunda-feira': 1,
  seg: 1,
  terca: 2,
  'terca-feira': 2,
  ter: 2,
  quarta: 3,
  'quarta-feira': 3,
  qua: 3,
  quinta: 4,
  'quinta-feira': 4,
  qui: 4,
  sexta: 5,
  'sexta-feira': 5,
  sex: 5,
  sabado: 6,
  sab: 6,
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function readText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new FacultyPhotoAnalysisError(`campo ${field} inválido na resposta da IA.`)
  const text = value.trim()
  if (text.length > maxLength) throw new FacultyPhotoAnalysisError(`campo ${field} longo demais na resposta da IA.`)
  return text
}

function parseDay(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return value
  if (typeof value !== 'string') return null
  const normalized = normalizeText(value)
  if (/^[0-6]$/.test(normalized)) return Number(normalized)
  return DAY_ALIASES[normalized] ?? null
}

export function validateFacultyScheduleAnalysis(raw: unknown, createId: () => string = uid): FacultyScheduleDraft[] {
  const aulas = raw && typeof raw === 'object' ? (raw as { aulas?: unknown }).aulas : undefined
  if (!Array.isArray(aulas)) throw new FacultyPhotoAnalysisError('resposta da IA em formato inesperado.')
  if (aulas.length > 80) throw new FacultyPhotoAnalysisError('a resposta da IA contém aulas demais.')

  return aulas.map((aula) => {
    if (!aula || typeof aula !== 'object' || Array.isArray(aula)) {
      throw new FacultyPhotoAnalysisError('uma aula retornada pela IA está inválida.')
    }
    const item = aula as Record<string, unknown>
    return {
      id: createId(),
      courseName: readText(item.disciplina, 'disciplina', 100),
      dayOfWeek: parseDay(item.dia),
      startTime: readText(item.inicio, 'início', 5),
      endTime: readText(item.fim, 'fim', 5),
      room: readText(item.sala, 'sala', 100),
      professor: readText(item.professor, 'professor', 100),
    }
  })
}

export interface AnalyzeFacultyPhotoOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
  prepareImage?: (file: Blob) => Promise<string>
}

export async function analyzeFacultySchedulePhoto(
  file: Blob,
  options: AnalyzeFacultyPhotoOptions = {},
): Promise<FacultyScheduleDraft[]> {
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? (() => {
    const user = getFirebaseAuth().currentUser
    return user ? user.getIdToken() : Promise.resolve(null)
  })
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new FacultyPhotoAnalysisError('sem conexão com a internet.')
  }
  const token = await getToken()
  if (!token) throw new FacultyPhotoAnalysisError('entre na sua conta para analisar a foto do horário.')

  let image: string
  try {
    image = await (options.prepareImage ?? ((input: Blob) => resizeImageToJpeg(input)))(file)
  } catch (error) {
    if (error instanceof Error) throw new FacultyPhotoAnalysisError(error.message)
    throw new FacultyPhotoAnalysisError('não consegui preparar a foto do horário.')
  }
  if (!image || image.length > MAX_DATA_URL_CHARS) {
    throw new FacultyPhotoAnalysisError('foto muito grande mesmo após compressão.')
  }

  let response: Response
  try {
    response = await fetcher(`${baseUrl}/analyze-faculty-schedule`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    })
  } catch {
    throw new FacultyPhotoAnalysisError('falha de rede ao enviar a foto.')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new FacultyPhotoAnalysisError('resposta inválida do serviço de análise.')
  }
  if (!response.ok) {
    const message = (payload as { error?: unknown } | null)?.error
    throw new FacultyPhotoAnalysisError(
      typeof message === 'string' ? message.replace(/^error:\s*/, '') : `falha ao analisar o horário (HTTP ${response.status}).`,
    )
  }
  return validateFacultyScheduleAnalysis(payload)
}
