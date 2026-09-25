// Row types mirroring supabase/migrations/0001_init.sql. Keep in sync with docs/CONTRACT.md.

export type BotShape =
  | 'clover' | 'flower' | 'star' | 'ghost' | 'mech' | 'circle' | 'hexagon' | 'square' | 'triangle'
  | 'blob' | 'drop' | 'droid' | 'alien' | 'cat' | 'cloud' | 'pill' | 'pebble' | 'puddle'

export interface Profile {
  id: string
  display_name: string | null
  webhook_token: string
  created_at: string
}

export interface Teammate {
  id: string
  owner_id: string
  name: string
  handle: string
  role: string
  bio: string
  system_prompt: string
  model: string
  allowed_toolkits: string[]
  avatar_shape: BotShape
  color: string
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  owner_id: string
  name: string
  description: string
  repo_url: string | null
  color: string
  created_at: string
  updated_at: string
}

export interface ProjectMember {
  project_id: string
  teammate_id: string
  owner_id: string
  added_at: string
}

export interface Thread {
  id: string // 'dm:<teammate_id>' | 'proj:<project_id>'
  owner_id: string
  kind: 'dm' | 'project'
  teammate_id: string | null
  project_id: string | null
  last_message_at: string | null
  last_read_at: string
  created_at: string
}

export type MessageKind = 'text' | 'approval' | 'handoff' | 'error' | 'event' | 'question' | 'connect'

export interface Message {
  id: string
  thread_id: string
  owner_id: string
  sender_type: 'user' | 'teammate' | 'system'
  teammate_id: string | null
  text: string
  mentions: string[]
  reply_to?: string | null
  kind: MessageKind
  meta: {
    stream_id?: string
    tool_calls?: { name: string; status: string }[]
    approval_id?: string
    to_teammate_id?: string
    note?: string
    event_id?: string
    event_type?: string
    attachments?: Attachment[]
    /** question cards */
    question?: string
    options?: string[]
    allow_other?: boolean
    /** connect cards */
    toolkit?: string
    name?: string
    reason?: string
    [k: string]: unknown
  }
  proactive: boolean
  run_id: string | null
  created_at: string
}

export type RunStatus = 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled'

export interface Run {
  id: string
  owner_id: string
  thread_id: string
  teammate_id: string | null
  trigger: 'message' | 'event' | 'schedule' | 'approval'
  status: RunStatus
  error: string | null
  handoffs: number
  started_at: string
  ended_at: string | null
}

/** A file the user attached; stored in the private `attachments` bucket at `path`. */
export interface Attachment { path: string; name: string; mime: string; size: number; width?: number; height?: number }

export interface Approval {
  id: string
  /** approval: act tools. question: ask_user options. connect: connect_app. */
  kind: 'approval' | 'question' | 'connect'
  answer: string | null
  owner_id: string
  thread_id: string
  teammate_id: string | null
  run_id: string | null
  message_id: string | null
  tool_name: string
  toolkit: string | null
  title: string
  draft: Record<string, unknown>
  final_args: Record<string, unknown> | null
  note: string | null
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decided_at: string | null
  created_at: string
}

export type ActivityType =
  | 'run_start' | 'run_end' | 'tool_call' | 'handoff' | 'approval_request' | 'approval_decision'
  | 'memory_write' | 'sandbox' | 'subagent' | 'compaction' | 'event' | 'error'

export interface Activity {
  id: string
  owner_id: string
  run_id: string | null
  thread_id: string | null
  teammate_id: string | null
  type: ActivityType
  name: string
  input: unknown
  output: unknown
  status: 'ok' | 'error' | 'pending'
  duration_ms: number | null
  created_at: string
}

export interface EventRule {
  id: string
  owner_id: string
  name: string
  event_type: string
  match: Record<string, unknown>
  project_id: string | null
  teammate_id: string
  instructions: string
  enabled: boolean
  max_per_hour: number
  created_at: string
}

export interface TubelightEvent {
  id: string
  owner_id: string
  type: string
  source: string
  payload: Record<string, unknown>
  rule_id: string | null
  run_id: string | null
  status: 'received' | 'routed' | 'ignored' | 'rate_limited' | 'error'
  created_at: string
}

/** Broadcast payloads on the private `thread:<id>` channel. */
export type LiveState = 'thinking' | 'tool' | 'writing' | 'waiting' | 'idle'
export interface StatusEvent { run_id: string; teammate_id: string; state: LiveState; label?: string }
export interface DeltaEvent { run_id: string; teammate_id: string; stream_id: string; text: string }
export interface DoneEvent { run_id: string; teammate_id: string; stream_id: string }

export const threadIdFor = {
  dm: (teammateId: string) => `dm:${teammateId}`,
  project: (projectId: string) => `proj:${projectId}`,
}
