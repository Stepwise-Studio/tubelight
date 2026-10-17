import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import AsyncStorage from '@react-native-async-storage/async-storage'

import { onReturn } from './app-state'
import * as outbox from './outbox'
import { liveChannel } from './realtime'
import { supabase } from '@/lib/supabase'
import type { Approval, Message, Project, ProjectMember, Run, Teammate, Thread } from '@/lib/types'

export type Preview = Pick<Message, 'id' | 'thread_id' | 'sender_type' | 'teammate_id' | 'text' | 'kind' | 'created_at'>

export interface Workspace {
  loading: boolean
  /** Last load failed (offline, etc.). */
  error: string | null
  /** The crew: teammates without linked computers (those are chats of their own, under Profile → Computers). */
  teammates: Teammate[]
  /** Everyone, computers included: for handle checks and lookups. */
  everyone: Teammate[]
  projects: Project[]
  members: ProjectMember[]
  threads: Thread[]
  pendingApprovals: Approval[]
  /** Runs still going (running or waiting for approval). */
  liveRuns: Run[]
  /** Latest message per thread id. */
  previews: Record<string, Preview>
  refresh: () => Promise<void>
  markRead: (threadId: string) => void
  teammate: (id: string | null | undefined) => Teammate | undefined
  project: (id: string | null | undefined) => Project | undefined
  thread: (id: string | null | undefined) => Thread | undefined
  /** Teammates in a project, in the order they were added. */
  membersOf: (projectId: string) => Teammate[]
  /** Teammates who can act in a thread: the DM teammate, or the project's members. */
  threadTeammates: (threadId: string) => Teammate[]
  threadTitle: (threadId: string) => string
  isWorking: (teammateId: string) => boolean
  isThreadLive: (threadId: string) => boolean
  /** The last refresh couldn't reach Supabase: what's shown is the saved copy. */
  offline: boolean
  chatsWith: (teammateId: string) => Thread[]
  newChat: (teammateId: string) => Promise<string>
  renameChat: (threadId: string, title: string) => Promise<void>
  deleteChat: (threadId: string) => Promise<void>
}

const Ctx = createContext<Workspace | null>(null)
/** A linked computer's own chat stands in as a teammate whose avatar_shape is `device:<computer id>`. */
/** `dm:<teammate>` or `dm:<teammate>:<id>` → the teammate's id. */
export const dmTeammate = (threadId: string) => threadId.split(':')[1]
/** A teammate's extra chat (not the main `dm:<teammate>` one). */
export const isExtraChat = (threadId: string) => threadId.startsWith('dm:') && threadId.split(':').length === 3
/** A chat's name in the chats list. */
export const chatTitle = (t: Pick<Thread, 'id' | 'title'>) => t.title || (isExtraChat(t.id) ? 'New chat' : 'Main chat')

export const isComputer = (t: { avatar_shape: string }) => t.avatar_shape.startsWith('device:')
export const computerId = (t: { avatar_shape: string }) => (isComputer(t) ? t.avatar_shape.slice(7) : null)
/** The phone's own chat (agent phone.py): the only one that does things on the phone; other teammates ask it. */
export const isPhone = (t: { avatar_shape: string }) => t.avatar_shape === 'phone'

/** Teammate lookup alone. Changes only when teammates do, so chat rows don't re-render on every message or run update. */
const TeammatesCtx = createContext<(id: string | null | undefined) => Teammate | undefined>(() => undefined)
export const useTeammate = (id: string | null | undefined) => use(TeammatesCtx)(id)

const LIVE = ['running', 'waiting_approval']

