import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, importBackup } from '../src/data/backup'
import { db, runApplyingRemote, SYNCABLE_SETTINGS } from '../src/data/db'
import { ensureSeed } from '../src/data/seed'
import { OWNER_UID } from '../src/assistantConfig'
import {
  applyConfirmedDraft,
  ASSISTANT_HISTORY_KEY,
  ASSISTANT_TOOLS,
  buildSystemPrompt,
  cancelPushReminderCard,
  clearAssistantHistory,
  confirmCalendarCard,
  executeAssistantTool,
  extractFinalAssistantContent,
  getAssistantToolsForUser,
  isCurrentUserOwner,
  loadAssistantHistory,
  saveAssistantHistory,
  sendAssistantTurn,
  SYSTEM_PROMPT,
  validateDraft,
  type AssistantDraft,
  type ChatTurnMessage,
} from '../src/lib/assistant'
import {
  describeMediaError,
  detectSupportedAudioMime,
  extensionForAudioMime,
  filenameForAudioMime,
  transcribeAudioClip,
} from '../src/lib/audioRecorder'
import { CALENDAR_SCOPE } from '../scripts/google-oauth.mjs'

async function resetDb() {
  await db.delete()
  await db.open()
  await ensureSeed()
  await db.outbox.clear()
}

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFilesRecursive(full))
    else out.push(full)
  }
  return out
}

