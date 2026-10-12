// The Vault, as a file manager. At the top: your folders (Stepwise folders; ones synced from a computer carry its
// mark), then cloud drives (Google Drive), the phone's own files, Browse by kind, and the files kept loose at the top.
// The same browser shows a folder or a category. Long-press a file to select several; long-press a folder for its menu.
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshControl, View, useWindowDimensions } from 'react-native'
import { FlatList, GestureDetector } from 'react-native-gesture-handler'
import {
  Add01Icon, ArrowDown01Icon, ArrowRight01Icon, Camera01Icon, Cancel01Icon, Delete02Icon, Edit02Icon,
  File01Icon, FolderAddIcon, FolderExportIcon, FolderSyncIcon, GridViewIcon, Image01Icon, LaptopIcon,
  LeftToRightListBulletIcon, MoreHorizontalIcon, ViewOffSlashIcon, MusicNote01Icon, PlayIcon, Share08Icon, SmartPhone01Icon, StarIcon,
} from '@hugeicons/core-free-icons'

import {
  CATEGORIES, SORTS, deleteItem, syncedCopy, dismissUpload, editItem, fileUrl, formatSize, inCategory, kindOf, refreshVault, sorter,
  uploadFiles, useVault, useVaultPrefs, viewable, type Category, type Upload, type VaultItem,
} from '@/lib/vault'
import { useDriveAbout } from '@/lib/drive'
import { Phone } from '@/lib/phone'
import { useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Press, SearchField, Sheet, Skeleton, Text, SelectDot, confirm, type MenuItem, haptic, showContextMenu, showMenu, toast } from '@/ui'

import { itemActions, itemMenu, moveItems, newFolderSheet, openItem, renameItem, shareItem } from './actions'
import { Folder, type FolderIconName } from './folder'
import { FileIcon, KIND_COLOR } from './file-icon'
import { FolderGlyph } from './file-tile'
import { DriveLogo } from './drive-logo'
import { Fab } from './fab'
import { FilePreview } from './preview'
import { SelectBar } from './select-bar'
import { useDragSelect } from './drag-select'

type Row =
  | { type: 'title'; key: string; label: string; controls?: boolean }
  | { type: 'folders'; key: string; items: VaultItem[] }
  | { type: 'places'; key: string }
  | { type: 'tiles'; key: string; items: VaultItem[] }
  | { type: 'file'; key: string; item: VaultItem }
  | { type: 'upload'; key: string; upload: Upload }

const CAT_LOOK: Record<Category, { icon: Parameters<typeof Icon>[0]['icon']; color: string }> = {
  photos: { icon: Image01Icon, color: KIND_COLOR.image }, videos: { icon: PlayIcon, color: KIND_COLOR.video },
  docs: { icon: File01Icon, color: KIND_COLOR.pdf }, audio: { icon: MusicNote01Icon, color: KIND_COLOR.audio },
  starred: { icon: StarIcon, color: '#e5a50a' }, all: { icon: FolderAddIcon, color: '#8b8b93' },
}

