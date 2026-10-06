// What you can do with a vault item, from anywhere: open, share, save to photos, star, rename, move, delete.
// Rename and Move are sheets in one host (mounted at the root), opened imperatively like menus.
import { File, Paths } from 'expo-file-system'
import { router } from 'expo-router'
import * as Sharing from 'expo-sharing'
import { Asset, requestPermissionsAsync } from 'expo-media-library'
import { useState, useSyncExternalStore } from 'react'
import { ScrollView, View } from 'react-native'
import {
  Delete02Icon, Download03Icon, Edit02Icon, FolderExportIcon, Share08Icon, StarIcon, StarOffIcon,
} from '@hugeicons/core-free-icons'

import { deleteItem, editItem, kindOf, newFolder, pathTo, refreshVault, useVault, viewable, type VaultItem, type Viewable } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, Press, Sheet, Text, TextField, confirm, haptic, showMenu, toast } from '@/ui'

import { FolderGlyph } from './file-tile'

export function openItem(item: VaultItem) {
  haptic.tap()
  if (item.kind === 'folder') router.push({ pathname: '/vault/[id]', params: { id: item.id } })
  else router.push({ pathname: '/vault/file/[id]', params: { id: item.id } })
}

/** The file on the phone (downloaded once into the cache), for sharing, PDFs and saving. */
export async function localCopy(item: Pick<Viewable, 'id' | 'name' | 'size' | 'src'>) {
  const dir = Paths.cache
  const file = new File(dir, `vault-${item.id.replace(/[^\w-]+/g, '_').slice(-60)}-${item.name.replace(/[^\w.-]+/g, '_')}`)
  if (file.exists && (!item.size || file.size === item.size)) return file
  if (file.exists) file.delete()
  return File.downloadFileAsync(item.src, file)
}

export async function shareItem(item: Viewable) {
  try {
    const f = await localCopy(item)
    await Sharing.shareAsync(f.uri, { mimeType: item.mime || undefined, dialogTitle: item.name })
  } catch (e) {
    toast({ title: 'Unable to share it', body: (e as Error).message, tone: 'error' })
  }
}

export async function saveToPhotos(item: Viewable) {
  try {
    const { granted } = await requestPermissionsAsync(true, ['photo', 'video'])
    if (!granted) { toast({ title: 'Allow Tubelight to save to your photos', body: 'Turn it on in Settings, then try again.', tone: 'error' }); return }
    const f = await localCopy(item)
    await Asset.create(f.uri)
    haptic.success()
    toast({ title: 'Saved to your photos', tone: 'success' })
  } catch (e) {
    toast({ title: 'Unable to save it', body: (e as Error).message, tone: 'error' })
  }
}

