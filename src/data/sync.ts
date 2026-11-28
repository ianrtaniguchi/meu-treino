import { getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'
import { firebaseConfig } from '../firebaseConfig'
import { createSnapshot } from './backup'
import { SYNCABLE_SETTINGS, db, getRawRecord, getRawTable, onLocalWrite, pkOf, recordDocId, runApplyingRemote, waitPendingOutbox } from './db'
import { TABLE_NAMES, type CloudRecord, type OutboxEntry, type TableName } from './types'

// ---------- Abstração de transporte (permite mock limpo nos testes sem rede) ----------

export interface CloudAdapter {
  fetchAll(uid: string): Promise<CloudRecord[]>
  pushBatch(uid: string, records: CloudRecord[]): Promise<void>
}

let appInstance: FirebaseApp | null = null
let authInstance: Auth | null = null
let firestoreInstance: Firestore | null = null

export function getFirebaseAuth(): Auth {
  if (!appInstance) {
    appInstance = getApps()[0] ?? initializeApp(firebaseConfig)
  }
  if (!authInstance) {
    try {
      authInstance = initializeAuth(appInstance, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      })
    } catch {
      authInstance = getAuth(appInstance)
    }
  }
  return authInstance
}

export function getFirebaseDb(): Firestore {
  if (!appInstance) {
    appInstance = getApps()[0] ?? initializeApp(firebaseConfig)
  }
  if (!firestoreInstance) {
    firestoreInstance = getFirestore(appInstance)
  }
  return firestoreInstance
}

const firestoreAdapter: CloudAdapter = {
  async fetchAll(uid: string): Promise<CloudRecord[]> {
    const fs = getFirebaseDb()
    const col = collection(fs, 'users', uid, 'records')
    const snap = await getDocs(col)
    const out: CloudRecord[] = []
    snap.forEach((d) => {
      const data = d.data() as CloudRecord
      if (data && typeof data.table === 'string' && typeof data.pk === 'string') {
        out.push({ ...data, id: d.id })
      }
    })
    return out
  },
  async pushBatch(uid: string, records: CloudRecord[]): Promise<void> {
    if (records.length === 0) return
    const fs = getFirebaseDb()
    const CHUNK = 400 // limite do Firestore é 500 operações por writeBatch
    for (let i = 0; i < records.length; i += CHUNK) {
      const slice = records.slice(i, i + CHUNK)
      const batch = writeBatch(fs)
      for (const r of slice) {
        const ref = doc(fs, 'users', uid, 'records', r.id)
        batch.set(ref, r)
      }
      await batch.commit()
    }
  },
}

let activeAdapter: CloudAdapter = firestoreAdapter

/** Permite substituir o adaptador em testes automatizados (sem rede). */
export function setCloudAdapter(adapter: CloudAdapter) {
  activeAdapter = adapter
}
export function resetCloudAdapter() {
  activeAdapter = firestoreAdapter
}

// ---------- Empacotamento de registros ----------

export function isSyncableRecord(table: TableName, row: any): boolean {
  if (!row || typeof row !== 'object') return false
  if (table === 'settings') return SYNCABLE_SETTINGS.has(String(row.key))
  // Exercícios/alimentos padrão intactos (updatedAt === 1 e não excluídos) não precisam poluir a nuvem
  if ((table === 'exercises' || table === 'foods') && row.builtin && row.updatedAt === 1 && !row.deleted) {
    return false
  }
  return true
}

export function toCloudRecord(table: TableName, row: any): CloudRecord {
  const pk = String(row[pkOf(table)])
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()
  const deleted = row.deleted === true
  const payload = { ...row, updatedAt, deleted }
  return {
    id: recordDocId(table, pk),
    table,
    pk,
    updatedAt,
    deleted,
    payload,
  }
}

// ---------- Resolução de conflitos (Last-Write-Wins por updatedAt) ----------

/**
 * Compara um registro local e um remoto.
 * Retorna `'remote'` se o remoto for mais novo, `'local'` se o local for mais novo,
 * ou `'equal'` se tiverem o mesmo timestamp e estado.
 */