export function VaultBrowser({ parent = '', category, header, root, bottom = 24, fab }: {
  parent?: string; category?: Category; header: ReactNode; root?: boolean
  /** The floating + (adds to this folder); hidden while choosing several. */
  fab?: boolean
  /** Space under the content (and where the selection bar floats). */
  bottom?: number
}) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const { items, uploads, error } = useVault()
  const [prefs, setPrefs] = useVaultPrefs()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const all = useMemo(() => items ?? [], [items])
  const selecting = selected.size > 0
  const media = category === 'photos' || category === 'videos'
  const view = media ? 'grid' : prefs.view

  const stats = useMemo(() => {
    const m = new Map<string, { n: number; bytes: number; thumbs: string[] }>()
    for (const r of all) {
      const s = m.get(r.parent) ?? { n: 0, bytes: 0, thumbs: [] }
      s.n++
      s.bytes += r.size
      if (r.thumb && s.thumbs.length < 3) s.thumbs.push(fileUrl(r.thumb)) // photos peek out of the folder
      m.set(r.parent, s)
    }
    return m
  }, [all])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const byId = new Map(all.map((x) => [x.id, x]))
    const inside = (r: VaultItem) => {
      if (!parent) return true
      for (let at = byId.get(r.parent); at; at = byId.get(at.parent)) if (at.id === parent) return true
      return false
    }
    let list = q ? all.filter((r) => r.name.toLowerCase().includes(q) && inside(r) && (!category || inCategory(r, category)))
      : category ? all.filter((r) => inCategory(r, category))
        : all.filter((r) => r.parent === parent)
    list = [...list].sort(sorter(prefs.sort))
    const folders = list.filter((r) => r.kind === 'folder')
    const files = list.filter((r) => r.kind === 'file')
    const out: Row[] = []
    const chunk = (l: VaultItem[], n: number, type: 'folders' | 'tiles') => {
      for (let i = 0; i < l.length; i += n) out.push({ type, key: `${type}-${l[i].id}`, items: l.slice(i, i + n) })
    }
    if (folders.length && !(root && !q)) out.push({ type: 'title', key: 't-f', label: 'Folders' }) // the top shows folders without a heading
    chunk(folders, 2, 'folders')
    if (root && !q && !category) out.push({ type: 'places', key: 'places' })
    const ups = q || category ? [] : uploads.filter((u) => u.parent === parent)
    if (files.length || ups.length) {
      out.push({ type: 'title', key: 't-d', label: q ? 'Matches' : category ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : root ? 'Loose files' : 'Files', controls: true })
      for (const u of ups) out.push({ type: 'upload', key: u.id, upload: u })
      if (view === 'grid') chunk(files, 3, 'tiles')
      else for (const f of files) out.push({ type: 'file', key: f.id, item: f })
    }
    return out
  }, [all, uploads, parent, category, query, prefs.sort, view, root])

  const tile = Math.floor((width - 32 - 16) / 3)
  // Hold a file, then slide over others to choose them all (tiles: which column from x).
  const drag = useDragSelect({
    order: useMemo(() => rows.flatMap((r) => (r.type === 'file' ? [r.item.id] : r.type === 'tiles' ? r.items.map((x) => x.id) : [])), [rows]),
    keyAt: (i, x) => {
      const r = rows[i]
      if (r?.type === 'file') return r.item.id
      if (r?.type === 'tiles') return r.items[Math.min(2, Math.max(0, Math.floor((x - 16) / (tile + 8))))]?.id ?? null
      return null
    },
    selected,
    setSelected,
    onHold: (i, x) => {
      const r = rows[i]
      if (r?.type === 'folders') folderHolds.get(r.items[x < 16 + card + 5 ? 0 : 1]?.id ?? '')?.()
    },
  })
  const card = Math.floor((width - 32 - 10) / 2)
  const picked = all.filter((r) => selected.has(r.id))
  const toggle = (r: VaultItem) => {
    haptic.tap()
    setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n })
  }
  const press = (r: VaultItem) => (selecting ? toggle(r) : openItem(r))
  const hold = (r: VaultItem) => drag.begin(r.id) // choose it, then slide to choose more
  const clear = () => setSelected(new Set())

  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={drag.gesture}>
      <View {...drag.wrapProps}>
      <FlatList
      {...drag.listProps}
        data={items ? rows : []}
        keyExtractor={(r) => r.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottom + (selecting || fab ? 96 : 40), flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshVault(); setRefreshing(false) }}
          tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={
          <View>
            {header}
            <View style={{ paddingHorizontal: 16, gap: 14, paddingBottom: root && !query ? 18 : 2 }}>
              <SearchField value={query} onChangeText={setQuery} placeholder={category ? `Search ${CATEGORIES.find((x) => x.id === category)?.label.toLowerCase()}` : parent ? 'Search this folder' : 'Search your vault'} />
            </View>
          </View>
        }
        renderItem={({ item: r }) => {
          if (r.type === 'title') {
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 10, paddingTop: 20, paddingBottom: 6 }}>
                <Text variant="overline" color="ink3" accessibilityRole="header" style={{ flex: 1 }}>{r.label}</Text>
                {r.controls && (
                  <>
                    <Press radius={10} static onPress={() => showMenu({ title: 'Sort by', items: SORTS.map((s) => ({ label: s.label, value: s.id === prefs.sort ? '✓' : undefined, onPress: () => setPrefs({ sort: s.id }) })) })}
                      accessibilityLabel={`Sorted by ${SORTS.find((s) => s.id === prefs.sort)?.label}. Change`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 32 }}>
                      <Text variant="footnote" color="ink2">{SORTS.find((s) => s.id === prefs.sort)?.label}</Text>
                      <Icon icon={ArrowDown01Icon} size={13} color="ink3" strokeWidth={2} />
                    </Press>
                    {!media && (
                      <IconButton icon={view === 'grid' ? LeftToRightListBulletIcon : GridViewIcon} size={34} iconSize={17} color={c.ink2}
                        accessibilityLabel={view === 'grid' ? 'Show as a list' : 'Show as a grid'} onPress={() => { haptic.tap(); setPrefs({ view: view === 'grid' ? 'list' : 'grid' }) }} />
                    )}
                  </>
                )}
              </View>
            )
          }
          if (r.type === 'folders') {
            return (
              <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 6, marginBottom: 22 }}>
                {r.items.map((f) => (
                  <View key={f.id} style={{ width: card, alignItems: 'center' }}>
                    <FolderTile item={f} size={card - 22} stat={stats.get(f.id)} selected={selected.has(f.id)} selecting={selecting}
                      onPress={() => press(f)} onSelect={() => toggle(f)} />
                  </View>
                ))}
              </View>
            )
          }
          if (r.type === 'places') return <Places items={all} width={card} />
          if (r.type === 'tiles') {
            return (
              <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12 }}>
                {r.items.map((m) => <Tile key={m.id} item={m} size={tile} named={!media} selected={selected.has(m.id)} selecting={selecting} onPress={() => press(m)} onHold={() => hold(m)} />)}
              </View>
            )
          }
          if (r.type === 'upload') return <UploadRow u={r.upload} />
          return <FileRow item={r.item} selected={selected.has(r.item.id)} selecting={selecting} onPress={() => press(r.item)} onHold={() => hold(r.item)} />
        }}
        ListEmptyComponent={!items ? <Loading tile={tile} /> : (
          <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 60 }}>
          <EmptyState
            art={<FolderGlyph size={56} />}
            title={error ? 'Unable to reach your vault' : query ? 'Nothing matches' : category ? 'Nothing here yet' : parent ? 'This folder is empty' : 'Your vault is empty'}
            body={error ?? (query ? 'Try another name.' : 'Keep photos, videos, PDFs, notes and documents here. They live on your own server, and your teammates can find them when you ask.')}
            action={error ? <Button label="Try again" onPress={() => refreshVault()} /> : query || category ? undefined : <Button label="Add files" icon={Add01Icon} onPress={() => addMenu(parent)} />}
          />
          </View>
        )}
      />
      </View>
      </GestureDetector>
      {selecting ? <SelectionBar picked={picked} bottom={bottom} onClear={clear} /> : fab && <Fab label="Add to the vault" items={() => addItems(parent)} bottom={bottom + 12} />}
    </View>
  )
}