describe('Assistente de IA no App (ferramentas, rascunhos, privacidade e isolamento)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('monta e executa as ferramentas somente de leitura retornando apenas o resumo necessário', async () => {
    const toolNames = ASSISTANT_TOOLS.map((t) => t.function.name)
    expect(toolNames).toEqual([
      'get_weekly_summary',
      'get_exercise_history',
      'get_diet_summary',
      'get_body_evolution',
      'list_exercises_and_routines',
      'propose_meal',
      'propose_routine',
      'propose_body_weight',
      'criar_evento',
      'editar_evento',
      'listar_eventos',
      'apagar_evento',
      'create_push_reminder',
      'list_push_reminders',
      'cancel_push_reminder',
    ])

    const ex = (await db.exercises.toArray())[0]
    await db.sessions.put({
      id: 'sess-1',
      date: '2026-11-14',
      name: 'Treino Empurrar',
      notes: '',
      entries: [
        {
          exerciseId: ex.id,
          sets: [
            { id: 's1', value: 12, load: 0 },
            { id: 's2', value: 10, load: 5 },
          ],
        },
      ],
      createdAt: 1000,
    })
    await db.meals.put({
      id: 'meal-1',
      date: '2026-11-14',
      type: 'almoco',
      items: [{ name: 'Frango grelhado', qty: '200 g', kcal: 330, p: 62, c: 0, g: 7 }],
      createdAt: 1000,
    })
    await db.body.put({
      id: 'body-2026-11-14',
      date: '2026-11-14',
      weight: 74.2,
      measures: { cintura: 78 },
    })

    const refNow = new Date(2026, 10, 15, 12, 0)
    const weekly = await executeAssistantTool('get_weekly_summary', { referenceDate: '2026-11-15' }, refNow)
    expect(weekly.dataLabel).toContain('resumo da semana')
    expect(weekly.result.workoutsCount).toBe(1)
    expect(weekly.result.totalSets).toBe(2)

    const exHist = await executeAssistantTool('get_exercise_history', { query: ex.name, limit: 5 }, refNow)
    expect(exHist.result.found).toBe(true)
    expect(exHist.result.totalSessions).toBe(1)

    const diet = await executeAssistantTool('get_diet_summary', { date: '2026-11-14' }, refNow)
    expect(diet.result.daysLogged).toBe(1)

    const body = await executeAssistantTool('get_body_evolution', { days: 30 }, refNow)
    expect((body.result.entries as any[]).length).toBeGreaterThanOrEqual(1)

    const list = await executeAssistantTool('list_exercises_and_routines', {})
    expect((list.result.exercises as any[]).length).toBeGreaterThan(0)
  })

  it('valida rascunhos antes de gravar e NUNCA grava automaticamente quando o modelo propõe escrita', async () => {
    const mealsBefore = await db.meals.count()
    const routinesBefore = await db.routines.count()
    const bodyBefore = await db.body.count()

    // 1. Modelo propõe refeição, rotina e peso: banco continua intacto
    const mealProposal = await executeAssistantTool('propose_meal', {
      date: '2026-11-15',
      type: 'jantar',
      items: [{ name: 'Ovos mexidos', qty: '3 unid', kcal: 240, p: 18, c: 2, g: 16 }],
    })
    const ex = (await db.exercises.toArray())[0]
    const routineProposal = await executeAssistantTool('propose_routine', {
      name: 'Fullbody Calistenia',
      exercises: [ex.name],
    })
    const bodyProposal = await executeAssistantTool('propose_body_weight', {
      date: '2026-11-15',
      weight: 73.8,
      measures: { cintura: 77.5 },
    })

    expect(await db.meals.count()).toBe(mealsBefore)
    expect(await db.routines.count()).toBe(routinesBefore)
    expect(await db.body.count()).toBe(bodyBefore)

    // 2. Validação rejeita rascunhos inválidos antes de gravar
    expect(() =>
      validateDraft({
        id: 'bad-1',
        kind: 'meal',
        status: 'pending',
        date: 'data-invalida',
        mealType: 'jantar',
        items: [],
      }),
    ).toThrow()

    expect(() =>
      validateDraft({
        id: 'bad-2',
        kind: 'body',
        status: 'pending',
        date: '2026-11-15',
        weight: 999, // fora da faixa
        measures: {},
      }),
    ).toThrow()

    // 3. Somente após confirmação explícita (applyConfirmedDraft) os dados são gravados no Dexie
    await applyConfirmedDraft(mealProposal.draft as AssistantDraft)
    await applyConfirmedDraft(routineProposal.draft as AssistantDraft)
    await applyConfirmedDraft(bodyProposal.draft as AssistantDraft)

    expect(await db.meals.count()).toBe(mealsBefore + 1)
    expect(await db.routines.count()).toBe(routinesBefore + 1)
    expect(await db.body.count()).toBe(bodyBefore + 1)
  })

  it('executa ciclo de tool calling com mock (sem rede) e lista quais dados foram enviados na resposta', async () => {
    let callCount = 0
    const mockFetcher: typeof fetch = async () => {
      callCount++
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tc_1',
                      type: 'function',
                      function: {
                        name: 'get_weekly_summary',
                        arguments: JSON.stringify({ referenceDate: '2026-11-15' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Você ainda não registrou treinos nesta semana. Bora começar hoje!',
                reasoning: 'Pensamento interno do gpt-oss que nunca deve aparecer na UI',
                reasoning_content: 'Outro campo de raciocinio',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const reply = await sendAssistantTurn('Como foi minha semana?', [], {
      fetcher: mockFetcher,
      getToken: async () => 'fake-firebase-id-token',
      workerUrl: 'https://meu-worker.workers.dev',
    })

    expect(callCount).toBe(2)
    expect(reply.role).toBe('assistant')
    expect(reply.content).toContain('não registrou treinos')
    expect(reply.content).not.toContain('Pensamento interno')
    expect((reply as any).reasoning).toBeUndefined()
    expect(extractFinalAssistantContent({ content: 'Final ok', reasoning: 'Ignorado' })).toBe('Final ok')
    expect(reply.dataSent).toContain('mensagem da conversa')
    expect(reply.dataSent?.some((d) => d.includes('resumo da semana'))).toBe(true)
  })

  it('garante que nenhum código do app lê groqApiKey nem o documento raiz users/{uid} e que não há chave em src/ ou wrangler.toml', () => {
    const srcDir = path.resolve(process.cwd(), 'src')
    const files = listFilesRecursive(srcDir)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toMatch(/gsk_[A-Za-z0-9]{20,}/)
      expect(content).not.toContain('GROQ_API_KEY')
      expect(content).not.toContain('groqApiKey')
    }

    // Verifica que o motor de sync acessa apenas a subcoleção users/{uid}/records e nunca o documento raiz users/{uid}
    const syncContent = fs.readFileSync(path.resolve(process.cwd(), 'src', 'data', 'sync.ts'), 'utf-8')
    expect(syncContent).toContain("collection(fs, 'users', uid, 'records')")
    expect(syncContent).toContain("doc(fs, 'users', uid, 'records', r.id)")
    expect(syncContent).not.toMatch(/doc\(\s*fs\s*,\s*['"]users['"]\s*,\s*uid\s*\)/)

    const wranglerPath = path.resolve(process.cwd(), 'worker', 'wrangler.toml')
    const wranglerContent = fs.readFileSync(wranglerPath, 'utf-8')
    expect(wranglerContent).not.toMatch(/gsk_[A-Za-z0-9]{20,}/)
  })

  it('garante que o histórico do chat não entra no backup, não é apagado no import e não entra na fila de sync (outbox)', async () => {
    expect(SYNCABLE_SETTINGS.has(ASSISTANT_HISTORY_KEY)).toBe(false)
    await db.outbox.clear()

    const sampleHistory: ChatTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'Meu histórico privado', createdAt: 1000 },
      { id: 'm2', role: 'assistant', content: 'Resposta local', createdAt: 2000, dataSent: ['mensagem da conversa'] },
    ]
    await saveAssistantHistory(sampleHistory)

    // 1. Não deve entrar na outbox do Firestore
    expect(await db.outbox.count()).toBe(0)

    // 2. Não deve entrar no backup exportado
    const exported = await buildBackup()
    const exportedKeys = exported.tables.settings.map((s) => s.key)
    expect(exportedKeys).not.toContain(ASSISTANT_HISTORY_KEY)

    // 3. Mesmo ao importar backup em modo replace (ou se um arquivo externo trouxer assistantHistory), o histórico local é preservado
    const externalBackup = structuredClone(exported)
    externalBackup.tables.settings.push({
      key: ASSISTANT_HISTORY_KEY,
      value: [{ id: 'hack', role: 'user', content: 'Injetado', createdAt: 1 }],
    })
    await importBackup(externalBackup, 'replace')

    const loaded = await loadAssistantHistory()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].content).toBe('Meu histórico privado')

    // 4. Limpar histórico funciona sem adicionar nada à outbox
    await db.outbox.clear()
    await clearAssistantHistory()
    expect(await loadAssistantHistory()).toEqual([])
    expect(await db.outbox.count()).toBe(0)
  })

  it('simula 22:49 em UTC-3 (quando em UTC já é o dia seguinte 01:49Z) e garante datas locais, peso de hoje e filtro de deleted = true', async () => {
    // 2026-11-15 às 22:49 no fuso UTC-3 corresponde a 2026-11-16T01:49:00.000Z em UTC
    const instant2249UtcMinus3 = new Date('2026-11-15T22:49:00-03:00')
    expect(instant2249UtcMinus3.toISOString()).toBe('2026-11-16T01:49:00.000Z')

    // Garante comportamento determinístico em UTC-3 mesmo se o runner de CI estiver com TZ=UTC
    const simulatedDate = new Proxy(instant2249UtcMinus3, {
      get(target, prop) {
        if (prop === 'getFullYear') return () => 2026
        if (prop === 'getMonth') return () => 10 // novembro (0-indexed)
        if (prop === 'getDate') return () => 15
        if (prop === 'getHours') return () => 22
        if (prop === 'getMinutes') return () => 49
        if (prop === 'getTimezoneOffset') return () => 180 // UTC-3 = +180 min
        const val = Reflect.get(target, prop)
        return typeof val === 'function' ? val.bind(target) : val
      },
    })

    // 1. Prompt de sistema deve conter a data local (2026-11-15), horário (22:49) e fuso (UTC-03:00)
    const sysPrompt = buildSystemPrompt(simulatedDate)
    expect(sysPrompt).toContain('2026-11-15')
    expect(sysPrompt).toContain('22:49')
    expect(sysPrompt).toContain('UTC-03:00')
    expect(sysPrompt).toContain('2026-11-09 a 2026-11-15')

    // 2. Popula peso de hoje (2026-11-15) na tabela db.body e um registro mais novo porém com deleted = true
    const ex = (await db.exercises.toArray())[0]
    await db.sessions.put({
      id: 'sess-local-today',
      date: '2026-11-15',
      name: 'Treino Noite',
      notes: '',
      entries: [{ exerciseId: ex.id, sets: [{ id: 'st-1', value: 15, load: 0 }] }],
      createdAt: 1000,
    })
    await db.meals.put({
      id: 'meal-local-today',
      date: '2026-11-15',
      type: 'jantar',
      items: [{ name: 'Arroz e frango', qty: '300g', kcal: 520, p: 45, c: 55, g: 10 }],
      createdAt: 1000,
    })
    await db.body.put({
      id: 'body-2026-11-15',
      date: '2026-11-15',
      weight: 75.4,
      measures: { cintura: 79 },
    })
    // Registro soft-deleted (deleted: true) que DEVE ser ignorado por get_weekly_summary e get_body_evolution
    await runApplyingRemote(async () => {
      await db.body.put({
        id: 'body-2026-11-15-deleted',
        date: '2026-11-15',
        weight: 99.9,
        measures: {},
        updatedAt: 999999,
        deleted: true,
      })
    })

    // 3. Mesmo se o modelo tentar passar a data UTC do dia seguinte ("2026-11-16"), o intervalo termina no dia local ("2026-11-15")
    const weekly = await executeAssistantTool(
      'get_weekly_summary',
      { referenceDate: '2026-11-16' },
      simulatedDate,
    )
    expect(weekly.result.todayDate).toBe('2026-11-15')
    expect(weekly.result.period).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(weekly.result.todayWeightKg).toBe(75.4)
    expect(weekly.result.latestWeight).toEqual({ date: '2026-11-15', weightKg: 75.4 })
    expect(weekly.result.weightsInWeek).toEqual([{ date: '2026-11-15', weightKg: 75.4 }])

    // 4. get_diet_summary também termina em 2026-11-15 (últimos 7 dias locais: 2026-11-09 a 2026-11-15)
    const diet = await executeAssistantTool(
      'get_diet_summary',
      { endDate: '2026-11-16' },
      simulatedDate,
    )
    expect(diet.result.todayDate).toBe('2026-11-15')
    expect((diet.result.period as any).from).toBe('2026-11-09')
    expect((diet.result.period as any).to).toBe('2026-11-15')
    expect(diet.result.daysLogged).toBe(1)

    // 5. get_body_evolution lê de db.body, ignora deleted = true e termina em 2026-11-15
    const bodyEvo = await executeAssistantTool(
      'get_body_evolution',
      { days: 7 },
      simulatedDate,
    )
    expect(bodyEvo.result.todayDate).toBe('2026-11-15')
    expect(bodyEvo.result.period).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(bodyEvo.result.todayWeightKg).toBe(75.4)
    expect(bodyEvo.result.latestWeight).toEqual({ date: '2026-11-15', weightKg: 75.4 })
    expect((bodyEvo.result.entries as any[]).map((e) => e.weightKg)).toEqual([75.4])

    // 6. get_exercise_history também respeita a data local de hoje (2026-11-15)
    const exHist = await executeAssistantTool(
      'get_exercise_history',
      { query: ex.name },
      simulatedDate,
    )
    expect(exHist.result.todayDate).toBe('2026-11-15')
    expect(exHist.result.period).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(exHist.result.totalSessions).toBe(1)
  })

  it('integra ferramentas de agenda (Google Calendar), escopo calendar.events e fluxo de confirmação de editar/apagar', async () => {
    expect(CALENDAR_SCOPE).toBe('https://www.googleapis.com/auth/calendar.events')
    expect(SYSTEM_PROMPT).toContain('America/Sao_Paulo')
    expect(SYSTEM_PROMPT).toContain('1h')
    expect(SYSTEM_PROMPT).toContain('Confirmar')

    const sentPayloads: any[] = []
    const mockCalendarWorkerFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      sentPayloads.push(body)
      const ca = body.calendar_action
      if (ca?.tool === 'apagar_evento' && !ca.args?.confirmado) {
        return new Response(
          JSON.stringify({
            status: 'confirmation_required',
            requiresConfirmation: true,
            action: 'apagar_evento',
            event: {
              id: 'evt-99',
              titulo: 'Treino no Parque',
              inicio: '2026-11-17T10:00:00-03:00',
              fim: '2026-11-17T11:00:00-03:00',
              local: 'Parque Ibirapuera',
              htmlLink: 'https://calendar.google.com/calendar/event?eid=evt99',
            },
            pendingAction: { tool: 'apagar_evento', id: 'evt-99' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (ca?.tool === 'apagar_evento' && ca.args?.confirmado === 'confirmado') {
        return new Response(
          JSON.stringify({ status: 'deleted', id: 'evt-99' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('Chamada inesperada')
    }

    const out = await executeAssistantTool(
      'apagar_evento',
      { id: 'evt-99' },
      new Date('2026-11-17T09:00:00-03:00'),
      {
        fetcher: mockCalendarWorkerFetch,
        getToken: async () => 'token-firebase-mock',
        workerUrl: 'https://meu-worker.workers.dev',
      },
    )

    expect(out.calendarCards).toHaveLength(1)
    const card = out.calendarCards![0]
    expect(card.status).toBe('pending_confirmation')
    expect(card.event.titulo).toBe('Treino no Parque')
    expect(card.event.htmlLink).toContain('calendar.google.com')

    await confirmCalendarCard(card, {
      fetcher: mockCalendarWorkerFetch,
      getToken: async () => 'token-firebase-mock',
      workerUrl: 'https://meu-worker.workers.dev',
    })

    expect(sentPayloads).toHaveLength(2)
    expect(sentPayloads[1].calendar_action.args.confirmado).toBe('confirmado')
  })

  it('integra ferramentas de lembretes push (create_push_reminder, list_push_reminders, cancel_push_reminder) e botão rápido de cancelar no card', async () => {
    expect(SYSTEM_PROMPT).toContain('create_push_reminder')
    expect(SYSTEM_PROMPT).toContain('list_push_reminders')
    expect(SYSTEM_PROMPT).toContain('cancel_push_reminder')

    const sentReminderPayloads: any[] = []
    const mockReminderWorkerFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      sentReminderPayloads.push(body)
      const ra = body.reminder_action
      if (ra?.tool === 'create_push_reminder') {
        return new Response(
          JSON.stringify({
            status: 'created',
            reminder: {
              id: 'rem_creatina123',
              uid: 'tH4A7sYnH1WDUdBVDd1mfltMPdj2',
              title: ra.args.title,
              body: ra.args.body ?? '',
              triggerAt: '2026-11-26T21:00:00.000Z',
              timezone: 'America/Sao_Paulo',
              recurrence: ra.args.recurrence ?? 'none',
              status: 'pending',
              url: 'https://ianrtaniguchi.github.io/meu-treino/',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (ra?.tool === 'cancel_push_reminder') {
        return new Response(
          JSON.stringify({
            status: 'cancelled',
            reminder: {
              id: ra.args.id ?? 'rem_creatina123',
              title: 'Tomar creatina',
              triggerAt: '2026-11-26T21:00:00.000Z',
              recurrence: 'daily',
              status: 'cancelled',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('Chamada inesperada no mock de lembretes')
    }

    const out = await executeAssistantTool(
      'create_push_reminder',
      {
        title: 'Tomar creatina',
        body: '5g com água',
        dateTime: '2026-11-26T18:00:00-03:00',
        recurrence: 'daily',
      },
      new Date('2026-11-26T10:00:00-03:00'),
      {
        fetcher: mockReminderWorkerFetch,
        getToken: async () => 'token-firebase-mock',
        workerUrl: 'https://meu-worker.workers.dev',
      },
    )

    expect(out.reminderCards).toHaveLength(1)
    const rCard = out.reminderCards![0]
    expect(rCard.reminder.id).toBe('rem_creatina123')
    expect(rCard.reminder.title).toBe('Tomar creatina')
    expect(rCard.reminder.status).toBe('pending')
    expect(rCard.reminder.recurrence).toBe('daily')

    const cancelled = await cancelPushReminderCard(rCard, {
      fetcher: mockReminderWorkerFetch,
      getToken: async () => 'token-firebase-mock',
      workerUrl: 'https://meu-worker.workers.dev',
    })
    expect(cancelled?.status).toBe('cancelled')
    expect(sentReminderPayloads).toHaveLength(2)
    expect(sentReminderPayloads[1].reminder_action).toEqual({
      tool: 'cancel_push_reminder',
      args: { id: 'rem_creatina123' },
    })
  })

  it('gravador e transcrição de áudio cross-platform (PC WebM/Opus e iOS Safari MP4/AAC -> /transcribe)', async () => {
    // 1. No PC (Chromium/Edge/Brave): prioriza audio/webm;codecs=opus -> gravacao.webm
    const pcMime = detectSupportedAudioMime((m) => m === 'audio/webm;codecs=opus' || m === 'audio/webm')
    expect(pcMime).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      extension: 'webm',
      filename: 'gravacao.webm',
    })

    // 2. No iPhone (iOS Safari/WebKit PWA): quando só audio/mp4 é suportado -> gravacao.m4a
    const iosMime = detectSupportedAudioMime((m) => m === 'audio/mp4')
    expect(iosMime).toEqual({
      mimeType: 'audio/mp4',
      extension: 'm4a',
      filename: 'gravacao.m4a',
    })

    expect(extensionForAudioMime('audio/mp4;codecs=mp4a.40.2')).toBe('m4a')
    expect(filenameForAudioMime('audio/aac')).toBe('gravacao.m4a')
    expect(filenameForAudioMime('audio/webm')).toBe('gravacao.webm')
    expect(describeMediaError({ name: 'NotAllowedError' })).toContain('permissão de microfone negada')
    expect(describeMediaError({ name: 'NotFoundError' })).toContain('nenhum microfone encontrado')

    // 3. Rejeita clipe com menos de 0,6s (600ms) antes mesmo de chamar a rede
    const shortClip = {
      blob: new Blob([new Uint8Array(1024)], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      filename: 'gravacao.m4a',
      durationMs: 350,
    }
    await expect(
      transcribeAudioClip(shortClip, {
        getToken: async () => 'fake-token',
        workerUrl: 'https://meu-worker.workers.dev',
      }),
    ).rejects.toThrow(/muito curta/)

    // 4. Envia FormData com arquivo e extensão correta para POST /transcribe
    let sentUrl = ''
    let sentFile: any = null
    const mockTranscribeFetch: typeof fetch = async (input, init) => {
      sentUrl = String(input)
      const fd = init?.body as FormData
      sentFile = fd.get('file') as File
      return new Response(JSON.stringify({ text: 'Como foi minha semana de treino?' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const validClip = {
      blob: new Blob([new Uint8Array(2048)], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      filename: 'gravacao.m4a',
      durationMs: 2400,
    }
    const text = await transcribeAudioClip(validClip, {
      fetcher: mockTranscribeFetch,
      getToken: async () => 'fake-token',
      workerUrl: 'https://meu-worker.workers.dev',
    })
    expect(text).toBe('Como foi minha semana de treino?')
    expect(sentUrl).toBe('https://meu-worker.workers.dev/transcribe')
    expect(sentFile?.name).toBe('gravacao.m4a')
  })

  it('oculta ferramentas e instruções do Google Calendar para contas secundárias (uid !== OWNER_UID)', () => {
    expect(isCurrentUserOwner(OWNER_UID)).toBe(true)
    expect(isCurrentUserOwner('uid-namorada-002')).toBe(false)

    const ownerTools = getAssistantToolsForUser(OWNER_UID).map((t) => t.function.name)
    expect(ownerTools).toContain('criar_evento')
    expect(ownerTools).toContain('listar_eventos')

    const secondaryTools = getAssistantToolsForUser('uid-namorada-002').map((t) => t.function.name)
    expect(secondaryTools).not.toContain('criar_evento')
    expect(secondaryTools).not.toContain('listar_eventos')
    expect(secondaryTools).not.toContain('editar_evento')
    expect(secondaryTools).not.toContain('apagar_evento')
    expect(secondaryTools).toContain('propose_meal')
    expect(secondaryTools).toContain('create_push_reminder')

    const secondaryPrompt = buildSystemPrompt(new Date(2026, 10, 16, 9, 0, 0), 'uid-namorada-002')
    expect(secondaryPrompt).not.toContain('Google Calendar')
  })
})
