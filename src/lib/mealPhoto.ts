import { ASSISTANT_WORKER_URL } from '../assistantConfig'
import { db } from '../data/db'
import { getFirebaseAuth } from '../data/sync'
import type { MealItem, MealType } from '../data/types'

// ---------- Registro na dieta (mesmo formato usado pela aba Dieta) ----------

export const mealId = (date: string, type: MealType) => `meal-${date}-${type}`

/** Acrescenta itens à refeição do dia (cria a refeição se ainda não existir). */
export async function addItems(date: string, type: MealType, items: MealItem[]) {
  const id = mealId(date, type)
  const m = (await db.meals.get(id)) ?? { id, date, type, items: [], createdAt: Date.now() }
  await db.meals.put({ ...m, items: [...m.items, ...items] })
}

/** Desfaz um `addItems`: remove os últimos `count` itens da refeição (apaga a refeição se esvaziar). */
export async function undoAddItems(date: string, type: MealType, count: number) {
  const m = await db.meals.get(mealId(date, type))
  if (!m) return
  const items = m.items.slice(0, Math.max(0, m.items.length - count))
  if (items.length) await db.meals.put({ ...m, items })
  else await db.meals.delete(m.id)
}

/** Refeição correspondente ao horário local: café 4–10h, almoço 10–15h, lanche 15–18h, jantar 18–23h, lanche de madrugada. */
export function mealTypeForHour(now: Date = new Date()): MealType {
  const h = now.getHours()
  if (h >= 4 && h < 10) return 'cafe'
  if (h >= 10 && h < 15) return 'almoco'
  if (h >= 15 && h < 18) return 'lanche'
  if (h >= 18 && h < 23) return 'jantar'
  return 'lanche'
}

// ---------- Validação da resposta da IA ----------

export class MealAnalysisError extends Error {}
/** A foto não tem comida (lista de itens vazia). */
export class NoFoodError extends MealAnalysisError {}

const MAX_ITEMS = 20
const num = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null

/**
 * Valida o JSON `{ "itens": [ { nome, gramas, kcal, proteina_g, carbo_g, gordura_g, confianca } ] }`
 * e converte para o formato de item de refeição do app. Lança MealAnalysisError (inválido)
 * ou NoFoodError (sem comida) — nesses casos nada deve ser salvo.
 */
export function validateMealAnalysis(raw: unknown): MealItem[] {
  const itens = raw && typeof raw === 'object' ? (raw as { itens?: unknown }).itens : undefined
  if (!Array.isArray(itens)) throw new MealAnalysisError('resposta da IA em formato inesperado.')
  if (itens.length === 0) throw new NoFoodError('não encontrei comida na foto.')
  if (itens.length > MAX_ITEMS) throw new MealAnalysisError('resposta da IA com itens demais.')

  return itens.map((it: any) => {
    const nome = typeof it?.nome === 'string' ? it.nome.trim() : ''
    const gramas = num(it?.gramas, 5000)
    const kcal = num(it?.kcal, 5000)
    const p = num(it?.proteina_g, 1000)
    const c = num(it?.carbo_g, 1000)
    const g = num(it?.gordura_g, 1000)
    if (!nome || nome.length > 80 || gramas === null || kcal === null || p === null || c === null || g === null) {
      throw new MealAnalysisError('resposta da IA com valores inválidos.')
    }
    return {
      name: nome,
      qty: gramas > 0 ? `${Math.round(gramas)} g` : '1 porção',
      kcal: Math.round(kcal),
      p: Math.round(p * 10) / 10,
      c: Math.round(c * 10) / 10,
      g: Math.round(g * 10) / 10,
    }
  })
}

// ---------- Redução da imagem no cliente ----------

export const MAX_RAW_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MB
export const MAX_DATA_URL_CHARS = 1_400_000 // abaixo do limite de 1,5 MB do Worker

/** Reduz a foto (lado maior `maxSide` px) e devolve um data URL JPEG. */
export async function resizeImageToJpeg(file: Blob, maxSide = 1024, quality = 0.8): Promise<string> {
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw new MealAnalysisError('arquivo de imagem muito grande (máx. 20 MB).')
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new MealAnalysisError('não consegui ler a imagem.'))
      i.src = url
    })
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new MealAnalysisError('não consegui processar a imagem.')
    ctx.drawImage(img, 0, 0, w, h)
    let dataUrl = canvas.toDataURL('image/jpeg', quality)
    if (dataUrl.length > 1_200_000 && quality > 0.6) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.6)
    }
    return dataUrl
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------- Chamada ao Worker ----------

export interface AnalyzeMealOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
  /** Permite injetar o preparo da imagem (testes). Padrão: reduzir para 1024 px / JPEG 0.8. */
  prepareImage?: (file: Blob) => Promise<string>
}

async function defaultGetIdToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser
  return user ? user.getIdToken() : null
}

function httpMessage(status: number, serverError?: string): string {
  if (status === 401) return 'sessão expirada (401). Entre novamente em ~/config.'
  if (status === 403) return 'acesso negado pelo proxy (403).'
  if (status === 413) return 'foto muito grande (413).'
  if (status === 429) return 'limite de requisições atingido (429). Tente em instantes.'
  if (status === 503) return 'chave do assistente não configurada.'
  if (serverError) return serverError.replace(/^error:\s*/, '')
  return `falha ao analisar a foto (HTTP ${status}).`
}

/** Envia a foto ao Worker (/analyze-meal) e devolve os itens já validados. Nada é salvo aqui. */
export async function analyzeMealPhoto(file: Blob, options: AnalyzeMealOptions = {}): Promise<MealItem[]> {
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? defaultGetIdToken
  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new MealAnalysisError('sem conexão com a internet.')
  }
  const token = await getToken()
  if (!token) throw new MealAnalysisError('entre na sua conta em ~/config para usar a foto do prato.')

  const image = await (options.prepareImage ?? ((f: Blob) => resizeImageToJpeg(f)))(file)
  if (!image || image.length > MAX_DATA_URL_CHARS) {
    throw new MealAnalysisError('foto muito grande mesmo após compressão.')
  }

  let res: Response
  try {
    res = await fetcher(`${baseUrl}/analyze-meal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    })
  } catch {
    throw new MealAnalysisError('falha de rede ao enviar a foto.')
  }

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    // corpo vazio ou inválido
  }
  if (!res.ok) {
    throw new MealAnalysisError(httpMessage(res.status, (payload as { error?: string } | null)?.error))
  }
  return validateMealAnalysis(payload)
}
