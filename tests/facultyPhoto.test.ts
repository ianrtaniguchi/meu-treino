import { describe, expect, it } from 'vitest'
import { validateFacultyScheduleAnalysis } from '../src/lib/facultyPhoto'

describe('validateFacultyScheduleAnalysis', () => {
  it('normalizes Portuguese weekdays and leaves uncertain values editable', () => {
    const result = validateFacultyScheduleAnalysis(
      {
        aulas: [
          {
            disciplina: ' Cálculo II ',
            dia: 'terça-feira',
            inicio: '08:00',
            fim: '10:00',
            sala: 'A-101',
            professor: null,
          },
          { disciplina: '', dia: 'dia ilegível', inicio: '', fim: '', sala: '', professor: '' },
        ],
      },
      () => 'draft-id',
    )

    expect(result).toEqual([
      {
        id: 'draft-id',
        courseName: 'Cálculo II',
        dayOfWeek: 2,
        startTime: '08:00',
        endTime: '10:00',
        room: 'A-101',
        professor: '',
      },
      {
        id: 'draft-id',
        courseName: '',
        dayOfWeek: null,
        startTime: '',
        endTime: '',
        room: '',
        professor: '',
      },
    ])
  })

  it('rejects malformed or oversized responses instead of dropping entries', () => {
    expect(() => validateFacultyScheduleAnalysis({ aulas: ['não é uma aula'] })).toThrow()
    expect(() => validateFacultyScheduleAnalysis({ aulas: Array(81).fill({}) })).toThrow('aulas demais')
  })
})
