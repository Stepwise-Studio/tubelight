// The Vault's browser, for the top of the vault and for each folder: what's stored (a storage card at the top),
// search, filters, folders as cards, photos and videos as a grid, everything else as rows with their type's badge.
// Uploads show in place with their progress. Long-press anything for its actions.
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useMemo, useState, type ReactNode } from 'react'
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import {
  Add01Icon, Camera01Icon, Cancel01Icon, File01Icon, FolderAddIcon, Image01Icon, MoreHorizontalIcon, PlayIcon, StarIcon,
} from '@hugeicons/core-free-icons'

import { kindOf, byFolderThenNewest, dismissUpload, formatSize, refreshVault, uploadFiles, useVault, type Upload, type VaultItem } from '@/lib/vault'
import { motion, useTheme } from '@/theme'
import { Button, Chip, EmptyState, Icon, IconButton, Press, SearchField, Skeleton, Squircle, Text, haptic, showMenu, toast } from '@/ui'

import { itemMenu, newFolderSheet, openItem } from './actions'
import { FileTile, FolderGlyph, Thumb, tintOf } from './file-tile'

type Filter = 'all' | 'photos' | 'videos' | 'docs' | 'starred'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'photos', label: 'Photos' }, { value: 'videos', label: 'Videos' },
  { value: 'docs', label: 'Documents' }, { value: 'starred', label: 'Starred' },
]
const DOCS = ['pdf', 'word', 'sheet', 'slides', 'markdown', 'text']

type Row =
  | { type: 'title'; key: string; label: string }
  | { type: 'folders'; key: string; items: VaultItem[] }
  | { type: 'media'; key: string; items: VaultItem[] }
  | { type: 'file'; key: string; item: VaultItem }
  | { type: 'upload'; key: string; upload: Upload }