export function resolveLWW(localRow: any | undefined, remote: CloudRecord): 'remote' | 'local' | 'equal' {
  if (!localRow) return 'remote'
  const localTs = typeof localRow.updatedAt === 'number' ? localRow.updatedAt : 0
  const remoteTs = typeof remote.updatedAt === 'number' ? remote.updatedAt : 0
  if (remoteTs > localTs) return 'remote'
  if (localTs > remoteTs) return 'local'
  return 'equal'
}

// ---------- Prévia e detecção de primeiro login com dados locais ----------

export interface SyncSideCounts {
  sessions: number
  meals: number
  body: number
  routines: number
  customExercises: number
  customFoods: number
  totalUserItems: number
}

export interface FirstLoginPreview {
  uid: string
  local: SyncSideCounts
  cloud: SyncSideCounts
  remoteRecords: CloudRecord[]
  needsProfileName?: boolean
  existingProfileName?: string
}

export async function getLocalCounts(): Promise<SyncSideCounts> {
  const [sessions, meals, body, routines, exercises, foods] = await Promise.all([
    db.sessions.count(),
    db.meals.count(),
    db.body.count(),
    db.routines.count(),
    db.exercises.toArray(),
    db.foods.toArray(),
  ])
  const customExercises = exercises.filter((e) => !e.builtin || (e.updatedAt && e.updatedAt > 1)).length
  const customFoods = foods.filter((f) => !f.builtin || (f.updatedAt && f.updatedAt > 1)).length
  return {
    sessions,
    meals,
    body,
    routines,
    customExercises,
    customFoods,
    totalUserItems: sessions + meals + body + routines + customExercises + customFoods,
  }
}

export function getCloudCounts(records: CloudRecord[]): SyncSideCounts {
  const active = records.filter((r) => !r.deleted)
  const sessions = active.filter((r) => r.table === 'sessions').length
  const meals = active.filter((r) => r.table === 'meals').length
  const body = active.filter((r) => r.table === 'body').length
  const routines = active.filter((r) => r.table === 'routines').length
  const customExercises = active.filter((r) => r.table === 'exercises').length
  const customFoods = active.filter((r) => r.table === 'foods').length
  return {
    sessions,
    meals,
    body,
    routines,
    customExercises,
    customFoods,
    totalUserItems: sessions + meals + body + routines + customExercises + customFoods,
  }
}

export async function hasSyncedUidBefore(uid: string): Promise<boolean> {
  const r = await getRawRecord('settings', `syncedUid:${uid}`)
  return r?.value === true
}

export async function markUidSynced(uid: string): Promise<void> {
  await runApplyingRemote(async () => {
    await db.settings.put({ key: `syncedUid:${uid}`, value: true, updatedAt: Date.now(), deleted: false })
  })
}

export async function resolveExistingProfileName(
  remoteRecords: CloudRecord[],
): Promise<string> {
  const remoteSetting = remoteRecords.find(
    (r) => !r.deleted && r.table === 'settings' && r.pk === 'profileName',
  )
  const remoteVal =
    typeof remoteSetting?.payload?.value === 'string'
      ? remoteSetting.payload.value.trim()
      : ''
  if (remoteVal) return remoteVal

  const localRow = await getRawRecord<{ key: string; value: unknown; deleted?: boolean }>(
    'settings',
    'profileName',
  )
  const localVal =
    localRow && !localRow.deleted && typeof localRow.value === 'string'
      ? localRow.value.trim()
      : ''
  return localVal
}

/**
 * Verifica se este login requer confirmação do usuário antes de mesclar ou se precisa pedir o `profileName`:
 * - Se o aparelho nunca sincronizou com este `uid` E já possui dados locais registrados, exibe a prévia (local vs. nuvem).
 * - Se `options.promptIfMissingProfileName` for true e a conta ainda não tiver `profileName` salvo (nem local nem na nuvem),
 *   também retorna o `FirstLoginPreview` para pedir o nome da saudação no primeiro login.
 */
