import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { listSnapshots } from '../src/data/backup'
import { DB_NAME, DB_VERSION, db, getRawRecord, setSetting, waitPendingOutbox } from '../src/data/db'
import { ensureSeed } from '../src/data/seed'
import {
  checkFirstLoginState,
  completeFirstLoginMerge,
  flushOutbox,
  isolateAccountOnSwitch,
  mergeRemoteRecords,
  setCloudAdapter,
  syncNow,
  toCloudRecord,
  type CloudAdapter,
} from '../src/data/sync'
import type { BodyEntry, CloudRecord, Meal, Session } from '../src/data/types'

/** Mock em memória do Firestore (users/{uid}/records/{id}), sem nenhuma chamada de rede. */
function createMockCloud() {
  const store = new Map<string, Map<string, CloudRecord>>()
  let shouldFailPush = false

  const userStore = (uid: string) => {
    let m = store.get(uid)
    if (!m) store.set(uid, (m = new Map()))
    return m
  }

  const adapter: CloudAdapter = {
    async fetchAll(uid: string): Promise<CloudRecord[]> {
      return [...userStore(uid).values()].map((r) => JSON.parse(JSON.stringify(r)))
    },
    async pushBatch(uid: string, records: CloudRecord[]): Promise<void> {
      if (shouldFailPush) throw new Error('Simulated offline / network error')
      const m = userStore(uid)
      for (const r of records) {
        m.set(r.id, JSON.parse(JSON.stringify(r)))
      }
    },
  }

  return {
    adapter,
    userStore,
    setFailPush(fail: boolean) {
      shouldFailPush = fail
    },
  }
}

const makeSession = (id: string, date = '2026-11-10', notes = 'ok'): Session => ({
  id,
  date,
  name: 'Treino A',
  notes,
  createdAt: 1000,
  entries: [{ exerciseId: 'ex-1', sets: [{ id: 's1', value: 12, load: 10 }] }],
})

const makeMeal = (id: string, date = '2026-11-10'): Meal => ({
  id,
  date,
  type: 'almoco',
  createdAt: 1000,
  items: [{ name: 'Arroz', qty: '100 g', kcal: 128, p: 2.5, c: 28, g: 0.2 }],
})

const makeBody = (date = '2026-11-10', weight = 78.5): BodyEntry => ({
  id: `body-${date}`,
  date,
  weight,
  measures: { cintura: 79 },
})

let cloud: ReturnType<typeof createMockCloud>

beforeEach(async () => {
  cloud = createMockCloud()
  setCloudAdapter(cloud.adapter)
  await db.delete()
  await db.open()
})

describe('migração v2 → v3 (sincronização)', () => {
  it('preserva todos os dados v2, preenche updatedAt e deleted=false e cria snapshot automático antes da migração', async () => {
    await db.delete()
    // Simula banco existente na versão 2
    const v2 = new Dexie(DB_NAME)
    v2.version(1).stores({
      exercises: 'id, category, name',
      routines: 'id',
      sessions: 'id, date',
      foods: 'id, name',
      meals: 'id, date',
      body: 'id, date',
      settings: 'key',
      snapshots: 'id, kind, createdAt',
    })
    v2.version(2).stores({
      sessions: 'id, date, routineId',
    })
    await v2.open()
    await v2.table('sessions').add({
      id: 'sess-v2',
      date: '2026-10-15',
      name: 'Treino Antigo V2',
      notes: 'nota v2',
      entries: [{ exerciseId: 'ex-1', sets: [{ id: 's1', value: 15, load: 0 }] }],
      createdAt: 500,
    })
    await v2.table('meals').add({
      id: 'meal-v2',
      date: '2026-10-15',
      type: 'jantar',
      items: [{ name: 'Frango', qty: '150 g', kcal: 240, p: 48, c: 0, g: 4 }],
      createdAt: 500,
    })
    await v2.table('body').add({
      id: 'body-2026-10-15',
      date: '2026-10-15',
      weight: 81.2,
      measures: { peito: 102 },
    })
    v2.close()

    // Abre o AppDB na versão 3
    await db.open()
    expect(db.verno).toBe(DB_VERSION)

    const s = await db.sessions.get('sess-v2')
    expect(s?.name).toBe('Treino Antigo V2')
    expect(s?.notes).toBe('nota v2')
    expect(typeof s?.updatedAt).toBe('number')
    expect(s?.updatedAt).toBeGreaterThan(0)
    expect(s?.deleted).toBe(false)

    const m = await db.meals.get('meal-v2')
    expect(m?.items[0].name).toBe('Frango')
    expect(m?.deleted).toBe(false)
    expect(typeof m?.updatedAt).toBe('number')

    const b = await db.body.get('body-2026-10-15')
    expect(b?.weight).toBe(81.2)
    expect(b?.deleted).toBe(false)

    // Snapshot automático criado antes da migração v2 -> v3
    const snaps = await listSnapshots()
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    expect(snaps[0].reason).toMatch(/migração/i)
    expect(snaps[0].data.tables.sessions).toHaveLength(1)
  })
})

