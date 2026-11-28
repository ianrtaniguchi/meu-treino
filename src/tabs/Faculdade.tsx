import { useMemo, useRef, useState } from 'react'
import { PromptTitle } from '../components/TerminalChrome'
import { Field, Sheet, useUi } from '../components/ui'
import { setSetting, uid } from '../data/db'
import { today } from '../data/stats'
import { useSetting } from '../hooks'
import {
  calculateFacultyGradeProgress,
  EMPTY_FACULTY_DATA,
  FACULDADE_SETTING_KEY,
  FACULTY_WEEKDAYS,
  type FacultyAssessment,
  type FacultyClass,
  type FacultyCourse,
  type FacultyData,
  type FacultyDeadline,
  type FacultyEventType,
} from '../lib/faculty'
import { analyzeFacultySchedulePhoto, type FacultyScheduleDraft } from '../lib/facultyPhoto'
import { cancelFacultyDeadlineReminders, replaceFacultyDeadlineReminders } from '../lib/facultyReminders'

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const EVENT_TYPES: FacultyEventType[] = ['prova', 'lista', 'trabalho']
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

type Editor =
  | { kind: 'course'; id: string; name: string; passingAverage: string }
  | { kind: 'class'; id: string; courseId: string; dayOfWeek: string; startTime: string; endTime: string; room: string; professor: string }
  | { kind: 'deadline'; id: string; courseId: string; type: FacultyEventType; date: string; time: string; status: 'pendente' | 'feito' }
  | { kind: 'assessment'; id: string; courseId: string; name: string; weight: string; grade: string }

function formatDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function formatTimeRange(start: string, end: string): string {
  return `${start || '—'}${end ? `–${end}` : ''}`
}

function eventLabel(type: FacultyEventType): string {
  return type === 'prova' ? 'Prova' : type === 'lista' ? 'Lista' : 'Trabalho'
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((current) => current.id === item.id)
    ? items.map((current) => current.id === item.id ? item : current)
    : [...items, item]
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
}

