import { describe, expect, it } from 'vitest'
import { formatAnnouncements, formatGrades, formatPlanner, nextLink } from '../src/core/canvas'

const now = Date.parse('2026-09-25T16:00:00Z')

describe('canvas', () => {
  it('lists due work in order with submission state', () => {
    const out = formatPlanner(
      [
        { plannable_type: 'assignment', plannable_date: '2026-09-28T03:59:00Z', plannable: { title: 'HW 3', points_possible: 20 }, context_name: 'Data Structures', submissions: { submitted: false } },
        { plannable_type: 'assignment', plannable_date: '2026-09-24T03:59:00Z', plannable: { title: 'HW 2' }, context_name: 'Data Structures', submissions: { submitted: false } },
        { plannable_type: 'quiz', plannable_date: '2026-09-26T14:00:00Z', plannable: { title: 'Quiz 1' }, context_name: 'Calc', submissions: { submitted: true, graded: true } },
        { plannable_type: 'announcement', plannable_date: '2026-09-25T14:00:00Z', plannable: { title: 'Welcome' } }
      ],
      now
    )
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('HW 2')
    expect(lines[0]).toContain('NOT SUBMITTED, past due')
    expect(lines[1]).toContain('Quiz 1 [Calc] · graded')
    expect(lines[2]).toContain('HW 3 [Data Structures, 20 pts] · not submitted')
  })

  it('formats grades and announcements', () => {
    const courses = [{ id: 7, name: 'Calc', enrollments: [{ computed_current_score: 91.2, computed_current_grade: 'A' }] }, { id: 8, name: 'Art', enrollments: [{ computed_current_score: null }] }]
    expect(formatGrades(courses)).toBe('- Calc: 91.2% (A)')
    expect(formatAnnouncements([{ title: 'Exam moved', posted_at: '2026-09-24T12:00:00Z', context_code: 'course_7', message: '<p>Now&nbsp;Friday</p>' }], courses)).toContain('Calc · Exam moved: Now Friday')
  })

  it('follows pagination links', () => {
    expect(nextLink('<https://x/api/v1/a?page=2>; rel="next", <https://x/api/v1/a?page=9>; rel="last"')).toBe('https://x/api/v1/a?page=2')
    expect(nextLink('<https://x/api/v1/a?page=9>; rel="last"')).toBeNull()
  })
})
