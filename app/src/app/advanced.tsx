// The plumbing, off Profile: the webhook URL services post to, and whether the teammate service's parts are up.
import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Copy01Icon, RefreshIcon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons'

import { FormSection } from '@/components/form-bits'
import { ScreenHeader } from '@/components/screen-header'
import { ApiError, api } from '@/lib/api'
import { randomHex } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'
import { useTheme } from '@/theme'
import { Button, Chip, Divider, ListRow, Skeleton, Surface, Text, confirm, haptic, toast } from '@/ui'

const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_URL ?? 'http://localhost:8787'

export default function AdvancedScreen() {
  const insets = useSafeAreaInsets()
  const [profile, setProfile] = useState<Profile | null>(null)
  const load = useCallback(() => supabase.from('profiles').select('*').single()
    .then(({ data }) => { if (data) setProfile(data as Profile) }), [])
  useEffect(() => { load() }, [load])
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Advanced" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 36 }}>
        <WebhookSection profile={profile} onChanged={setProfile} />
        <ServiceStatus />
        {__DEV__ && (
          <Surface style={{ overflow: 'hidden' }}>
            <ListRow title="UI gallery" subtitle="Every primitive, for development" chevron onPress={() => router.push('/ui-gallery')} />
          </Surface>
        )}
      </ScrollView>
    </View>
  )
}

// ------------------------------------------------------------------ webhook token

function WebhookSection({ profile, onChanged }: { profile: Profile | null; onChanged: (p: Profile) => void }) {
  const { c } = useTheme()
  const [shown, setShown] = useState(false)
  const token = profile?.webhook_token
  const url = token ? `${AGENT_URL}/events/${token}` : ''

  const copy = async () => { await Clipboard.setStringAsync(url); haptic.light(); toast({ title: 'Webhook URL copied' }) }
  const regenerate = async () => {
    if (!profile) return
    const ok = await confirm({
      title: 'Make a new webhook URL?',
      body: 'The current URL stops working right away. Anything that posts to it needs the new one.',
      confirmLabel: 'Make new URL',
      destructive: true,
    })
    if (!ok) return
    const { data, error } = await supabase.from('profiles').update({ webhook_token: randomHex(18) }).eq('id', profile.id).select().single()
    if (error) { toast({ title: 'Unable to make a new URL', body: 'Check your connection and try again.', tone: 'error' }); return }
    onChanged(data as Profile)
    setShown(true)
    haptic.success()
    toast({ title: 'New webhook URL is live', tone: 'success' })
  }

  const masked = token ? `${AGENT_URL}/events/${token.slice(0, 4)}${'•'.repeat(12)}${token.slice(-4)}` : ''
  return (
    <FormSection title="Webhook" hint="Services post events here to wake a teammate. Rules live in each project’s settings. Keep it private.">
      <Surface style={{ overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }}>
          {token ? (
            <Text variant="mono" selectable={shown} style={{ fontSize: 12, lineHeight: 18, color: c.ink2 }} accessibilityLabel={shown ? url : 'Webhook URL, hidden'}>
              {shown ? url : masked}
            </Text>
          ) : <Skeleton height={14} width="80%" />}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 10, paddingTop: 4 }}>
          <Button label="Copy" size="sm" variant="soft" icon={Copy01Icon} onPress={copy} disabled={!token} />
          <Button label={shown ? 'Hide' : 'Show'} size="sm" variant="ghost" icon={shown ? ViewOffIcon : ViewIcon} onPress={() => setShown((x) => !x)} disabled={!token} />
          <View style={{ flex: 1 }} />
          <Button label="New URL" size="sm" variant="ghost" icon={RefreshIcon} onPress={regenerate} disabled={!token} />
        </View>
      </Surface>
    </FormSection>
  )
}

// ------------------------------------------------------------------ service status

interface Health { ok: boolean; llm: boolean; db: boolean; docker: boolean; composio: boolean; push: boolean }

const CHECKS: { key: keyof Omit<Health, 'ok'>; title: string; on: string; off: string }[] = [
  { key: 'llm', title: 'Language models', on: 'Ready', off: 'No model provider key. Add GROQ_API_KEY or OPENROUTER_API_KEY to agent-service/.env.' },
  { key: 'db', title: 'Database', on: 'Connected', off: 'The service can’t reach Supabase. Check SUPABASE_DB_URL in agent-service/.env.' },
  { key: 'docker', title: 'Code sandbox', on: 'Docker is running', off: 'Docker isn’t running, so teammates can’t run code. Start Docker where the service runs.' },
  { key: 'composio', title: 'App connectors', on: 'Ready', off: 'No COMPOSIO_API_KEY, so Gmail, GitHub, Linear and Notion can’t connect.' },
]

function ServiceStatus() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<Health>('/health').then(setHealth).catch((e: ApiError) => setError(e.status === 0 ? `Can’t reach the teammate service at ${AGENT_URL}. Check it’s running and on the same network.` : e.message))
  }, [])

  return (
    <FormSection title="Teammate service" hint={AGENT_URL}>
      {error ? (
        <Surface padding={16}><Text variant="caption" color="danger">{error}</Text></Surface>
      ) : (
        <Surface style={{ overflow: 'hidden' }}>
          {CHECKS.map((ch, i) => {
            const ok = health?.[ch.key]
            return (
              <View key={ch.key}>
                {i > 0 && <Divider />}
                <View
                  style={{ paddingHorizontal: 16, paddingVertical: 12, minHeight: 52, gap: 4, justifyContent: 'center' }}
                  accessible
                  accessibilityLabel={health ? `${ch.title}, ${ok ? ch.on : `off. ${ch.off}`}` : `${ch.title}, checking`}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text variant="bodyMedium" style={{ flex: 1 }}>{ch.title}</Text>
                    {health ? <Chip label={ok ? ch.on : 'Off'} color={ok ? 'success' : 'warning'} size="sm" dot />
                      : <Skeleton width={56} height={22} radius={11} />}
                  </View>
                  {health && !ok && <Text variant="caption" color="ink3">{ch.off}</Text>}
                </View>
              </View>
            )
          })}
        </Surface>
      )}
    </FormSection>
  )
}
