import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api } from '@/lib/api'
import { syncNotifications } from '@/lib/phone'
import { supabase } from '@/lib/supabase'
import * as outbox from '@/lib/outbox'
import { liveChannel } from '@/lib/realtime'
import type { Approval, Attachment, DeltaEvent, DoneEvent, LiveState, Message, StatusEvent } from '@/lib/types'

const PAGE = 50

/** A message as the UI holds it: DB rows plus optimistic sends. */
/** `queued`: written while the server was out of reach; lib/outbox sends it when it's back. */
export type ChatMessage = Message & { local?: 'sending' | 'queued' | 'failed' }
export interface Ghost { stream_id: string; run_id: string; teammate_id: string; text: string; done: boolean; event_type?: string }
export interface LiveStatus { run_id: string; teammate_id: string; state: LiveState; label?: string }
export interface SendOptions { reply_to?: string | null; attachments?: Attachment[]; voiceTask?: boolean; apps?: string[] }

let localSeq = 0

/**
 * Everything one thread needs: paginated messages (newest first), approvals, live typing
 * status and streamed ghost text over the private `thread:<id>` channel, and send.
 */
// One realtime channel per chat, shared: the app and the assistant panel are two React roots in one JS runtime, and
// Supabase hands back the already-joined channel for a topic (the server broadcasts to "thread:<id>", so the name
// can't vary). Every screen showing the chat gets the events; the channel closes when the last one leaves.
type PgEvent = { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: unknown; old: unknown }
interface ThreadListener {
  status: (s: StatusEvent) => void
  delta: (d: DeltaEvent) => void
  done: (d: DoneEvent & { discarded?: boolean }) => void
  message: (e: PgEvent) => void
  approval: (e: PgEvent) => void
  joined: () => void
}
const hubs = new Map<string, { listeners: Set<ThreadListener>; live: ReturnType<typeof liveChannel> }>()

function joinThread(threadId: string, l: ThreadListener): () => void {
  let hub = hubs.get(threadId)
  if (!hub) {
    const listeners = new Set<ThreadListener>()
    const each = (f: (x: ThreadListener) => void) => listeners.forEach(f)
    // Self-healing (lib/realtime): every join, the first or after the channel died, catches the screen up.
    const live = liveChannel(() => supabase
      .channel(`thread:${threadId}`, { config: { private: true } })
      .on('broadcast', { event: 'status' }, ({ payload }) => each((x) => x.status(payload as StatusEvent)))
      .on('broadcast', { event: 'delta' }, ({ payload }) => each((x) => x.delta(payload as DeltaEvent)))
      .on('broadcast', { event: 'done' }, ({ payload }) => each((x) => x.done(payload as DoneEvent & { discarded?: boolean })))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `thread_id=eq.${threadId}` }, (e) => each((x) => x.message(e as PgEvent)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals', filter: `thread_id=eq.${threadId}` }, (e) => each((x) => x.approval(e as PgEvent)))
      , () => each((x) => x.joined()))
    hub = { listeners, live }
    hubs.set(threadId, hub)
  } else if (hub.live.channel?.state === 'joined') {
    l.joined() // already live: catch up now
  }
  hub.listeners.add(l)
  return () => {
    const h = hubs.get(threadId)
    if (!h) return
    h.listeners.delete(l)
    if (!h.listeners.size) { hubs.delete(threadId); h.live.stop() }
  }
}

