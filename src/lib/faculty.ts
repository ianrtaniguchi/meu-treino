export type FacultyEventType = 'prova' | 'lista' | 'trabalho'
export type FacultyEventStatus = 'pendente' | 'feito'

export interface FacultyCourse {
  id: string
  name: string
  passingAverage: number
}

export interface FacultyClass {
  id: string
  courseId: string
  dayOfWeek: number
  startTime: string
  endTime: string
  room: string
  professor?: string
}

export interface FacultyDeadline {
  id: string
  courseId: string
  type: FacultyEventType
  date: string
  time: string
  status: FacultyEventStatus
  reminderIds?: string[]
}

export interface FacultyAssessment {
  id: string
  courseId: string
  name: string
  weight: number
  grade?: number
}

export interface FacultyData {
  courses: FacultyCourse[]
  classes: FacultyClass[]
  deadlines: FacultyDeadline[]
  assessments: FacultyAssessment[]
}

export type FacultyGradeStatus =
  | 'no-assessments'
  | 'in-progress'
  | 'passed'
  | 'recovery-needed'
  | 'impossible'

export interface FacultyGradeProgress {
  status: FacultyGradeStatus
  currentAverage: number | null
  pointsGuaranteed: number
  remainingWeight: number
  requiredAverage: number | null
  recoveryScoreNeeded: number | null
  recoveryAtBestPossible: boolean
}

export const FACULDADE_SETTING_KEY = 'faculdadeData'

export const EMPTY_FACULTY_DATA: FacultyData = {
  courses: [],
  classes: [],
  deadlines: [],
  assessments: [],
}

export const FACULTY_WEEKDAYS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
] as const

export interface NextFacultyClass {
  facultyClass: FacultyClass
  course: FacultyCourse
  startsAt: Date
}

export function getNextFacultyClass(
  classes: FacultyClass[],
  courses: FacultyCourse[],
  from = new Date(),
): NextFacultyClass | null {
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const candidates = classes.flatMap((facultyClass) => {
    const course = courseById.get(facultyClass.courseId)
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(facultyClass.startTime)
    if (!course || !match || facultyClass.dayOfWeek < 0 || facultyClass.dayOfWeek > 6) return []

    const startsAt = new Date(from)
    const daysUntil = (facultyClass.dayOfWeek - from.getDay() + 7) % 7
    startsAt.setDate(from.getDate() + daysUntil)
    startsAt.setHours(Number(match[1]), Number(match[2]), 0, 0)
    if (startsAt <= from) startsAt.setDate(startsAt.getDate() + 7)
    return [{ facultyClass, course, startsAt }]
  })

  candidates.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return candidates[0] ?? null
}

export interface NextFacultyDeadline {
  deadline: FacultyDeadline
  course: FacultyCourse
  dueAt: Date
}

export function getNextFacultyDeadline(
  deadlines: FacultyDeadline[],
  courses: FacultyCourse[],
  from = new Date(),
): NextFacultyDeadline | null {
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const candidates = deadlines.flatMap((deadline) => {
    const course = courseById.get(deadline.courseId)
    const dueAt = new Date(`${deadline.date}T${deadline.time}:00`)
    if (deadline.status !== 'pendente' || !course || Number.isNaN(dueAt.getTime()) || dueAt < from) return []
    return [{ deadline, course, dueAt }]
  })

  candidates.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
  return candidates[0] ?? null
}

export interface FacultyCourseMargin {
  course: FacultyCourse
  margin: number
  progress: FacultyGradeProgress
}

export function getLowestFacultyCourseMargin(
  courses: FacultyCourse[],
  assessments: FacultyAssessment[],
): FacultyCourseMargin | null {
  const candidates = courses.flatMap((course) => {
    const progress = calculateFacultyGradeProgress(
      assessments.filter((assessment) => assessment.courseId === course.id),
      course.passingAverage,
    )
    if (progress.currentAverage === null) return []
    return [{ course, progress, margin: progress.currentAverage - course.passingAverage }]
  })
  candidates.sort((a, b) => a.margin - b.margin)
  return candidates[0] ?? null
}

export function calculateFacultyGradeProgress(
  assessments: FacultyAssessment[],
  passingAverage: number,
): FacultyGradeProgress {
  if (!Number.isFinite(passingAverage) || passingAverage < 0 || passingAverage > 100) {
    throw new RangeError('A média mínima deve estar entre 0 e 100.')
  }

  for (const assessment of assessments) {
    if (!Number.isFinite(assessment.weight) || assessment.weight <= 0) {
      throw new RangeError('O peso de cada avaliação deve ser maior que zero.')
    }
    if (
      assessment.grade !== undefined &&
      (!Number.isFinite(assessment.grade) || assessment.grade < 0 || assessment.grade > 100)
    ) {
      throw new RangeError('A nota de cada avaliação deve estar entre 0 e 100.')
    }
  }

  const totalWeight = assessments.reduce((sum, assessment) => sum + assessment.weight, 0)
  if (totalWeight === 0) {
    return {
      status: 'no-assessments',
      currentAverage: null,
      pointsGuaranteed: 0,
      remainingWeight: 0,
      requiredAverage: null,
      recoveryScoreNeeded: null,
      recoveryAtBestPossible: false,
    }
  }

  const graded = assessments.filter((assessment) => assessment.grade !== undefined)
  const gradedWeight = graded.reduce((sum, assessment) => sum + assessment.weight, 0)
  const earnedPoints = graded.reduce(
    (sum, assessment) => sum + assessment.grade! * assessment.weight,
    0,
  )
  const remainingWeight = totalWeight - gradedWeight
  const currentAverage = gradedWeight > 0 ? earnedPoints / gradedWeight : null
  const pointsGuaranteed = earnedPoints / totalWeight

  if (pointsGuaranteed >= passingAverage) {
    return {
      status: 'passed',
      currentAverage,
      pointsGuaranteed,
      remainingWeight,
      requiredAverage: null,
      recoveryScoreNeeded: null,
      recoveryAtBestPossible: false,
    }
  }

  if (remainingWeight > 0) {
    const requiredAverage = (passingAverage * totalWeight - earnedPoints) / remainingWeight
    if (requiredAverage <= 100) {
      return {
        status: 'in-progress',
        currentAverage,
        pointsGuaranteed,
        remainingWeight,
        requiredAverage,
        recoveryScoreNeeded: null,
        recoveryAtBestPossible: false,
      }
    }

    const bestPossibleAverage = (earnedPoints + remainingWeight * 100) / totalWeight
    const recoveryScoreNeeded = 2 * passingAverage - bestPossibleAverage
    return {
      status: recoveryScoreNeeded <= 100 ? 'recovery-needed' : 'impossible',
      currentAverage,
      pointsGuaranteed,
      remainingWeight,
      requiredAverage,
      recoveryScoreNeeded: recoveryScoreNeeded <= 100 ? recoveryScoreNeeded : null,
      recoveryAtBestPossible: recoveryScoreNeeded <= 100,
    }
  }

  const recoveryScoreNeeded = 2 * passingAverage - (currentAverage ?? 0)
  return {
    status: recoveryScoreNeeded <= 100 ? 'recovery-needed' : 'impossible',
    currentAverage,
    pointsGuaranteed,
    remainingWeight,
    requiredAverage: null,
    recoveryScoreNeeded: recoveryScoreNeeded <= 100 ? recoveryScoreNeeded : null,
    recoveryAtBestPossible: false,
  }
}
