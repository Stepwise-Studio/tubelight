import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { memo, useState } from 'react'
import { FlatList, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandTile } from '@/components/brand-mark'
import { ScreenHeader } from '@/components/screen-header'
import { connectionStatus } from '@/components/teammate-form'
import { api } from '@/lib/api'
import { connectApp, toolkitName, useConnections, useToolkits, type Connection, type Toolkit } from '@/lib/catalog'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { AvatarStack, Button, Chip, Divider, Press, SearchField, Skeleton, Surface, Text, confirm, haptic, toast } from '@/ui'

export default function Connections() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { connections, error, reload } = useConnections()
  const { toolkits, error: catalogError, reload: reloadCatalog } = useToolkits()
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const unavailable = connections?.some((x) => x.status === 'unavailable')

  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false) }

  const byToolkit = new Map((connections ?? []).map((x) => [x.toolkit, x]))
  const mine = (connections ?? []).filter((x) => x.connected || x.status === 'expired' || x.status === 'failed')

  // The categories people actually browse: the most common ones in the catalog.
  const counts = new Map<string, number>()
  for (const t of toolkits ?? []) for (const k of t.categories) counts.set(k, (counts.get(k) ?? 0) + 1)
  const categories = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k)

  const q = query.trim().toLowerCase()
  const shown = (toolkits ?? []).filter((t) =>
    (!category || t.categories.includes(category))
    && (!q || t.name.toLowerCase().includes(q) || t.toolkit.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)))

  const header = (
    <View style={{ gap: 16, paddingBottom: 8 }}>
      <Text variant="body" color="ink2">
        Sign in to an app once and every teammate you allow can use it. Anything that sends, posts or changes things still waits for your approval.
      </Text>
      {unavailable && (
        <Text variant="caption" color="ink3">Connectors are turned off on the teammate service (no Composio key), so you can’t connect apps right now.</Text>
      )}
      {error && !connections && (
        <View style={{ gap: 12, alignItems: 'flex-start' }}>
          <Text variant="caption" color="danger">{error}</Text>
          <Button label="Try again" variant="soft" size="sm" onPress={reload} />
        </View>
      )}
      {mine.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text variant="label" color="ink3">Connected</Text>
          <Surface style={{ overflow: 'hidden' }}>
            {mine.map((conn, i) => (
              <View key={conn.toolkit}>
                {i > 0 && <Divider inset={64} />}
                <ConnectionRow conn={conn} onChanged={reload} disabled={!!unavailable} />
              </View>
            ))}
          </Surface>
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Text variant="label" color="ink3">{toolkits ? `All apps · ${toolkits.length.toLocaleString()}` : 'All apps'}</Text>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search Gmail, Slack, Stripe…" />
        {categories.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ marginHorizontal: -20 }}>
            <View style={{ width: 14 }} />
            {[null, ...categories].map((k) => {
              const on = category === k
              return (
                <Press
                  key={k ?? 'all'}
                  radius={16}
                  smoothing={0}
                  onPress={() => { haptic.tap(); setCategory(k) }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={{ height: 32, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: on ? c.tubeSoft : c.panel2 }}
                >
                  <Text variant="label" color={on ? 'tube' : 'ink2'}>{k ? k.charAt(0).toUpperCase() + k.slice(1) : 'All'}</Text>
                </Press>
              )
            })}
            <View style={{ width: 14 }} />
          </ScrollView>
        )}
        {catalogError && !toolkits && (
          <View style={{ gap: 12, alignItems: 'flex-start' }}>
            <Text variant="caption" color="danger">{catalogError}</Text>
            <Button label="Try again" variant="soft" size="sm" onPress={reloadCatalog} />
          </View>
        )}
        {!toolkits && !catalogError && [0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }} accessible accessibilityLabel="Loading">
            <Skeleton width={40} height={40} radius={12} />
            <View style={{ flex: 1, gap: 8 }}><Skeleton width="35%" height={12} /><Skeleton width="70%" height={10} /></View>
          </View>
        ))}
        {toolkits && shown.length === 0 && <Text variant="caption" color="ink3">No apps match “{query}”.</Text>}
      </View>
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Connections" />
      <FlatList
        data={shown}
        keyExtractor={(t) => t.toolkit}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <ToolkitRow t={item} state={byToolkit.get(item.toolkit)?.connected ? 'connected' : item.auth === 'none' ? 'ready' : 'idle'} disabled={!!unavailable} onChanged={reload} />
        )}
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
        maxToRenderPerBatch={12}
        windowSize={9}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      />
    </View>
  )
}

