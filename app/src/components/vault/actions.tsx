// What you can do with a vault item, from anywhere: open, share, save to photos, star, rename, move, delete.
// Rename and Move are sheets in one host (mounted at the root), opened imperatively like menus.
import { File, Paths } from 'expo-file-system'
import { router } from 'expo-router'
import * as Sharing from 'expo-sharing'
import { Asset, requestPermissionsAsync } from 'expo-media-library'
import { useState, useSyncExternalStore } from 'react'
import { ScrollView, View } from 'react-native'
import {
  CheckmarkCircle02Icon, Delete02Icon, Download03Icon, Edit02Icon, FolderExportIcon, PaintBrush02Icon, RefreshIcon, Share08Icon,
  StarIcon, StarOffIcon,
} from '@hugeicons/core-free-icons'

import { deleteItem, editItem, kindOf, newFolder, pathTo, refreshVault, syncNow, syncedCopy, syncedRoot, useVault, viewable, type VaultItem, type Viewable } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, Icon, Press, Sheet, Text, TextField, confirm, haptic, showMenu, toast, type MenuItem } from '@/ui'

import { ColorSwatches } from '@/components/form-bits'

import { FolderGlyph } from './file-tile'
import { FOLDER_COLORS, FOLDER_ICONS, Folder, type FolderIconName } from './folder'

export function openItem(item: VaultItem) {
  haptic.tap()
  if (item.kind === 'folder') router.push({ pathname: '/vault/[id]', params: { id: item.id } })
  else router.push({ pathname: '/vault/file/[id]', params: { id: item.id } })
}

/** The file on the phone (downloaded once into the cache), for sharing, PDFs and saving. */
export async function localCopy(item: Pick<Viewable, 'id' | 'name' | 'size' | 'src'>) {
  if (item.src.startsWith('file:')) return new File(item.src) // already on the phone (a file another app opened)
  const dir = Paths.cache
  const file = new File(dir, `vault-${item.id.replace(/[^\w-]+/g, '_').slice(-60)}-${item.name.replace(/[^\w.-]+/g, '_')}`)
  if (file.exists && (!item.size || file.size === item.size)) return file
  if (file.exists) file.delete()
  return File.downloadFileAsync(item.src, file)
}

