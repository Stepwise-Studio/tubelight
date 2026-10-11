// The phone's own files inside the Vault: its main folders and the newest documents anywhere on it (top), or one
// folder (path). Files open in the vault's viewer and can be kept in the vault or shared. Needs "All files access".
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { RefreshControl, View, useWindowDimensions } from 'react-native'
import { FlatList, GestureDetector } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Delete02Icon, Edit02Icon, FolderAddIcon, FolderExportIcon, GridViewIcon, LeftToRightListBulletIcon, Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { askName, shareItem } from '@/components/vault/actions'
import { FolderPicker, type PickerDir } from '@/components/vault/folder-picker'
import { PLACES, openPhoneFile, usePhoneAccess, type PhoneFile } from '@/components/vault/phone-files'
import { useDragSelect } from '@/components/vault/drag-select'
import { OutsideRow, OutsideTile, chunk } from '@/components/vault/outside-row'
import { SelectBar } from '@/components/vault/select-bar'
import { Phone } from '@/lib/phone'
import { uploadFiles, useVaultPrefs } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, EmptyState, IconButton, SearchField, Skeleton, Text, confirm, haptic, showMenu, toast } from '@/ui'

export default function PhoneFiles() {
  const { path, name } = useLocalSearchParams<{ path?: string; name?: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const allowed = usePhoneAccess()
  const [rows, setRows] = useState<PhoneFile[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [prefs, setPrefs] = useVaultPrefs()
  const { width } = useWindowDimensions()
  const tile = Math.floor((width - 32 - 16) / 3)

  const load = async () => {
    if (!allowed || !Phone?.listFiles || !Phone.recentFiles) return
    try {
      if (path) {
        const r = await Phone.listFiles(path)
        setRows(r.items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
      } else {
        const [top, recent] = await Promise.all([Phone.listFiles(''), Phone.recentFiles('docs', 60)])
        const places = PLACES.map((p) => top.items.find((x) => x.dir && x.name === p)).filter(Boolean) as PhoneFile[]
        setRows([...places, ...recent])
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { load() }, [allowed, path]) // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

  const title = path ? name ?? path.split('/').pop() ?? 'Folder' : 'This phone'
  const q = query.trim().toLowerCase()
  const shown = (rows ?? []).filter((f) => !q || f.name.toLowerCase().includes(q))
  const grid = prefs.view === 'grid'
  // Folders, then (at the top) the newest documents under their own heading; in a grid, three to a row.
  const groups = path ? [{ label: '', items: shown }] : [{ label: '', items: shown.filter((f) => f.dir) }, { label: 'Recent documents', items: shown.filter((f) => !f.dir) }]
  const blocks: { key: string; label?: string; items?: PhoneFile[] }[] = []
  for (const g of groups) {
    if (!g.items.length) continue
    if (g.label) blocks.push({ key: `l-${g.label}`, label: g.label })
    for (const r of grid ? chunk(g.items, 3) : g.items.map((f) => [f])) blocks.push({ key: r[0].path, items: r })
  }
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState<PhoneFile[] | null>(null)
  const selecting = selected.size > 0
  const files = blocks.flatMap((b) => (b.items ?? []).filter((f) => !f.dir))
  const drag = useDragSelect({
    order: files.map((f) => f.path),
    keyAt: (i, x) => {
      const r = blocks[i]?.items
      const f = grid ? r?.[Math.min(2, Math.max(0, Math.floor((x - 16) / (tile + 8))))] : r?.[0]
      return f && !f.dir ? f.path : null
    },
    selected,
    setSelected,
  })
  const toggle = (f: PhoneFile) => { haptic.tap(); setSelected((s) => { const n = new Set(s); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n }) }
  const picked = files.filter((f) => selected.has(f.path))
  const label = (f: PhoneFile) => (f.dir && f.name === 'Download' ? 'Downloads' : f.name)
  const open = (f: PhoneFile) => (selecting && !f.dir ? toggle(f) : f.dir ? router.push({ pathname: '/vault/phone', params: { path: f.path, name: label(f) } }) : openPhoneFile(f))
  const more = (f: PhoneFile) => showMenu({ title: label(f), items: [
    ...(f.dir ? [] : [
      { label: 'Save to Vault', icon: VaultIcon, onPress: () => {
        toast({ title: `Saving ${f.name} to your vault` })
        uploadFiles([{ uri: `file://${f.path}`, name: f.name, mime: f.mime, size: f.size }], '')
          .then((r) => toast(r.done ? { title: 'Saved to your vault', body: f.name, tone: 'success' } : { title: 'Unable to save it', tone: 'error' }))
      } },
      { label: 'Share or open in…', icon: Share08Icon, onPress: () => shareItem({ id: f.path, name: f.name, mime: f.mime, size: f.size, src: `file://${f.path}` }) },
    ]),
    { label: 'Rename', icon: Edit02Icon, onPress: () => askName(f.dir ? 'Rename folder' : 'Rename file', 'Rename', async (n) => {
      await Phone!.renameFile!(f.path, n)
      toast({ title: `Renamed to ${n}`, tone: 'success' })
      load()
    }, f.name) },
    { label: 'Move to…', icon: FolderExportIcon, onPress: () => setMoving([f]) },
    { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => removeFiles([f]) },
  ] })
  const removeFiles = async (list: PhoneFile[]) => {
    const one = list.length === 1 ? list[0] : null
    if (!await confirm({ title: one ? `Delete ${label(one)}?` : `Delete ${list.length} items?`,
      body: `${one?.dir ? 'The folder and everything in it are' : one ? 'It’s' : 'They’re'} removed from this phone for good.`, confirmLabel: 'Delete', destructive: true })) return
    setSelected(new Set())
    try {
      const n = await Phone!.deleteFiles!(list.map((f) => f.path))
      haptic.success()
      toast({ title: one ? `${label(one)} deleted` : `${n} items deleted`, tone: 'success' })
    } catch (e) {
      toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' })
    }
    load()
  }
  const moveTo = async (dir: PickerDir) => {
    const list = moving ?? []
    setSelected(new Set())
    try {
      await Phone!.moveFiles!(list.map((f) => f.path), dir.id)
      toast({ title: `Moved to ${dir.name}`, tone: 'success' })
    } catch (e) {
      toast({ title: 'Unable to move', body: (e as Error).message, tone: 'error' })
    }
    load()
  }
  const phoneDirs = (at: string) => Phone!.listFiles!(at).then((r) => r.items.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.path, name: x.name })))
  const newFolder = () => askName('New folder', 'Create folder', async (n) => {
    await Phone!.makeFolder!(path ?? '', n)
    toast({ title: `${n} is on your phone`, tone: 'success' })
    load()
  })
  if (!Phone?.listFiles) {
    return <View style={{ flex: 1, backgroundColor: c.canvas }}><ScreenHeader title={title} /><EmptyState title="Update Tubelight" body="This version can’t read the phone’s files yet." /></View>
  }
  if (!allowed) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader title={title} subtitle="Vault" />
        <EmptyState title="See your phone’s files here"
          body="Allow Tubelight to manage all files, the way a file manager does: your downloads and documents then show in the Vault and open in its viewer. Nothing leaves the phone unless you save it to the vault."
          action={<Button label="Allow in Settings" onPress={() => Phone?.openFilesAccess?.()} />} />
      </View>
    )
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={title} subtitle={path ? 'This phone' : 'Vault'} right={
        <>
          <IconButton icon={grid ? LeftToRightListBulletIcon : GridViewIcon} accessibilityLabel={grid ? 'Show as a list' : 'Show as a grid'}
            onPress={() => { haptic.tap(); setPrefs({ view: grid ? 'list' : 'grid' }) }} />
          {!!path && <IconButton icon={FolderAddIcon} accessibilityLabel="New folder here" onPress={newFolder} />}
        </>
      } />
      <GestureDetector gesture={drag.gesture}>
      <View {...drag.wrapProps}>
      <FlatList
        {...drag.listProps}
        data={blocks}
        keyExtractor={(b) => b.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}><SearchField value={query} onChangeText={setQuery} placeholder={path ? 'Search this folder' : 'Search recent documents'} /></View>}
        renderItem={({ item: b }) => b.label ? (
          <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingLeft: 20, paddingTop: 18, paddingBottom: 6 }}>{b.label}</Text>
        ) : grid ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12 }}>
            {b.items!.map((f) => <OutsideTile key={f.path} name={label(f)} mime={f.mime} dir={f.dir} size={tile} thumb={f.mime.startsWith('image/') ? `file://${f.path}` : null}
              onPress={() => open(f)} onHold={f.dir ? () => more(f) : () => drag.begin(f.path)} selecting={selecting} selected={selected.has(f.path)} />)}
          </View>
        ) : (() => {
          const f = b.items![0]
          return (
            <OutsideRow name={label(f)} mime={f.mime} dir={f.dir} size={f.size} date={f.dir ? undefined : f.modified} thumb={f.mime.startsWith('image/') ? `file://${f.path}` : null}
              meta={f.dir ? `${f.size} ${f.size === 1 ? 'item' : 'items'}` : undefined} onPress={() => open(f)} onMore={() => more(f)}
              onHold={f.dir ? undefined : () => drag.begin(f.path)} selecting={selecting} selected={selected.has(f.path)} />
          )
        })()}
        ListEmptyComponent={!rows && !error
          ? <View style={{ paddingHorizontal: 16, gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
          : <EmptyState title={error ? 'Unable to read this folder' : q ? 'Nothing matches' : 'Empty'} body={error ?? (q ? 'Try another name.' : 'Nothing in this folder yet.')} />}
      />
      </View>
      </GestureDetector>
      {selecting && (
        <SelectBar count={selected.size} bottom={insets.bottom + 8} onClear={() => setSelected(new Set())} actions={[
          ...(picked.length === 1 ? [{ icon: Edit02Icon, label: 'Rename it', onPress: () => { const f = picked[0]; setSelected(new Set()); askName('Rename file', 'Rename', async (n) => { await Phone!.renameFile!(f.path, n); toast({ title: `Renamed to ${n}`, tone: 'success' }); load() }, f.name) } }] : []),
          { icon: FolderExportIcon, label: 'Move them', onPress: () => setMoving(picked) },
          { icon: VaultIcon, label: 'Save them to the vault', onPress: () => {
            const list = picked
            setSelected(new Set())
            toast({ title: `Saving ${list.length} ${list.length === 1 ? 'file' : 'files'} to your vault` })
            uploadFiles(list.map((f) => ({ uri: `file://${f.path}`, name: f.name, mime: f.mime, size: f.size })), '')
              .then((r) => toast(r.failed ? { title: `${r.done} saved, ${r.failed} didn’t`, tone: 'error' } : { title: 'Saved to your vault', tone: 'success' }))
          } },
          { icon: Delete02Icon, label: 'Delete them', color: c.danger, onPress: () => removeFiles(picked) },
          ...(picked.length === 1 ? [{ icon: Share08Icon, label: 'Share it', onPress: () => shareItem({ id: picked[0].path, name: picked[0].name, mime: picked[0].mime, size: picked[0].size, src: `file://${picked[0].path}` }) }] : []),
        ]} />
      )}
      <FolderPicker open={!!moving} title={moving?.length === 1 ? `Move “${label(moving[0])}”` : `Move ${moving?.length ?? 0} items`}
        root={{ id: '/storage/emulated/0', name: 'This phone' }} load={phoneDirs}
        disabled={(d) => !!moving?.some((m) => m.path === d)} onPick={moveTo} onClose={() => setMoving(null)} />
    </View>
  )
}
