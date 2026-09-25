import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BrandTile } from '@/components/brand-mark'
import { ScreenHeader } from '@/components/screen-header'
import { connectionStatus } from '@/components/teammate-form'
import { api } from '@/lib/api'
import { toolkitName, useConnections, type Connection } from '@/lib/catalog'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { AvatarStack, Button, Chip, Divider, Skeleton, Surface, Text, confirm, haptic, toast } from '@/ui'

export default function Connections() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { connections, error, reload } = useConnections()
  const [refreshing, setRefreshing] = useState(false)
  const unavailable = connections?.some((x) => x.status === 'unavailable')

  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false) }

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Connections" />
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
      >
        <Text variant="body" color="ink2">
          Sign in to an app once and every teammate you allow can use it. Anything that sends, posts or changes things still waits for your approval.
        </Text>
        {unavailable && (
          <Text variant="caption" color="ink3">Connectors are turned off on the teammate service (no Composio key), so you can’t connect apps right now.</Text>
        )}
        {error && !connections ? (
          <View style={{ gap: 12, alignItems: 'flex-start' }}>
            <Text variant="caption" color="danger">{error}</Text>
            <Button label="Try again" variant="soft" size="sm" onPress={reload} />
          </View>
        ) : (
          <Surface style={{ overflow: 'hidden' }}>
            {connections === null
              ? [0, 1, 2, 3].map((i) => (
                  <View key={i}>
                    {i > 0 && <Divider inset={64} />}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 72 }} accessible accessibilityLabel="Loading">
                      <Skeleton width={40} height={40} radius={12} />
                      <View style={{ flex: 1, gap: 8 }}><Skeleton width="35%" height={12} /><Skeleton width="55%" height={10} /></View>
                    </View>
                  </View>
                ))
              : connections.map((conn, i) => (
                  <View key={conn.toolkit}>
                    {i > 0 && <Divider inset={64} />}
                    <ConnectionRow conn={conn} onChanged={reload} disabled={!!unavailable} />
                  </View>
                ))}
          </Surface>
        )}
      </ScrollView>
    </View>
  )
}

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
