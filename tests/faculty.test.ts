import { describe, expect, it } from 'vitest'
import { calculateFacultyGradeProgress, type FacultyAssessment } from '../src/lib/faculty'

const assessments = (...values: Array<[number, number?]>): FacultyAssessment[] =>
  values.map(([weight, grade], index) => ({
    id: `assessment-${index}`,
    courseId: 'course-1',
    name: `Avaliação ${index + 1}`,
    weight,
    ...(grade === undefined ? {} : { grade }),
  }))

describe('calculateFacultyGradeProgress', () => {
  it('shows the remaining target when no grades have been entered', () => {
    const result = calculateFacultyGradeProgress(assessments([40], [60]), 60)

    expect(result.status).toBe('in-progress')
    expect(result.currentAverage).toBeNull()
    expect(result.pointsGuaranteed).toBe(0)
    expect(result.requiredAverage).toBe(60)
  })

  it('calculates current average, guaranteed points, and required remaining score', () => {
    const result = calculateFacultyGradeProgress(assessments([40, 70], [60]), 60)

    expect(result.currentAverage).toBe(70)
    expect(result.pointsGuaranteed).toBe(28)
    expect(result.requiredAverage).toBeCloseTo(53.333333)
  })

  it('reports passed when guaranteed points already meet the minimum', () => {
    const result = calculateFacultyGradeProgress(assessments([70, 90], [30]), 60)

    expect(result.status).toBe('passed')
    expect(result.pointsGuaranteed).toBe(63)
    expect(result.requiredAverage).toBeNull()
  })

  it('reports impossible when neither remaining assessments nor recovery can reach the minimum', () => {
    const result = calculateFacultyGradeProgress(assessments([90, 0], [10]), 60)

    expect(result.status).toBe('impossible')
    expect(result.requiredAverage).toBeGreaterThan(100)
    expect(result.recoveryScoreNeeded).toBeNull()
  })

  it('calculates the recovery exam score using the approved IFES formula', () => {
    const result = calculateFacultyGradeProgress(assessments([100, 50]), 60)

    expect(result.status).toBe('recovery-needed')
    expect(result.recoveryScoreNeeded).toBe(70)
  })
})
