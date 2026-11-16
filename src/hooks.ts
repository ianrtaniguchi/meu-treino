import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db } from './data/db'
import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from './data/sync'

/** Lê uma configuração de forma reativa. `undefined` enquanto carrega. */
export function useSetting<T>(key: string, fallback: T): T | undefined {
  return useLiveQuery(async () => {
    const r = await db.settings.get(key)
    return r ? (r.value as T) : fallback
  }, [key])
}

/** Estado reativo de autenticação e sincronização com a nuvem. */
export function useSyncStatus(): SyncStatus {
  const [st, setSt] = useState<SyncStatus>(() => getSyncStatus())
  useEffect(() => subscribeSyncStatus(setSt), [])
  return st
}
