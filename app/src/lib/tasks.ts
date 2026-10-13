// The Tasks tab's data: your to-dos (agent-service todos.py) and every chat's follow-ups (followups.py).
// A small shared store per kind, so the tab, the sheets and the badge read the same list and edits show at once.
// To-dos work offline (see below); follow-ups need the server.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useSyncExternalStore } from 'react'

import { api } from '@/lib/api'
import { offlineList } from '@/lib/offline-list'

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
  /** Label ids. */
  labels: string[]
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
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'doing', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'canceled', label: 'Canceled' },
]
export const statusLabel = (s: TodoStatus) => STATUSES.find((x) => x.value === s)?.label ?? s
export const PRIORITIES = [
  { value: 0, label: 'No priority' }, { value: 1, label: 'Urgent' }, { value: 2, label: 'High' },
  { value: 3, label: 'Medium' }, { value: 4, label: 'Low' },
]

/** A server list kept on the phone too (`key` in AsyncStorage), so it shows offline; refreshes redraw only on change. */
function store<T>(load: () => Promise<T>, key: string) {
  let value: T | null = null
  let error: string | null = null
  let loading: Promise<void> | null = null
  const subs = new Set<() => void>()
  const emit = () => subs.forEach((f) => f())
  const snapshot = () => ({ value, error })
  let snap = snapshot()
  AsyncStorage.getItem(key).then((c) => { if (c && value === null) { value = JSON.parse(c); snap = snapshot(); emit() } }, () => {})
  const s = {
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
    get: () => snap,
    set: (v: T) => {
      const json = JSON.stringify(v)
      if (json === JSON.stringify(value) && !error) return
      value = v; error = null; snap = snapshot(); emit()
      AsyncStorage.setItem(key, json).catch(() => {})
    },
    refresh: () => {
      // Offline, the kept list stays up: an error shows only when there's nothing to show.
      loading ??= load().then((v) => s.set(v), (e) => { if (value === null) { error = e instanceof Error ? e.message : String(e); snap = snapshot(); emit() } })
        .finally(() => { loading = null })
      return loading
    },
  }
  return s
}

const followStore = store(() => api<{ pending: Followup[]; done: Followup[] }>('/followups'), 'tl.followups')

export function useFollowups() {
  const snap = useSyncExternalStore(followStore.subscribe, followStore.get)
  useEffect(() => { followStore.refresh() }, [])
  return { pending: snap.value?.pending ?? null, done: snap.value?.done ?? [], error: snap.error, refresh: followStore.refresh }
}

const sortTodos = (l: Todo[]) => [...l].sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))

// ------------------------------------------------------------------ to-dos and their labels, offline first (offline-list.ts)
const todoList = offlineList<Todo>({
  path: '/todos', field: 'todos', key: 'tl.todos', noun: 'to-do', sort: sortTodos,
  apply: (t, changes, at) => ({ ...t, ...changes, updated_at: at,
    completed_at: changes.status ? (changes.status === 'done' ? (t.completed_at ?? at) : null) : t.completed_at }),
  addBody: ({ id, title, notes, status, priority, due, project_id, assignee, labels }) => ({ id, title, notes, status, priority, due, project_id, assignee, labels }),
})
export const syncTodos = todoList.sync

/** The to-do list: on the phone at once, synced with the server whenever it's reachable. */
export function useTodos() {
  const s = todoList.use()
  return { todos: s.rows, error: s.error, offline: s.offline, unsynced: s.unsynced, refresh: syncTodos }
}

export async function addTodo(fields: Partial<Todo> & { title: string }) {
  const now = new Date().toISOString()
  return todoList.add({
    notes: '', status: 'todo', priority: 0, due: null, project_id: null, thread_id: null, added_by: null, assignee: null, labels: [],
    sort: -Date.now() / 1000, created_at: now, updated_at: now, completed_at: fields.status === 'done' ? now : null,
    ...fields,
  })
}

export async function updateTodo(id: string, changes: Partial<Todo>) { todoList.update(id, changes) }
export async function deleteTodo(id: string) { todoList.remove(id) }

export interface Label { id: string; name: string; color: string; created_at: string; updated_at: string }
/** New labels take these in turn (the server's todos.COLORS). */
export const LABEL_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#64748b']
const labelList = offlineList<Label>({
  path: '/todo-labels', field: 'items', key: 'tl.labels', noun: 'label',
  sort: (l) => [...l].sort((a, b) => a.created_at.localeCompare(b.created_at)),
})
export function useLabels() { return labelList.use().rows ?? [] }
export function addLabel(name: string) {
  const now = new Date().toISOString()
  const n = labelList.get().rows?.length ?? 0
  return labelList.add({ name, color: LABEL_COLORS[n % LABEL_COLORS.length], created_at: now, updated_at: now })
}
export const updateLabel = (id: string, changes: Partial<Label>) => labelList.update(id, changes)
/** Takes it off every to-do too. */
export function deleteLabel(id: string) {
  for (const t of todoList.get().rows ?? []) if (t.labels?.includes(id)) todoList.update(t.id, { labels: t.labels.filter((x) => x !== id) })
  labelList.remove(id)
}

/** Tapping a to-do moves it on: to do → in progress → done; a finished one opens again. */
export const nextStatus = (s: TodoStatus): TodoStatus => (s === 'doing' ? 'done' : s === 'done' || s === 'canceled' ? 'todo' : 'doing')

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

export const refreshTasks = () => Promise.all([syncTodos(), labelList.sync(), followStore.refresh()])

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
