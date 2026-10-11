// The phone's own files inside the Vault: its main folders and the newest documents anywhere on it (top), or one
// folder (path). Files open in the vault's viewer and can be kept in the vault or shared. Needs "All files access".
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Share08Icon, VaultIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { shareItem } from '@/components/vault/actions'
import { PLACES, openPhoneFile, usePhoneAccess, type PhoneFile } from '@/components/vault/phone-files'
import { OutsideRow } from '@/components/vault/outside-row'
import { Phone } from '@/lib/phone'
import { uploadFiles } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, EmptyState, SearchField, Skeleton, Text, showMenu } from '@/ui'


export default function PhoneFiles() {
  const { path, name } = useLocalSearchParams<{ path?: string; name?: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const allowed = usePhoneAccess()
  const [rows, setRows] = useState<PhoneFile[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

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
  const firstFile = path ? -1 : shown.findIndex((f) => !f.dir)
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title={title} subtitle={path ? 'On this phone' : 'Vault'} />
      <FlatList
        data={shown}
        keyExtractor={(f) => f.path}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
        ListHeaderComponent={<View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}><SearchField value={query} onChangeText={setQuery} placeholder={path ? 'Search this folder' : 'Search recent documents'} /></View>}
        renderItem={({ item: f, index }) => (
          <>
            {index === firstFile && <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingLeft: 20, paddingTop: 18, paddingBottom: 6 }}>Recent documents</Text>}
            <OutsideRow name={f.dir && f.name === 'Download' ? 'Downloads' : f.name} mime={f.mime} dir={f.dir} size={f.size} date={f.dir ? undefined : f.modified}
              meta={f.dir ? `${f.size} ${f.size === 1 ? 'item' : 'items'}` : undefined}
              onPress={() => f.dir ? router.push({ pathname: '/vault/phone', params: { path: f.path, name: f.name === 'Download' ? 'Downloads' : f.name } }) : openPhoneFile(f)}
              onMore={f.dir ? undefined : () => showMenu({ title: f.name, items: [
                { label: 'Save to Vault', icon: VaultIcon, onPress: () => uploadFiles([{ uri: `file://${f.path}`, name: f.name, mime: f.mime, size: f.size }], '') },
                { label: 'Share or open in…', icon: Share08Icon, onPress: () => shareItem({ id: f.path, name: f.name, mime: f.mime, size: f.size, src: `file://${f.path}` }) },
              ] })} />
          </>
        )}
        ListEmptyComponent={!rows && !error
          ? <View style={{ paddingHorizontal: 16, gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
          : <EmptyState title={error ? 'Unable to read this folder' : q ? 'Nothing matches' : 'Empty'} body={error ?? (q ? 'Try another name.' : 'Nothing in this folder yet.')} />}
      />
    </View>
  )
}