export function WorkspaceProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [teammates, setTeammates] = useState<Teammate[]>([])
  const known = useRef(new Set<string>())
  const [projects, setProjects] = useState<Project[]>([])
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [pendingApprovals, setPending] = useState<Approval[]>([])
  const [liveRuns, setLiveRuns] = useState<Run[]>([])
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [offline, setOffline] = useState(false)
  const loaded = useRef(false)
  const previewsRef = useRef(previews)
  useEffect(() => { previewsRef.current = previews }, [previews])

  const refresh = useCallback(async () => {
    if (!userId) return
    const [t, p, m, th, a, r] = await Promise.all([
      supabase.from('teammates').select('*').order('created_at'),
      supabase.from('projects').select('*').order('created_at'),
      supabase.from('project_members').select('*').order('added_at'),
      supabase.from('threads').select('*'),
      supabase.from('approvals').select('*').eq('status', 'pending').eq('kind', 'approval').order('created_at', { ascending: false }),
      supabase.from('runs').select('*').in('status', LIVE),
    ])
    const failed = [t, p, m, th, a, r].find((x) => x.error)
    if (failed) {
      // Offline with the saved copy (or an earlier load) on screen: keep it, like WhatsApp; say so quietly.
      if (loaded.current) setOffline(true)
      else setError('Unable to load your workspace. Check your connection and pull to refresh.')
      setLoading(false)
      return
    }
    setError(null)
    setOffline(false)
    outbox.flush()
    setTeammates(t.data as Teammate[])
    known.current = new Set((t.data as Teammate[]).map((x) => x.id))
    setProjects(p.data as Project[])
    setMembers(m.data as ProjectMember[])
    setThreads(th.data as Thread[])
    setPending(a.data as Approval[])
    setLiveRuns(r.data as Run[])
    // Show the lists now; last-message previews fill in right after instead of holding the whole inbox.
    loaded.current = true
    setLoading(false)
    // Latest message per thread. ponytail: one query per thread; fine for tens of threads,
    // swap for an RPC / view with DISTINCT ON if a workspace grows to hundreds.
    // Only threads with something newer than the preview we already hold are asked again (a refresh on every return
    // to the app used to cost one request per thread).
    const have = previewsRef.current
    const stale = (th.data as Thread[]).filter((x) => x.last_message_at && !(have[x.id] && Date.parse(have[x.id].created_at) >= Date.parse(x.last_message_at!)))
    const rows = await Promise.all(
      stale.map((x) =>
        supabase.from('messages').select('id,thread_id,sender_type,teammate_id,text,kind,created_at')
          .eq('thread_id', x.id).order('created_at', { ascending: false }).limit(1).maybeSingle()),
    )
    const next: Record<string, Preview> = {}
    for (const x of th.data as Thread[]) if (have[x.id] && x.last_message_at) next[x.id] = have[x.id]
    for (const row of rows) if (row.data) next[row.data.thread_id] = row.data as Preview
    setPreviews(next)
    AsyncStorage.setItem(`tl.ws.${userId}`, JSON.stringify({ t: t.data, p: p.data, m: m.data, th: th.data, a: a.data, previews: next })).catch(() => {})
  }, [userId])

  // The last workspace is kept on the phone: the inbox shows at once on a cold start, and with no connection at all.
  useEffect(() => {
    if (!userId) return
    AsyncStorage.getItem(`tl.ws.${userId}`).then((v) => {
      if (!v || loaded.current) return
      const c = JSON.parse(v)
      setTeammates(c.t); known.current = new Set((c.t as Teammate[]).map((x) => x.id))
      setProjects(c.p); setMembers(c.m); setThreads(c.th); setPending(c.a); setPreviews(c.previews)
      loaded.current = true
      setLoading(false)
    }, () => {})
  }, [userId])

  // Teammates speak in the user's local time: keep the device's time zone in their auth metadata.
  useEffect(() => {
    if (!userId) return
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    supabase.auth.getUser().then(({ data }) => {
      if (timezone && data.user && data.user.user_metadata?.timezone !== timezone) supabase.auth.updateUser({ data: { timezone } })
    }).catch(() => {})
  }, [userId])

  useEffect(() => {
    // The root layout keys this provider by user, so signing out remounts it with empty state.
    if (!userId) return
    // refresh() only sets state after its first await; the rule can't see through the callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()

    // Self-healing (lib/realtime): a rejoin after the channel died catches up on what it missed.
    const live = liveChannel(() => supabase
        .channel(`workspace:${userId}:${Math.random().toString(36).slice(2)}`) // unique: the assistant panel runs a second one
        .on('postgres_changes', { event: '*', schema: 'public', table: 'threads' }, (e) => {
          if (e.eventType === 'DELETE') setThreads((l) => l.filter((x) => x.id !== (e.old as Thread).id))
          else {
            const row = e.new as Thread
            setThreads((l) => (l.some((x) => x.id === row.id) ? l.map((x) => (x.id === row.id ? row : x)) : [...l, row]))
            // Teammates aren't in the realtime feed: a new chat for one we don't know (a linked computer's) reloads them.
            if (row.kind === 'dm' && row.teammate_id && !known.current.has(row.teammate_id)) refresh()
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals' }, (e) => {
          const row = (e.eventType === 'DELETE' ? e.old : e.new) as Approval
          setPending((l) => {
            const rest = l.filter((x) => x.id !== row.id)
            return e.eventType !== 'DELETE' && row.status === 'pending' && row.kind === 'approval' ? [row, ...rest] : rest
          })
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'runs' }, (e) => {
          const row = (e.eventType === 'DELETE' ? e.old : e.new) as Run
          setLiveRuns((l) => {
            const rest = l.filter((x) => x.id !== row.id)
            return e.eventType !== 'DELETE' && LIVE.includes(row.status) ? [...rest, row] : rest
          })
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (e) => {
          const m = e.new as Message
          setPreviews((p) => ({ ...p, [m.thread_id]: m }))
        }), (first) => { if (!first && loaded.current) refresh() })

    // Catch up on anything missed while away (not after a dialog's blip: see onReturn).
    const stop = onReturn(() => { if (loaded.current) refresh() })
    return () => {
      stop()
      live.stop()
    }
  }, [userId, refresh])

  const markRead = useCallback((threadId: string) => {
    const now = new Date().toISOString()
    setThreads((l) => l.map((x) => (x.id === threadId ? { ...x, last_read_at: now } : x)))
    supabase.from('threads').update({ last_read_at: now }).eq('id', threadId).then(() => {})
  }, [])

  const teammate = (id: string | null | undefined) => (id ? teammates.find((t) => t.id === id) : undefined)
  const project = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id) : undefined)
  const thread = (id: string | null | undefined) => (id ? threads.find((t) => t.id === id) : undefined)
  const membersOf = (projectId: string) =>
    members.filter((m) => m.project_id === projectId).map((m) => teammate(m.teammate_id)).filter((t): t is Teammate => !!t)
  const threadTeammates = (threadId: string) => {
    if (threadId.startsWith('dm:')) { const t = teammate(dmTeammate(threadId)); return t ? [t] : [] }
    if (threadId.startsWith('proj:')) return membersOf(threadId.slice(5))
    return []
  }
  const threadTitle = (threadId: string) =>
    threadId.startsWith('dm:') ? teammate(dmTeammate(threadId))?.name ?? 'Teammate'
      : project(threadId.slice(5))?.name ?? 'Project'
  /** Every chat with one teammate, the most recently active first. */
  const chatsWith = (teammateId: string) => threads.filter((t) => t.kind === 'dm' && t.teammate_id === teammateId)
    .sort((a, b) => Date.parse(b.last_message_at ?? b.created_at) - Date.parse(a.last_message_at ?? a.created_at))
  /** A new chat with a teammate, beside the main one. Resolves to its id (or throws). */
  const newChat = async (teammateId: string) => {
    const row: Thread = {
      id: `dm:${teammateId}:${Math.random().toString(36).slice(2, 10)}`, title: null, owner_id: userId!, kind: 'dm',
      teammate_id: teammateId, project_id: null, last_message_at: null, last_read_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('threads').insert(row)
    if (error) throw new Error(error.message)
    setThreads((l) => (l.some((x) => x.id === row.id) ? l : [...l, row]))
    return row.id
  }
  const renameChat = async (threadId: string, title: string) => {
    setThreads((l) => l.map((x) => (x.id === threadId ? { ...x, title: title || null } : x)))
    await supabase.from('threads').update({ title: title || null }).eq('id', threadId)
  }
  /** Extra chats only: the main chat is where calls, automations and the phone post. */
  const deleteChat = async (threadId: string) => {
    if (!isExtraChat(threadId)) return
    setThreads((l) => l.filter((x) => x.id !== threadId))
    await supabase.from('threads').delete().eq('id', threadId)
  }
  const isWorking = (teammateId: string) => liveRuns.some((r) => r.teammate_id === teammateId && r.status === 'running')
  const isThreadLive = (threadId: string) => liveRuns.some((r) => r.thread_id === threadId)

  const crew = teammates.filter((t) => !isComputer(t) && !isPhone(t))
  return (
    <Ctx value={{
      loading, error, offline, teammates: crew, everyone: teammates, projects, members, threads, pendingApprovals, liveRuns, previews,
      refresh, markRead, teammate, project, thread, membersOf, threadTeammates, threadTitle, isWorking, isThreadLive,
      chatsWith, newChat, renameChat, deleteChat,
    }}>
      <TeammatesCtx value={teammate}>{children}</TeammatesCtx>
    </Ctx>
  )
}

export function useWorkspace() {
  const v = use(Ctx)
  if (!v) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return v
}
