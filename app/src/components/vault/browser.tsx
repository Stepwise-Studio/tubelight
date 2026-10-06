// The Vault, as a file manager: at the top, what's stored (by kind), Browse (photos, videos, documents, audio,
// starred, everything), Recent with real previews, then folders and files, sorted your way, as a list or a grid.
// The same browser shows a folder or a category. Long-press to select several; tap ⋯ for one file's actions.
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { router } from 'expo-router'
import { useMemo, useState, type ReactNode } from 'react'
import { FlatList, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import {
  Add01Icon, ArrowDown01Icon, Camera01Icon, Cancel01Icon, CheckmarkCircle02Icon, Delete02Icon, File01Icon, FolderAddIcon,
  FolderExportIcon, GridViewIcon, Image01Icon, LeftToRightListBulletIcon, MoreHorizontalIcon, MusicNote01Icon, PlayIcon,
  Share08Icon, StarIcon,
} from '@hugeicons/core-free-icons'

import {
  CATEGORIES, SORTS, deleteItem, dismissUpload, editItem, formatSize, inCategory, kindOf, refreshVault, sorter, uploadFiles,
  useVault, useVaultPrefs, viewable, type Category, type Upload, type VaultItem,
} from '@/lib/vault'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Press, SearchField, Sheet, Skeleton, Squircle, Text, confirm, elevation, haptic, showMenu, toast } from '@/ui'

import { itemMenu, moveItems, newFolderSheet, openItem, shareItem } from './actions'
import { FileIcon, KIND_COLOR } from './file-icon'
import { FolderGlyph } from './file-tile'
import { FilePreview } from './preview'

type Row =
  | { type: 'title'; key: string; label: string; controls?: boolean }
  | { type: 'folders'; key: string; items: VaultItem[] }
  | { type: 'tiles'; key: string; items: VaultItem[] }
  | { type: 'file'; key: string; item: VaultItem }
  | { type: 'upload'; key: string; upload: Upload }

const CAT_LOOK: Record<Category, { icon: Parameters<typeof Icon>[0]['icon']; color: string }> = {
  photos: { icon: Image01Icon, color: KIND_COLOR.image }, videos: { icon: PlayIcon, color: KIND_COLOR.video },
  docs: { icon: File01Icon, color: KIND_COLOR.pdf }, audio: { icon: MusicNote01Icon, color: KIND_COLOR.audio },
  starred: { icon: StarIcon, color: '#e5a50a' }, all: { icon: FolderAddIcon, color: '#8b8b93' },
}

export function VaultBrowser({ parent = '', category, header, root, bottom = 24 }: {
  parent?: string; category?: Category; header: ReactNode; root?: boolean
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
    const m = new Map<string, { n: number; bytes: number }>()
    for (const r of all) {
      const s = m.get(r.parent) ?? { n: 0, bytes: 0 }
      s.n++
      s.bytes += r.size
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
    if (folders.length) { out.push({ type: 'title', key: 't-f', label: 'Folders' }); chunk(folders, 2, 'folders') }
    const ups = q || category ? [] : uploads.filter((u) => u.parent === parent)
    if (files.length || ups.length) {
      out.push({ type: 'title', key: 't-d', label: q ? 'Matches' : category ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : 'Files', controls: true })
      for (const u of ups) out.push({ type: 'upload', key: u.id, upload: u })
      if (view === 'grid') chunk(files, 3, 'tiles')
      else for (const f of files) out.push({ type: 'file', key: f.id, item: f })
    }
    return out
  }, [all, uploads, parent, category, query, prefs.sort, view])

  const tile = Math.floor((width - 32 - 16) / 3)
  const card = Math.floor((width - 32 - 10) / 2)
  const picked = all.filter((r) => selected.has(r.id))
  const toggle = (r: VaultItem) => {
    haptic.tap()
    setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n })
  }
  const press = (r: VaultItem) => (selecting ? toggle(r) : openItem(r))
  const hold = (r: VaultItem) => { haptic.light(); toggle(r) }
  const clear = () => setSelected(new Set())

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={items ? rows : []}
        keyExtractor={(r) => r.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottom + (selecting ? 96 : 40), flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshVault(); setRefreshing(false) }}
          tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={
          <View>
            {header}
            <View style={{ paddingHorizontal: 16, gap: 14, paddingBottom: 2 }}>
              <SearchField value={query} onChangeText={setQuery} placeholder={category ? `Search ${CATEGORIES.find((x) => x.id === category)?.label.toLowerCase()}` : parent ? 'Search this folder' : 'Search your vault'} />
            </View>
            {root && !query && items && all.some((r) => r.kind === 'file') && <Browse items={all} width={card} />}
            {root && !query && items && <Recent items={all} onOpen={press} onHold={hold} selected={selected} />}
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
              <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 10 }}>
                {r.items.map((f) => <FolderCard key={f.id} item={f} width={card} stat={stats.get(f.id)} selected={selected.has(f.id)} onPress={() => press(f)} onHold={() => hold(f)} />)}
              </View>
            )
          }
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
          <EmptyState
            art={<FolderGlyph size={56} />}
            title={error ? 'Unable to reach your vault' : query ? 'Nothing matches' : category ? 'Nothing here yet' : parent ? 'This folder is empty' : 'Your vault is empty'}
            body={error ?? (query ? 'Try another name.' : 'Keep photos, videos, PDFs, notes and documents here. They live on your own server, and your teammates can find them when you ask.')}
            action={error ? <Button label="Try again" onPress={() => refreshVault()} /> : query || category ? undefined : <Button label="Add files" icon={Add01Icon} onPress={() => addMenu(parent)} />}
          />
        )}
      />
      {selecting && <SelectionBar picked={picked} bottom={bottom} onClear={clear} />}
    </View>
  )
}

