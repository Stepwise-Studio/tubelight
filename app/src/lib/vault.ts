// The Vault's data: your files on your own server (agent-service vault.py). One shared store: the tab, folders and
// the viewer read the same list; uploads show in it at once with their progress.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useSyncExternalStore } from 'react'

import { BASE, api, authHeaders } from '@/lib/api'

export interface VaultItem {
  id: string
  kind: 'folder' | 'file'
  name: string
  /** "" = the top of the vault */
  parent: string
  mime: string
  size: number
  meta: { width?: number; height?: number; pages?: number; thumb?: boolean; duration?: number }
  starred: boolean
  created_at: string
  updated_at: string
  /** Signed paths on the agent service (prefix with BASE). */
  url?: string
  thumb?: string
}
export interface VaultUsage { used: number; files: number; free: number; total: number; quota: number }
export interface Upload { id: string; name: string; parent: string; mime: string; size: number; progress: number; local: string; error?: string }

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'word' | 'sheet' | 'slides' | 'archive' | 'other'

export function kindOf(name: string, mime = ''): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif'].includes(ext)) return 'image'
  if (mime.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm', '3gp', 'm4v'].includes(ext)) return 'video'
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac', 'flac'].includes(ext)) return 'audio'
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (ext === 'docx') return 'word'
  if (['xlsx', 'xlsm', 'csv', 'tsv'].includes(ext)) return 'sheet'
  if (ext === 'pptx') return 'slides'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  if (mime.startsWith('text/') || ['txt', 'json', 'log', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'kt', 'java', 'sh', 'sql', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'swift'].includes(ext)) return 'text'
  return 'other'
}

export const fileUrl = (path: string, download = false) => `${BASE}${path}${download ? '&dl=1' : ''}`

/** Anything the file viewer can open: a vault file or a chat attachment. `src` is a URL that needs no login. */
export interface Viewable {
  id: string
  name: string
  mime: string
  size: number
  meta: VaultItem['meta']
  src: string
  thumb?: string
  /** The API path of its native preview (Word, sheets, slides). */
  preview: string
}

export const viewable = (r: VaultItem): Viewable => ({
  id: r.id, name: r.name, mime: r.mime, size: r.size, meta: r.meta ?? {}, src: fileUrl(r.url!),
  thumb: r.thumb ? fileUrl(r.thumb) : undefined, preview: `/vault/${r.id}/preview`,
})

export function formatSize(n: number) {
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// ------------------------------------------------------------------ store
let items: VaultItem[] | null = null
let usage: VaultUsage | null = null
let uploads: Upload[] = []
let error: string | null = null
let loading: Promise<void> | null = null
const subs = new Set<() => void>()
let snap: { items: VaultItem[] | null; usage: VaultUsage | null; uploads: Upload[]; error: string | null } = { items, usage, uploads, error }
const emit = () => { snap = { items, usage, uploads, error }; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function refreshVault() {
  loading ??= api<{ items: VaultItem[]; usage: VaultUsage }>('/vault')
    .then((r) => { items = r.items; usage = r.usage; error = null; emit() },
      (e) => { error = e instanceof Error ? e.message : String(e); emit() })
    .finally(() => { loading = null })
  return loading
}

export function useVault() {
  const s = useSyncExternalStore(subscribe, () => snap)
  useEffect(() => { refreshVault() }, [])
  return s
}

const put = (row: VaultItem) => { items = [...(items ?? []).filter((r) => r.id !== row.id), row]; emit() }

export async function newFolder(name: string, parent: string) {
  const row = await api<VaultItem>('/vault/folders', { method: 'POST', json: { name, parent } })
  put(row)
  return row
}

export async function editItem(id: string, changes: Partial<Pick<VaultItem, 'name' | 'parent' | 'starred'>>) {
  const before = items
  items = (items ?? []).map((r) => (r.id === id ? { ...r, ...changes } : r))
  emit()
  try {
    put(await api<VaultItem>(`/vault/${id}`, { method: 'PATCH', json: changes }))
  } catch (e) {
    items = before
    emit()
    throw e
  }
}

export async function deleteItem(id: string) {
  const all = items ?? []
  const doomed = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const r of all) if (doomed.has(r.parent) && !doomed.has(r.id)) { doomed.add(r.id); grew = true }
  }
  const before = items
  items = all.filter((r) => !doomed.has(r.id))
  emit()
  try {
    await api(`/vault/${id}`, { method: 'DELETE' })
    refreshVault() // usage
  } catch (e) {
    items = before
    emit()
    throw e
  }
}

export async function saveAttachment(a: { path: string; name: string }, parent = '') {
  const row = await api<VaultItem>('/vault/save', { method: 'POST', json: { ...a, parent } })
  put(row)
  refreshVault()
  return row
}

const MAX = 100 * 1000 * 1000

