// Hackathon mode: a relay plan turned into a clock, milestones, judging criteria and a submission kit.

export interface Milestone {
  id: string
  title: string
  /** Hours after the build started when this should be working. */
  hour: number
  done: boolean
  /** Agent task started for this milestone, if any. */
  taskId?: string
}

export interface Criterion {
  id: string
  name: string
  detail: string
  /** What in the project currently answers this criterion, written by Anuj. */
  coveredBy: string
}

export interface SubmissionKit {
  writeup: string
  script: string
  checklist: { text: string; done: boolean }[]
  generatedAt: number
}

export interface Hackathon {
  id: string
  title: string
  url: string
  relayId?: string
  plan: string
  /** The hook the plan chose: the demo moment the script is built around. */
  hook: string
  startedAt: number
  deadline: number
  projectPath?: string
  milestones: Milestone[]
  criteria: Criterion[]
  kit?: SubmissionKit
  active: boolean
}

/** What the model extracts from a plan and the event page. */
export interface PlanExtract {
  deadline: string | null
  hook: string
  milestones: { hour: number; title: string }[]
  criteria: { name: string; detail: string }[]
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deadline', 'hook', 'milestones', 'criteria'],
  properties: {
    deadline: { type: ['string', 'null'], description: 'Submission deadline as ISO 8601 with offset, only if the page states it' },
    hook: { type: 'string', description: 'The emotional hook / demo moment the plan chose, one or two sentences' },
    milestones: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['hour', 'title'], properties: { hour: { type: 'number' }, title: { type: 'string' } } }
    },
    criteria: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'detail'], properties: { name: { type: 'string' }, detail: { type: 'string' } } }
    }
  }
}

export function extractPrompt(plan: string, page: string): string {
  return `Extract structured data from a hackathon plan and its event page. Return only JSON matching this shape:
{"deadline": ISO string or null, "hook": string, "milestones": [{"hour": number, "title": string}], "criteria": [{"name": string, "detail": string}]}

- deadline: the submission deadline stated on the page, as ISO 8601 with a UTC offset. null if not stated. Do not guess.
- hook: the emotional hook or demo moment the plan settles on.
- milestones: the plan's build plan as 4 to 10 checkpoints. hour = hours after building starts when the checkpoint should be working (use the plan's own timing; spread evenly if it gives none). Titles are short and concrete ("Camera to caption working end to end").
- criteria: the judging criteria and targeted prizes, each with a one-line detail of what judges look for. Use the page's words.

<plan>
${plan}
</plan>

<event_page>
${page.slice(0, 12000)}
</event_page>`
}

/** Pull the first JSON object out of a model reply (fenced or bare). */
export function parseExtract(text: string): PlanExtract | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/)
  if (!m) return null
  try {
    const d = JSON.parse(m[1])
    if (!Array.isArray(d.milestones) || !Array.isArray(d.criteria)) return null
    return {
      deadline: typeof d.deadline === 'string' ? d.deadline : null,
      hook: String(d.hook ?? ''),
      milestones: d.milestones.filter((x: { hour?: unknown; title?: unknown }) => typeof x.hour === 'number' && typeof x.title === 'string'),
      criteria: d.criteria.filter((x: { name?: unknown }) => typeof x.name === 'string').map((x: { name: string; detail?: string }) => ({ name: x.name, detail: x.detail ?? '' }))
    }
  } catch {
    return null
  }
}

export interface HackStatus {
  left: number
  /** 0 at the start of the build, 1 at the deadline. */
  progress: number
  behind: Milestone[]
  next?: Milestone
}

export function hackStatus(h: Hackathon, now: number): HackStatus {
  const due = (m: Milestone) => h.startedAt + m.hour * 3600_000
  const open = h.milestones.filter((m) => !m.done).sort((a, b) => a.hour - b.hour)
  const span = Math.max(1, h.deadline - h.startedAt)
  return {
    left: h.deadline - now,
    progress: Math.min(1, Math.max(0, (now - h.startedAt) / span)),
    behind: open.filter((m) => due(m) < now),
    next: open.find((m) => due(m) >= now)
  }
}

export function formatLeft(ms: number): string {
  if (ms <= 0) return 'past deadline'
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return h >= 48 ? `${Math.round(h / 24)}d left` : `${h}:${String(m).padStart(2, '0')} left`
}

/** One line for the brain's situation block. */
export function hackLine(h: Hackathon, now: number): string {
  const s = hackStatus(h, now)
  const hour = Math.floor((now - h.startedAt) / 3600_000)
  return [
    `Hackathon mode: ${h.title}, hour ${hour}, ${formatLeft(s.left)} until submission.`,
    s.behind.length ? `Behind on: ${s.behind.map((m) => `${m.title} (due hour ${m.hour})`).join('; ')}.` : 'On schedule.',
    s.next ? `Next checkpoint: ${s.next.title} by hour ${s.next.hour}.` : '',
    h.projectPath ? `Project folder: ${h.projectPath}.` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'hackathon'
  )
}
