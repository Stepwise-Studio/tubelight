// Google Drive inside the Vault: one Drive folder (or Starred / Recent), opened in the vault's viewer; add files from
// the phone, make folders, star, copy into the vault, remove (to Drive's trash).
import * as DocumentPicker from 'expo-document-picker'
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, Delete02Icon, File01Icon, FolderAddIcon, Share08Icon, StarIcon, StarOffIcon, VaultIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { askName, shareItem } from '@/components/vault/actions'
import { openOutside } from '@/components/vault/outside'
import { OutsideRow } from '@/components/vault/outside-row'
import { connectApp } from '@/lib/catalog'
import { driveToVault, driveViewable, newDriveFolder, starDrive, trashDrive, uploadToDrive, useDriveAbout, useDriveFolder, type DriveItem } from '@/lib/drive'
import { refreshVault } from '@/lib/vault'
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
    { label: f.starred ? 'Unstar in Drive' : 'Star in Drive', icon: f.starred ? StarOffIcon : StarIcon, onPress: () => starDrive(f.id, !f.starred).then(reload, fail('Unable to star it')) },
    ...(f.kind === 'file' ? [
      { label: 'Save to Vault', icon: VaultIcon, onPress: () => driveToVault(f.id).then(() => { refreshVault(); toast({ title: 'Saved to your vault', body: f.name, tone: 'success' }) }, fail('Unable to save it')) },
      { label: 'Share', icon: Share08Icon, onPress: share ?? (() => driveViewable(f).then(shareItem, fail('Unable to share it'))) },
    ] : []),
    { label: 'Remove from Drive', icon: Delete02Icon, destructive: true, onPress: async () => {
      if (!await confirm({ title: `Remove ${f.name}?`, body: 'It goes to your Drive’s trash, where you can still restore it.', confirmLabel: 'Remove', destructive: true })) return
      trashDrive(f.id).then(() => { haptic.success(); reload(); if (share) router.back() }, fail('Unable to remove it'))
    } },
  ]
  const add = () => showMenu({
    title: 'Add to Google Drive',
    items: [
      { label: 'Files from this phone', icon: File01Icon, onPress: async () => {
        const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
        if (r.canceled) return
        toast({ title: r.assets.length === 1 ? `Uploading ${r.assets[0].name}` : `Uploading ${r.assets.length} files` })
        const up = await uploadToDrive(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? undefined })), parent)
        toast(up.failed ? { title: `${up.done} uploaded, ${up.failed} didn’t`, tone: 'error' } : { title: 'In your Drive', tone: 'success' })
        reload()
      } },
      { label: 'New folder', icon: FolderAddIcon, onPress: () => askName('New Drive folder', 'Create folder', (n) => newDriveFolder(n, parent).then(reload)) },
    ],
  })

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
        right={(top ? tab === 'root' : true) && <IconButton icon={Add01Icon} accessibilityLabel="Add to this Drive folder" onPress={add} />} />
      <FlatList
        data={items ?? []}
        keyExtractor={(f) => f.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await reload(); setRefreshing(false) }} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 12 }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search your Drive" />
            {top && !query && <Segment value={tab} onChange={setTab} accessibilityLabel="Which files"
              options={[{ value: 'root', label: 'My Drive' }, { value: 'starred', label: 'Starred' }, { value: 'recent', label: 'Recent' }]} />}
          </View>
        }
        renderItem={({ item: f }) => (
          <OutsideRow name={f.name} mime={f.mime} dir={f.kind === 'folder'} size={f.size} date={f.updated_at} thumb={f.thumb}
            onPress={() => open(f)} onMore={() => { haptic.light(); showMenu({ title: f.name, items: menuItems(f) }) }} />
        )}
        ListEmptyComponent={!items && !error
          ? <View style={{ paddingHorizontal: 16, gap: 10 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
          : <EmptyState title={error ? 'Unable to reach Google Drive' : query ? 'Nothing matches' : 'Nothing here'}
              body={error ?? (query ? 'Try another name.' : tab === 'starred' && top ? 'Files you star in Drive show up here.' : 'Add files with +.')}
              action={error ? <Button label="Try again" onPress={reload} /> : undefined} />}
      />
    </View>
  )
}

const fail = (title: string) => (e: unknown) => toast({ title, body: (e as Error).message, tone: 'error' })