export async function removeItem(item: VaultItem, after?: () => void) {
  const what = item.kind === 'folder' ? 'this folder and everything in it' : item.name
  if (!await confirm({ title: `Delete ${item.kind === 'folder' ? item.name : 'this file'}?`, body: `This removes ${what} from your server for good.`, confirmLabel: 'Delete', destructive: true })) return
  after?.()
  deleteItem(item.id).then(() => haptic.success(), (e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' }))
}

export function toggleStar(item: VaultItem) {
  haptic.light()
  editItem(item.id, { starred: !item.starred }).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
}

export function itemMenu(item: VaultItem, opts: { onDeleted?: () => void; hideOpen?: boolean } = {}) {
  haptic.light()
  const media = ['image', 'video'].includes(kindOf(item.name, item.mime))
  showMenu({
    title: item.name,
    items: [
      { label: item.starred ? 'Unstar' : 'Star', icon: item.starred ? StarOffIcon : StarIcon, onPress: () => toggleStar(item) },
      ...(item.kind === 'file' ? [{ label: 'Share', icon: Share08Icon, onPress: () => shareItem(viewable(item)) }] : []),
      ...(media ? [{ label: 'Save to photos', icon: Download03Icon, onPress: () => saveToPhotos(viewable(item)) }] : []),
      { label: 'Rename', icon: Edit02Icon, onPress: () => renameItem(item) },
      { label: 'Move to…', icon: FolderExportIcon, onPress: () => moveItem(item) },
      { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => removeItem(item, opts.onDeleted) },
    ],
  })
}

// ------------------------------------------------------------------ sheets
type Req =
  | { kind: 'name'; title: string; value: string; label: string; confirm: string; submit: (name: string) => Promise<unknown> }
  | { kind: 'move'; item: VaultItem }
let req: Req | null = null
let shown = false
const subs = new Set<() => void>()
let n = 0
let snap: { req: Req | null; shown: boolean; n: number } = { req, shown, n }
const set = (r: Req | null, s: boolean) => { if (r) { req = r; n++ } shown = s; snap = { req, shown, n }; subs.forEach((f) => f()) }

export function newFolderSheet(parent: string) {
  set({ kind: 'name', title: 'New folder', value: '', label: 'Name', confirm: 'Create folder', submit: (name) => newFolder(name, parent) }, true)
}
export function renameItem(item: VaultItem) {
  set({ kind: 'name', title: item.kind === 'folder' ? 'Rename folder' : 'Rename file', value: item.name, label: 'Name', confirm: 'Rename', submit: (name) => editItem(item.id, { name }) }, true)
}
export function moveItem(item: VaultItem) { set({ kind: 'move', item }, true) }

export function VaultSheetsHost() {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => snap)
  const close = () => set(null, false)
  return (
    <>
      <NameSheet key={`n${s.n}`} open={s.shown && s.req?.kind === 'name'} req={s.req?.kind === 'name' ? s.req : null} onClose={close} />
      <MoveSheet open={s.shown && s.req?.kind === 'move'} item={s.req?.kind === 'move' ? s.req.item : null} onClose={close} />
    </>
  )
}

function NameSheet({ open, req: r, onClose }: { open: boolean; req: Extract<Req, { kind: 'name' }> | null; onClose: () => void }) {
  const [value, setValue] = useState(r?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!r) return null
  const submit = async () => {
    if (!value.trim()) { setError('Give it a name.'); return }
    setBusy(true)
    try {
      await r.submit(value.trim())
      haptic.success()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title={r.title}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
        <TextField label={r.label} value={value} onChangeText={(v) => { setValue(v); setError(null) }} error={error} autoFocus
          selectTextOnFocus maxLength={200} returnKeyType="done" onSubmitEditing={submit} />
        <Button label={r.confirm} fullWidth size="lg" loading={busy} onPress={submit} />
      </View>
    </Sheet>
  )
}

function MoveSheet({ open, item, onClose }: { open: boolean; item: VaultItem | null; onClose: () => void }) {
  const { items } = useVault()
  if (!item) return null
  const all = items ?? []
  // Never into itself or anything inside it.
  const inside = (id: string) => pathTo(id, all).some((p) => p.id === item.id)
  const folders = all.filter((r) => r.kind === 'folder' && !inside(r.id))
    .map((r) => ({ r, path: pathTo(r.id, all) }))
    .sort((a, b) => a.path.map((p) => p.name).join('/').localeCompare(b.path.map((p) => p.name).join('/')))
  const move = (parent: string) => {
    onClose()
    if (parent === item.parent) return
    editItem(item.id, { parent }).then(() => { haptic.success(); refreshVault() }, (e) => toast({ title: 'Unable to move it', body: (e as Error).message, tone: 'error' }))
  }
  return (
    <Sheet open={open} onClose={onClose} title={`Move “${item.name}”`}>
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}>
        <MoveRow label="Your vault" depth={0} current={item.parent === ''} onPress={() => move('')} />
        {folders.map(({ r, path }) => <MoveRow key={r.id} label={r.name} depth={path.length} current={item.parent === r.id} onPress={() => move(r.id)} />)}
        {!folders.length && <Text variant="footnote" color="ink3" style={{ padding: 12 }}>No other folders yet.</Text>}
      </ScrollView>
    </Sheet>
  )
}

function MoveRow({ label, depth, current, onPress }: { label: string; depth: number; current: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Press radius={12} onPress={onPress} disabled={current} accessibilityLabel={`Move to ${label}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingLeft: 8 + depth * 18, paddingRight: 8, opacity: current ? 0.45 : 1 }}>
      <FolderGlyph size={32} tint={depth ? undefined : c.ink2} />
      <Text variant="bodyMedium" style={{ flex: 1 }} numberOfLines={1}>{label}</Text>
      {current && <Text variant="footnote" color="ink3">Here now</Text>}
    </Press>
  )
}