/** Everything that adds to a folder: photos and videos, any file, the camera, a new folder, one synced from a computer. */
export function addItems(parent: string): MenuItem[] {
  const send = async (files: { uri: string; name: string; mime?: string; size?: number }[]) => {
    if (!files.length) return
    const r = await uploadFiles(files, parent)
    if (r.failed) toast({ title: r.done ? `${r.done} added, ${r.failed} didn’t upload` : 'Upload failed', body: 'Check the list for what went wrong.', tone: 'error' })
    else if (r.done) toast({ title: r.done === 1 ? `${files[0].name} is in your vault` : `${r.done} files are in your vault`, tone: 'success' })
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
  const fromPicker = (a: ImagePicker.ImagePickerAsset, i: number) => {
    const ext = (a.mimeType?.split('/')[1] ?? (a.type === 'video' ? 'mp4' : 'jpg')).replace('jpeg', 'jpg').replace('quicktime', 'mov')
    return { uri: a.uri, name: a.fileName ?? `${a.type === 'video' ? 'Video' : 'Photo'} ${stamp()}${i ? ` ${i + 1}` : ''}.${ext}`, mime: a.mimeType ?? undefined, size: a.fileSize ?? undefined }
  }
  return [
      { label: 'Photos & videos', icon: Image01Icon, onPress: async () => {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 0, quality: 1 })
        if (!r.canceled) send(r.assets.map(fromPicker))
      } },
      { label: 'Files', icon: File01Icon, onPress: async () => {
        const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
        if (!r.canceled) send(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? undefined, size: a.size ?? undefined })))
      } },
      { label: 'Take a photo', icon: Camera01Icon, onPress: async () => {
        const p = await ImagePicker.requestCameraPermissionsAsync()
        if (!p.granted) { toast({ title: 'Allow the camera to take a photo', body: 'Turn it on in Settings, then try again.', tone: 'error' }); return }
        const r = await ImagePicker.launchCameraAsync({ quality: 0.9 })
        if (!r.canceled) send(r.assets.map(fromPicker))
      } },
      { label: 'New folder', icon: FolderAddIcon, onPress: () => newFolderSheet(parent) },
      { label: 'Sync from your computer', icon: FolderSyncIcon, onPress: () => router.push({ pathname: '/vault/sync', params: { parent } }) },
  ]
}

