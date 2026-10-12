import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'

import { ApiError, api } from './api'
import type { Message } from './types'

/**
 * Messages written while the server can't be reached (no data, or the home server down): kept on the phone and sent
 * in order once it answers again, like WhatsApp's clock tick. Survives restarts. A message the server refuses (a 4xx)
 * leaves the queue and shows as "Not sent". ponytail: a send whose reply was lost in transit can arrive twice; give
 * POST /messages an idempotency key if that shows up.
 */
export interface Queued { local: Message; mentions: string[] }
type Listener = (e: { localId: string; sent?: Message; failed?: boolean }) => void

const KEY = 'tl.outbox'
let queue: Queued[] = []
const ready = AsyncStorage.getItem(KEY).then((v) => { if (v) queue = JSON.parse(v) }, () => {})
const listeners = new Set<Listener>()
const save = () => AsyncStorage.setItem(KEY, JSON.stringify(queue)).catch(() => {})

/** The service is unreachable (no connection, or the tunnel answering for a server that's down). */
export const unreachable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 502

export async function enqueue(q: Queued) {
  await ready
  if (!queue.some((x) => x.local.id === q.local.id)) queue.push(q)
  save()
  schedule()
}

export async function queuedFor(threadId: string) {
  await ready
  return queue.filter((q) => q.local.thread_id === threadId)
}

export function remove(localId: string) {
  queue = queue.filter((q) => q.local.id !== localId)
  save()
}

export function onOutbox(l: Listener) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export const send = (q: Queued) => api<{ message: Message; run_id: string }>(`/threads/${encodeURIComponent(q.local.thread_id)}/messages`, {
  method: 'POST',
  json: {
    text: q.local.text, mentions: q.mentions, reply_to: q.local.reply_to ?? null, attachments: q.local.meta.attachments ?? [],
    apps: q.local.meta.apps ?? [], voice_task: !!q.local.meta.voice_task,
  },
})

let flushing = false
/** Send what's waiting, oldest first; stops at the first sign the server is still away. */
export async function flush() {
  await ready
  if (flushing || !queue.length) return
  flushing = true
  try {
    while (queue.length) {
      const q = queue[0]
      try {
        const res = await send(q)
        remove(q.local.id)
        listeners.forEach((l) => l({ localId: q.local.id, sent: res.message }))
      } catch (e) {
        if (unreachable(e)) break
        remove(q.local.id)
        listeners.forEach((l) => l({ localId: q.local.id, failed: true }))
      }
    }
  } finally {
    flushing = false
    schedule()
  }
}

// While anything waits: try every 20 s, and right away when the app comes back.
let timer: ReturnType<typeof setTimeout> | undefined
function schedule() {
  clearTimeout(timer)
  if (queue.length) timer = setTimeout(flush, 20_000)
}
AppState.addEventListener('change', (s) => { if (s === 'active') flush() })
ready.then(flush)
