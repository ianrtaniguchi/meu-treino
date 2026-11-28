import { ASSISTANT_WORKER_URL } from '../assistantConfig'
import { getFirebaseAuth } from '../data/sync'
import type { FacultyDeadline, FacultyEventType } from './faculty'

interface ReminderActionOptions {
  fetcher?: typeof fetch
  getToken?: () => Promise<string | null>
  workerUrl?: string
  now?: Date
}

function isoWithSaoPauloOffset(date: string, time: string): string {
  return new Date(`${date}T${time}:00-03:00`).toISOString()
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

function eventName(type: FacultyEventType): string {
  return type === 'prova' ? 'Prova' : type === 'lista' ? 'Lista' : 'Trabalho'
}

async function callReminderAction(
  tool: 'create_push_reminder' | 'cancel_push_reminder',
  args: Record<string, unknown>,
  options: ReminderActionOptions,
): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch
  const getToken = options.getToken ?? (() => {
    const user = getFirebaseAuth().currentUser
    return user ? user.getIdToken() : Promise.resolve(null)
  })
  const token = await getToken()
  if (!token) throw new Error('Entre na sua conta para configurar lembretes push.')

  const baseUrl = (options.workerUrl ?? ASSISTANT_WORKER_URL).replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetcher(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminder_action: { tool, args } }),
    })
  } catch {
    throw new Error('Falha de rede ao configurar lembretes push.')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Resposta inválida ao configurar lembretes push.')
  }
  const result = payload as Record<string, unknown>
  if (!response.ok || typeof result.error === 'string') {
    throw new Error(typeof result.error === 'string' ? result.error.replace(/^error:\s*/, '') : `Falha nos lembretes push (HTTP ${response.status}).`)
  }
  return result
}

export async function cancelFacultyDeadlineReminders(
  reminderIds: string[],
  options: ReminderActionOptions = {},
): Promise<void> {
  for (const id of reminderIds) {
    await callReminderAction('cancel_push_reminder', { id }, options)
  }
}

export async function replaceFacultyDeadlineReminders(
  deadline: FacultyDeadline,
  courseName: string,
  previousReminderIds: string[] = [],
  options: ReminderActionOptions = {},
): Promise<string[]> {
  if (deadline.status !== 'pendente') {
    await cancelFacultyDeadlineReminders(previousReminderIds, options)
    return []
  }

  const now = (options.now ?? new Date()).getTime()
  const label = `${eventName(deadline.type)} de ${courseName}`
  const reminders = [
    {
      date: shiftDate(deadline.date, -2),
      title: `${label} em 2 dias`,
      body: `${courseName} · ${deadline.date} às ${deadline.time}`,
    },
    {
      date: deadline.date,
      title: `Hoje: ${label}`,
      body: `${courseName} · prazo às ${deadline.time}`,
    },
  ].filter((reminder) => new Date(isoWithSaoPauloOffset(reminder.date, deadline.time)).getTime() > now)

  const createdIds: string[] = []
  try {
    for (const reminder of reminders) {
      const result = await callReminderAction(
        'create_push_reminder',
        {
          title: reminder.title,
          body: reminder.body,
          dateTime: `${reminder.date}T${deadline.time}:00-03:00`,
          timezone: 'America/Sao_Paulo',
        },
        options,
      )
      const created = result.reminder as { id?: unknown } | undefined
      if (typeof created?.id !== 'string' || !created.id) {
        throw new Error('O Worker não retornou o ID do lembrete criado.')
      }
      createdIds.push(created.id)
    }
  } catch (error) {
    let cleanupError = ''
    try {
      await cancelFacultyDeadlineReminders(createdIds, options)
    } catch (cleanup) {
      cleanupError = ` Também não foi possível remover um lembrete parcial: ${cleanup instanceof Error ? cleanup.message : 'erro desconhecido'}.`
    }
    throw new Error(`${error instanceof Error ? error.message : 'Falha ao criar lembretes.'}${cleanupError}`)
  }

  try {
    await cancelFacultyDeadlineReminders(previousReminderIds, options)
  } catch (error) {
    let cleanupError = ''
    try {
      await cancelFacultyDeadlineReminders(createdIds, options)
    } catch (cleanup) {
      cleanupError = ` Também não foi possível remover os novos lembretes: ${cleanup instanceof Error ? cleanup.message : 'erro desconhecido'}.`
    }
    throw new Error(`${error instanceof Error ? error.message : 'Falha ao substituir lembretes.'}${cleanupError}`)
  }
  return createdIds
}