describe('outbox (fila de envio)', () => {
  it('enfileira gravações locais, envia em lote para a nuvem e faz retry em caso de falha', async () => {
    await ensureSeed()
    expect(await db.outbox.count()).toBe(0) // seed inicial não polui a fila

    await db.sessions.put(makeSession('s1'))
    await db.meals.put(makeMeal('m1'))
    await db.body.put(makeBody('2026-11-10', 78.5))
    await setSetting('goals', { kcal: 2500, p: 160, c: 280, g: 70 })
    // setting efêmero não deve ir para a nuvem
    await setSetting('activeSessionId', 's1')
    await waitPendingOutbox()

    const queued = await db.outbox.toArray()
    expect(queued.map((q) => q.id).sort()).toEqual([
      'body:body-2026-11-10',
      'meals:m1',
      'sessions:s1',
      'settings:goals',
    ])

    // Simula falha de rede: itens permanecem na fila e incrementam attempts
    cloud.setFailPush(true)
    await expect(flushOutbox('user-1')).rejects.toThrow()
    expect(await db.outbox.count()).toBe(4)
    expect((await db.outbox.get('sessions:s1'))?.attempts).toBe(1)

    // Rede volta: envia tudo e limpa a outbox
    cloud.setFailPush(false)
    const sent = await flushOutbox('user-1')
    expect(sent).toBe(4)
    expect(await db.outbox.count()).toBe(0)

    const remoteDocs = await cloud.adapter.fetchAll('user-1')
    expect(remoteDocs).toHaveLength(4)
  })
})

describe('merge last-write-wins (LWW)', () => {
  it('mantém o registro com maior updatedAt por registro (local vs. nuvem)', async () => {
    // Registro A: local é mais recente (ts 2000 vs remoto 1000) -> local vence
    await db.sessions.put({ ...makeSession('s-local-newer', '2026-11-01', 'versao local nova'), updatedAt: 2000, _preserveUpdatedAt: true } as any)

    // Registro B: remoto é mais recente (ts 3000 vs local 1000) -> remoto vence
    await db.sessions.put({ ...makeSession('s-remote-newer', '2026-11-02', 'versao local antiga'), updatedAt: 1000, _preserveUpdatedAt: true } as any)

    await waitPendingOutbox()
    await db.outbox.clear()

    const remoteRecords: CloudRecord[] = [
      toCloudRecord('sessions', { ...makeSession('s-local-newer', '2026-11-01', 'versao remota antiga'), updatedAt: 1000, deleted: false }),
      toCloudRecord('sessions', { ...makeSession('s-remote-newer', '2026-11-02', 'versao remota nova'), updatedAt: 3000, deleted: false }),
      toCloudRecord('sessions', { ...makeSession('s-only-remote', '2026-11-03', 'veio da nuvem'), updatedAt: 1500, deleted: false }),
    ]

    await mergeRemoteRecords(remoteRecords, true)

    expect((await db.sessions.get('s-local-newer'))?.notes).toBe('versao local nova')
    expect((await db.sessions.get('s-remote-newer'))?.notes).toBe('versao remota nova')
    expect((await db.sessions.get('s-only-remote'))?.notes).toBe('veio da nuvem')

    // O registro em que o local venceu precisa estar na outbox para atualizar a nuvem
    const outboxIds = (await db.outbox.toArray()).map((o) => o.id)
    expect(outboxIds).toContain('sessions:s-local-newer')
    expect(outboxIds).not.toContain('sessions:s-remote-newer')
  })
})