export function VaultBrowser({ parent, header, root }: { parent: string; header: ReactNode; root?: boolean }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const { items, usage, uploads, error } = useVault()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const all = useMemo(() => items ?? [], [items])

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of all) m.set(r.parent, (m.get(r.parent) ?? 0) + 1)
    return m
  }, [all])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const inside = (r: VaultItem) => {
      if (!parent) return true
      const byId = new Map(all.map((x) => [x.id, x]))
      let at = byId.get(r.parent)
      while (at) { if (at.id === parent) return true; at = byId.get(at.parent) }
      return r.parent === parent
    }
    let list: VaultItem[]
    if (q) list = all.filter((r) => r.name.toLowerCase().includes(q) && inside(r))
    else if (filter !== 'all') {
      list = all.filter((r) => {
        const k = kindOf(r.name, r.mime)
        return filter === 'starred' ? r.starred : r.kind === 'file' && (filter === 'photos' ? k === 'image' : filter === 'videos' ? k === 'video' : DOCS.includes(k))
      })
    } else list = all.filter((r) => r.parent === parent)
    list = [...list].sort(byFolderThenNewest)
    const folders = list.filter((r) => r.kind === 'folder')
    const media = list.filter((r) => r.kind === 'file' && ['image', 'video'].includes(kindOf(r.name, r.mime)))
    const files = list.filter((r) => r.kind === 'file' && !media.includes(r))
    const out: Row[] = []
    const chunk = (l: VaultItem[], n: number, type: 'folders' | 'media') => {
      for (let i = 0; i < l.length; i += n) out.push({ type, key: `${type}-${l[i].id}`, items: l.slice(i, i + n) })
    }
    if (folders.length) { out.push({ type: 'title', key: 't-f', label: 'Folders' }); chunk(folders, 2, 'folders') }
    const ups = q || filter !== 'all' ? [] : uploads.filter((u) => u.parent === parent)
    if (media.length) { out.push({ type: 'title', key: 't-m', label: filter === 'videos' ? 'Videos' : filter === 'photos' ? 'Photos' : 'Photos & videos' }); chunk(media, 3, 'media') }
    if (files.length || ups.length) {
      out.push({ type: 'title', key: 't-d', label: 'Files' })
      for (const u of ups) out.push({ type: 'upload', key: u.id, upload: u })
      for (const f of files) out.push({ type: 'file', key: f.id, item: f })
    }
    return out
  }, [all, uploads, parent, filter, query])

  const gridW = width - 32
  const tile = Math.floor((gridW - 8) / 3)
  const card = Math.floor((gridW - 10) / 2)
  const filtered = !!query.trim() || filter !== 'all'

  return (
    <FlatList
      data={items ? rows : []}
      keyExtractor={(r) => r.key}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: 140, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshVault(); setRefreshing(false) }}
        tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      ListHeaderComponent={
        <View>
          {header}
          <View style={{ paddingHorizontal: 16, gap: 12, paddingBottom: 4 }}>
            {root && !filtered && usage && items && <Storage items={all} free={usage.free} />}
            <SearchField value={query} onChangeText={setQuery} placeholder={parent ? 'Search this folder' : 'Search your vault'} />
            {root && !query && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {FILTERS.map((f) => <Chip key={f.value} label={f.label} selected={filter === f.value} onPress={() => { haptic.tap(); setFilter(f.value) }} />)}
              </View>
            )}
          </View>
        </View>
      }
      renderItem={({ item: r }) => {
        if (r.type === 'title') return <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 }}>{r.label}</Text>
        if (r.type === 'folders') {
          return (
            <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 10 }}>
              {r.items.map((f) => <FolderCard key={f.id} item={f} width={card} count={counts.get(f.id) ?? 0} />)}
            </View>
          )
        }
        if (r.type === 'media') {
          return (
            <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 16, marginBottom: 4 }}>
              {r.items.map((m) => <MediaTile key={m.id} item={m} size={tile} />)}
            </View>
          )
        }
        if (r.type === 'upload') return <UploadRow u={r.upload} />
        return <FileRow item={r.item} />
      }}
      ListEmptyComponent={!items ? <Loading tile={tile} /> : (
        <EmptyState
          art={<FolderGlyph size={56} />}
          title={error ? 'Unable to reach your vault' : filtered ? 'Nothing matches' : parent ? 'This folder is empty' : 'Your vault is empty'}
          body={error ?? (filtered ? 'Try another name or filter.' : 'Keep photos, videos, PDFs, notes and documents here. They live on your own server, and your teammates can find them when you ask.')}
          action={error ? <Button label="Try again" onPress={() => refreshVault()} /> : filtered ? undefined : <Button label="Add files" icon={Add01Icon} onPress={() => addMenu(parent)} />}
        />
      )}
    />
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

/** What the vault holds, by kind, and how much room the server has left. */
function Storage({ items, free }: { items: VaultItem[]; free: number }) {
  const { c } = useTheme()
  const parts = [
    { label: 'Photos', kinds: ['image'], color: '#12a594' },
    { label: 'Videos', kinds: ['video'], color: '#0090ff' },
    { label: 'Documents', kinds: DOCS, color: '#8e4ec6' },
    { label: 'Other', kinds: ['audio', 'archive', 'other'], color: c.ink4 },
  ].map((p) => ({ ...p, bytes: items.filter((r) => r.kind === 'file' && p.kinds.includes(kindOf(r.name, r.mime))).reduce((s, r) => s + r.size, 0) }))
  const used = parts.reduce((s, p) => s + p.bytes, 0)
  const files = items.filter((r) => r.kind === 'file').length
  return (
    <Animated.View entering={FadeIn.duration(motion.duration.slow)}>
      <Squircle style={{ borderRadius: 20, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text variant="footnote" color="ink3">In your vault</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text variant="title" tabular>{formatSize(used)}</Text>
              <Text variant="footnote" color="ink3" tabular>{files.toLocaleString()} {files === 1 ? 'file' : 'files'}</Text>
            </View>
          </View>
          <Text variant="footnote" color="ink3" tabular style={{ paddingBottom: 6 }}>{formatSize(free)} free on your server</Text>
        </View>
        <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: c.panel2, gap: used ? 2 : 0 }}>
          {used > 0 && parts.filter((p) => p.bytes).map((p) => <Bar key={p.label} color={p.color} flex={p.bytes / used} />)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 }}>
          {parts.filter((p) => p.bytes).map((p) => (
            <View key={p.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 3, backgroundColor: p.color }} />
              <Text variant="footnote" color="ink2">{p.label}</Text>
              <Text variant="footnote" color="ink3" tabular>{formatSize(p.bytes)}</Text>
            </View>
          ))}
          {!used && <Text variant="footnote" color="ink3">Nothing stored yet.</Text>}
        </View>
      </Squircle>
    </Animated.View>
  )
}