/** One app in the catalog. Connected apps show a chip here; manage them in the Connected section above. */
const ToolkitRow = memo(function ToolkitRow({ t, state, disabled, onChanged }: {
  t: Toolkit; state: 'connected' | 'ready' | 'idle'; disabled: boolean; onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const connect = async () => {
    setBusy(true)
    try { await connectApp(t.toolkit, t.name); await onChanged() } catch (e) {
      toast({ title: `Unable to connect ${t.name}`, body: (e as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }
  const hint = state === 'ready' ? 'No sign-in needed' : t.auth === 'key' ? 'Connects with an API key' : null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 64 }}>
      <BrandTile toolkit={t.toolkit} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{t.name}</Text>
        {!!t.description && <Text variant="caption" color="ink3" numberOfLines={1}>{t.description}</Text>}
        {hint && <Text variant="footnote" color="ink3" numberOfLines={1}>{hint}</Text>}
      </View>
      {state === 'connected' ? <Chip label="Connected" tone="success" dot />
        : state === 'ready' ? <Chip label="Ready" />
        : <Button label="Connect" size="sm" variant="soft" loading={busy} disabled={disabled} onPress={connect} />}
    </View>
  )
})

function ConnectionRow({ conn, onChanged, disabled }: { conn: Connection; onChanged: () => Promise<void>; disabled: boolean }) {
  const ws = useWorkspace()
  const [busy, setBusy] = useState(false)
  const users = ws.teammates.filter((t) => t.allowed_toolkits.includes(conn.toolkit))
  const name = conn.name || toolkitName(conn.toolkit)
  const needsFix = conn.status === 'expired' || conn.status === 'failed'

  const connect = async () => {
    setBusy(true)
    try {
      const callback = Linking.createURL('connections')
      const { redirect_url } = await api<{ redirect_url: string }>(`/connections/${conn.toolkit}`, { method: 'POST', json: { callback_url: callback } })
      await WebBrowser.openAuthSessionAsync(redirect_url, callback)
      await onChanged()
    } catch (e) {
      toast({ title: `Unable to connect ${name}`, body: (e as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    const who = users.length ? ` ${users.map((u) => u.name).join(', ')} will lose access.` : ''
    const ok = await confirm({ title: `Disconnect ${name}?`, body: `Teammates can’t use ${name} until you connect it again.${who}`, confirmLabel: `Disconnect ${name}`, destructive: true })
    if (!ok) return
    setBusy(true)
    try {
      await api(`/connections/${conn.toolkit}`, { method: 'DELETE' })
      haptic.success()
      await onChanged()
    } catch (e) {
      toast({ title: `Unable to disconnect ${name}`, body: (e as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 72 }}>
      <BrandTile toolkit={conn.toolkit} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>{name}</Text>
          {conn.connected && <Chip label="Connected" tone="success" dot />}
          {needsFix && <Chip label="Needs reconnecting" tone="warning" />}
        </View>
        {!conn.connected && !needsFix && <Text variant="caption" color="ink3" numberOfLines={1}>{connectionStatus(conn)}</Text>}
        {conn.connected && conn.account && <Text variant="caption" color="ink3" numberOfLines={1}>{conn.account}</Text>}
        {users.length > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <AvatarStack teammates={users} size={18} max={4} />
            <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>
              {users.length === 1 ? `${users[0].name} uses it` : `${users.length} teammates use it`}
            </Text>
          </View>
        ) : (
          <Text variant="footnote" color="ink3">No teammate uses it yet</Text>
        )}
      </View>
      {conn.connected ? (
        <Button label="Disconnect" size="sm" variant="ghost" loading={busy} disabled={disabled} onPress={disconnect} style={{ alignSelf: 'center' }} />
      ) : (
        <Button label={needsFix ? 'Reconnect' : 'Connect'} size="sm" variant="soft" loading={busy} disabled={disabled} onPress={connect} style={{ alignSelf: 'center' }} />
      )}
    </View>
  )
}