export default function Faculdade() {
  const data = useSetting<FacultyData>(FACULDADE_SETTING_KEY, EMPTY_FACULTY_DATA) ?? EMPTY_FACULTY_DATA
  const { toast } = useUi()
  const photoInput = useRef<HTMLInputElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editorError, setEditorError] = useState('')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoReview, setPhotoReview] = useState<FacultyScheduleDraft[] | null>(null)
  const [photoError, setPhotoError] = useState('')

  const courseById = useMemo(() => new Map(data.courses.map((course) => [course.id, course])), [data.courses])
  const assessmentsByCourse = useMemo(() => {
    const map = new Map<string, FacultyAssessment[]>()
    for (const assessment of data.assessments) {
      const current = map.get(assessment.courseId) ?? []
      current.push(assessment)
      map.set(assessment.courseId, current)
    }
    return map
  }, [data.assessments])
  const deadlines = useMemo(
    () => [...data.deadlines].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)),
    [data.deadlines],
  )

  const persist = async (next: FacultyData): Promise<boolean> => {
    try {
      await setSetting(FACULDADE_SETTING_KEY, next)
      return true
    } catch (error) {
      toast(`error: não foi possível salvar Faculdade. ${error instanceof Error ? error.message : ''}`)
      return false
    }
  }

  const syncDeadlineReminders = async (
    deadline: FacultyDeadline,
    baseData: FacultyData,
    previousReminderIds: string[] = [],
  ) => {
    try {
      const courseName = courseById.get(deadline.courseId)?.name
      if (!courseName) throw new Error('Disciplina do prazo não encontrada.')
      const reminderIds = await replaceFacultyDeadlineReminders(deadline, courseName, previousReminderIds)
      const next = {
        ...baseData,
        deadlines: baseData.deadlines.map((item) =>
          item.id === deadline.id ? { ...item, reminderIds } : item,
        ),
      }
      if (await persist(next)) {
        toast(deadline.status === 'pendente' ? 'Prazo salvo e lembretes push agendados.' : 'Prazo marcado como feito; lembretes cancelados.')
      }
    } catch (error) {
      toast(`Prazo salvo, mas não foi possível configurar os lembretes push. ${error instanceof Error ? error.message : ''}`)
    }
  }

  const openCourseEditor = (course?: FacultyCourse) => {
    setEditor({
      kind: 'course',
      id: course?.id ?? '',
      name: course?.name ?? '',
      passingAverage: String(course?.passingAverage ?? 60),
    })
    setEditorError('')
  }

  const openClassEditor = (facultyClass?: FacultyClass) => {
    if (data.courses.length === 0) {
      toast('Cadastre uma disciplina antes de adicionar aulas.')
      return
    }
    setEditor({
      kind: 'class',
      id: facultyClass?.id ?? '',
      courseId: facultyClass?.courseId ?? data.courses[0].id,
      dayOfWeek: String(facultyClass?.dayOfWeek ?? 1),
      startTime: facultyClass?.startTime ?? '08:00',
      endTime: facultyClass?.endTime ?? '10:00',
      room: facultyClass?.room ?? '',
      professor: facultyClass?.professor ?? '',
    })
    setEditorError('')
  }

  const openDeadlineEditor = (deadline?: FacultyDeadline) => {
    if (data.courses.length === 0) {
      toast('Cadastre uma disciplina antes de adicionar provas e prazos.')
      return
    }
    const now = new Date()
    const defaultTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    setEditor({
      kind: 'deadline',
      id: deadline?.id ?? '',
      courseId: deadline?.courseId ?? data.courses[0].id,
      type: deadline?.type ?? 'prova',
      date: deadline?.date ?? today(),
      time: deadline?.time ?? defaultTime,
      status: deadline?.status ?? 'pendente',
    })
    setEditorError('')
  }

  const openAssessmentEditor = (courseId: string, assessment?: FacultyAssessment) => {
    setEditor({
      kind: 'assessment',
      id: assessment?.id ?? '',
      courseId,
      name: assessment?.name ?? '',
      weight: String(assessment?.weight ?? 1),
      grade: assessment?.grade === undefined ? '' : String(assessment.grade),
    })
    setEditorError('')
  }

  const saveEditor = async () => {
    if (!editor) return
    setEditorError('')
    let next = data
    let updatedDeadline: FacultyDeadline | undefined
    let previousReminderIds: string[] = []

    if (editor.kind === 'course') {
      const name = editor.name.trim()
      const passingAverage = Number(editor.passingAverage)
      if (!name || name.length > 100) return setEditorError('Informe uma disciplina com até 100 caracteres.')
      if (!Number.isFinite(passingAverage) || passingAverage < 0 || passingAverage > 100) {
        return setEditorError('A média mínima deve estar entre 0 e 100.')
      }
      if (data.courses.some((course) => course.id !== editor.id && course.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return setEditorError('Essa disciplina já está cadastrada.')
      }
      const course = { id: editor.id || uid(), name, passingAverage }
      next = { ...data, courses: upsert(data.courses, course) }
    } else if (editor.kind === 'class') {
      const dayOfWeek = Number(editor.dayOfWeek)
      if (!editor.courseId || !courseById.has(editor.courseId)) return setEditorError('Selecione uma disciplina válida.')
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return setEditorError('Selecione um dia válido.')
      if (!TIME_RE.test(editor.startTime) || !TIME_RE.test(editor.endTime) || editor.endTime <= editor.startTime) {
        return setEditorError('Informe um horário de início e fim válidos.')
      }
      if (!editor.room.trim()) return setEditorError('Informe a sala.')
      const facultyClass: FacultyClass = {
        id: editor.id || uid(),
        courseId: editor.courseId,
        dayOfWeek,
        startTime: editor.startTime,
        endTime: editor.endTime,
        room: editor.room.trim(),
        professor: editor.professor.trim() || undefined,
      }
      next = { ...data, classes: upsert(data.classes, facultyClass) }
    } else if (editor.kind === 'deadline') {
      if (!editor.courseId || !courseById.has(editor.courseId)) return setEditorError('Selecione uma disciplina válida.')
      if (!validDate(editor.date) || !TIME_RE.test(editor.time)) return setEditorError('Informe uma data e horário válidos.')
      const deadline: FacultyDeadline = {
        id: editor.id || uid(),
        courseId: editor.courseId,
        type: editor.type,
        date: editor.date,
        time: editor.time,
        status: editor.status,
        reminderIds: editor.id ? data.deadlines.find((item) => item.id === editor.id)?.reminderIds : undefined,
      }
      next = { ...data, deadlines: upsert(data.deadlines, deadline) }
      updatedDeadline = deadline
      previousReminderIds = data.deadlines.find((item) => item.id === editor.id)?.reminderIds ?? []
    } else {
      const name = editor.name.trim()
      const weight = Number(editor.weight)
      const grade = editor.grade.trim() === '' ? undefined : Number(editor.grade)
      if (!editor.courseId || !courseById.has(editor.courseId)) return setEditorError('Selecione uma disciplina válida.')
      if (!name || name.length > 100) return setEditorError('Informe o nome da avaliação.')
      if (!Number.isFinite(weight) || weight <= 0 || weight > 100) return setEditorError('O peso deve ser maior que zero e no máximo 100.')
      if (grade !== undefined && (!Number.isFinite(grade) || grade < 0 || grade > 100)) {
        return setEditorError('A nota deve estar entre 0 e 100.')
      }
      const assessment: FacultyAssessment = {
        id: editor.id || uid(),
        courseId: editor.courseId,
        name,
        weight,
        ...(grade === undefined ? {} : { grade }),
      }
      next = { ...data, assessments: upsert(data.assessments, assessment) }
    }

    if (await persist(next)) {
      setEditor(null)
      if (updatedDeadline) await syncDeadlineReminders(updatedDeadline, next, previousReminderIds)
    }
  }

  const removeClass = async (id: string) => {
    if (await persist({ ...data, classes: data.classes.filter((item) => item.id !== id) })) {
      toast('Aula removida.')
    }
  }

  const removeDeadline = async (id: string) => {
    const deadline = data.deadlines.find((item) => item.id === id)
    if (!deadline) return
    try {
      await cancelFacultyDeadlineReminders(deadline.reminderIds ?? [])
    } catch (error) {
      toast(`Não foi possível cancelar os lembretes. O prazo não foi removido. ${error instanceof Error ? error.message : ''}`)
      return
    }
    if (await persist({ ...data, deadlines: data.deadlines.filter((item) => item.id !== id) })) {
      toast('Prazo removido.')
    }
  }

  const toggleDeadlineStatus = async (deadline: FacultyDeadline) => {
    const updated = {
      ...deadline,
      status: deadline.status === 'feito' ? 'pendente' as const : 'feito' as const,
    }
    const next = {
      ...data,
      deadlines: data.deadlines.map((item) => item.id === deadline.id ? updated : item),
    }
    if (await persist(next)) await syncDeadlineReminders(updated, next, deadline.reminderIds ?? [])
  }

  const removeAssessment = async (id: string) => {
    if (await persist({ ...data, assessments: data.assessments.filter((item) => item.id !== id) })) {
      toast('Avaliação removida.')
    }
  }

  const removeCourse = async (course: FacultyCourse) => {
    if (
      data.classes.some((item) => item.courseId === course.id) ||
      data.deadlines.some((item) => item.courseId === course.id) ||
      data.assessments.some((item) => item.courseId === course.id)
    ) {
      toast('Remova primeiro as aulas, prazos e avaliações dessa disciplina.')
      return
    }
    if (await persist({ ...data, courses: data.courses.filter((item) => item.id !== course.id) })) {
      toast('Disciplina removida.')
    }
  }

  const onPhoto = async (file?: File) => {
    if (!file || photoBusy) return
    setPhotoBusy(true)
    setPhotoError('')
    try {
      const drafts = await analyzeFacultySchedulePhoto(file)
      if (drafts.length === 0) {
        toast('Não encontrei aulas legíveis nessa foto. Você pode cadastrá-las manualmente.')
      } else {
        setPhotoReview(drafts)
      }
    } catch (error) {
      toast(`error: ${error instanceof Error ? error.message : 'falha ao analisar a foto.'}`)
    } finally {
      setPhotoBusy(false)
      if (photoInput.current) photoInput.current.value = ''
    }
  }

  const confirmPhotoReview = async () => {
    if (!photoReview) return
    setPhotoError('')
    const invalid = photoReview.some((draft) =>
      !draft.courseName.trim() ||
      draft.dayOfWeek === null ||
      !TIME_RE.test(draft.startTime) ||
      !TIME_RE.test(draft.endTime) ||
      draft.endTime <= draft.startTime ||
      !draft.room.trim(),
    )
    if (invalid) {
      setPhotoError('Revise disciplina, dia, horários e sala de todas as aulas antes de confirmar.')
      return
    }

    const courses = [...data.courses]
    const classes = [...data.classes]
    for (const draft of photoReview) {
      if (draft.dayOfWeek === null) {
        setPhotoError('Selecione o dia da semana de todas as aulas antes de confirmar.')
        return
      }
      const courseName = draft.courseName.trim()
      let course = courses.find((item) => item.name.toLocaleLowerCase() === courseName.toLocaleLowerCase())
      if (!course) {
        course = { id: uid(), name: courseName, passingAverage: 60 }
        courses.push(course)
      }
      classes.push({
        id: uid(),
        courseId: course.id,
        dayOfWeek: draft.dayOfWeek,
        startTime: draft.startTime,
        endTime: draft.endTime,
        room: draft.room.trim(),
        professor: draft.professor.trim() || undefined,
      })
    }
    if (await persist({ ...data, courses, classes })) {
      setPhotoReview(null)
      toast(`${photoReview.length} aula(s) confirmada(s).`)
    }
  }

  const weekdayClasses = DAY_ORDER.map((day) => ({
    day,
    classes: data.classes
      .filter((facultyClass) => facultyClass.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime)),
  })).filter((group) => group.classes.length > 0)

  return (
    <div className="scroll">
      <PromptTitle
        path="~/faculdade"
        rightSlot={
          <button type="button" className="small" style={{ minHeight: 44 }} onClick={() => openCourseEditor()}>
            + disciplina
          </button>
        }
      />

      <section className="card stack">
        <div className="row between">
          <b>Horário das aulas</b>
          <div className="faculty-actions">
            <button type="button" className="small" style={{ minHeight: 44 }} disabled={photoBusy} onClick={() => photoInput.current?.click()}>
              {photoBusy ? 'lendo foto…' : 'cadastrar por foto'}
            </button>
            <button type="button" className="small" style={{ minHeight: 44 }} onClick={() => openClassEditor()}>
              + aula
            </button>
          </div>
        </div>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          style={{ display: 'none' }}
          onChange={(event) => void onPhoto(event.target.files?.[0])}
        />
        {weekdayClasses.length === 0 ? (
          <div className="small muted">Nenhuma aula cadastrada. Adicione uma aula ou fotografe a grade.</div>
        ) : (
          weekdayClasses.map(({ day, classes }) => (
            <div key={day}>
              <div className="faculty-day-heading">{FACULTY_WEEKDAYS[day]}</div>
              {classes.map((facultyClass) => (
                <div key={facultyClass.id} className="faculty-item">
                  <div className="grow">
                    <b>{courseById.get(facultyClass.courseId)?.name ?? 'Disciplina removida'}</b>
                    <div className="small muted">
                      {formatTimeRange(facultyClass.startTime, facultyClass.endTime)} · {facultyClass.room}
                      {facultyClass.professor ? ` · ${facultyClass.professor}` : ''}
                    </div>
                  </div>
                  <div className="faculty-row-actions">
                    <button type="button" className="ghost small" aria-label="Editar aula" onClick={() => openClassEditor(facultyClass)}>editar</button>
                    <button type="button" className="ghost small" aria-label="Remover aula" onClick={() => void removeClass(facultyClass.id)}>remover</button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </section>

      <section className="card stack">
        <div className="row between">
          <b>Provas e prazos</b>
          <button type="button" className="small" style={{ minHeight: 44 }} onClick={() => openDeadlineEditor()}>
            + prazo
          </button>
        </div>
        {deadlines.length === 0 ? (
          <div className="small muted">Nenhuma prova, lista ou trabalho cadastrado.</div>
        ) : (
          deadlines.map((deadline) => (
            <div key={deadline.id} className={`faculty-item${deadline.status === 'feito' ? ' faculty-done' : ''}`}>
              <div className="grow">
                <b>{eventLabel(deadline.type)} · {courseById.get(deadline.courseId)?.name ?? 'Disciplina removida'}</b>
                <div className="small muted">
                  {formatDate(deadline.date)} às {deadline.time} · {deadline.status}
                  {deadline.reminderIds?.length ? ' · push agendado' : ''}
                </div>
              </div>
              <div className="faculty-row-actions">
                <button
                  type="button"
                  className="ghost small"
                  aria-label={deadline.status === 'feito' ? 'Marcar como pendente' : 'Marcar como feito'}
                  onClick={() => void toggleDeadlineStatus(deadline)}
                >
                  {deadline.status === 'feito' ? 'reabrir' : 'feito'}
                </button>
                <button type="button" className="ghost small" aria-label="Editar prazo" onClick={() => openDeadlineEditor(deadline)}>editar</button>
                <button type="button" className="ghost small" aria-label="Remover prazo" onClick={() => void removeDeadline(deadline.id)}>remover</button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="card stack">
        <div className="row between">
          <b>Notas e média</b>
          <button type="button" className="small" style={{ minHeight: 44 }} onClick={() => openCourseEditor()}>
            + disciplina
          </button>
        </div>
        {data.courses.length === 0 ? (
          <div className="small muted">Cadastre uma disciplina para registrar avaliações e calcular a média.</div>
        ) : (
          data.courses.map((course) => {
            const assessments = assessmentsByCourse.get(course.id) ?? []
            const progress = calculateFacultyGradeProgress(assessments, course.passingAverage)
            return (
              <div key={course.id} className="faculty-course">
                <div className="row between">
                  <div>
                    <b>{course.name}</b>
                    <div className="small muted">Média mínima: {course.passingAverage}</div>
                  </div>
                  <div className="faculty-row-actions">
                    <button type="button" className="ghost small" aria-label={`Editar ${course.name}`} onClick={() => openCourseEditor(course)}>editar</button>
                    <button type="button" className="ghost small" aria-label={`Remover ${course.name}`} onClick={() => void removeCourse(course)}>remover</button>
                  </div>
                </div>
                <div className="small" style={{ marginTop: 8 }}>
                  Média atual: <b>{progress.currentAverage === null ? 'sem notas' : progress.currentAverage.toFixed(1)}</b>
                  {' · '}Pontos garantidos: <b>{progress.pointsGuaranteed.toFixed(1)}</b>
                </div>
                {progress.status === 'no-assessments' && <div className="small muted">Cadastre avaliações para calcular a média.</div>}
                {progress.status === 'in-progress' && (
                  <div className="small muted">
                    Nota média necessária nas avaliações restantes: <b>{progress.requiredAverage?.toFixed(1)}</b>
                  </div>
                )}
                {progress.status === 'passed' && <div className="small green">Média mínima atingida; você já passou.</div>}
                {progress.status === 'recovery-needed' && (
                  <div className="small amber">
                    {progress.recoveryAtBestPossible
                      ? `Mesmo com 100 nas avaliações restantes, precisa de ${progress.recoveryScoreNeeded?.toFixed(1)} na recuperação.`
                      : `Precisa de ${progress.recoveryScoreNeeded?.toFixed(1)} na recuperação.`}
                  </div>
                )}
                {progress.status === 'impossible' && (
                  <div className="small amber">Não é mais possível atingir a média mínima, mesmo com 100 nas avaliações restantes e na recuperação.</div>
                )}
                {assessments.map((assessment) => (
                  <div key={assessment.id} className="faculty-item">
                    <div className="grow small">
                      {assessment.name} · peso {assessment.weight}
                      <div className="muted">{assessment.grade === undefined ? 'sem nota' : `Nota: ${assessment.grade}`}</div>
                    </div>
                    <div className="faculty-row-actions">
                      <button type="button" className="ghost small" aria-label="Editar avaliação" onClick={() => openAssessmentEditor(course.id, assessment)}>editar</button>
                      <button type="button" className="ghost small" aria-label="Remover avaliação" onClick={() => void removeAssessment(assessment.id)}>remover</button>
                    </div>
                  </div>
                ))}
                <button type="button" className="small" style={{ minHeight: 44 }} onClick={() => openAssessmentEditor(course.id)}>
                  + avaliação
                </button>
              </div>
            )
          })
        )}
      </section>

      {editor && (
        <Sheet
          title={
            editor.kind === 'course'
              ? editor.id ? 'Editar disciplina' : 'Nova disciplina'
              : editor.kind === 'class'
                ? editor.id ? 'Editar aula' : 'Nova aula'
                : editor.kind === 'deadline'
                  ? editor.id ? 'Editar prazo' : 'Novo prazo'
                  : editor.id ? 'Editar avaliação' : 'Nova avaliação'
          }
          onClose={() => setEditor(null)}
        >
          <div className="stack">
            {editor.kind === 'course' && (
              <>
                <Field label="Disciplina" value={editor.name} onChange={(name) => setEditor({ ...editor, name })} placeholder="Ex.: Cálculo II" />
                <Field
                  label="Média mínima para passar (0–100)"
                  value={editor.passingAverage}
                  onChange={(passingAverage) => setEditor({ ...editor, passingAverage })}
                  type="number"
                  mode="decimal"
                />
              </>
            )}
            {editor.kind === 'class' && (
              <>
                <label className="f">Disciplina
                  <select value={editor.courseId} onChange={(event) => setEditor({ ...editor, courseId: event.target.value })}>
                    {data.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                  </select>
                </label>
                <label className="f">Dia da semana
                  <select value={editor.dayOfWeek} onChange={(event) => setEditor({ ...editor, dayOfWeek: event.target.value })}>
                    {FACULTY_WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                  </select>
                </label>
                <div className="grid2">
                  <Field label="Início" value={editor.startTime} onChange={(startTime) => setEditor({ ...editor, startTime })} type="time" />
                  <Field label="Fim" value={editor.endTime} onChange={(endTime) => setEditor({ ...editor, endTime })} type="time" />
                </div>
                <Field label="Sala" value={editor.room} onChange={(room) => setEditor({ ...editor, room })} />
                <Field label="Professor (opcional)" value={editor.professor} onChange={(professor) => setEditor({ ...editor, professor })} />
              </>
            )}
            {editor.kind === 'deadline' && (
              <>
                <label className="f">Disciplina
                  <select value={editor.courseId} onChange={(event) => setEditor({ ...editor, courseId: event.target.value })}>
                    {data.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                  </select>
                </label>
                <label className="f">Tipo
                  <select value={editor.type} onChange={(event) => setEditor({ ...editor, type: event.target.value as FacultyEventType })}>
                    {EVENT_TYPES.map((type) => <option key={type} value={type}>{eventLabel(type)}</option>)}
                  </select>
                </label>
                <div className="grid2">
                  <Field label="Data" value={editor.date} onChange={(date) => setEditor({ ...editor, date })} type="date" />
                  <Field label="Horário" value={editor.time} onChange={(time) => setEditor({ ...editor, time })} type="time" />
                </div>
                <label className="f">Status
                  <select value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value as 'pendente' | 'feito' })}>
                    <option value="pendente">Pendente</option>
                    <option value="feito">Feito</option>
                  </select>
                </label>
              </>
            )}
            {editor.kind === 'assessment' && (
              <>
                <Field label="Avaliação" value={editor.name} onChange={(name) => setEditor({ ...editor, name })} placeholder="Ex.: Prova 1" />
                <div className="grid2">
                  <Field label="Peso" value={editor.weight} onChange={(weight) => setEditor({ ...editor, weight })} type="number" mode="decimal" />
                  <Field label="Nota (opcional)" value={editor.grade} onChange={(grade) => setEditor({ ...editor, grade })} type="number" mode="decimal" />
                </div>
              </>
            )}
            {editorError && <div className="small red" role="alert">{editorError}</div>}
            <button type="button" className="primary block" style={{ minHeight: 44 }} onClick={() => void saveEditor()}>
              salvar
            </button>
          </div>
        </Sheet>
      )}

      {photoReview && (
        <Sheet title="Revisar horário lido" onClose={() => setPhotoReview(null)}>
          <div className="stack">
            <div className="small muted">Confira e corrija os campos antes de salvar a grade.</div>
            {photoReview.map((draft, index) => (
              <div key={draft.id} className="card stack">
                <div className="small muted">Aula {index + 1}</div>
                <Field
                  label="Disciplina"
                  value={draft.courseName}
                  onChange={(courseName) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, courseName } : row) ?? null)}
                />
                <label className="f">Dia
                  <select
                    value={draft.dayOfWeek === null ? '' : String(draft.dayOfWeek)}
                    onChange={(event) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, dayOfWeek: event.target.value === '' ? null : Number(event.target.value) } : row) ?? null)}
                  >
                    <option value="">Selecione o dia</option>
                    {FACULTY_WEEKDAYS.map((day, dayIndex) => <option key={day} value={dayIndex}>{day}</option>)}
                  </select>
                </label>
                <div className="grid2">
                  <Field label="Início" value={draft.startTime} onChange={(startTime) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, startTime } : row) ?? null)} type="time" />
                  <Field label="Fim" value={draft.endTime} onChange={(endTime) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, endTime } : row) ?? null)} type="time" />
                </div>
                <Field label="Sala" value={draft.room} onChange={(room) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, room } : row) ?? null)} />
                <Field label="Professor (opcional)" value={draft.professor} onChange={(professor) => setPhotoReview((current) => current?.map((row, i) => i === index ? { ...row, professor } : row) ?? null)} />
              </div>
            ))}
            {photoError && <div className="small red" role="alert">{photoError}</div>}
            <button type="button" className="primary block" style={{ minHeight: 44 }} onClick={() => void confirmPhotoReview()}>
              confirmar todas as aulas
            </button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