/** The + menu: photos and videos, any file, the camera, a folder. */
export function addMenu(parent: string) {
  haptic.tap()
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
  showMenu({
    title: 'Add to your vault',
    items: [
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
    ],
  })
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

/** Browse by kind: each a tile with its count and size. */
function Browse({ items, width }: { items: VaultItem[]; width: number }) {
  const { c, scheme } = useTheme()
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 22, gap: 10 }}>
      <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingLeft: 4 }}>Browse</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {CATEGORIES.map((cat) => {
          const hits = items.filter((r) => inCategory(r, cat.id))
          const files = hits.filter((r) => r.kind === 'file')
          const look = CAT_LOOK[cat.id]
          return (
            <Press key={cat.id} radius={18} onPress={() => { haptic.tap(); router.push({ pathname: '/vault/[id]', params: { id: `cat:${cat.id}` } }) }}
              accessibilityLabel={`${cat.label}, ${hits.length}`} outerStyle={{ width }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel }}>
              <View style={{ width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: `${look.color}${scheme === 'dark' ? '2b' : '1c'}` }}>
                <Icon icon={look.icon} size={20} color={look.color} strokeWidth={1.9} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyMedium" numberOfLines={1}>{cat.label}</Text>
                <Text variant="footnote" color="ink3" tabular numberOfLines={1}>
                  {hits.length ? `${hits.length}${files.length ? ` · ${formatSize(files.reduce((s, r) => s + r.size, 0))}` : ''}` : 'None yet'}
                </Text>
              </View>
            </Press>
          )
        })}
      </View>
    </View>
  )
}

/** The newest files, as cards you can flick through. */
function Recent({ items, onOpen, onHold, selected }: { items: VaultItem[]; onOpen: (r: VaultItem) => void; onHold: (r: VaultItem) => void; selected: Set<string> }) {
  const recent = items.filter((r) => r.kind === 'file').sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12)
  if (!recent.length) return null
  return (
    <View style={{ paddingTop: 22, gap: 10 }}>
      <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingLeft: 20 }}>Recent</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
        {recent.map((r) => (
          <Press key={r.id} radius={16} static onPress={() => onOpen(r)} onLongPress={() => onHold(r)} accessibilityLabel={r.name} style={{ width: 128, gap: 8 }}>
            <View>
              <FilePreview item={r} width={128} height={160} radius={16} />
              {selected.has(r.id) && <Check on />}
            </View>
            <View style={{ paddingHorizontal: 2 }}>
              <Text variant="label" numberOfLines={1}>{r.name}</Text>
              <Text variant="footnote" color="ink3" numberOfLines={1} tabular>{formatSize(r.size)} · {new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
            </View>
          </Press>
        ))}
      </ScrollView>
    </View>
  )
}

