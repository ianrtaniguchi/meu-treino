import { db, getSetting } from './db'
import type { Exercise, Food, Goals } from './types'

export const SEED_VERSION = 1
export const DEFAULT_GOALS: Goals = { kcal: 2400, p: 150, c: 280, g: 70 }

const slug = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** Progressões por categoria, do mais fácil ao mais difícil. Sufixo "*" = medido em tempo (isométrico). */
const CATALOG: [string, string[]][] = [
  ['Flexões', ['Flexão inclinada', 'Flexão de joelhos', 'Flexão', 'Flexão diamante', 'Flexão declinada', 'Flexão archer', 'Flexão pseudo planche', 'Flexão uma mão (assistida)', 'Flexão uma mão']],
  ['Barra fixa', ['Hang passivo*', 'Hang ativo*', 'Remada australiana', 'Barra fixa negativa', 'Barra fixa', 'Barra fixa pegada fechada', 'Barra fixa archer', 'Barra fixa explosiva', 'Barra fixa uma mão (assistida)']],
  ['Paralelas e dips', ['Dip no banco', 'Apoio nas paralelas*', 'Dip nas paralelas negativo', 'Dip nas paralelas', 'Dip russo', 'Dip com carga']],
  ['Muscle-up', ['Barra fixa alta (peito na barra)', 'Transição na barra', 'Muscle-up negativo', 'Muscle-up na barra', 'Muscle-up nas argolas']],
  ['Front lever', ['Tuck front lever*', 'Advanced tuck front lever*', 'Straddle front lever*', 'Front lever completo*', 'Front lever pull-up']],
  ['Planche', ['Planche lean*', 'Tuck planche*', 'Advanced tuck planche*', 'Straddle planche*', 'Full planche*']],
  ['Handstand', ['Parada de mão na parede (barriga)*', 'Parada de mão na parede (costas)*', 'Parada de mão livre*', 'Flexão de parada de mão (pike)', 'Flexão de parada de mão na parede', 'Flexão de parada de mão livre']],
  ['Agachamento e pernas', ['Agachamento', 'Agachamento búlgaro', 'Afundo', 'Agachamento com salto', 'Agachamento cossaco', 'Pistol assistido', 'Pistol squat', 'Elevação de panturrilha', 'Nordic curl']],
  ['Core', ['Prancha*', 'Prancha lateral*', 'Elevação de joelhos', 'Elevação de pernas', 'Hollow body*', 'L-sit no chão*', 'L-sit nas paralelas*', 'V-sit*', 'Dragon flag', 'Toes to bar']],
  ['Costas e ombros', ['Superman*', 'Remada invertida', 'Face pull com elástico', 'Pike push-up', 'Skin the cat']],
]

export const BUILTIN_EXERCISES: Exercise[] = CATALOG.flatMap(([category, names]) =>
  names.map((raw, i): Exercise => {
    const time = raw.endsWith('*')
    const name = time ? raw.slice(0, -1) : raw
    return { id: `ex-${slug(category)}-${slug(name)}`, name, category, level: i + 1, measure: time ? 'time' : 'reps', builtin: true }
  }),
)

// Valores APROXIMADOS (baseados em tabelas brasileiras comuns), editáveis pelo usuário.
const FOODS: [string, string, number, number, number, number][] = [
  ['Arroz branco cozido', '100 g', 128, 2.5, 28, 0.2],
  ['Feijão carioca cozido', '100 g', 76, 4.8, 13.6, 0.5],
  ['Peito de frango grelhado', '100 g', 159, 32, 0, 2.5],
  ['Patinho bovino grelhado', '100 g', 219, 36, 0, 7.3],
  ['Tilápia grelhada', '100 g', 128, 26, 0, 2.7],
  ['Ovo cozido', '1 unidade (50 g)', 72, 6.3, 0.4, 4.8],
  ['Pão francês', '1 unidade (50 g)', 150, 4.7, 29, 1.6],
  ['Pão de forma', '2 fatias (50 g)', 130, 4, 24, 1.5],
  ['Banana prata', '1 unidade (70 g)', 68, 0.7, 17.5, 0.1],
  ['Maçã', '1 unidade (130 g)', 68, 0.3, 18, 0.2],
  ['Mamão papaia', '100 g', 40, 0.5, 10, 0.1],
  ['Leite integral', '200 ml', 122, 6.2, 9.4, 6.6],
  ['Iogurte natural', '170 g', 100, 6, 8, 5],
  ['Queijo mussarela', '30 g', 90, 6.6, 0.9, 6.8],
  ['Aveia em flocos', '30 g', 118, 4.2, 20, 2.2],
  ['Batata-doce cozida', '100 g', 77, 0.6, 18.4, 0.1],
  ['Macarrão cozido', '100 g', 122, 4.5, 24, 0.9],
  ['Pasta de amendoim', '15 g', 90, 3.8, 3, 7.5],
  ['Whey protein', '30 g', 120, 24, 3, 1.5],
  ['Azeite de oliva', '1 colher de sopa (13 ml)', 117, 0, 0, 13],
]

export const BUILTIN_FOODS: Food[] = FOODS.map(([name, qty, kcal, p, c, g]) => ({
  id: `food-${slug(name)}`, name, qty, kcal, p, c, g, favorite: false, builtin: true,
}))

/** Popula exercícios e alimentos padrão uma única vez (não recria itens que o usuário apagou). */
export async function ensureSeed(): Promise<void> {
  const done = await getSetting<number>('seedVersion', 0)
  if (done >= SEED_VERSION) return
  await db.transaction('rw', db.exercises, db.foods, db.settings, async () => {
    const ex = new Set((await db.exercises.toCollection().primaryKeys()) as string[])
    const fd = new Set((await db.foods.toCollection().primaryKeys()) as string[])
    await db.exercises.bulkAdd(BUILTIN_EXERCISES.filter((e) => !ex.has(e.id)).map((e) => ({ ...e, _seedInit: true, updatedAt: 1 } as any)))
    await db.foods.bulkAdd(BUILTIN_FOODS.filter((f) => !fd.has(f.id)).map((f) => ({ ...f, _seedInit: true, updatedAt: 1 } as any)))
    await db.settings.put({ key: 'seedVersion', value: SEED_VERSION, _seedInit: true, updatedAt: 1 } as any)
    if ((await db.settings.get('goals')) === undefined) await db.settings.put({ key: 'goals', value: DEFAULT_GOALS, _seedInit: true, updatedAt: 1 } as any)
    if ((await db.settings.get('restSeconds')) === undefined) await db.settings.put({ key: 'restSeconds', value: 90, _seedInit: true, updatedAt: 1 } as any)
    if ((await db.settings.get('firstUseAt')) === undefined) await db.settings.put({ key: 'firstUseAt', value: Date.now(), _seedInit: true, updatedAt: 1 } as any)
  })
}