/** The same as an action sheet. */
export function addMenu(parent: string) {
  haptic.tap()
  showMenu({ title: 'Add to your vault', items: addItems(parent) })
}

/** What the vault holds, by kind, against its 20 GB: the bar is the whole allowance, so the empty part is what's free. */
export function StorageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c } = useTheme()
  const { items, usage } = useVault()
  const all = items ?? []
  const parts = [
    { label: 'Photos', cat: 'photos' as const, color: KIND_COLOR.image, icon: CAT_LOOK.photos.icon },
    { label: 'Videos', cat: 'videos' as const, color: KIND_COLOR.video, icon: CAT_LOOK.videos.icon },
    { label: 'Documents', cat: 'docs' as const, color: KIND_COLOR.pdf, icon: CAT_LOOK.docs.icon },
    { label: 'Audio', cat: 'audio' as const, color: KIND_COLOR.audio, icon: CAT_LOOK.audio.icon },
  ].map((p) => {
    const l = all.filter((r) => inCategory(r, p.cat))
    return { ...p, n: l.length, bytes: l.reduce((s, r) => s + r.size, 0) }
  })
  const files = all.filter((r) => r.kind === 'file')
  const used = files.reduce((s, r) => s + r.size, 0)
  const other = { label: 'Other', cat: 'all' as const, color: c.ink4, icon: File01Icon, n: files.length - parts.reduce((s, p) => s + p.n, 0), bytes: used - parts.reduce((s, p) => s + p.bytes, 0) }
  const shown = [...parts, other].filter((p) => p.bytes > 0)
  const quota = usage?.quota || 20e9
  const free = usage?.free ?? Math.max(0, quota - used)
  const pct = Math.min(100, (used / quota) * 100)
  return (
    <Sheet open={open} onClose={onClose} title="Storage">
      <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 18 }}>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text variant="largeTitle" tabular>{formatSize(used)}</Text>
            <Text variant="body" color="ink3" tabular>of {formatSize(quota)}</Text>
          </View>
          <Text variant="label" color="ink3" tabular>{formatSize(free)} free · {pct < 1 && used ? 'under 1' : Math.round(pct)}% used · {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'}</Text>
        </View>
        {/* The whole allowance; each kind takes its share, the rest is free space */}
        <View accessibilityLabel={`${formatSize(used)} used, ${formatSize(free)} free`}
          style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: c.panel2, gap: 2 }}>
          {shown.map((p) => <View key={p.label} style={{ width: `${Math.max((p.bytes / quota) * 100, 1.2)}%`, backgroundColor: p.color }} />)}
          <View style={{ flex: 1, borderRadius: 3, borderWidth: 1, borderColor: c.line, borderStyle: 'dashed' }} />
        </View>
        <View style={{ gap: 4 }}>
          {[...shown, { label: 'Free', cat: null, color: c.panel3, icon: null, n: 0, bytes: free }].map((p) => (
            <Press key={p.label} radius={14} disabled={!p.cat} onPress={() => { onClose(); if (p.cat) router.push({ pathname: '/vault/[id]', params: { id: `cat:${p.cat}` } }) }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4 }}>
              <View style={{ width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: p.icon ? p.color + '22' : c.panel2, borderWidth: p.icon ? 0 : 1, borderColor: c.line, borderStyle: 'dashed' }}>
                {p.icon && <Icon icon={p.icon} size={17} color={p.color} strokeWidth={1.8} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium">{p.label}</Text>
                {!!p.n && <Text variant="footnote" color="ink3" tabular>{p.n.toLocaleString()} {p.n === 1 ? 'file' : 'files'}</Text>}
              </View>
              <Text variant="label" color="ink2" tabular>{formatSize(p.bytes)}</Text>
            </Press>
          ))}
        </View>
        {usage && usage.total > 0 && <Text variant="footnote" color="ink4">Kept on your home server. The vault is capped at {formatSize(quota)}.</Text>}
      </View>
    </Sheet>
  )
}