describe('soft delete', () => {
  it('marca deleted=true ao excluir localmente, oculta das consultas e propaga a exclusão entre aparelhos', async () => {
    await db.sessions.put(makeSession('s-del', '2026-11-05'))
    expect(await db.sessions.count()).toBe(1)

    // Exclui localmente
    await db.sessions.delete('s-del')

    // Consultas normais da UI não veem mais o registro
    expect(await db.sessions.get('s-del')).toBeUndefined()
    expect(await db.sessions.toArray()).toHaveLength(0)
    expect(await db.sessions.count()).toBe(0)

    // Porém o tombstone existe no banco com deleted=true e foi para a outbox
    const raw = await getRawRecord('sessions', 's-del')
    expect(raw?.deleted).toBe(true)
    expect(typeof raw?.updatedAt).toBe('number')

    // Envia para a nuvem
    await flushOutbox('user-1')
    const remote = await cloud.adapter.fetchAll('user-1')
    const remoteTomb = remote.find((r) => r.id === 'sessions:s-del')
    expect(remoteTomb?.deleted).toBe(true)

    // Simula segundo aparelho que tinha a sessão antiga e recebe o sync
    await db.delete()
    await db.open()
    await db.sessions.put({ ...makeSession('s-del', '2026-11-05'), updatedAt: 500, _preserveUpdatedAt: true } as any)
    expect(await db.sessions.count()).toBe(1)

    await mergeRemoteRecords(remote, true)
    expect(await db.sessions.count()).toBe(0)
    expect(await db.sessions.get('s-del')).toBeUndefined()
  })
})

describe('primeiro login com dados locais', () => {
  it('detecta dados locais + dados na nuvem, gera prévia sem sobrescrever nada e cria snapshot antes do merge', async () => {
    // Dados já existentes na nuvem
    await cloud.adapter.pushBatch('user-1', [
      toCloudRecord('sessions', { ...makeSession('cloud-1', '2026-11-01', 'treino nuvem'), updatedAt: 1000, deleted: false }),
      toCloudRecord('meals', { ...makeMeal('cloud-m1', '2026-11-01'), updatedAt: 1000, deleted: false }),
    ])

    // Dados criados offline no aparelho antes de logar
    await db.sessions.put(makeSession('local-1', '2026-11-08', 'treino local'))
    await db.body.put(makeBody('2026-11-08', 77.8))

    const preview = await checkFirstLoginState('user-1')
    expect(preview).not.toBeNull()
    expect(preview?.local).toMatchObject({ sessions: 1, meals: 0, body: 1 })
    expect(preview?.cloud).toMatchObject({ sessions: 1, meals: 1, body: 0 })

    // Antes da confirmação do usuário, nada da nuvem foi gravado localmente e nada local foi para a nuvem
    expect(await db.sessions.count()).toBe(1)
    expect(await cloud.adapter.fetchAll('user-1')).toHaveLength(2)

    // Usuário confirma enviar dados locais e mesclar com a nuvem
    await completeFirstLoginMerge('user-1', true, preview!.remoteRecords)

    // Snapshot de segurança criado antes do merge
    const snaps = await listSnapshots()
    expect(snaps.some((s) => s.reason.includes('primeiro merge'))).toBe(true)

    // Agora ambos os lados têm todos os registros (2 sessões, 1 refeição, 1 peso)
    expect(await db.sessions.count()).toBe(2)
    expect(await db.meals.count()).toBe(1)
    expect(await db.body.count()).toBe(1)

    const afterCloud = await cloud.adapter.fetchAll('user-1')
    expect(afterCloud.map((r) => r.id).sort()).toEqual([
      'body:body-2026-11-08',
      'meals:cloud-m1',
      'sessions:cloud-1',
      'sessions:local-1',
    ])

    // Próximos syncs não pedem confirmação novamente
    expect(await checkFirstLoginState('user-1')).toBeNull()
    const res = await syncNow('user-1')
    expect(res.pushed).toBe(0)
  })

  it('isola os dados locais ao trocar de uma conta para outra (isolateAccountOnSwitch), criando snapshot de segurança', async () => {
    await isolateAccountOnSwitch('user-conta-principal')
    await db.sessions.put(makeSession('sess-principal', '2026-11-10', 'treino da conta principal'))
    await db.meals.put(makeMeal('meal-principal', '2026-11-10'))
    expect(await db.sessions.count()).toBe(1)

    // Mesmo usuário reabrindo o app não limpa nada
    const switchedSame = await isolateAccountOnSwitch('user-conta-principal')
    expect(switchedSame).toBe(false)
    expect(await db.sessions.count()).toBe(1)

    // Troca para conta secundária limpa as tabelas de trabalho e salva snapshot de segurança
    const switchedDifferent = await isolateAccountOnSwitch('user-conta-secundaria')
    expect(switchedDifferent).toBe(true)
    expect(await db.sessions.count()).toBe(0)
    expect(await db.meals.count()).toBe(0)

    const snaps = await listSnapshots()
    expect(snaps.some((s) => s.reason.includes('Troca de conta'))).toBe(true)
  })
})