export async function checkFirstLoginState(
  uid: string,
  options: { promptIfMissingProfileName?: boolean } = {},
): Promise<FirstLoginPreview | null> {
  const already = await hasSyncedUidBefore(uid)
  const remoteRecords = await activeAdapter.fetchAll(uid)
  const existingProfileName = await resolveExistingProfileName(remoteRecords)
  const needsProfileName = !existingProfileName

  if (already) {
    if (options.promptIfMissingProfileName && needsProfileName) {
      const local = await getLocalCounts()
      const cloud = getCloudCounts(remoteRecords)
      return {
        uid,
        local,
        cloud,
        remoteRecords,
        needsProfileName: true,
        existingProfileName: '',
      }
    }
    return null
  }

  const local = await getLocalCounts()
  const cloud = getCloudCounts(remoteRecords)
  if (local.totalUserItems === 0) {
    if (options.promptIfMissingProfileName && needsProfileName) {
      return {
        uid,
        local,
        cloud,
        remoteRecords,
        needsProfileName: true,
        existingProfileName: '',
      }
    }
    return null
  }
  return {
    uid,
    local,
    cloud,
    remoteRecords,
    needsProfileName,
    existingProfileName,
  }
}

/** Enfileira todos os registros locais sincronizáveis no outbox (para o primeiro envio à nuvem). */
export async function enqueueAllLocalRecords(): Promise<number> {
  const entries: OutboxEntry[] = []
  for (const t of TABLE_NAMES) {
    const rows = await getRawTable(t)
    const pkField = pkOf(t)
    for (const r of rows) {
      if (!isSyncableRecord(t, r)) continue
      const pk = String(r[pkField])
      entries.push({
        id: recordDocId(t, pk),
        table: t,
        pk,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
        attempts: 0,
      })
    }
  }
  if (entries.length > 0) {
    await db.outbox.bulkPut(entries)
  }
  return entries.length
}

// ---------- Operações de Pull, Push e Sync completo ----------

/**
 * Mescla registros remotos no banco local usando Last-Write-Wins (updatedAt).
 * Se um registro local for mais recente que o remoto (ou não existir na nuvem quando `enqueueLocalNewer` for true),
 * garante que ele esteja na outbox para ser enviado.
 */
export async function mergeRemoteRecords(remoteRecords: CloudRecord[], enqueueLocalNewer = true): Promise<void> {
  const remoteById = new Map<string, CloudRecord>()
  for (const r of remoteRecords) remoteById.set(r.id, r)

  const toOutbox: OutboxEntry[] = []

  await runApplyingRemote(async () => {
    await db.transaction('rw', [...TABLE_NAMES.map((t) => db.table(t)), db.outbox], async () => {
      for (const r of remoteRecords) {
        if (!TABLE_NAMES.includes(r.table)) continue
        const table = db.table(r.table)
        const local = await table.get(r.pk)
        const winner = resolveLWW(local, r)
        if (winner === 'remote') {
          const payload = {
            ...r.payload,
            [pkOf(r.table)]: r.pk,
            updatedAt: r.updatedAt,
            deleted: r.deleted === true,
          }
          await table.put(payload)
          // Se havia item no outbox mais antigo que o remoto, remove da fila
          const ob = await db.outbox.get(r.id)
          if (ob && ob.updatedAt <= r.updatedAt) {
            await db.outbox.delete(r.id)
          }
        } else if (winner === 'local' && enqueueLocalNewer && local && isSyncableRecord(r.table, local)) {
          toOutbox.push({
            id: r.id,
            table: r.table,
            pk: r.pk,
            updatedAt: local.updatedAt,
            attempts: 0,
          })
        }
      }

      if (enqueueLocalNewer) {
        for (const t of TABLE_NAMES) {
          const rows = await db.table(t).toArray()
          const pkField = pkOf(t)
          for (const local of rows) {
            if (!isSyncableRecord(t, local)) continue
            const pk = String(local[pkField])
            const docId = recordDocId(t, pk)
            if (!remoteById.has(docId)) {
              toOutbox.push({
                id: docId,
                table: t,
                pk,
                updatedAt: typeof local.updatedAt === 'number' ? local.updatedAt : Date.now(),
                attempts: 0,
              })
            }
          }
        }
      }

      if (toOutbox.length > 0) {
        await db.outbox.bulkPut(toOutbox)
      }
    })
  })
}