/** A folder as Stepwise's Folder, in its colour and icon; a synced one carries its computer's mark in the count. */
const folderHolds = new Map<string, () => void>()

function FolderTile({ item, size, stat, selected, selecting, onPress, onSelect }: {
  item: VaultItem; size: number; stat?: { n: number; bytes: number; thumbs: string[] }; selected: boolean; selecting: boolean
  onPress: () => void; onSelect: () => void
}) {
  const ref = useRef<View>(null)
  const n = stat?.n ?? 0
  const src = item.meta?.source
  const count = n === 0 ? (src && !src.last ? 'Syncing…' : 'Empty') : `${n} ${n === 1 ? 'item' : 'items'}`
  const look = { size, label: item.name, count, color: item.meta?.look?.color, icon: (item.meta?.look?.icon as FolderIconName) ?? (src ? 'laptop' : 'folder'),
    thumbs: stat?.thumbs, peek: n ? Math.min(n, 3) : 0,
    badge: src ? <Icon icon={LaptopIcon} size={11} color="ink3" strokeWidth={2} /> : item.meta?.hidden ? <Icon icon={ViewOffSlashIcon} size={11} color="ink3" strokeWidth={2} /> : item.starred ? <Icon icon={StarIcon} size={11} color="#e5a50a" strokeWidth={2.2} /> : undefined } as const
  // Long-press: the folder's menu in place (Select first), or while choosing, toggle it.
  const hold = () => (selecting ? onSelect() : showContextMenu(ref.current, <Folder {...look} onPress={() => {}} />, itemActions(item, { onSelect })))
  // The list's drag gesture takes a held touch before the folder's own long-press fires, so it calls this instead.
  useEffect(() => { folderHolds.set(item.id, hold); return () => { folderHolds.delete(item.id) } })
  return (
    <View ref={ref} collapsable={false}>
      <Folder {...look} selected={selected} selecting={selecting} onPress={onPress} onLongPress={hold}
        accessibilityLabel={`${item.name}, folder, ${count}${src ? `, synced from ${src.name}` : ''}${item.meta?.hidden ? ', hidden from teammates' : ''}`} />
    </View>
  )
}

/** Below the folders on the vault's top: Google Drive and this phone, each with how full it is, then Browse. */
function Places({ items, width }: { items: VaultItem[]; width: number }) {
  const { c } = useTheme()
  const { about, reload } = useDriveAbout()
  const [phone, setPhone] = useState(() => Phone?.storage?.() ?? null)
  // Fresh numbers each time the Vault comes into view (and a retry if Drive didn't answer before).
  useFocusEffect(useCallback(() => { reload(); setPhone(Phone?.storage?.() ?? null) }, [reload]))
  const go = (pathname: '/vault/phone' | '/vault/drive/[id]', params: Record<string, string>) => { haptic.tap(); router.push({ pathname, params } as never) }
  return (
    <View style={{ gap: 24, paddingTop: 4 }}>
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <PlaceCard art={<DriveLogo size={22} />} title="Google Drive"
          used={about?.connected ? about.used ?? 0 : undefined} total={about?.connected ? about.quota || undefined : undefined}
          note={about && !about.connected ? 'Connect to browse your Drive here' : undefined}
          onPress={() => go('/vault/drive/[id]', { id: 'root' })} />
        <PlaceCard art={<Icon icon={SmartPhone01Icon} size={20} color={c.ink2} strokeWidth={1.9} />} title="This phone"
          used={phone ? phone.total - phone.free : undefined} total={phone?.total} note={phone ? undefined : 'Downloads, documents and recent files'}
          onPress={() => go('/vault/phone', {})} />
      </View>
    </View>
  )
}

