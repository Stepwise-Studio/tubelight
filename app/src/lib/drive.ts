// Google Drive in the Vault (agent-service drive.py): browse, open, add and remove Drive files. The server talks to
// Drive through the user's Composio connection; uploads go from the phone straight to Google.
import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy'
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { VaultItem, Viewable } from '@/lib/vault'

export interface DriveItem {
  id: string
  kind: 'folder' | 'file'
  name: string
  mime: string
  size: number
  updated_at: string
  starred: boolean
  thumb: string | null
  /** A Google Doc, Sheet or Slides file (opens as a PDF). */
  google: boolean
}
export interface DriveAbout { connected: boolean; email?: string; used?: number; quota?: number }

let about: DriveAbout | null = null
export function useDriveAbout() {
  const [a, setA] = useState<DriveAbout | null>(about)
  const reload = useCallback(() => api<DriveAbout>('/drive').then((r) => { about = r; setA(r) }, () => {}), [])
  useEffect(() => { reload() }, [reload])
  return { about: a, reload }
}

const lists = new Map<string, DriveItem[]>()
/** A Drive folder ('root', 'starred', 'recent' or an id), cached for instant back-navigation. */
export function useDriveFolder(folder: string, query = '') {
  const key = `${folder}|${query}`
  const [items, setItems] = useState<DriveItem[] | null>(lists.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const r = await api<{ items: DriveItem[] }>(`/drive/files?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(query)}`)
      lists.set(key, r.items)
      setItems(r.items)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [folder, query, key])
  useEffect(() => {
    setItems(lists.get(key) ?? null) // eslint-disable-line react-hooks/set-state-in-effect -- show the cached list for this folder at once
    reload()
  }, [key, reload])
  return { items, error, reload }
}

/** Something to open in the viewer: a fresh download link (Google files come as PDFs). */
export async function driveViewable(f: DriveItem): Promise<Viewable> {
  const r = await api<DriveItem & { url: string }>(`/drive/files/${f.id}/open`)
  return { id: `drive:${f.id}`, name: r.name, mime: r.mime, size: r.size, meta: {}, src: r.url, thumb: f.thumb ?? undefined, preview: `/drive/files/${f.id}/preview` }
}

export const trashDrive = (id: string) => api(`/drive/files/${id}`, { method: 'DELETE' })
export const editDrive = (id: string, changes: { starred?: boolean; name?: string; parent?: string }) => api<DriveItem>(`/drive/files/${id}`, { method: 'PATCH', json: changes })
export const starDrive = (id: string, starred: boolean) => editDrive(id, { starred })
/** The folders inside a Drive folder (for Move to…). */
export const driveFolders = (id: string) => api<{ items: DriveItem[] }>(`/drive/files?folder=${encodeURIComponent(id)}`).then((r) => r.items.filter((f) => f.kind === 'folder'))
export const newDriveFolder = (name: string, parent: string) => api<DriveItem>('/drive/folders', { method: 'POST', json: { name, parent } })
export const driveToVault = (id: string, parent = '') => api<VaultItem>(`/drive/files/${id}/vault`, { method: 'POST', json: { parent } })

/** Puts files from the phone into a Drive folder: the server opens an upload, the phone sends the bytes to Google. */
export async function uploadToDrive(files: { uri: string; name: string; mime?: string }[], parent: string) {
  let done = 0
  for (const f of files) {
    try {
      const { url } = await api<{ url: string }>('/drive/upload', { method: 'POST', json: { name: f.name, parent, mime: f.mime ?? '' } })
      const r = await uploadAsync(url, f.uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: f.mime ? { 'Content-Type': f.mime } : {} })
      if (r.status >= 200 && r.status < 300) done++
    } catch { /* counted as failed */ }
  }
  return { done, failed: files.length - done }
}