export function useThread(threadId: string, ownerId: string | undefined) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [approvals, setApprovals] = useState<Record<string, Approval>>({})
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({})
  const [ghosts, setGhosts] = useState<Record<string, Ghost>>({})
  const oldest = useRef<string | null>(null)

  const load = useCallback(async () => {
    const [m, a] = await Promise.all([
      supabase.from('messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(PAGE),
      supabase.from('approvals').select('*').eq('thread_id', threadId),
    ])
    if (m.error || a.error) {
      // Offline with a saved copy on screen: keep showing it, like WhatsApp.
      setMessages((prev) => { if (!prev.length) setError('Unable to load this chat. Check your connection and try again.'); return prev })
      setLoading(false)
      return
    }
    setError(null)
    const rows = m.data as Message[]
    setMessages((prev) => [...prev.filter((x) => x.local && !rows.some((r) => r.id === x.id)), ...rows])
    oldest.current = rows.at(-1)?.created_at ?? null
    setHasMore(rows.length === PAGE)
    setApprovals(Object.fromEntries((a.data as Approval[]).map((x) => [x.id, x])))
    setLoading(false)
  }, [threadId])

  const loadOlder = async () => {
    if (!hasMore || loadingOlder || !oldest.current) return
    setLoadingOlder(true)
    const { data } = await supabase.from('messages').select('*').eq('thread_id', threadId)
      .lt('created_at', oldest.current).order('created_at', { ascending: false }).limit(PAGE)
    const rows = (data ?? []) as Message[]
    if (rows.length) oldest.current = rows.at(-1)!.created_at
    setHasMore(rows.length === PAGE)
    setMessages((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))])
    setLoadingOlder(false)
  }

  // Insert or replace a DB row; swap out the optimistic twin and the ghost it came from.
  const upsert = useCallback((row: Message) => {
    setMessages((prev) => {
      if (prev.some((p) => p.id === row.id)) return prev.map((p) => (p.id === row.id ? row : p))
      if (row.sender_type === 'user') {
        const twin = prev.findIndex((p) => p.local === 'sending' && p.text === row.text)
        if (twin >= 0) return prev.map((p, i) => (i === twin ? row : p))
      }
      return [row, ...prev]
    })
    const sid = row.meta?.stream_id
    if (sid) setGhosts((g) => { if (!g[sid]) return g; const { [sid]: _, ...rest } = g; return rest })
  }, [])

  // The last page is kept on the phone: the chat opens at once, and offline it still shows.
  const cacheKey = `tl.chat.${threadId}`
  useEffect(() => {
    let off = false
    Promise.all([AsyncStorage.getItem(cacheKey).catch(() => null), outbox.queuedFor(threadId)]).then(([v, queued]) => {
      if (off) return
      const saved = (v ? JSON.parse(v) : []) as Message[]
      const waiting: ChatMessage[] = queued.map((q) => ({ ...q.local, local: 'queued' }))
      setMessages((prev) => (prev.some((x) => !x.local) ? [...waiting.filter((w) => !prev.some((p) => p.id === w.id)), ...prev]
        : [...waiting, ...prev.filter((p) => !waiting.some((w) => w.id === p.id)), ...saved]))
      if (saved.length) setLoading(false)
    })
    const stop = outbox.onOutbox(({ localId, sent, failed }) => setMessages((prev) => {
      if (failed) return prev.map((p) => (p.id === localId ? { ...p, local: 'failed' } : p))
      const rest = prev.filter((p) => p.id !== localId)
      return sent && !rest.some((p) => p.id === sent.id) ? [sent, ...rest] : rest
    }))
    return () => { off = true; stop() }
  }, [threadId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => {
      const keep = messages.filter((m) => !m.local).slice(0, PAGE)
      if (keep.length) AsyncStorage.setItem(cacheKey, JSON.stringify(keep)).catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  }, [messages, cacheKey])

  // One hook instance per thread screen (the route remounts per threadId), so no reset here.
  useEffect(() => {
    // load() only sets state after its first await; the rule can't see through the callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()

    let cancelled = false
    let leave: (() => void) | null = null
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (data.session) await supabase.realtime.setAuth(data.session.access_token)
      leave = joinThread(threadId, {
        status: (s) => {
          if (s.state === 'idle') {
            setStatuses(({ [s.run_id]: _, ...rest }) => rest)
            // Contract: idle ends the run; drop ghosts that never finished (cancelled / failed).
            setGhosts((g) => Object.fromEntries(Object.entries(g).filter(([, x]) => x.run_id !== s.run_id || x.done)))
          } else {
            setStatuses((st) => ({ ...st, [s.run_id]: s }))
          }
        },
        delta: (d) => setGhosts((g) => ({ ...g, [d.stream_id]: { stream_id: d.stream_id, run_id: d.run_id, teammate_id: d.teammate_id, text: d.text, done: false, event_type: d.event_type } })),
        done: (d) => setGhosts((g) => {
          if (!g[d.stream_id]) return g
          if (d.discarded) { const { [d.stream_id]: _, ...rest } = g; return rest }
          return { ...g, [d.stream_id]: { ...g[d.stream_id], done: true } }
        }),
        message: (e) => {
          if (e.eventType === 'DELETE') setMessages((l) => l.filter((x) => x.id !== (e.old as Message).id))
          else upsert(e.new as Message)
        },
        approval: (e) => { if (e.eventType !== 'DELETE') { const a = e.new as Approval; setApprovals((m) => ({ ...m, [a.id]: a })) } },
        // Rows can land between the first load and the join (or during a dropped socket): reload on every join.
        joined: () => { load(); outbox.flush() },
      })
    })()
    return () => {
      cancelled = true
      leave?.()
    }
  }, [threadId, load, upsert])

  const post = async (local: ChatMessage, mentions: string[]) => {
    await syncNotifications().catch(() => {}) // "what did Kishore send me?" needs the phone's latest
    try {
      const res = await outbox.send({ local, mentions })
      setMessages((prev) => {
        const withoutLocal = prev.filter((p) => p.id !== local.id)
        return withoutLocal.some((p) => p.id === res.message.id) ? withoutLocal : [res.message, ...withoutLocal]
      })
      return null
    } catch (e) {
      if (outbox.unreachable(e)) {  // no connection: wait on the phone and go out when it's back
        const { local: _, ...row } = local
        await outbox.enqueue({ local: row, mentions })
        setMessages((prev) => prev.map((p) => (p.id === local.id ? { ...p, local: 'queued' } : p)))
        return null
      }
      setMessages((prev) => prev.map((p) => (p.id === local.id ? { ...p, local: 'failed' } : p)))
      return e instanceof ApiError ? e.message : 'Unable to send. Check your connection and try again.'
    }
  }

  /** Optimistic send. Resolves to an error message, or null when sent. */
  const send = (text: string, mentions: string[], opts: SendOptions = {}) => {
    const local: ChatMessage = {
      id: `local-${Date.now().toString(36)}-${++localSeq}`, /* unique across restarts: queued ones outlive the app */ thread_id: threadId, owner_id: ownerId ?? '', sender_type: 'user', teammate_id: null,
      text, mentions, kind: 'text',
      meta: { ...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.voiceTask ? { voice_task: true } : {}), ...(opts.apps?.length ? { apps: opts.apps } : {}) },
      reply_to: opts.reply_to ?? null, proactive: false, run_id: null, created_at: new Date().toISOString(), local: 'sending',
    }
    setMessages((prev) => [local, ...prev])
    return post(local, mentions)
  }

  const retry = (m: ChatMessage) => {
    setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, local: 'sending', created_at: new Date().toISOString() } : p)))
    return post(m, m.mentions)
  }

  /** Runs a sent message again, in place (no second copy); the failed attempt's error notes go. */
  const rerun = async (m: ChatMessage) => {
    try {
      await api(`/messages/${m.id}/retry`, { method: 'POST' })
      setMessages((prev) => prev.filter((p) => !(p.kind === 'error' && p.created_at > m.created_at)))
      return null
    } catch (e) {
      return e instanceof ApiError ? e.message : 'Unable to retry. Check your connection and try again.'
    }
  }

  const discard = (id: string) => { outbox.remove(id); setMessages((prev) => prev.filter((p) => p.id !== id)) }

  /** Your reaction on a message (the same emoji again removes it): shown at once, then confirmed by the server. */
  const react = async (m: ChatMessage, emoji: string) => {
    const mine = (m.meta.reactions ?? []).find((r) => r.by === 'user')
    const rest = (m.meta.reactions ?? []).filter((r) => r.by !== 'user')
    const next = mine?.emoji === emoji ? rest : [...rest, { by: 'user', emoji }]
    setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, meta: { ...p.meta, reactions: next } } : p)))
    try {
      await api(`/messages/${m.id}/react`, { method: 'POST', json: { emoji } })
    } catch {
      setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, meta: { ...p.meta, reactions: m.meta.reactions } } : p)))
    }
  }

  const refreshApprovals = async () => {
    const { data } = await supabase.from('approvals').select('*').eq('thread_id', threadId)
    if (data) setApprovals(Object.fromEntries((data as Approval[]).map((x) => [x.id, x])))
  }

  return { messages, loading, error, reload: load, hasMore, loadOlder, loadingOlder, approvals, refreshApprovals, statuses, ghosts, send, retry, rerun, discard, react }
}