function FolderCard({ item, width, stat, selected, onPress, onHold }: {
  item: VaultItem; width: number; stat?: { n: number; bytes: number }; selected: boolean; onPress: () => void; onHold: () => void
}) {
  const { c } = useTheme()
  const n = stat?.n ?? 0
  return (
    <Press radius={18} onPress={onPress} onLongPress={onHold} accessibilityLabel={`${item.name}, folder, ${n} items`} accessibilityState={{ selected }}
      outerStyle={{ width }} style={{ borderWidth: 1, borderColor: selected ? c.tube : c.line, backgroundColor: selected ? c.tubeSoft : c.panel, padding: 14, gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <FolderGlyph size={40} />
        {selected ? <Icon icon={CheckmarkCircle02Icon} size={20} color="tube" strokeWidth={2} />
          : item.starred ? <Icon icon={StarIcon} size={15} color="#e5a50a" strokeWidth={2.2} />
            : <IconButton icon={MoreHorizontalIcon} size={30} iconSize={16} color={c.ink3} accessibilityLabel={`More for ${item.name}`} onPress={() => itemMenu(item)} style={{ marginTop: -4, marginRight: -6 }} />}
      </View>
      <View style={{ gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{item.name}</Text>
        <Text variant="footnote" color="ink3" tabular>{n === 0 ? 'Empty' : `${n} ${n === 1 ? 'item' : 'items'}${stat?.bytes ? ` · ${formatSize(stat.bytes)}` : ''}`}</Text>
      </View>
    </Press>
  )
}

function Tile({ item, size, named, selected, selecting, onPress, onHold }: {
  item: VaultItem; size: number; named: boolean; selected: boolean; selecting: boolean; onPress: () => void; onHold: () => void
}) {
  return (
    <Press radius={14} static onPress={onPress} onLongPress={onHold} accessibilityLabel={item.name} accessibilityState={{ selected }} style={{ width: size, gap: 6 }}>
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
        ? <View style={{ width: 40, alignItems: 'center' }}><Icon icon={CheckmarkCircle02Icon} size={22} color={selected ? 'tube' : 'ink4'} strokeWidth={selected ? 2.2 : 1.5} /></View>
        : <IconButton icon={MoreHorizontalIcon} size={40} iconSize={18} color={c.ink3} accessibilityLabel={`More for ${item.name}`} onPress={() => itemMenu(item)} />}
    </Press>
  )
}

function Check({ on }: { on: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: on ? c.tube : 'rgba(0,0,0,0.35)', borderWidth: 1.5, borderColor: '#fff' }}>
      {on && <Icon icon={CheckmarkCircle02Icon} size={16} color="#fff" strokeWidth={2.4} />}
    </View>
  )
}

/** Several picked: what you can do with them all at once. */
function SelectionBar({ picked, bottom, onClear }: { picked: VaultItem[]; bottom: number; onClear: () => void }) {
  const { c, scheme } = useTheme()
  const starAll = picked.some((r) => !r.starred)
  const one = picked.length === 1 && picked[0].kind === 'file' ? picked[0] : null
  const act = (f: () => unknown) => { haptic.tap(); f() }
  return (
    <Animated.View entering={FadeInDown.duration(motion.duration.fast)} exiting={FadeOutDown.duration(motion.duration.quick)}
      style={[{ position: 'absolute', left: 16, right: 16, bottom: bottom + 8, borderRadius: 26 }, elevation(scheme)]}>
      <Squircle style={{ borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', padding: 6, gap: 2 }}>
        <IconButton icon={Cancel01Icon} round accessibilityLabel="Clear the selection" onPress={() => act(onClear)} />
        <Text variant="bodyMedium" style={{ flex: 1 }} tabular>{picked.length} selected</Text>
        <IconButton icon={StarIcon} color={starAll ? c.ink2 : '#e5a50a'} accessibilityLabel={starAll ? 'Star them' : 'Unstar them'}
          onPress={() => act(() => Promise.all(picked.map((r) => editItem(r.id, { starred: starAll }))).catch(() => toast({ title: 'Unable to save', tone: 'error' })))} />
        <IconButton icon={FolderExportIcon} accessibilityLabel="Move them" onPress={() => act(() => { moveItems(picked); onClear() })} />
        {one && <IconButton icon={Share08Icon} accessibilityLabel="Share it" onPress={() => act(() => shareItem(viewable(one)))} />}
        <IconButton icon={Delete02Icon} color={c.danger} accessibilityLabel="Delete them" onPress={async () => {
          if (!await confirm({ title: `Delete ${picked.length} ${picked.length === 1 ? 'item' : 'items'}?`, body: 'They leave your server for good, with everything inside any folder.', confirmLabel: 'Delete', destructive: true })) return
          onClear()
          for (const r of picked) await deleteItem(r.id).catch(() => toast({ title: `Unable to delete ${r.name}`, tone: 'error' }))
          haptic.success()
        }} />
      </Squircle>
    </Animated.View>
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
