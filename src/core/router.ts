// Deterministic intent routing. Clear commands never need a model; everything
// else goes to the brain. (PRD §15.8: bypass generative reasoning when the
// request is unambiguous.)

export type AgentName = 'codex' | 'claude'

export type Intent =
  | { type: 'chat'; text: string }
  | { type: 'delegate'; agent: AgentName; model?: string; prompt: string; project?: string }
  | { type: 'open'; target: string }
  | { type: 'resume'; project?: string }
  | { type: 'end-session'; project?: string }
  | { type: 'remember'; text: string; kind: 'idea' | 'fact'; private: boolean }
  | { type: 'status' }
  | { type: 'brief' }
  | { type: 'stop-task'; agent?: AgentName }
  | { type: 'stop-speech' }
  | { type: 'switch-brain'; provider: 'codex' | 'claude' | 'local' }
  | { type: 'new-conversation' }
  | { type: 'relay'; url: string; note?: string }
  | { type: 'mail'; text: string }
  | { type: 'agenda'; text: string }
  | { type: 'research'; query: string }
  | { type: 'web-search'; query: string }
  /** A team of parallel agents (Ultra). */
  | { type: 'swarm'; goal: string; count?: number }
  /** Save a screenshot to the gallery. */
  | { type: 'screenshot' }
  /** Something to do on the Mac: open or quit apps, arrange windows. */
  | { type: 'mac'; text: string }

const AGENT_WORDS: Record<string, { agent: AgentName; model?: string }> = {
  codex: { agent: 'codex' },
  gpt: { agent: 'codex' },
  astra: { agent: 'codex', model: 'gpt-6-astra' },
  sol: { agent: 'codex', model: 'gpt-6-sol' },
  claude: { agent: 'claude' },
  opus: { agent: 'claude', model: 'opus' },
  sonnet: { agent: 'claude', model: 'sonnet' }
}

const WAKE = /^(?:(?:hey|hay|ok|okay|yo)\s+)?(?:vesper|bluevis)[,.!:]?\s*/i

export function stripWake(text: string): string {
  return text.replace(WAKE, '').trim()
}

