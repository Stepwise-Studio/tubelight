// Google Drive inside the Vault: one Drive folder (or Starred / Recent), opened in the vault's viewer; add files from
// the phone, make folders, star, copy into the vault, remove (to Drive's trash).
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { RefreshControl, View, useWindowDimensions } from 'react-native'
import { FlatList, GestureDetector } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Delete02Icon, Edit02Icon, File01Icon, FolderAddIcon, Image01Icon, FolderExportIcon, GridViewIcon, LeftToRightListBulletIcon, Share08Icon, StarIcon, StarOffIcon, VaultIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { askName, shareItem } from '@/components/vault/actions'
import { openOutside } from '@/components/vault/outside'
import { useDragSelect } from '@/components/vault/drag-select'
import { Fab } from '@/components/vault/fab'
import { FolderPicker, type PickerDir } from '@/components/vault/folder-picker'
import { OutsideRow, OutsideTile, chunk } from '@/components/vault/outside-row'
import { SelectBar } from '@/components/vault/select-bar'
import { connectApp } from '@/lib/catalog'
import { driveFolders, driveToVault, driveViewable, editDrive, newDriveFolder, starDrive, trashDrive, uploadToDrive, useDriveAbout, useDriveFolder, type DriveItem } from '@/lib/drive'
import { refreshVault, useVaultPrefs } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, EmptyState, IconButton, SearchField, Segment, Skeleton, confirm, haptic, showMenu, toast } from '@/ui'

type View3 = 'root' | 'starred' | 'recent'

