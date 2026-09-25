import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'

import { supabase } from './supabase'
import type { Attachment } from './types'

/** A file picked in the composer: local until uploaded, then `path` is set. */
export interface Draft {
  id: string
  uri: string
  name: string
  mime: string
  size: number
  width?: number
  height?: number
  path?: string
  failed?: boolean
}

export const MAX_BYTES = 25 * 1024 * 1024 // the bucket's limit
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const fromImages = (r: ImagePicker.ImagePickerResult): Draft[] => (r.canceled ? [] : r.assets.map((a) => ({
  id: id(), uri: a.uri, name: a.fileName || `photo-${id()}.jpg`, mime: a.mimeType || 'image/jpeg',
  size: a.fileSize ?? 0, width: a.width, height: a.height,
})))

export async function pickPhotos() {
  return fromImages(await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', allowsMultipleSelection: true, selectionLimit: 6, quality: 0.8 }))
}

export async function takePhoto() {
  const perm = await ImagePicker.requestCameraPermissionsAsync()
  if (!perm.granted) throw new Error('Allow camera access in Settings to take a photo.')
  return fromImages(await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 }))
}

export async function pickDocuments(): Promise<Draft[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  return r.canceled ? [] : r.assets.map((a) => ({ id: id(), uri: a.uri, name: a.name, mime: a.mimeType || 'application/octet-stream', size: a.size ?? 0 }))
}

/** Uploads to the private `attachments` bucket under the user's folder (RLS allows only their own). */
export async function upload(d: Draft): Promise<Attachment> {
  const { data } = await supabase.auth.getSession()
  const uid = data.session?.user.id
  if (!uid) throw new Error('Sign in again to attach files.')
  const body = await (await fetch(d.uri)).arrayBuffer()
  if (body.byteLength > MAX_BYTES) throw new Error(`${d.name} is over 25 MB.`)
  const path = `${uid}/${id()}-${d.name.replace(/[^\w.-]+/g, '_')}`
  const { error } = await supabase.storage.from('attachments').upload(path, body, { contentType: d.mime })
  if (error) throw new Error(error.message)
  return { path, name: d.name, mime: d.mime, size: d.size || body.byteLength, width: d.width, height: d.height }
}
