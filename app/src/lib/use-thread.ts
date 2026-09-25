import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import type { Approval, DeltaEvent, DoneEvent, LiveState, Message, StatusEvent } from '@/lib/types'

const PAGE = 50

/** A message as the UI holds it: DB rows plus optimistic sends. */
export type ChatMessage = Message & { local?: 'sending' | 'failed' }
export interface Ghost { stream_id: string; run_id: string; teammate_id: string; text: string; done: boolean }
export interface LiveStatus { run_id: string; teammate_id: string; state: LiveState; label?: string }

let localSeq = 0

/**
 * Everything one thread needs: paginated messages (newest first), approvals, live typing
 * status and streamed ghost text over the private `thread:<id>` channel, and send.
 */
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
    setError(null)
    const [m, a] = await Promise.all([
      supabase.from('messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(PAGE),
      supabase.from('approvals').select('*').eq('thread_id', threadId),
    ])
    if (m.error || a.error) {
      setError('Unable to load this chat. Check your connection and try again.')
      setLoading(false)
      return
    }
    const rows = m.data as Message[]
    setMessages((prev) => [...prev.filter((x) => x.local), ...rows])
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

  useEffect(() => {
    setLoading(true)
    setMessages([])
    setStatuses({})
    setGhosts({})
    load()

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (data.session) await supabase.realtime.setAuth(data.session.access_token)
      channel = supabase
        .channel(`thread:${threadId}`, { config: { private: true } })
        .on('broadcast', { event: 'status' }, ({ payload }) => {
          const s = payload as StatusEvent
          if (s.state === 'idle') {
            setStatuses(({ [s.run_id]: _, ...rest }) => rest)
            // Contract: idle ends the run; drop ghosts that never finished (cancelled / failed).
            setGhosts((g) => Object.fromEntries(Object.entries(g).filter(([, x]) => x.run_id !== s.run_id || x.done)))
          } else {
            setStatuses((st) => ({ ...st, [s.run_id]: s }))
          }
        })
        .on('broadcast', { event: 'delta' }, ({ payload }) => {
          const d = payload as DeltaEvent
          setGhosts((g) => ({ ...g, [d.stream_id]: { stream_id: d.stream_id, run_id: d.run_id, teammate_id: d.teammate_id, text: d.text, done: false } }))
        })
        .on('broadcast', { event: 'done' }, ({ payload }) => {
          const d = payload as DoneEvent & { discarded?: boolean }
          setGhosts((g) => {
            if (!g[d.stream_id]) return g
            if (d.discarded) { const { [d.stream_id]: _, ...rest } = g; return rest }
            return { ...g, [d.stream_id]: { ...g[d.stream_id], done: true } }
          })
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `thread_id=eq.${threadId}` }, (e) => {
          if (e.eventType === 'DELETE') setMessages((l) => l.filter((x) => x.id !== (e.old as Message).id))
          else upsert(e.new as Message)
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals', filter: `thread_id=eq.${threadId}` }, (e) => {
          if (e.eventType !== 'DELETE') { const a = e.new as Approval; setApprovals((m) => ({ ...m, [a.id]: a })) }
        })
        // Rows can land between the first load and the join (or during a dropped socket): reload on every join.
        .subscribe((status) => { if (status === 'SUBSCRIBED') load() })
    })()
    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [threadId, load, upsert])

  const post = async (local: ChatMessage, mentions: string[]) => {
    try {
      const res = await api<{ message: Message; run_id: string }>(`/threads/${encodeURIComponent(threadId)}/messages`, {
        method: 'POST', json: { text: local.text, mentions },
      })
      setMessages((prev) => {
        const withoutLocal = prev.filter((p) => p.id !== local.id)
        return withoutLocal.some((p) => p.id === res.message.id) ? withoutLocal : [res.message, ...withoutLocal]
      })
      return null
    } catch (e) {
      setMessages((prev) => prev.map((p) => (p.id === local.id ? { ...p, local: 'failed' } : p)))
      return e instanceof ApiError ? e.message : 'Unable to send. Check your connection and try again.'
    }
  }

  /** Optimistic send. Resolves to an error message, or null when sent. */
  const send = (text: string, mentions: string[]) => {
    const local: ChatMessage = {
      id: `local-${++localSeq}`, thread_id: threadId, owner_id: ownerId ?? '', sender_type: 'user', teammate_id: null,
      text, mentions, kind: 'text', meta: {}, proactive: false, run_id: null, created_at: new Date().toISOString(), local: 'sending',
    }
    setMessages((prev) => [local, ...prev])
    return post(local, mentions)
  }

  const retry = (m: ChatMessage) => {
    setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, local: 'sending', created_at: new Date().toISOString() } : p)))
    return post(m, m.mentions)
  }

  const discard = (id: string) => setMessages((prev) => prev.filter((p) => p.id !== id))

  const refreshApprovals = async () => {
    const { data } = await supabase.from('approvals').select('*').eq('thread_id', threadId)
    if (data) setApprovals(Object.fromEntries((data as Approval[]).map((x) => [x.id, x])))
  }

  return { messages, loading, error, reload: load, hasMore, loadOlder, loadingOlder, approvals, refreshApprovals, statuses, ghosts, send, retry, discard }
}
