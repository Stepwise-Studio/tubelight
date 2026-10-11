// The Tasks tab's data: your to-dos (agent-service todos.py) and every chat's follow-ups (followups.py).
// A small shared store per kind, so the tab, the sheets and the badge read the same list and edits show at once.
// To-dos work offline (see below); follow-ups need the server.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import { ApiError, api } from '@/lib/api'
import { onReturn } from '@/lib/app-state'
import { toast } from '@/ui'

export type TodoStatus = 'backlog' | 'todo' | 'doing' | 'done' | 'canceled'
export interface Todo {
  id: string
  title: string
  notes: string
  status: TodoStatus
  /** Linear's: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number
  /** YYYY-MM-DD */
  due: string | null
  project_id: string | null
  thread_id: string | null
  /** The teammate who added it; null when you did. */
  added_by: string | null
  /** The teammate it's assigned to (they work on it); null: yours. */
  assignee: string | null
  sort: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Followup {
  id: string
  thread_id: string
  what: string
  /** A teammate id, or "group" in a project chat. */
  owner: string
  at: string | null
  until: string | null
  check_by: string | null
  poll_hours: number | null
  set_by: string
  created: string
  status?: 'fired' | 'done' | 'cancelled' | 'dropped'
  closed?: string
}

export const STATUSES: { value: TodoStatus; label: string }[] = [
  { value: 'doing', label: 'In progress' },
  { value: 'todo', label: 'Todo' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'done', label: 'Done' },
  { value: 'canceled', label: 'Canceled' },
]
export const statusLabel = (s: TodoStatus) => STATUSES.find((x) => x.value === s)?.label ?? s
export const PRIORITIES = [
  { value: 0, label: 'No priority' }, { value: 1, label: 'Urgent' }, { value: 2, label: 'High' },
  { value: 3, label: 'Medium' }, { value: 4, label: 'Low' },
]

function store<T>(load: () => Promise<T>) {
  let value: T | null = null
  let error: string | null = null
  let loading: Promise<void> | null = null
  const subs = new Set<() => void>()
  const emit = () => subs.forEach((f) => f())
  const snapshot = () => ({ value, error })
  let snap = snapshot()
  const s = {
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
    get: () => snap,
    set: (v: T) => { value = v; error = null; snap = snapshot(); emit() },
    refresh: () => {
      loading ??= load().then((v) => s.set(v), (e) => { error = e instanceof Error ? e.message : String(e); snap = snapshot(); emit() })
        .finally(() => { loading = null })
      return loading
    },
  }
  return s
}

const followStore = store(() => api<{ pending: Followup[]; done: Followup[] }>('/followups'))

export function useFollowups() {
  const snap = useSyncExternalStore(followStore.subscribe, followStore.get)
  useEffect(() => { followStore.refresh() }, [])
  return { pending: snap.value?.pending ?? null, done: snap.value?.done ?? [], error: snap.error, refresh: followStore.refresh }
}

const sortTodos = (l: Todo[]) => [...l].sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))

// ------------------------------------------------------------------ to-dos, offline first
// The list lives on the phone: the last list the server sent (cached) with every change you made since replayed on
// top (the outbox, also kept), so it opens instantly and works with the server down. Changes go out in order whenever
// the server answers: after each change, when the app comes back, on pull to refresh, and every 20 s while any wait.
// A new to-do gets its id here, so sending it twice keeps one. A change the server refuses (not "unreachable") is
// dropped with a note; one for a to-do that's gone is dropped quietly. Teammates' edits arrive with the next list.
type Op =
  | { kind: 'add'; todo: Todo }
  | { kind: 'edit'; id: string; changes: Partial<Todo>; at: string }
  | { kind: 'del'; id: string }
const CACHE = 'tl.todos.cache'
const OUTBOX = 'tl.todos.outbox'
const RETRY_MS = 20_000

let server: Todo[] | null = null
let outbox: Op[] = []
let offline = false
let failed: string | null = null
let todoSnap = { todos: null as Todo[] | null, error: null as string | null, offline: false, unsynced: 0 }
const todoSubs = new Set<() => void>()

function edited(t: Todo, changes: Partial<Todo>, at: string): Todo {
  return { ...t, ...changes, updated_at: at,
    completed_at: changes.status ? (changes.status === 'done' ? (t.completed_at ?? at) : null) : t.completed_at }
}
function replay(list: Todo[], ops: Op[]) {
  let l = list
  for (const op of ops) {
    if (op.kind === 'add') l = l.some((t) => t.id === op.todo.id) ? l : [op.todo, ...l]
    else if (op.kind === 'edit') l = l.map((t) => (t.id === op.id ? edited(t, op.changes, op.at) : t))
    else l = l.filter((t) => t.id !== op.id)
  }
  return sortTodos(l)
}
function publish() {
  todoSnap = { todos: server || outbox.length ? replay(server ?? [], outbox) : null, error: server || outbox.length ? null : failed,
    offline, unsynced: outbox.length }
  todoSubs.forEach((f) => f())
}
const persist = () => AsyncStorage.multiSet([[CACHE, JSON.stringify(server)], [OUTBOX, JSON.stringify(outbox)]]).catch(() => {})