/** Envia todos os itens pendentes na fila (outbox) para o Firestore. */
export async function flushOutbox(uid: string): Promise<number> {
  await waitPendingOutbox()
  const items = await db.outbox.toArray()
  if (items.length === 0) return 0

  const records: CloudRecord[] = []
  const sentEntries: OutboxEntry[] = []

  for (const item of items) {
    const row = await getRawRecord(item.table, item.pk)
    if (!row || !isSyncableRecord(item.table, row)) {
      await db.outbox.delete(item.id)
      continue
    }
    records.push(toCloudRecord(item.table, row))
    sentEntries.push(item)
  }

  if (records.length === 0) return 0

  try {
    await activeAdapter.pushBatch(uid, records)
    // Remove da outbox apenas se o registro não sofreu nova escrita enquanto enviava
    await db.transaction('rw', db.outbox, async () => {
      for (const sent of sentEntries) {
        const cur = await db.outbox.get(sent.id)
        if (cur && cur.updatedAt <= sent.updatedAt) {
          await db.outbox.delete(sent.id)
        }
      }
    })
    return records.length
  } catch (err) {
    await db.transaction('rw', db.outbox, async () => {
      for (const sent of sentEntries) {
        const cur = await db.outbox.get(sent.id)
        if (cur) await db.outbox.put({ ...cur, attempts: (cur.attempts ?? 0) + 1 })
      }
    })
    throw err
  }
}

/**
 * Conclui o primeiro login após escolha do usuário:
 *  - `sendLocal = true`: cria snapshot de segurança, mescla nuvem + local (LWW) e envia os dados locais para a nuvem.
 *  - `sendLocal = false`: cria snapshot de segurança dos dados locais, limpa dados locais e baixa apenas o que está na nuvem.
 */
export async function completeFirstLoginMerge(
  uid: string,
  sendLocal: boolean,
  prefetchedRemote?: CloudRecord[],
): Promise<void> {
  await createSnapshot('seguranca', 'Antes do primeiro merge com a nuvem')
  const remote = prefetchedRemote ?? (await activeAdapter.fetchAll(uid))

  if (!sendLocal) {
    // Usuário escolheu NÃO enviar os dados locais e usar apenas a nuvem
    await runApplyingRemote(async () => {
      await db.transaction('rw', [...TABLE_NAMES.map((t) => db.table(t)), db.outbox], async () => {
        await db.outbox.clear()
        for (const t of ['sessions', 'routines', 'meals', 'body'] as TableName[]) {
          await db.table(t).clear()
        }
        // Remove exercícios/alimentos criados pelo usuário
        const exs = await db.exercises.toArray()
        await db.exercises.bulkDelete(exs.filter((e) => !e.builtin).map((e) => e.id))
        const fds = await db.foods.toArray()
        await db.foods.bulkDelete(fds.filter((f) => !f.builtin).map((f) => f.id))
      })
    })
    await mergeRemoteRecords(remote, false)
  } else {
    await mergeRemoteRecords(remote, true)
    await flushOutbox(uid)
  }

  await markUidSynced(uid)
  await saveLastSyncAt(Date.now())
}

async function saveLastSyncAt(ts: number) {
  await runApplyingRemote(async () => {
    await db.settings.put({ key: 'lastSyncAt', value: ts, updatedAt: ts, deleted: false })
  })
}

/**
 * Executa um ciclo completo de sincronização para um usuário já vinculado:
 * 1) Baixa registros da nuvem e aplica LWW;
 * 2) Envia a fila (outbox) pendente;
 * 3) Atualiza `lastSyncAt`.
 */
