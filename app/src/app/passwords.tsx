// Saved passwords: the sign-ins Tubelight's browser can fill for teammates when a site logs you out (agent-service
// passwords.py). Saved from the Sign in screen when you sign in yourself; kept encrypted on your server, never shown
// to a teammate, never here either. Remove one and teammates ask you to sign in again.
import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Key01Icon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { ago } from '@/lib/format'
import { useTheme } from '@/theme'
import { Button, Divider, EmptyState, ListRow, Skeleton, Surface, Text, confirm, haptic, toast } from '@/ui'

interface Saved { site: string; username: string; saved_at: string; used_at: string }

export default function Passwords() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<Saved[] | null>(null)
  const load = useCallback(() => api<{ items: Saved[] }>('/browser/passwords').then((r) => setItems(r.items), (e: Error) => {
    setItems([]); toast({ title: 'Unable to load saved passwords', body: e.message, tone: 'error' })
  }), [])
  useFocusEffect(useCallback(() => { load() }, [load]))

  const forget = async (s: Saved) => {
    if (!(await confirm({ title: `Remove the ${s.site} password?`, body: 'Teammates will ask you to sign in yourself next time the site logs you out.', confirmLabel: 'Remove', destructive: true }))) return
    try { await api(`/browser/passwords/${encodeURIComponent(s.site)}`, { method: 'DELETE' }); haptic.success(); load() } catch (e) { toast({ title: 'Unable to remove it', body: (e as Error).message, tone: 'error' }) }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Saved passwords" subtitle="Filled in by your server; teammates never see them" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 12 }}>
        {items === null ? (
          <Surface padding={16} style={{ gap: 12 }}><Skeleton width="45%" /><Skeleton width="70%" /></Surface>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing saved yet" body="When you sign in to a site in Tubelight’s browser, it offers to save the password so teammates can sign you back in." />
        ) : (
          <Surface style={{ overflow: 'hidden' }}>
            {items.map((s, i) => (
              <View key={s.site}>
                {i > 0 && <Divider />}
                <ListRow title={s.site} icon={Key01Icon}
                  subtitle={[s.username, s.used_at ? `used ${ago(s.used_at).toLowerCase()}` : `saved ${ago(s.saved_at).toLowerCase()}`].filter(Boolean).join(' · ')}
                  accessory={<Button label="Remove" size="sm" variant="ghost" onPress={() => forget(s)} />} />
              </View>
            ))}
          </Surface>
        )}
        <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 4 }}>
          A teammate asks before using one, unless it’s an automation you set up. Codes sent to your phone or email still come to you.
        </Text>
      </ScrollView>
    </View>
  )
}
