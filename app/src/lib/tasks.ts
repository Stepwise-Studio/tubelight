// The Tasks tab's data: your to-dos (agent-service todos.py) and every chat's follow-ups (followups.py).
// A small shared store per kind, so the tab, the sheets and the badge read the same list and edits show at once.
import { useEffect, useSyncExternalStore } from 'react'

import { api } from '@/lib/api'

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

const todoStore = store(() => api<{ todos: Todo[] }>('/todos').then((r) => r.todos))
const followStore = store(() => api<{ pending: Followup[]; done: Followup[] }>('/followups'))

/** The to-do list, kept fresh: loads on first use and whenever `refresh()` is called. */
export function useTodos() {
  const snap = useSyncExternalStore(todoStore.subscribe, todoStore.get)
  useEffect(() => { todoStore.refresh() }, [])
  return { todos: snap.value, error: snap.error, refresh: todoStore.refresh }
}

export function useFollowups() {
  const snap = useSyncExternalStore(followStore.subscribe, followStore.get)
  useEffect(() => { followStore.refresh() }, [])
  return { pending: snap.value?.pending ?? null, done: snap.value?.done ?? [], error: snap.error, refresh: followStore.refresh }
}

const sortTodos = (l: Todo[]) => [...l].sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))

/** Edits land in the list at once and roll back if the server says no. */
async function optimistic(next: (l: Todo[]) => Todo[], call: () => Promise<unknown>) {
  const before = todoStore.get().value ?? []
  todoStore.set(sortTodos(next(before)))
  try {
    await call()
  } catch (e) {
    todoStore.set(before)
    throw e
  }
}

export async function addTodo(fields: Partial<Todo> & { title: string }) {
  const temp: Todo = {
    id: `temp-${Date.now()}`, notes: '', status: 'todo', priority: 0, due: null, project_id: null, thread_id: null,
    added_by: null, assignee: null, sort: -Date.now() / 1000, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    completed_at: null, ...fields,
  }
  let made: Todo | null = null
  await optimistic((l) => [temp, ...l], async () => {
    made = await api<Todo>('/todos', { method: 'POST', json: fields })
  })
  const now = todoStore.get().value ?? []
  todoStore.set(sortTodos(now.map((t) => (t.id === temp.id && made ? made : t))))
  return made as Todo | null
}

export function updateTodo(id: string, changes: Partial<Todo>) {
  const stamp = new Date().toISOString()
  return optimistic(
    (l) => l.map((t) => (t.id === id ? {
      ...t, ...changes, updated_at: stamp,
      completed_at: changes.status ? (changes.status === 'done' ? (t.completed_at ?? stamp) : null) : t.completed_at,
    } : t)),
    () => api(`/todos/${id}`, { method: 'PATCH', json: changes }),
  )
}

export function deleteTodo(id: string) {
  return optimistic((l) => l.filter((t) => t.id !== id), () => api(`/todos/${id}`, { method: 'DELETE' }))
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

export const refreshTasks = () => Promise.all([todoStore.refresh(), followStore.refresh()])

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
