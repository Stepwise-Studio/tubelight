// A list that lives on the phone (to-dos, labels, alarms, reminders): the last list the server sent (cached) with every
// change you made since replayed on top (the outbox, also kept), so it opens instantly and works with the server down.
// Changes go out in order whenever the server answers: after each change, when the app comes back, on pull to
// refresh, and every 20 s while any wait. A new row gets its id here, so sending it twice keeps one. A change the
// server refuses (not "unreachable") is dropped with a note; one for a row that's gone is dropped quietly. Teammates'
// edits arrive with the next list.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import { ApiError, api } from '@/lib/api'
import { onReturn } from '@/lib/app-state'
import { toast } from '@/ui'

type Row = { id: string; updated_at: string }
type Op<T> =
  | { kind: 'add'; row: T }
  | { kind: 'edit'; id: string; changes: Partial<T>; at: string }
  | { kind: 'del'; id: string }

const RETRY_MS = 20_000
const unreachable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500

export interface Snap<T> { rows: T[] | null; error: string | null; offline: boolean; unsynced: number }

export function offlineList<T extends Row>(o: {
  /** API path: GET lists, POST adds, PATCH/DELETE `${path}/${id}`. */
  path: string
  /** The list's key in the GET response. */
  field: string
  /** AsyncStorage key prefix. */
  key: string
  /** What a change sent to the server says about one, for the "didn't save" note. */
  noun: string
  sort: (l: T[]) => T[]
  /** A change applied on the phone (defaults to a merge). */
  apply?: (row: T, changes: Partial<T>, at: string) => T
  /** Sent with an add (defaults to the whole row). */
  addBody?: (row: T) => unknown
}) {
  const CACHE = `${o.key}.cache`
  const OUTBOX = `${o.key}.outbox`
  const apply = o.apply ?? ((r: T, ch: Partial<T>, at: string) => ({ ...r, ...ch, updated_at: at }))
  let server: T[] | null = null
  let outbox: Op<T>[] = []
  let offline = false
  let failed: string | null = null
  let snap: Snap<T> = { rows: null, error: null, offline: false, unsynced: 0 }
  const subs = new Set<() => void>()

  function replay(list: T[], ops: Op<T>[]) {
    let l = list
    for (const op of ops) {
      if (op.kind === 'add') l = l.some((t) => t.id === op.row.id) ? l : [op.row, ...l]
      else if (op.kind === 'edit') l = l.map((t) => (t.id === op.id ? apply(t, op.changes, op.at) : t))
      else l = l.filter((t) => t.id !== op.id)
    }
    return o.sort(l)
  }
  function publish() {
    const has = server || outbox.length
    snap = { rows: has ? replay(server ?? [], outbox) : null, error: has ? null : failed, offline, unsynced: outbox.length }
    subs.forEach((f) => f())
  }
  const persist = () => AsyncStorage.multiSet([[CACHE, JSON.stringify(server)], [OUTBOX, JSON.stringify(outbox)]]).catch(() => {})

  let boot: Promise<void> | null = null
  function load() {
    if (boot) return boot
    onReturn(() => { sync() })
    AppState.addEventListener('change', (st) => { if (st === 'active' && outbox.length) sync() }) // unsent changes: at once
    boot = AsyncStorage.multiGet([CACHE, OUTBOX]).then(([[, c], [, ob]]) => {
      if (server === null && c) server = JSON.parse(c)
      // (to-dos queued before this list existed kept the row under `todo`)
      const kept = (ob ? (JSON.parse(ob) as (Op<T> & { todo?: T })[]) : []).map((op) => (op.kind === 'add' && !op.row ? { kind: 'add' as const, row: op.todo! } : op))
      outbox = [...kept, ...outbox] // anything queued before the load came back goes after
      publish()
    }, () => {})
    return boot
  }

  function send(op: Op<T>) {
    if (op.kind === 'add') return api(o.path, { method: 'POST', json: o.addBody ? o.addBody(op.row) : op.row })
    if (op.kind === 'edit') return api(`${o.path}/${op.id}`, { method: 'PATCH', json: op.changes })
    return api(`${o.path}/${op.id}`, { method: 'DELETE' })
  }

  let syncing: Promise<void> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  /** Sends what's waiting, in order, then takes the server's list. Safe to call any time. */
  function sync(): Promise<void> {
    syncing ??= (async () => {
      await load()
      if (retry) { clearTimeout(retry); retry = null }
      while (outbox.length) {
        try {
          await send(outbox[0])
        } catch (e) {
          if (unreachable(e)) { offline = true; publish(); retry = setTimeout(sync, RETRY_MS); return }
          if (!(e instanceof ApiError && e.status === 404)) toast({ title: `A ${o.noun} change didn’t save`, body: (e as Error).message, tone: 'error' })
        }
        outbox.shift()
        persist()
        publish()
      }
      try {
        server = (await api<Record<string, T[]>>(o.path))[o.field]
        offline = false
        failed = null
        persist()
      } catch (e) {
        if (unreachable(e)) offline = true
        failed = (e as Error).message
      }
      publish()
    })().finally(() => { syncing = null })
    return syncing
  }

  function queue(op: Op<T>) {
    outbox.push(op)
    persist()
    publish()
    sync()
  }

  const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
  return {
    sync,
    load,
    subscribe,
    get: () => snap,
    /** The list: on the phone at once, synced with the server whenever it's reachable. */
    use() {
      const s = useSyncExternalStore(subscribe, () => snap)
      useEffect(() => { sync() }, [])
      return s
    },
    add(fields: Omit<T, 'id'>) {
      const row = { ...fields, id: Crypto.randomUUID() } as T
      queue({ kind: 'add', row })
      return row
    },
    update(id: string, changes: Partial<T>) { queue({ kind: 'edit', id, changes, at: new Date().toISOString() }) },
    remove(id: string) { queue({ kind: 'del', id }) },
  }
}