let boot: Promise<void> | null = null
function load() {
  if (boot) return boot
  onReturn(() => { syncTodos() })
  AppState.addEventListener('change', (st) => { if (st === 'active' && outbox.length) syncTodos() }) // unsent changes: at once
  boot = AsyncStorage.multiGet([CACHE, OUTBOX]).then(([[, c], [, o]]) => {
    if (server === null && c) server = JSON.parse(c)
    outbox = [...(o ? (JSON.parse(o) as Op[]) : []), ...outbox] // anything queued before the load came back goes after
    publish()
  }, () => {})
  return boot
}

const unreachable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500
function send(op: Op) {
  if (op.kind === 'add') {
    const { id, title, notes, status, priority, due, project_id, assignee } = op.todo
    return api('/todos', { method: 'POST', json: { id, title, notes, status, priority, due, project_id, assignee } })
  }
  if (op.kind === 'edit') return api(`/todos/${op.id}`, { method: 'PATCH', json: op.changes })
  return api(`/todos/${op.id}`, { method: 'DELETE' })
}

let syncing: Promise<void> | null = null
let retry: ReturnType<typeof setTimeout> | null = null
/** Sends what's waiting, in order, then takes the server's list. Safe to call any time. */
export function syncTodos() {
  syncing ??= (async () => {
    await load()
    if (retry) { clearTimeout(retry); retry = null }
    while (outbox.length) {
      try {
        await send(outbox[0])
      } catch (e) {
        if (unreachable(e)) { offline = true; publish(); retry = setTimeout(syncTodos, RETRY_MS); return }
        if (!(e instanceof ApiError && e.status === 404)) toast({ title: 'A to-do change didn’t save', body: (e as Error).message, tone: 'error' })
      }
      outbox.shift()
      persist()
      publish()
    }
    try {
      server = (await api<{ todos: Todo[] }>('/todos')).todos
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

function queue(op: Op) {
  outbox.push(op)
  persist()
  publish()
  syncTodos()
}

/** The to-do list: on the phone at once, synced with the server whenever it's reachable. */
export function useTodos() {
  const snap = useSyncExternalStore((f) => { todoSubs.add(f); return () => { todoSubs.delete(f) } }, () => todoSnap)
  useEffect(() => { syncTodos() }, [])
  return { ...snap, refresh: syncTodos }
}

export async function addTodo(fields: Partial<Todo> & { title: string }) {
  const now = new Date().toISOString()
  const todo: Todo = {
    notes: '', status: 'todo', priority: 0, due: null, project_id: null, thread_id: null, added_by: null, assignee: null,
    sort: -Date.now() / 1000, created_at: now, updated_at: now, completed_at: fields.status === 'done' ? now : null,
    ...fields, id: Crypto.randomUUID(),
  }
  queue({ kind: 'add', todo })
  return todo
}

export async function updateTodo(id: string, changes: Partial<Todo>) {
  queue({ kind: 'edit', id, changes, at: new Date().toISOString() })
}

export async function deleteTodo(id: string) {
  queue({ kind: 'del', id })
}

export async function editFollowup(id: string, changes: { what?: string; at?: string; until?: string; check_by?: string | null }) {
  await api(`/followups/${id}`, { method: 'PATCH', json: changes })
  await followStore.refresh()
}

export async function cancelFollowup(id: string) {
  await api(`/followups/${id}`, { method: 'DELETE' })
  await followStore.refresh()
}

export async function followupNow(id: string) {
  await api(`/followups/${id}/now`, { method: 'POST' })
  await followStore.refresh()
}

export const refreshTasks = () => Promise.all([syncTodos(), followStore.refresh()])

/** "Today", "Tomorrow", "Fri", "Oct 21" for a YYYY-MM-DD due date, and whether it's overdue or due today. */
export function dueLabel(due: string, now = new Date()) {
  const [y, m, d] = due.split('-').map(Number)
  const day = new Date(y, m - 1, d)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000)
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : diff > 1 && diff < 7 ? day.toLocaleDateString(undefined, { weekday: 'short' })
      : day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return { label, overdue: diff < 0, today: diff === 0, soon: diff >= 0 && diff <= 1 }
}

/** A local Date as YYYY-MM-DD. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