export default function DriveFolder() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const top = id === 'root'
  const [tab, setTab] = useState<View3>('root')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const folder = top ? tab : id
  const { about, reload: reloadAbout } = useDriveAbout()
  const { items, error, reload } = useDriveFolder(folder, query.trim())
  const parent = top ? 'root' : id
  const [prefs, setPrefs] = useVaultPrefs()
  const grid = prefs.view === 'grid'
  const { width } = useWindowDimensions()
  const tile = Math.floor((width - 32 - 16) / 3)
  const more = (f: DriveItem) => { haptic.light(); showMenu({ title: f.name, items: menuItems(f) }) }
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState<DriveItem[] | null>(null)
  const moveTo = async (dir: PickerDir) => {
    const list = moving ?? []
    toast({ title: `Moving ${list.length === 1 ? list[0].name : `${list.length} items`} to ${dir.name}` })
    const r = await Promise.allSettled(list.map((f) => editDrive(f.id, { parent: dir.id })))
    const failed = r.filter((x) => x.status === 'rejected').length
    toast(failed ? { title: `${list.length - failed} moved, ${failed} didn’t`, tone: 'error' } : { title: `Moved to ${dir.name}`, tone: 'success' })
    reload()
  }
  const selecting = selected.size > 0
  const files = (items ?? []).filter((f) => f.kind === 'file')
  const rows = grid ? chunk(items ?? [], 3) : (items ?? []).map((f) => [f])
  const drag = useDragSelect({
    order: files.map((f) => f.id),
    keyAt: (i, x) => {
      const f = grid ? rows[i]?.[Math.min(2, Math.max(0, Math.floor((x - 16) / (tile + 8))))] : rows[i]?.[0]
      return f?.kind === 'file' ? f.id : null
    },
    selected,
    setSelected,
    onHold: (i, x) => {
      const f = grid ? rows[i]?.[Math.min(2, Math.max(0, Math.floor((x - 16) / (tile + 8))))] : rows[i]?.[0]
      if (f) more(f)
    },
  })
  const toggle = (f: DriveItem) => { haptic.tap(); setSelected((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n }) }
  const tap = (f: DriveItem) => (selecting && f.kind === 'file' ? toggle(f) : open(f))
  const picked = files.filter((f) => selected.has(f.id))
  const bulk = async (what: string, run: (f: DriveItem) => Promise<unknown>, done: string) => {
    const list = picked
    setSelected(new Set())
    toast({ title: `${what} ${list.length} ${list.length === 1 ? 'file' : 'files'}` })
    const r = await Promise.allSettled(list.map(run))
    const failed = r.filter((x) => x.status === 'rejected').length
    toast(failed ? { title: `${list.length - failed} done, ${failed} didn’t work`, tone: 'error' } : { title: done, tone: 'success' })
    reload()
  }

  const open = async (f: DriveItem) => {
    haptic.tap()
    if (f.kind === 'folder') { router.push({ pathname: '/vault/drive/[id]', params: { id: f.id, name: f.name } }); return }
    try {
      const v = await driveViewable(f)
      openOutside(v, () => menuItems(f, () => shareItem(v)))
    } catch (e) {
      toast({ title: 'Unable to open it', body: (e as Error).message, tone: 'error' })
    }
  }
  const menuItems = (f: DriveItem, share?: () => void) => [
    { label: f.starred ? 'Unstar in Drive' : 'Star in Drive', icon: f.starred ? StarOffIcon : StarIcon, onPress: () => starDrive(f.id, !f.starred).then(() => {
      toast({ title: f.starred ? 'Unstarred in Drive' : 'Starred in Drive', body: f.name, tone: 'success' })
      reload()
    }, fail('Unable to star it')) },
    ...(f.kind === 'file' ? [
      { label: 'Save to Vault', icon: VaultIcon, onPress: () => {
        toast({ title: `Saving ${f.name} to your vault` })
        driveToVault(f.id).then(() => { refreshVault(); toast({ title: 'Saved to your vault', body: f.name, tone: 'success' }) }, fail('Unable to save it'))
      } },
      { label: 'Share', icon: Share08Icon, onPress: share ?? (() => driveViewable(f).then(shareItem, fail('Unable to share it'))) },
    ] : []),
    { label: 'Rename', icon: Edit02Icon, onPress: () => askName(f.kind === 'folder' ? 'Rename folder' : 'Rename file', 'Rename', (n) => editDrive(f.id, { name: n }).then(() => {
      toast({ title: `Renamed to ${n}`, tone: 'success' })
      reload()
      if (share) router.back()
    }), f.name) },
    { label: 'Move to…', icon: FolderExportIcon, onPress: () => setMoving([f]) },
    { label: 'Remove from Drive', icon: Delete02Icon, destructive: true, onPress: async () => {
      if (!await confirm({ title: `Remove ${f.name}?`, body: 'It goes to your Drive’s trash, where you can still restore it.', confirmLabel: 'Remove', destructive: true })) return
      trashDrive(f.id).then(() => {
        haptic.success()
        toast({ title: 'Moved to Drive’s trash', body: f.name, tone: 'success' })
        reload()
        if (share) router.back()
      }, fail('Unable to remove it'))
    } },
  ]
  const upload = async (files: { uri: string; name: string; mime?: string }[]) => {
    if (!files.length) return
    toast({ title: files.length === 1 ? `Uploading ${files[0].name}` : `Uploading ${files.length} files` })
    const up = await uploadToDrive(files, parent)
    toast(up.failed ? { title: `${up.done} uploaded, ${up.failed} didn’t`, tone: 'error' }
      : { title: up.done === 1 ? `${files[0].name} is in your Drive` : `${up.done} files are in your Drive`, tone: 'success' })
    reload()
  }
  const addItems = () => [
      { label: 'Photos & videos', icon: Image01Icon, onPress: async () => {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 0, quality: 1 })
        if (!r.canceled) upload(r.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `${a.type === 'video' ? 'Video' : 'Photo'} ${Date.now()}${i ? `-${i}` : ''}.${a.type === 'video' ? 'mp4' : 'jpg'}`, mime: a.mimeType ?? undefined })))
      } },
      { label: 'Files from this phone', icon: File01Icon, onPress: async () => {
        const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
        if (!r.canceled) upload(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? undefined })))
      } },
      { label: 'New folder', icon: FolderAddIcon, onPress: () => askName('New Drive folder', 'Create folder', (n) => newDriveFolder(n, parent).then(() => {
        toast({ title: `${n} is in your Drive`, tone: 'success' })
        reload()
      })) },
  ]

  if (about && !about.connected) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader title="Google Drive" subtitle="Vault" />
        <EmptyState title="Connect Google Drive" body="Browse, open, add and remove your Drive files from here. You sign in with Google; Tubelight never sees your password."
          action={<Button label="Connect Google Drive" onPress={() => connectApp('GOOGLEDRIVE', 'Google Drive').then(() => { reloadAbout(); reload() })} />} />
      </View>
    )
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={top ? 'Google Drive' : name ?? 'Folder'} subtitle={top ? about?.email ?? 'Vault' : 'Google Drive'}
        right={<>
          <IconButton icon={grid ? LeftToRightListBulletIcon : GridViewIcon} accessibilityLabel={grid ? 'Show as a list' : 'Show as a grid'}
            onPress={() => { haptic.tap(); setPrefs({ view: grid ? 'list' : 'grid' }) }} />
        </>} />
      <GestureDetector gesture={drag.gesture}>
      <View {...drag.wrapProps}>
      <FlatList
        {...drag.listProps}
        data={rows}
        keyExtractor={(row) => row[0].id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 100, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await reload(); setRefreshing(false) }} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 12 }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search your Drive" />
            {top && !query && <Segment value={tab} onChange={setTab} accessibilityLabel="Which files"
              options={[{ value: 'root', label: 'My Drive' }, { value: 'starred', label: 'Starred' }, { value: 'recent', label: 'Recent' }]} />}
          </View>
        }
        renderItem={({ item: row }) => grid ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12 }}>
            {row.map((f) => <OutsideTile key={f.id} name={f.name} mime={f.mime} dir={f.kind === 'folder'} thumb={f.thumb} size={tile} onPress={() => tap(f)}
              onHold={f.kind === 'file' ? () => drag.begin(f.id) : () => more(f)} selecting={selecting} selected={selected.has(f.id)} />)}
          </View>
        ) : (
          <OutsideRow name={row[0].name} mime={row[0].mime} dir={row[0].kind === 'folder'} size={row[0].size} date={row[0].updated_at} thumb={row[0].thumb}
            onPress={() => tap(row[0])} onMore={() => more(row[0])} onHold={row[0].kind === 'file' ? () => drag.begin(row[0].id) : undefined}
            selecting={selecting} selected={selected.has(row[0].id)} />
        )}
        ListEmptyComponent={!items && !error
          ? <View style={{ paddingHorizontal: 16, gap: 10 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
          : <EmptyState title={error ? 'Unable to reach Google Drive' : query ? 'Nothing matches' : 'Nothing here'}
              body={error ?? (query ? 'Try another name.' : tab === 'starred' && top ? 'Files you star in Drive show up here.' : 'Add files with +.')}
              action={error ? <Button label="Try again" onPress={reload} /> : undefined} />}
      />
      </View>
      </GestureDetector>
      {!selecting && (!top || tab === 'root') && <Fab label="Add to this Drive folder" items={addItems} bottom={insets.bottom + 16} />}
      {selecting && (
        <SelectBar count={selected.size} bottom={insets.bottom + 8} onClear={() => setSelected(new Set())} actions={[
          { icon: StarIcon, label: 'Star them in Drive', onPress: () => bulk('Starring', (f) => starDrive(f.id, true), 'Starred in Drive') },
          ...(picked.length === 1 ? [{ icon: Edit02Icon, label: 'Rename it', onPress: () => { const f = picked[0]; setSelected(new Set()); askName('Rename file', 'Rename', (n) => editDrive(f.id, { name: n }).then(() => { toast({ title: `Renamed to ${n}`, tone: 'success' }); reload() }), f.name) } }] : []),
          { icon: FolderExportIcon, label: 'Move them', onPress: () => { setMoving(picked); setSelected(new Set()) } },
          { icon: VaultIcon, label: 'Save them to the vault', onPress: () => bulk('Saving', (f) => driveToVault(f.id), 'Saved to your vault').then(() => refreshVault()) },
          { icon: Delete02Icon, label: 'Remove them from Drive', color: c.danger, onPress: async () => {
            if (!await confirm({ title: `Remove ${picked.length} ${picked.length === 1 ? 'file' : 'files'}?`, body: 'They go to your Drive’s trash, where you can still restore them.', confirmLabel: 'Remove', destructive: true })) return
            bulk('Removing', (f) => trashDrive(f.id), 'Moved to Drive’s trash')
          } },
        ]} />
      )}
      <FolderPicker open={!!moving} title={moving?.length === 1 ? `Move “${moving[0].name}”` : `Move ${moving?.length ?? 0} items`} root={{ id: 'root', name: 'My Drive' }}
        load={driveFolders} disabled={(d) => !!moving?.some((m) => m.id === d)} onPick={moveTo} onClose={() => setMoving(null)} />
    </View>
  )
}

const fail = (title: string) => (e: unknown) => toast({ title, body: (e as Error).message, tone: 'error' })