export async function shareItem(item: Pick<Viewable, 'id' | 'name' | 'size' | 'src' | 'mime'>) {
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
  if (syncedRoot(item)) {
    if (!await confirm({ title: `Stop syncing ${item.name}?`, body: `Its copies leave your vault. Nothing changes on ${item.meta.source!.name}.`, confirmLabel: 'Stop syncing', destructive: true })) return
    after?.()
    deleteItem(item.id).then(() => haptic.success(), (e) => toast({ title: 'Unable to stop syncing', body: (e as Error).message, tone: 'error' }))
    return
  }
  const what = item.kind === 'folder' ? 'this folder and everything in it' : item.name
  if (!await confirm({ title: `Delete ${item.kind === 'folder' ? item.name : 'this file'}?`, body: `This removes ${what} from your server for good.`, confirmLabel: 'Delete', destructive: true })) return
  after?.()
  deleteItem(item.id).then(() => haptic.success(), (e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' }))
}

export function toggleStar(item: VaultItem) {
  haptic.light()
  editItem(item.id, { starred: !item.starred }).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
}

export function itemMenu(item: VaultItem, opts: { onDeleted?: () => void; onSelect?: () => void } = {}) {
  haptic.light()
  showMenu({ title: item.name, items: itemActions(item, opts) })
}

/** What can be done with an item, for the action sheet (itemMenu) or a menu in place (showContextMenu). */
export function itemActions(item: VaultItem, opts: { onDeleted?: () => void; onSelect?: () => void } = {}): MenuItem[] {
  const media = ['image', 'video'].includes(kindOf(item.name, item.mime))
  const copy = syncedCopy(item) // the computer owns it: rename, move and delete happen there
  return [
      ...(opts.onSelect ? [{ label: 'Select', icon: CheckmarkCircle02Icon, onPress: opts.onSelect }] : []),
      { label: item.starred ? 'Unstar' : 'Star', icon: item.starred ? StarOffIcon : StarIcon, onPress: () => toggleStar(item) },
      ...(item.kind === 'file' ? [{ label: 'Share', icon: Share08Icon, onPress: () => shareItem(viewable(item)) }] : []),
      ...(media ? [{ label: 'Save to photos', icon: Download03Icon, onPress: () => saveToPhotos(viewable(item)) }] : []),
      ...(item.kind === 'folder' ? [{ label: 'Customise', icon: PaintBrush02Icon, onPress: () => customiseFolder(item) }] : []),
      ...(syncedRoot(item) ? [{ label: 'Sync now', icon: RefreshIcon, onPress: () => syncFolderNow(item) }] : []),
      ...(copy ? [] : [
        { label: 'Rename', icon: Edit02Icon, onPress: () => renameItem(item) },
        { label: 'Move to…', icon: FolderExportIcon, onPress: () => moveItem(item) },
        { label: syncedRoot(item) ? 'Stop syncing' : 'Delete', icon: Delete02Icon, destructive: true, onPress: () => removeItem(item, opts.onDeleted) },
      ]),
  ]
}

async function syncFolderNow(item: VaultItem) {
  try {
    const r = await syncNow(item.id)
    if (r.busy) toast({ title: 'Already syncing', body: 'New files show up as they arrive.' })
    else if (r.error) toast({ title: 'Synced, with a problem', body: r.error, tone: 'error' })
    else toast({ title: r.added || r.removed ? `${r.added ?? 0} added, ${r.removed ?? 0} removed` : 'Already up to date', tone: 'success' })
  } catch (e) {
    toast({ title: 'Unable to sync', body: (e as Error).message, tone: 'error' })
  }
}

// ------------------------------------------------------------------ sheets
type Req =
  | { kind: 'name'; title: string; value: string; label: string; confirm: string; submit: (name: string) => Promise<unknown> }
  | { kind: 'move'; items: VaultItem[] }
  | { kind: 'look'; item: VaultItem }
let req: Req | null = null
let shown = false
const subs = new Set<() => void>()
let n = 0
let snap: { req: Req | null; shown: boolean; n: number } = { req, shown, n }
const set = (r: Req | null, s: boolean) => { if (r) { req = r; n++ } shown = s; snap = { req, shown, n }; subs.forEach((f) => f()) }

export function newFolderSheet(parent: string) {
  set({ kind: 'name', title: 'New folder', value: '', label: 'Name', confirm: 'Create folder', submit: (name) => newFolder(name, parent) }, true)
}
/** Asks for a name in the vault's name sheet (new Drive folders and the like). */
export function askName(title: string, confirmLabel: string, submit: (name: string) => Promise<unknown>) {
  set({ kind: 'name', title, value: '', label: 'Name', confirm: confirmLabel, submit }, true)
}
export function renameItem(item: VaultItem) {
  set({ kind: 'name', title: item.kind === 'folder' ? 'Rename folder' : 'Rename file', value: item.name, label: 'Name', confirm: 'Rename', submit: (name) => editItem(item.id, { name }) }, true)
}
export function customiseFolder(item: VaultItem) { set({ kind: 'look', item }, true) }
export function moveItem(item: VaultItem) { set({ kind: 'move', items: [item] }, true) }
export function moveItems(items: VaultItem[]) { if (items.length) set({ kind: 'move', items }, true) }

export function VaultSheetsHost() {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => snap)
  const close = () => set(null, false)
  return (
    <>
      <NameSheet key={`n${s.n}`} open={s.shown && s.req?.kind === 'name'} req={s.req?.kind === 'name' ? s.req : null} onClose={close} />
      <MoveSheet open={s.shown && s.req?.kind === 'move'} moving={s.req?.kind === 'move' ? s.req.items : null} onClose={close} />
      <LookSheet key={`l${s.n}`} open={s.shown && s.req?.kind === 'look'} item={s.req?.kind === 'look' ? s.req.item : null} onClose={close} />
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

function MoveSheet({ open, moving, onClose }: { open: boolean; moving: VaultItem[] | null; onClose: () => void }) {
  const { items } = useVault()
  if (!moving?.length) return null
  const all = items ?? []
  const ids = new Set(moving.map((m) => m.id))
  // Never into one of the moving folders or anything inside them.
  const inside = (id: string) => pathTo(id, all).some((p) => ids.has(p.id))
  const folders = all.filter((r) => r.kind === 'folder' && !inside(r.id))
    .map((r) => ({ r, path: pathTo(r.id, all) }))
    .sort((a, b) => a.path.map((p) => p.name).join('/').localeCompare(b.path.map((p) => p.name).join('/')))
  const here = moving.length === 1 ? moving[0].parent : null
  const move = (parent: string) => {
    onClose()
    Promise.all(moving.filter((m) => m.parent !== parent).map((m) => editItem(m.id, { parent })))
      .then(() => { haptic.success(); refreshVault() }, (e) => toast({ title: 'Unable to move', body: (e as Error).message, tone: 'error' }))
  }
  return (
    <Sheet open={open} onClose={onClose} title={moving.length === 1 ? `Move “${moving[0].name}”` : `Move ${moving.length} items`}>
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}>
        <MoveRow label="Your vault" depth={0} current={here === ''} onPress={() => move('')} />
        {folders.map(({ r, path }) => <MoveRow key={r.id} label={r.name} depth={path.length} current={here === r.id} onPress={() => move(r.id)} />)}
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

/** A folder's colour and icon, with the folder itself as the preview (like Stepwise UI's Colors & icon demo). */
function LookSheet({ open, item, onClose }: { open: boolean; item: VaultItem | null; onClose: () => void }) {
  const { c } = useTheme()
  const [color, setColor] = useState(item?.meta.look?.color ?? '')
  const [icon, setIcon] = useState<FolderIconName | ''>((item?.meta.look?.icon as FolderIconName) ?? 'folder')
  if (!item) return null
  const save = () => {
    onClose()
    editItem(item.id, { look: { color, icon } }).then(() => haptic.success(), (e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
  }
  return (
    <Sheet open={open} onClose={onClose} title="Customise folder">
      <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 20 }}>
        <View style={{ alignItems: 'center', paddingTop: 8 }} pointerEvents="none">
          <Folder size={170} label={item.name} color={color} icon={icon} onPress={() => {}} />
        </View>
        <ColorSwatches colors={FOLDER_COLORS.map((x) => ({ ...x, value: x.value || c.panel3 }))} value={color || c.panel3}
          onChange={(v) => setColor(v === c.panel3 ? '' : v)} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }} accessibilityRole="radiogroup" accessibilityLabel="Icon">
          {(['', ...Object.keys(FOLDER_ICONS)] as (FolderIconName | '')[]).map((k) => {
            const on = k === icon
            return (
              <Press key={k || 'none'} radius={12} onPress={() => { haptic.tap(); setIcon(k) }} accessibilityRole="radio" accessibilityState={{ checked: on }}
                accessibilityLabel={k ? `${k} icon` : 'No icon'}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.tubeSoft : c.panel2, borderWidth: 1, borderColor: on ? c.tube : c.line }}>
                {k ? <Icon icon={FOLDER_ICONS[k]} size={20} color={on ? 'tube' : 'ink2'} strokeWidth={1.8} /> : <Text variant="footnote" color={on ? 'tube' : 'ink3'}>None</Text>}
              </Press>
            )
          })}
        </View>
        <Button label="Save" fullWidth size="lg" onPress={save} />
      </View>
    </Sheet>
  )
}
