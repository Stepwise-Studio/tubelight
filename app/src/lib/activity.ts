// Turns `activity` rows into the sentences the Activity tab and profiles show.
import { toolkitName } from '@/lib/catalog'
import type { Activity } from '@/lib/types'

export type ActivityFilter = 'all' | 'tools' | 'handoffs' | 'approvals' | 'events' | 'errors'

/** Row types each filter shows. `errors` also matches any row with status "error". */
export const FILTER_TYPES: Record<Exclude<ActivityFilter, 'errors'>, Activity['type'][]> = {
  all: ['tool_call', 'sandbox', 'subagent', 'memory_write', 'handoff', 'approval_request', 'approval_decision', 'event', 'error', 'compaction'],
  tools: ['tool_call', 'sandbox', 'subagent', 'memory_write'],
  handoffs: ['handoff'],
  approvals: ['approval_request', 'approval_decision'],
  events: ['event'],
}

/** Tool calls the service logs twice (a dedicated row type says it better). */
const HIDDEN_TOOLS = new Set(['remember', 'handoff_to', 'spawn_helper'])

export const isShown = (a: Activity) => !(a.type === 'tool_call' && HIDDEN_TOOLS.has(a.name))

export function matchesFilter(a: Activity, f: ActivityFilter) {
  if (!isShown(a)) return false
  if (f === 'errors') return a.type === 'error' || a.status === 'error'
  return FILTER_TYPES[f].includes(a.type)
}

const PAST: Record<string, string> = {
  list: 'listed', search: 'searched', get: 'fetched', fetch: 'fetched', find: 'found', read: 'read', create: 'created',
  send: 'sent', update: 'updated', delete: 'deleted', add: 'added', remove: 'removed', post: 'posted', reply: 'replied to',
  star: 'starred', merge: 'merged', close: 'closed', comment: 'commented on', move: 'moved', archive: 'archived',
  query: 'queried', retrieve: 'fetched', append: 'added to', patch: 'updated', forward: 'forwarded', modify: 'updated',
}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})

/** GITHUB_LIST_REPOSITORY_ISSUES → { app: "GitHub", verb: "list", rest: "repository issues" } */
function splitSlug(slug: string) {
  const [tk, verb = '', ...rest] = slug.split('_')
  return { app: toolkitName(tk), verb: verb.toLowerCase(), rest: rest.join(' ').toLowerCase() }
}

/** The app tool actually called: the first inner tool of a Composio multi-execute call. */
export function innerSlug(a: Pick<Activity, 'name' | 'input'>) {
  if (a.name !== 'COMPOSIO_MULTI_EXECUTE_TOOL') return a.name
  const tools = obj(a.input).tools
  const first = Array.isArray(tools) ? obj(tools[0]) : {}
  return (first.tool_slug as string) ?? a.name
}

function toolSentence(slug: string) {
  const { app, verb, rest } = splitSlug(slug)
  if (!rest && !PAST[verb]) return `used ${app}`
  return PAST[verb] ? `${PAST[verb]} ${app} ${rest}`.trim() : `used ${app}: ${verb} ${rest}`.trim()
}

const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/**
 * A human sentence without the subject: "searched GitHub issues", "handed off to Tess".
 * The row puts the teammate's name in front.
 */
export function describe(a: Activity, nameOf: (id: string | null | undefined) => string | undefined): string {
  const input = obj(a.input)
  switch (a.type) {
    case 'tool_call': {
      if (a.name === 'COMPOSIO_SEARCH_TOOLS') return 'looked for the right app tool'
      if (a.name === 'COMPOSIO_GET_TOOL_SCHEMAS') return 'read how an app tool works'
      if (a.name === 'recall') return 'searched its memory'
      const tools = Array.isArray(input.tools) ? input.tools : []
      const s = toolSentence(innerSlug(a))
      return tools.length > 1 ? `${s} and ${tools.length - 1} more` : s
    }
    case 'sandbox':
      if (a.name === 'run_shell') return `ran ${clip(String(input.cmd ?? 'a command'), 40)}`
      if (a.name === 'read_file') return `read ${clip(String(input.path ?? 'a file'))}`
      if (a.name === 'write_file') return `wrote ${clip(String(input.path ?? 'a file'))}`
      if (a.name === 'git_push') return `pushed to ${input.branch ?? 'a branch'}`
      if (a.name === 'diff') return 'changed files in the sandbox'
      return `used the sandbox: ${a.name}`
    case 'subagent': return `asked a helper to ${clip(String(input.task ?? 'look into something').replace(/^to\s+/i, ''), 60)}`
    case 'memory_write': return `remembered “${clip(String(input.text ?? ''), 60)}”`
    case 'handoff': return `handed off to ${nameOf(input.to as string) ?? '@' + (a.name.split('->')[1] ?? 'a teammate')}`
    case 'approval_request': {
      const { verb, rest, app } = splitSlug(a.name)
      return a.name.includes('_') ? `asked to ${verb} ${rest ? `${rest} on ${app}` : app}` : `asked to run ${a.name}`
    }
    case 'approval_decision': {
      const { verb, rest, app } = splitSlug(a.name)
      return `${input.action === 'reject' ? 'was told no' : 'got the go-ahead'} to ${verb} ${rest ? `${rest} on ${app}` : app}`
    }
    case 'event':
      if (a.name === 'email_ignored') return 'skipped an email as low priority'
      return `picked up ${/^[aeiou]/i.test(a.name) ? 'an' : 'a'} ${a.name.replace(/_/g, ' ')} event`
    case 'error': return a.name === 'compaction' ? 'couldn’t summarise a long chat' : 'ran into an error'
    case 'compaction': return 'condensed a long conversation'
    case 'run_start': return 'started working'
    case 'run_end': return a.name === 'error' ? 'stopped with an error' : a.name === 'cancelled' ? 'was stopped' : 'finished'
  }
}

/** "820 ms", "4.2 s", "1 min 3 s" */
export function durationLabel(ms: number | null) {
  if (ms == null) return null
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}
