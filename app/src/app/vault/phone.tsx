// The phone's own files inside the Vault: its main folders and the newest documents anywhere on it (top), or one
// folder (path). Files open in the vault's viewer and can be kept in the vault or shared. Needs "All files access".
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GridViewIcon, LeftToRightListBulletIcon, Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { shareItem } from '@/components/vault/actions'
import { PLACES, openPhoneFile, usePhoneAccess, type PhoneFile } from '@/components/vault/phone-files'
import { OutsideRow, OutsideTile, chunk } from '@/components/vault/outside-row'
import { Phone } from '@/lib/phone'
import { uploadFiles, useVaultPrefs } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, EmptyState, IconButton, SearchField, Skeleton, Text, haptic, showMenu, toast } from '@/ui'

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

  const title = path ? name ?? path.split('/').pop() ?? 'Folder' : 'On this phone'
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
  const label = (f: PhoneFile) => (f.dir && f.name === 'Download' ? 'Downloads' : f.name)
  const open = (f: PhoneFile) => (f.dir ? router.push({ pathname: '/vault/phone', params: { path: f.path, name: label(f) } }) : openPhoneFile(f))
  const more = (f: PhoneFile) => showMenu({ title: f.name, items: [
    { label: 'Save to Vault', icon: VaultIcon, onPress: () => {
      toast({ title: `Saving ${f.name} to your vault` })
      uploadFiles([{ uri: `file://${f.path}`, name: f.name, mime: f.mime, size: f.size }], '')
        .then((r) => toast(r.done ? { title: 'Saved to your vault', body: f.name, tone: 'success' } : { title: 'Unable to save it', tone: 'error' }))
    } },
    { label: 'Share or open in…', icon: Share08Icon, onPress: () => shareItem({ id: f.path, name: f.name, mime: f.mime, size: f.size, src: `file://${f.path}` }) },
  ] })
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={title} subtitle={path ? 'On this phone' : 'Vault'} right={
        <IconButton icon={grid ? LeftToRightListBulletIcon : GridViewIcon} accessibilityLabel={grid ? 'Show as a list' : 'Show as a grid'}
          onPress={() => { haptic.tap(); setPrefs({ view: grid ? 'list' : 'grid' }) }} />
      } />
      <FlatList
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
              onPress={() => open(f)} onMore={f.dir ? undefined : () => more(f)} />)}
          </View>
        ) : (() => {
          const f = b.items![0]
          return (
            <OutsideRow name={label(f)} mime={f.mime} dir={f.dir} size={f.size} date={f.dir ? undefined : f.modified} thumb={f.mime.startsWith('image/') ? `file://${f.path}` : null}
              meta={f.dir ? `${f.size} ${f.size === 1 ? 'item' : 'items'}` : undefined} onPress={() => open(f)} onMore={f.dir ? undefined : () => more(f)} />
          )
        })()}
        ListEmptyComponent={!rows && !error
          ? <View style={{ paddingHorizontal: 16, gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
          : <EmptyState title={error ? 'Unable to read this folder' : q ? 'Nothing matches' : 'Empty'} body={error ?? (q ? 'Try another name.' : 'Nothing in this folder yet.')} />}
      />
    </View>
  )
}