/** Pull a trailing "in/on/for <project>" out of a delegated prompt when it names a known project. */
function splitProject(prompt: string, projects: string[]): { prompt: string; project?: string } {
  for (const p of projects) {
    const re = new RegExp(`\\s+(?:in|on|for)\\s+(?:the\\s+)?${escape(p)}(?:\\s+(?:project|repo))?\\s*[.?!]?$`, 'i')
    if (re.test(prompt)) return { prompt: prompt.replace(re, '').trim(), project: p }
  }
  const named = projects.find((p) => new RegExp(`\\b${escape(p)}\\b`, 'i').test(prompt))
  return { prompt, project: named }
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function route(raw: string, projects: string[] = []): Intent {
  const text = stripWake(raw)
  const lower = text.toLowerCase().replace(/[.!?]+$/, '').trim()

  // Any Devpost link starts a hackathon relay; the rest of the message becomes the note.
  const devpost = text.match(/https?:\/\/[a-z0-9-]+\.devpost\.com\S*/i)
  if (devpost) {
    const note = text
      .replace(devpost[0], '')
      .replace(/^(please\s+)?(brainstorm|relay|run (a |the )?(hackathon )?relay|ideas?|plan)\s*(on|for|about)?\s*(this)?[:,.]?\s*/i, '')
      .trim()
    return { type: 'relay', url: devpost[0].replace(/[).,]+$/, ''), note: note || undefined }
  }

  if (/^(stop|shh+|quiet|shut up|stop talking|be quiet|enough)$/.test(lower)) return { type: 'stop-speech' }

  const stop = lower.match(/^(?:stop|cancel|kill|abort)\s+(?:the\s+)?(codex|claude|agent|task)s?\b/)
  if (stop) return { type: 'stop-task', agent: stop[1] === 'codex' || stop[1] === 'claude' ? stop[1] : undefined }

  const sw = lower.match(/^(?:switch to|use)\s+(codex|gpt|claude|qwen|local|the local model)(?:\s+(?:for chat|as (?:the )?brain))?$/)
  if (sw) return { type: 'switch-brain', provider: sw[1] === 'claude' ? 'claude' : sw[1] === 'qwen' || sw[1].includes('local') ? 'local' : 'codex' }

  if (/^(new (conversation|chat)|start over|fresh (context|start))$/.test(lower)) return { type: 'new-conversation' }

  const del = text.match(/^(?:please\s+)?(?:have|ask|let|get|tell|send)\s+(codex|gpt|astra|sol|claude|opus|sonnet)\s+(?:to\s+)?(.+)$/i)
  if (del) {
    const who = AGENT_WORDS[del[1].toLowerCase()]
    const { prompt, project } = splitProject(del[2].trim(), projects)
    return { type: 'delegate', agent: who.agent, model: who.model, prompt, project }
  }
  const prefix = text.match(/^(codex|claude)\s*[:,]\s*(.+)$/i)
  if (prefix) {
    const { prompt, project } = splitProject(prefix[2].trim(), projects)
    return { type: 'delegate', agent: prefix[1].toLowerCase() as AgentName, prompt, project }
  }

  if (/^(?:good morning|(?:give me )?(?:my |the |a )?(?:morning |daily )?brief(?:ing)?(?: me)?|brief me|what'?s my day(?: look(?:ing)? like)?|how'?s my day looking)[.!?]*$/.test(lower)) return { type: 'brief' }

  if (/^(status|what'?s running|what(?:'s| is) (?:the agent|codex|claude) doing|agent status|what are the agents doing)$/.test(lower)) {
    return { type: 'status' }
  }

  const resume = lower.match(/^(?:where (?:did i|did we|were we)(?: leave off)?|resume|pick up where i left off|catch me up)(?:\s+(?:on|with)\s+(.+))?$/)
  if (resume) return { type: 'resume', project: resume[1] ? matchProject(resume[1], projects) ?? resume[1] : undefined }

  const end = lower.match(/^(?:i'?m done|done for (?:today|tonight|now)|that'?s it for (?:today|tonight)|end (?:the )?session)(?:\s+(?:with|on)\s+(.+?))?(?:\s+for (?:today|tonight|now))?$/)
  if (end) return { type: 'end-session', project: end[1] ? matchProject(end[1], projects) ?? end[1] : undefined }

  if (/^(?:(?:take|grab|save)\s+(?:a\s+)?)?(?:screenshot|screen\s?shot|screen\s?grab)(?:\s+(?:this|that|now|of (?:this|that|my screen)))?(?:,?\s+please)?[.!]*$|^(?:remember|save|capture)\s+(?:this|that|this screen|my screen)[.!]*$/i.test(text))
    return { type: 'screenshot' }

  const idea = text.match(/^(?:save|keep|log)\s+(?:that|this)?\s*(?:as an? idea)[:,.]?\s*(.*)$/i)
  if (idea) return { type: 'remember', text: idea[1].trim(), kind: 'idea', private: false }
  const rem = text.match(/^(?:remember|note)(?:\s+that)?[:,]?\s+(.+)$/i)
  if (rem) {
    const priv = /\b(keep (?:it|this|that) (?:private|local)|out of (?:cloud|agent)[- ]?(?:agent )?handoffs?)\b/i.test(rem[1])
    const body = rem[1].replace(/[,;]?\s*(?:but\s+)?keep (?:it|this|that) (?:private|local|out of (?:cloud|agent)[- ]?(?:agent )?handoffs?)\.?$/i, '').trim()
    return { type: 'remember', text: body, kind: 'fact', private: priv }
  }

  const team = text.match(/^(?:please\s+)?(?:launch|spawn|start|spin up|create|get|use)\s+(?:a\s+team\s+of\s+)?(\d+|two|three|four|five|six|a few|some)?\s*(?:parallel\s+)?(?:sub-?agents?|agents?)\b[\s,:]*(?:to|that|who|which|and|for)?\s*(.+)$/i)
  if (team) {
    const n = { two: 2, three: 3, four: 4, five: 5, six: 6 }[team[1]?.toLowerCase() as 'two'] ?? (Number(team[1]) || undefined)
    return { type: 'swarm', goal: team[2].trim(), count: n ? Math.min(6, Math.max(2, n)) : undefined }
  }
  const research = text.match(/^(?:please\s+)?(?:(?:deep\s+)?research|look into|dig into)\s*[:,]?\s+(.+)$/i)
  if (research) return { type: 'research', query: research[1].trim() }
  const web = text.match(/^(?:search|google|look up)\s*(?:the web|google|online)?\s*[:,]?\s*(?:for\s+)?(.+)$/i)
  if (web && !/\b(my (?:notes|vault|memory)|in (?:my )?(?:notes|vault|memory))\b/i.test(web[1])) return { type: 'web-search', query: web[1].trim() }

  // Questions about email go to Claude with read-only Gmail tools.
  if (/\b(e-?mails?|inbox|gmail|mailbox|OAs?|online assessments?|hackerrank|codesignal|recruiters?|interview (?:invites?|requests?)|rejections?|offers? letters?)\b/i.test(text) && !/^(remember|note|save)\b/i.test(lower)) {
    return { type: 'mail', text }
  }

  if (/\b(calendar|schedule|agenda|what'?s (on|coming up|today|tomorrow)|due (today|tomorrow|this week|soon)|deadlines?|assignments?|homework|canvas|grades?|announcements?|submitted|quiz(?:zes)?|missing work|class(es)? (today|tomorrow)|free (today|tomorrow|this))\b/i.test(text) && !/^(remember|note|save)\b/i.test(lower)) {
    return { type: 'agenda', text }
  }

  const open = lower.match(/^(?:open|pull up|show me|go to)\s+(?:the\s+)?(.+?)(?:\s+(?:project|repo|folder))?$/)
  if (open) {
    const target = matchProject(open[1], projects)
    if (target) return { type: 'open', target }
  }
  if (/^(?:please\s+)?(?:open|launch|start up|quit|close|arrange|split|tile|snap|put|move|maximi[sz]e|full ?screen)\b/.test(lower)) return { type: 'mac', text }

  return { type: 'chat', text }
}

export function matchProject(fragment: string, projects: string[]): string | undefined {
  const f = fragment.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  if (!f) return undefined
  const exact = projects.find((p) => p.toLowerCase() === f)
  if (exact) return exact
  return projects.find((p) => {
    const pl = p.toLowerCase()
    return pl.startsWith(f) || f.startsWith(pl) || pl.split(/[\s-_]+/)[0] === f.split(' ')[0]
  })
}

/**
 * Does answering this need Anuj's vault? General questions ("best AI news",
 * "what is a pointer") get only a tiny identity line; questions about Anuj,
 * his projects, schedule, work or past decisions pull from memory.
 */
export function needsMemory(text: string, projects: string[] = []): boolean {
  const t = text.toLowerCase()
  if (/\b(i|i'm|im|i've|ive|i'd|my|mine|myself|we|we're|our|anuj)\b|\babout me\b/.test(t)) return true
  if (/\b(remember|remind|decided|decision|last time|yesterday|earlier|again|schedule|calendar|deadline|due|assignment|class|course|exam|internship|job|resume|application|recruit|manager|coworker|team)\b/.test(t)) return true
  return projects.some((p) => t.includes(p.toLowerCase()))
}