/** Uploads files one after another (the home server's uplink is the bottleneck), each showing its progress. */
export async function uploadFiles(files: { uri: string; name: string; mime?: string; size?: number }[], parent: string) {
  const queued: Upload[] = files.map((f, i) => ({
    id: `up-${Date.now()}-${i}`, name: f.name, parent, mime: f.mime ?? '', size: f.size ?? 0, progress: 0, local: f.uri,
    ...(f.size && f.size > MAX ? { error: 'Over 100 MB' } : {}),
  }))
  uploads = [...uploads, ...queued]
  emit()
  const headers = await authHeaders()
  let failed = 0
  for (const u of queued) {
    if (u.error) { failed++; continue }
    try {
      const row = await send(u, headers, (p) => { uploads = uploads.map((x) => (x.id === u.id ? { ...x, progress: p } : x)); emit() })
      uploads = uploads.filter((x) => x.id !== u.id)
      put(row)
    } catch (e) {
      failed++
      uploads = uploads.map((x) => (x.id === u.id ? { ...x, error: e instanceof Error ? e.message : 'Upload failed' } : x))
      emit()
    }
  }
  refreshVault()
  return { done: queued.length - failed, failed }
}

export function dismissUpload(id: string) {
  uploads = uploads.filter((x) => x.id !== id)
  emit()
}

function send(u: Upload, headers: Record<string, string>, onProgress: (p: number) => void) {
  return new Promise<VaultItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/vault/upload`)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
      else {
        let msg = `Upload failed (${xhr.status})`
        try { msg = JSON.parse(xhr.responseText).detail ?? msg } catch { /* not JSON */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Can’t reach your server'))
    const form = new FormData()
    // React Native reads the file from its URI as it sends.
    form.append('file', { uri: u.local, name: u.name, type: u.mime || 'application/octet-stream' } as unknown as Blob)
    form.append('parent', u.parent)
    xhr.send(form)
  })
}

/** The folders from the top down to `id` (for headers and "Move to…"). */
export function pathTo(id: string, all: VaultItem[]) {
  const byId = new Map(all.map((r) => [r.id, r]))
  const out: VaultItem[] = []
  let at = byId.get(id)
  while (at) { out.unshift(at); at = at.parent ? byId.get(at.parent) : undefined }
  return out
}

/** Folders first (by name), then files, newest first. */
export const byFolderThenNewest = (a: VaultItem, b: VaultItem) =>
  a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1)
    : a.kind === 'folder' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : b.created_at.localeCompare(a.created_at)

// ------------------------------------------------------------------ browsing
export type Category = 'photos' | 'videos' | 'docs' | 'audio' | 'starred' | 'all'
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'photos', label: 'Photos' }, { id: 'videos', label: 'Videos' }, { id: 'docs', label: 'Documents' },
  { id: 'audio', label: 'Audio' }, { id: 'starred', label: 'Starred' }, { id: 'all', label: 'All files' },
]
const DOC_KINDS: FileKind[] = ['pdf', 'word', 'sheet', 'slides', 'markdown', 'text']

export function inCategory(r: VaultItem, c: Category) {
  if (c === 'starred') return r.starred
  if (r.kind !== 'file') return false
  const k = kindOf(r.name, r.mime)
  return c === 'all' || (c === 'photos' ? k === 'image' : c === 'videos' ? k === 'video' : c === 'audio' ? k === 'audio' : DOC_KINDS.includes(k))
}

export type Sort = 'date' | 'name' | 'size' | 'type'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'date', label: 'Date added' }, { id: 'name', label: 'Name' }, { id: 'size', label: 'Size' }, { id: 'type', label: 'Type' },
]

/** Folders first (by name), then files in the chosen order. */
export function sorter(sort: Sort) {
  return (a: VaultItem, b: VaultItem) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    if (a.kind === 'folder' || sort === 'name') return byName
    if (sort === 'size') return b.size - a.size || byName
    if (sort === 'type') return kindOf(a.name, a.mime).localeCompare(kindOf(b.name, b.mime)) || byName
    return b.created_at.localeCompare(a.created_at)
  }
}

/** How you like to browse (kept on the phone): list or grid, and the order. */
let prefs: { view: 'list' | 'grid'; sort: Sort } = { view: 'list', sort: 'date' }
const prefSubs = new Set<() => void>()
AsyncStorage.getItem('tl.vault.prefs').then((v) => { if (v) { prefs = { ...prefs, ...JSON.parse(v) }; prefSubs.forEach((f) => f()) } }, () => {})
export function useVaultPrefs() {
  const p = useSyncExternalStore((f) => { prefSubs.add(f); return () => { prefSubs.delete(f) } }, () => prefs)
  const set = (changes: Partial<typeof prefs>) => {
    prefs = { ...prefs, ...changes }
    prefSubs.forEach((f) => f())
    AsyncStorage.setItem('tl.vault.prefs', JSON.stringify(prefs)).catch(() => {})
  }
  return [p, set] as const
}
