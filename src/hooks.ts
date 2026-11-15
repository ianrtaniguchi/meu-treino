import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './data/db'

/** Lê uma configuração de forma reativa. `undefined` enquanto carrega. */
export function useSetting<T>(key: string, fallback: T): T | undefined {
  return useLiveQuery(async () => {
    const r = await db.settings.get(key)
    return r ? (r.value as T) : fallback
  }, [key])
}
