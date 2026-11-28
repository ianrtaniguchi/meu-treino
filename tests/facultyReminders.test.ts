import { describe, expect, it, vi } from 'vitest'
import { replaceFacultyDeadlineReminders } from '../src/lib/facultyReminders'
import type { FacultyDeadline } from '../src/lib/faculty'

const deadline: FacultyDeadline = {
  id: 'deadline-1',
  courseId: 'course-1',
  type: 'prova',
  date: '2026-07-10',
  time: '09:00',
  status: 'pendente',
}

describe('replaceFacultyDeadlineReminders', () => {
  it('schedules two reminders in the São Paulo timezone using the authenticated Worker route', async () => {
    const calls: Array<{ url: string; body: Record<string, any> }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>
      calls.push({ url: String(input), body })
      const id = `reminder-${calls.length}`
      return new Response(JSON.stringify({ reminder: { id } }), { status: 200 })
    })

    const ids = await replaceFacultyDeadlineReminders(deadline, 'Cálculo II', [], {
      workerUrl: 'https://worker.example/',
      getToken: async () => 'firebase-id-token',
      fetcher,
      now: new Date('2026-07-07T08:00:00-03:00'),
    })

    expect(ids).toEqual(['reminder-1', 'reminder-2'])
    expect(calls.map((call) => call.url)).toEqual([
      'https://worker.example/chat',
      'https://worker.example/chat',
    ])
    expect(calls.map((call) => call.body.reminder_action.args.dateTime)).toEqual([
      '2026-07-08T09:00:00-03:00',
      '2026-07-10T09:00:00-03:00',
    ])
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer firebase-id-token' })
  })

  it('skips reminders that would be scheduled in the past', async () => {
    const fetcher = vi.fn()
    const ids = await replaceFacultyDeadlineReminders(
      { ...deadline, date: '2026-07-07', time: '07:00' },
      'Cálculo II',
      [],
      { fetcher: fetcher as typeof fetch, getToken: async () => 'token', now: new Date('2026-07-07T08:00:00-03:00') },
    )

    expect(ids).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
