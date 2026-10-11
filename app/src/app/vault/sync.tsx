// Keep a folder on one of your computers in the Vault: pick the computer, walk its folders, choose one. Its files
// copy over in the next minutes and follow the computer from then on (new files arrive, deleted ones go).
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp01Icon, LaptopIcon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { OutsideRow } from '@/components/vault/outside-row'
import { api } from '@/lib/api'
import { startSync, syncDirs } from '@/lib/vault'
import { useTheme } from '@/theme'
import { Button, EmptyState, Icon, Press, Skeleton, Text, haptic, toast } from '@/ui'

interface Computer { id: string; name: string; online: boolean; version: string | null }

export default function SyncFolder() {
  const { parent = '' } = useLocalSearchParams<{ parent?: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [computers, setComputers] = useState<Computer[] | null>(null)
  const [computer, setComputer] = useState<Computer | null>(null)
  const [dir, setDir] = useState<{ path: string; parent?: string; dirs: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ computers: Computer[] }>('/computers').then((d) => {
      setComputers(d.computers)
      if (d.computers.length === 1) setComputer(d.computers[0])
    }, (e) => setError((e as Error).message))
  }, [])
  const go = (path: string) => {
    if (!computer) return
    setDir(null)
    setError(null)
    syncDirs(computer.id, path).then(setDir, (e) => setError((e as Error).message))
  }
  useEffect(() => { if (computer?.online) go('') }, [computer]) // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

  const sync = async () => {
    if (!computer || !dir?.path) return
    setBusy(true)
    try {
      const row = await startSync(computer.id, dir.path, parent)
      haptic.success()
      toast({ title: `Syncing ${row.name}`, body: 'Its files arrive over the next few minutes.', tone: 'success' })
      router.back()
    } catch (e) {
      toast({ title: 'Unable to sync it', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const home = dir && !dir.parent
  const pretty = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Sync a folder" subtitle={computer ? computer.name : 'From your computer'} />
      {!computer ? (
        <FlatList
          data={computers ?? []}
          keyExtractor={(x) => x.id}
          contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
          ListHeaderComponent={computers?.length ? <Text variant="caption" color="ink3" style={{ paddingBottom: 6 }}>Which computer is the folder on?</Text> : null}
          renderItem={({ item: x }) => (
            <Press radius={16} onPress={() => setComputer(x)} accessibilityLabel={`${x.name}, ${x.online ? 'online' : 'offline'}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
              <Icon icon={LaptopIcon} size={22} color="ink2" />
              <Text variant="bodyMedium" style={{ flex: 1 }}>{x.name}</Text>
              <Text variant="footnote" color={x.online ? 'success' : 'ink3'}>{x.online ? 'Online' : 'Offline'}</Text>
            </Press>
          )}
          ListEmptyComponent={!computers && !error ? <Skeleton height={56} radius={16} />
            : <EmptyState title={error ? 'Unable to load your computers' : 'No computers linked'} body={error ?? 'Link your laptop first (Profile → Computers), then pick a folder on it to keep here.'}
                action={error ? undefined : <Button label="Link a computer" onPress={() => router.push('/computers')} />} />}
        />
      ) : !computer.online ? (
        <EmptyState title={`${computer.name} is offline`} body="Open Tubelight on it (or switch it on), then try again." action={<Button label="Try again" onPress={() => router.replace({ pathname: '/vault/sync', params: { parent } })} />} />
      ) : (
        <>
          <FlatList
            data={dir?.dirs ?? []}
            keyExtractor={(d) => d}
            contentContainerStyle={{ paddingBottom: 120, flexGrow: 1 }}
            ListHeaderComponent={dir ? (
              <View>
                <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, gap: 2 }}>
                  <Text variant="overline" color="ink3">Folder</Text>
                  <Text variant="bodyMedium" numberOfLines={2}>{pretty(dir.path) || 'Shared folders'}</Text>
                </View>
                {!!dir.parent && <Press radius={0} onPress={() => go(dir.parent!)} accessibilityLabel="Up one folder" style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 14 }}>
                  <Icon icon={ArrowUp01Icon} size={18} color="ink3" />
                  <Text variant="label" color="ink2">Up to {pretty(dir.parent).split('/').pop() || dir.parent}</Text>
                </Press>}
              </View>
            ) : null}
            renderItem={({ item: d }) => (
              <OutsideRow name={d} dir onPress={() => { haptic.tap(); go(dir!.path ? `${dir!.path}/${d}` : d) }} />
            )}
            ListEmptyComponent={!dir && !error ? <View style={{ padding: 16, gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} radius={12} />)}</View>
              : <EmptyState title={error ? 'Unable to read that computer' : 'No folders inside'} body={error ?? 'You can still sync this folder itself.'} />}
          />
          {dir?.path && !home && (
            <View style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 16, gap: 8 }}>
              <Button label={`Sync “${dir.path.split('/').pop()}”`} size="lg" fullWidth loading={busy} onPress={sync} />
              <Text variant="footnote" color="ink3" align="center">One way: changes on {computer.name} show here. Copies count toward your vault’s space.</Text>
            </View>
          )}
        </>
      )}
    </View>
  )
}