export async function syncNow(uid: string): Promise<{ pushed: number; pulled: number }> {
  const already = await hasSyncedUidBefore(uid)
  if (!already) {
    const preview = await checkFirstLoginState(uid)
    if (preview) {
      throw new Error('Confirmação de primeiro login pendente.')
    }
    // Aparelho sem dados locais no primeiro login: cria snapshot se houver algo e mescla direto
    const remote = await activeAdapter.fetchAll(uid)
    await mergeRemoteRecords(remote, true)
    const pushed = await flushOutbox(uid)
    await markUidSynced(uid)
    await saveLastSyncAt(Date.now())
    return { pushed, pulled: remote.length }
  }

  const remote = await activeAdapter.fetchAll(uid)
  await mergeRemoteRecords(remote, true)
  const pushed = await flushOutbox(uid)
  await saveLastSyncAt(Date.now())
  return { pushed, pulled: remote.length }
}

// ---------- Gerenciador de estado de Auth + Sync em background (para a UI) ----------

export interface SyncUser {
  uid: string
  email: string | null
  displayName?: string | null
  photoURL?: string | null
}

export interface SyncStatus {
  user: SyncUser | null
  syncing: boolean
  error: string | null
  firstLoginPreview: FirstLoginPreview | null
}

type Listener = (s: SyncStatus) => void
const listeners = new Set<Listener>()
let currentStatus: SyncStatus = {
  user: null,
  syncing: false,
  error: null,
  firstLoginPreview: null,
}

function setStatus(patch: Partial<SyncStatus>) {
  currentStatus = { ...currentStatus, ...patch }
  for (const l of listeners) l(currentStatus)
}

export function getSyncStatus(): SyncStatus {
  return currentStatus
}

export function subscribeSyncStatus(fn: Listener): () => void {
  listeners.add(fn)
  fn(currentStatus)
  return () => listeners.delete(fn)
}

let retryTimer: number | undefined
let debounceTimer: number | undefined
let initialized = false

function schedulePush(delayMs = 800) {
  if (typeof window === 'undefined') return
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void triggerBackgroundSync(true)
  }, delayMs)
}

export async function triggerBackgroundSync(pushOnly = false): Promise<void> {
  const u = currentStatus.user
  if (!u || currentStatus.syncing || currentStatus.firstLoginPreview) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return

  setStatus({ syncing: true, error: null })
  try {
    if (pushOnly && (await hasSyncedUidBefore(u.uid))) {
      await flushOutbox(u.uid)
      await saveLastSyncAt(Date.now())
    } else {
      const preview = await checkFirstLoginState(u.uid, { promptIfMissingProfileName: true })
      if (preview) {
        setStatus({ syncing: false, firstLoginPreview: preview })
        return
      }
      await syncNow(u.uid)
    }
    setStatus({ syncing: false, error: null })
  } catch {
    setStatus({ syncing: false, error: 'Falha ao sincronizar (tentando novamente quando houver conexão).' })
    if (typeof window !== 'undefined') {
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(() => void triggerBackgroundSync(pushOnly), 15_000)
    }
  }
}

const ACTIVE_UID_STORAGE_KEY = 'meu_treino_active_uid'

function persistActiveUidToLocalStorage(uid: string | null): void {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
      const st = (globalThis as any).localStorage as Storage
      if (uid) st.setItem(ACTIVE_UID_STORAGE_KEY, uid)
      else st.removeItem(ACTIVE_UID_STORAGE_KEY)
    }
  } catch {
    // ignore
  }
}

/**
 * Garante isolamento completo entre contas diferentes no mesmo aparelho:
 * se o aparelho estava vinculado ao usuário A e agora entrou o usuário B (`prevUid !== nextUid`),
 * salva um snapshot local de segurança, limpa as tabelas locais de trabalho e marca `activeAccountUid = nextUid`
 * para que os dados da conta anterior nunca sejam misturados nem enviados para a conta secundária.
 */
