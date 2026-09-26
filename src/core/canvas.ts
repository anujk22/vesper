// Canvas LMS: turn API responses into a compact, dated brief for the model.

export interface PlannerItem {
  context_name?: string
  plannable_type: string
  plannable_date?: string
  plannable?: { title?: string; due_at?: string; points_possible?: number }
  submissions?: false | { submitted?: boolean; excused?: boolean; graded?: boolean; late?: boolean; missing?: boolean; has_feedback?: boolean }
  html_url?: string
}

export interface CanvasCourse {
  id: number
  name: string
  course_code?: string
  enrollments?: { computed_current_score?: number | null; computed_current_grade?: string | null }[]
}

export interface CanvasAnnouncement {
  title: string
  posted_at: string
  context_code: string
  message?: string
}

function when(iso: string, tz: string) {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function state(i: PlannerItem, now: number): string {
  const s = i.submissions
  if (!s) return ''
  if (s.excused) return 'excused'
  if (s.graded) return s.has_feedback ? 'graded, has feedback' : 'graded'
  if (s.submitted) return s.late ? 'submitted late' : 'submitted'
  if (s.missing || (i.plannable_date && Date.parse(i.plannable_date) < now)) return 'NOT SUBMITTED, past due'
  return 'not submitted'
}

/** Assignments, quizzes and discussions with a due date, oldest first, each with its submission state. */
export function formatPlanner(items: PlannerItem[], now: number, tz = 'America/New_York'): string {
  const work = items
    .filter((i) => i.plannable_type !== 'announcement' && i.plannable_date)
    .sort((a, b) => Date.parse(a.plannable_date!) - Date.parse(b.plannable_date!))
  if (!work.length) return '(Nothing due in this window.)'
  return work
    .map((i) => {
      const pts = i.plannable?.points_possible ? `, ${i.plannable.points_possible} pts` : ''
      const st = state(i, now)
      return `- ${when(i.plannable_date!, tz)} · ${i.plannable?.title ?? 'Untitled'} [${i.context_name ?? 'course'}${pts}]${st ? ` · ${st}` : ''}`
    })
    .join('\n')
}

export function formatGrades(courses: CanvasCourse[]): string {
  const rows = courses
    .map((c) => {
      const e = c.enrollments?.[0]
      if (e?.computed_current_score == null) return null
      return `- ${c.name}: ${e.computed_current_score}%${e.computed_current_grade ? ` (${e.computed_current_grade})` : ''}`
    })
    .filter(Boolean)
  return rows.length ? rows.join('\n') : '(No current grades published.)'
}

export function formatAnnouncements(list: CanvasAnnouncement[], courses: CanvasCourse[], tz = 'America/New_York'): string {
  if (!list.length) return '(No announcements in the last week.)'
  const name = (code: string) => courses.find((c) => `course_${c.id}` === code)?.name ?? code
  return list
    .slice(0, 12)
    .map((a) => {
      const body = (a.message ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      return `- ${when(a.posted_at, tz)} · ${name(a.context_code)} · ${a.title}${body ? `: ${body.slice(0, 280)}${body.length > 280 ? '…' : ''}` : ''}`
    })
    .join('\n')
}

/** The next page URL from a Canvas `Link` header, if any. */
export function nextLink(link: string | null): string | null {
  return link?.split(',').find((p) => /rel="next"/.test(p))?.match(/<([^>]+)>/)?.[1] ?? null
}