function Bar({ color, flex }: { color: string; flex: number }) {
  return <View style={{ flex: Math.max(flex, 0.02), backgroundColor: color }} />
}

function FolderCard({ item, width, count }: { item: VaultItem; width: number; count: number }) {
  const { c } = useTheme()
  return (
    <Press radius={18} onPress={() => openItem(item)} onLongPress={() => itemMenu(item)} accessibilityLabel={`${item.name}, folder, ${count} items`}
      outerStyle={{ width }} style={{ borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <FolderGlyph size={40} />
        {item.starred && <Icon icon={StarIcon} size={14} color="warning" strokeWidth={2} />}
      </View>
      <View style={{ gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{item.name}</Text>
        <Text variant="footnote" color="ink3" tabular>{count === 0 ? 'Empty' : `${count} ${count === 1 ? 'item' : 'items'}`}</Text>
      </View>
    </Press>
  )
}

function MediaTile({ item, size }: { item: VaultItem; size: number }) {
  const video = kindOf(item.name, item.mime) === 'video'
  return (
    <Press radius={12} onPress={() => openItem(item)} onLongPress={() => itemMenu(item)} accessibilityLabel={`${item.name}, ${video ? 'video' : 'photo'}`}
      outerStyle={{ width: size, height: size }} style={{ width: size, height: size, overflow: 'hidden' }}>
      <Thumb item={item} style={{ width: size, height: size }} />
      {video && (
        <View style={{ position: 'absolute', left: 6, bottom: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={PlayIcon} size={12} color="#fff" strokeWidth={2.2} />
        </View>
      )}
      {item.starred && (
        <View style={{ position: 'absolute', right: 6, top: 6 }}><Icon icon={StarIcon} size={14} color="#fff" strokeWidth={2.2} /></View>
      )}
    </Press>
  )
}

function FileRow({ item }: { item: VaultItem }) {
  const { c } = useTheme()
  const kind = kindOf(item.name, item.mime)
  const date = new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const meta = [formatSize(item.size), item.meta?.pages && `${item.meta.pages} ${item.meta.pages === 1 ? 'page' : 'pages'}`, date].filter(Boolean).join(' · ')
  return (
    <Press radius={0} onPress={() => openItem(item)} onLongPress={() => itemMenu(item)} accessibilityLabel={`${item.name}, ${meta}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 6, paddingVertical: 8 }}>
      {kind === 'image' && item.thumb ? <Thumb item={item} style={{ width: 44, height: 44, borderRadius: 13 }} /> : <FileTile item={item} size={44} />}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>{item.name}</Text>
          {item.starred && <Icon icon={StarIcon} size={12} color="warning" strokeWidth={2.2} />}
        </View>
        <Text variant="footnote" color="ink3" tabular numberOfLines={1}>{meta}</Text>
      </View>
      <IconButton icon={MoreHorizontalIcon} size={40} iconSize={18} color={c.ink3} accessibilityLabel={`More for ${item.name}`} onPress={() => itemMenu(item)} />
    </Press>
  )
}

function UploadRow({ u }: { u: Upload }) {
  const { c } = useTheme()
  const tint = tintOf(u) ?? c.tube
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 6, paddingVertical: 8 }}
      accessible accessibilityLabel={u.error ? `${u.name} didn’t upload: ${u.error}` : `Uploading ${u.name}, ${Math.round(u.progress * 100)} percent`}>
      <FileTile item={u} size={44} />
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
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Skeleton height={112} radius={18} style={{ flex: 1 }} />
        <Skeleton height={112} radius={18} style={{ flex: 1 }} />
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[0, 1, 2].map((i) => <Skeleton key={i} width={tile} height={tile} radius={12} />)}
      </View>
    </View>
  )
}