/** A place with storage: its mark and name, a bar of how full it is (zinc; yellow past 70%, red past 85%), and
 * "x of y used". */
function PlaceCard({ art, title, used, total, note, onPress }: { art: ReactNode; title: string; used?: number; total?: number; note?: string; onPress: () => void }) {
  const { c } = useTheme()
  const pct = used !== undefined && total ? Math.min(100, (used / total) * 100) : null
  const line = note ?? (used === undefined ? ' ' : total ? `${formatSize(used)} of ${formatSize(total)} used` : `${formatSize(used)} used`)
  const fill = pct === null ? c.ink3 : pct > 85 ? c.danger : pct > 70 ? c.warning : c.ink3
  return (
    <Press radius={24} onPress={onPress} accessibilityLabel={`${title}. ${line}${pct !== null ? `, ${Math.round(pct)} percent full` : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel }}>
      <View style={{ width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2 }}>{art}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{title}</Text>
        {pct !== null && (
          <View style={{ height: 4, borderRadius: 2, backgroundColor: c.panel3, overflow: 'hidden' }}>
            <View style={{ width: `${Math.max(pct, 1.5)}%`, height: 4, borderRadius: 2, backgroundColor: fill }} />
          </View>
        )}
        <Text variant="footnote" color="ink3" numberOfLines={1} tabular>{line}</Text>
      </View>
      <Icon icon={ArrowRight01Icon} size={16} color="ink4" />
    </Press>
  )
}

function Tile({ item, size, named, selected, selecting, onPress, onHold }: {
  item: VaultItem; size: number; named: boolean; selected: boolean; selecting: boolean; onPress: () => void; onHold: () => void
}) {
  return (
    <Press radius={0} wash={null} onPress={onPress} onLongPress={onHold} accessibilityLabel={item.name} accessibilityState={{ selected }} style={{ width: size, gap: 6 }}>
      <View style={{ opacity: selecting && !selected ? 0.7 : 1 }}>
        <FilePreview item={item} width={size} height={size} radius={14} />
        {selecting && <Check on={selected} />}
      </View>
      {named && <Text variant="footnote" numberOfLines={1} style={{ paddingHorizontal: 2 }}>{item.name}</Text>}
    </Press>
  )
}

function FileRow({ item, selected, selecting, onPress, onHold }: { item: VaultItem; selected: boolean; selecting: boolean; onPress: () => void; onHold: () => void }) {
  const { c } = useTheme()
  const kind = kindOf(item.name, item.mime)
  const date = new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const meta = [formatSize(item.size), item.meta?.pages && `${item.meta.pages} ${item.meta.pages === 1 ? 'page' : 'pages'}`, date].filter(Boolean).join(' · ')
  const visual = kind === 'image' || kind === 'video' || kind === 'pdf'
  return (
    <Press radius={0} onPress={onPress} onLongPress={onHold} accessibilityLabel={`${item.name}, ${meta}`} accessibilityState={{ selected }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 6, paddingVertical: 8, backgroundColor: selected ? c.tubeSoft : undefined }}>
      {visual ? <FilePreview item={item} width={48} height={48} radius={12} /> : <View style={{ width: 48, alignItems: 'center' }}><FileIcon name={item.name} mime={item.mime} size={46} glow={false} /></View>}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>{item.name}</Text>
          {item.starred && <Icon icon={StarIcon} size={12} color="#e5a50a" strokeWidth={2.2} />}
        </View>
        <Text variant="footnote" color="ink3" tabular numberOfLines={1}>{meta}</Text>
      </View>
      {selecting
        ? <View style={{ width: 40, alignItems: 'center' }}><SelectDot on={selected} size={18} /></View>
        : <IconButton icon={MoreHorizontalIcon} size={40} iconSize={18} color={c.ink3} accessibilityLabel={`More for ${item.name}`} onPress={() => itemMenu(item)} />}
    </Press>
  )
}

function Check({ on }: { on: boolean }) {
  return <View style={{ position: 'absolute', left: 6, top: 6 }}><SelectDot on={on} onImage /></View>
}

/** Several picked: what you can do with them all at once. */
function SelectionBar({ picked, bottom, onClear }: { picked: VaultItem[]; bottom: number; onClear: () => void }) {
  const { c } = useTheme()
  const starAll = picked.some((r) => !r.starred)
  const one = picked.length === 1 && picked[0].kind === 'file' ? picked[0] : null
  return (
    <SelectBar count={picked.length} bottom={bottom} onClear={onClear} actions={[
      { icon: StarIcon, label: starAll ? 'Star them' : 'Unstar them', color: starAll ? undefined : '#e5a50a',
        onPress: () => Promise.all(picked.map((r) => editItem(r.id, { starred: starAll }))).catch(() => toast({ title: 'Unable to save', tone: 'error' })) },
      { icon: FolderExportIcon, label: 'Move them', onPress: () => { moveItems(picked); onClear() } },
      ...(picked.length === 1 && !syncedCopy(picked[0]) ? [{ icon: Edit02Icon, label: 'Rename it', onPress: () => { renameItem(picked[0]); onClear() } }] : []),
      ...(one ? [{ icon: Share08Icon, label: 'Share it', onPress: () => shareItem(viewable(one)) }] : []),
      { icon: Delete02Icon, label: 'Delete them', color: c.danger, onPress: async () => {
        if (!await confirm({ title: `Delete ${picked.length} ${picked.length === 1 ? 'item' : 'items'}?`, body: 'They leave your server for good, with everything inside any folder.', confirmLabel: 'Delete', destructive: true })) return
        onClear()
        for (const r of picked) await deleteItem(r.id).catch((e) => toast({ title: `Unable to delete ${r.name}`, body: (e as Error).message, tone: 'error' }))
        haptic.success()
        toast({ title: picked.length === 1 ? `${picked[0].name} deleted` : `${picked.length} items deleted`, tone: 'success' })
      } },
    ]} />
  )
}

function UploadRow({ u }: { u: Upload }) {
  const { c } = useTheme()
  const tint = KIND_COLOR[kindOf(u.name, u.mime)]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 6, paddingVertical: 8 }}
      accessible accessibilityLabel={u.error ? `${u.name} didn’t upload: ${u.error}` : `Uploading ${u.name}, ${Math.round(u.progress * 100)} percent`}>
      <View style={{ width: 48, alignItems: 'center' }}><FileIcon name={u.name} mime={u.mime} size={46} glow={false} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text variant="bodyMedium" numberOfLines={1} color={u.error ? 'ink3' : 'ink'}>{u.name}</Text>
        {u.error ? <Text variant="footnote" color="danger" numberOfLines={1}>{u.error}</Text> : (
          <View style={{ height: 4, borderRadius: 2, backgroundColor: c.panel2, overflow: 'hidden' }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: tint, width: `${Math.max(2, Math.round(u.progress * 100))}%` }} />
          </View>
        )}
      </View>
      {u.error ? <IconButton icon={Cancel01Icon} size={40} iconSize={16} color={c.ink3} accessibilityLabel="Dismiss" onPress={() => dismissUpload(u.id)} />
        : <Text variant="footnote" color="ink3" tabular style={{ width: 40, textAlign: 'right', paddingRight: 8 }}>{Math.round(u.progress * 100)}%</Text>}
    </View>
  )
}

function Loading({ tile }: { tile: number }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 20, gap: 10 }} accessible accessibilityLabel="Loading your vault">
      <Skeleton height={130} radius={22} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[0, 1, 2].map((i) => <Skeleton key={i} width={tile} height={tile} radius={14} />)}
      </View>
    </View>
  )
}