export async function isolateAccountOnSwitch(nextUid: string): Promise<boolean> {
  const prevRow = await getRawRecord<{ key: string; value: unknown }>('settings', 'activeAccountUid')
  const prevUid = typeof prevRow?.value === 'string' ? prevRow.value.trim() : ''

  if (prevUid && prevUid !== nextUid) {
    await createSnapshot(
      'seguranca',
      `Troca de conta (${prevUid.slice(0, 6)} → ${nextUid.slice(0, 6)})`,
    )
    await runApplyingRemote(async () => {
      await db.transaction(
        'rw',
        [...TABLE_NAMES.map((t) => db.table(t)), db.outbox],
        async () => {
          await db.outbox.clear()
          for (const t of ['sessions', 'routines', 'meals', 'body'] as TableName[]) {
            await db.table(t).clear()
          }
          const exs = await db.exercises.toArray()
          await db.exercises.bulkDelete(exs.filter((e) => !e.builtin).map((e) => e.id))
          const fds = await db.foods.toArray()
          await db.foods.bulkDelete(fds.filter((f) => !f.builtin).map((f) => f.id))
          for (const k of SYNCABLE_SETTINGS) {
            await db.settings.delete(k)
          }
          await db.settings.delete('lastSyncAt')
          await db.settings.put({
            key: 'activeAccountUid',
            value: nextUid,
            updatedAt: Date.now(),
            deleted: false,
          })
        },
      )
    })
    persistActiveUidToLocalStorage(nextUid)
    return true
  }

  if (prevUid !== nextUid) {
    await runApplyingRemote(async () => {
      await db.settings.put({
        key: 'activeAccountUid',
        value: nextUid,
        updatedAt: Date.now(),
        deleted: false,
      })
    })
  }
  persistActiveUidToLocalStorage(nextUid)
  return false
}

export function initSyncManager(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  onLocalWrite(() => {
    if (currentStatus.user && !currentStatus.firstLoginPreview) {
      schedulePush(600)
    }
  })

  window.addEventListener('online', () => {
    void triggerBackgroundSync(false)
  })

  try {
    const auth = getFirebaseAuth()
    void getRedirectResult(auth).catch(() => null)
    onAuthStateChanged(auth, async (fbUser: User | null) => {
      if (!fbUser) {
        persistActiveUidToLocalStorage(null)
        setStatus({ user: null, syncing: false, error: null, firstLoginPreview: null })
        return
      }
      await isolateAccountOnSwitch(fbUser.uid)
      setStatus({
        user: {
          uid: fbUser.uid,
          email: fbUser.email,
          displayName: fbUser.displayName,
          photoURL: fbUser.photoURL,
        },
        error: null,
      })
      await triggerBackgroundSync(false)
    })
  } catch {
    // Modo local caso Firebase falhe ao inicializar offline
  }
}

// ---------- Ações de autenticação (E-mail/Senha + Google OAuth multi-conta) ----------

export async function authSignIn(email: string, pass: string): Promise<void> {
  const auth = getFirebaseAuth()
  await signInWithEmailAndPassword(auth, email.trim(), pass)
}

export async function authSignInWithGoogle(): Promise<void> {
  const auth = getFirebaseAuth()
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  try {
    await signInWithPopup(auth, provider)
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    if (
      code.includes('popup-blocked') ||
      code.includes('operation-not-supported-in-this-environment')
    ) {
      await signInWithRedirect(auth, provider)
      return
    }
    throw err
  }
}

export async function authSignOut(): Promise<void> {
  const auth = getFirebaseAuth()
  await signOut(auth)
  persistActiveUidToLocalStorage(null)
  setStatus({ user: null, syncing: false, error: null, firstLoginPreview: null })
}

export async function authResetPassword(email: string): Promise<void> {
  const auth = getFirebaseAuth()
  await sendPasswordResetEmail(auth, email.trim())
}

export async function resolveFirstLoginChoice(
  sendLocal: boolean,
  profileNameInput?: string,
): Promise<void> {
  const preview = currentStatus.firstLoginPreview
  if (!preview) return
  setStatus({ syncing: true, error: null })
  try {
    const cleanName = (profileNameInput ?? '').trim()
    if (cleanName) {
      await db.settings.put({ key: 'profileName', value: cleanName })
      await waitPendingOutbox()
    }
    await completeFirstLoginMerge(preview.uid, sendLocal, preview.remoteRecords)
    if (cleanName) {
      await flushOutbox(preview.uid)
    }
    setStatus({ syncing: false, firstLoginPreview: null, error: null })
  } catch {
    setStatus({ syncing: false, error: 'Não foi possível concluir a sincronização inicial.' })
  }
}
