// Profile: you up top (a live dithered banner you pick, your Google picture, name, email and three numbers), then
// short groups of rows: what teammates use and know, where they work, your preferences, then Advanced and Sign out.
// Anything with more than a row's worth of settings has its own page.
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import * as Notifications from 'expo-notifications'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, RefreshControl, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Brain02Icon, BrowserIcon, DashboardSpeed01Icon, LaptopIcon, Logout01Icon, PaintBrush02Icon, Plug01Icon, RepeatIcon,
  Settings02Icon, SmartPhone01Icon,
} from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { NotifyChoices } from '@/components/notify-prefs'
import { Banner } from '@/components/profile/banner'
import { BANNERS, type BannerId } from '@/components/profile/banner-shader'
import { useTabBarInset } from '@/components/tab-bar'
import { api } from '@/lib/api'
import { identities } from '@/lib/auth'
import type { Automation } from '@/lib/automations'
import { useConnections } from '@/lib/catalog'
import { whenLabel } from '@/lib/format'
import { useFocusLater } from '@/lib/focus'
import { useSession } from '@/lib/session'
import { supabase } from '@/lib/supabase'
import type { MemoryOverview, Profile } from '@/lib/types'
import { isPhone, useWorkspace } from '@/lib/workspace'
import { type as typeScale, useTheme, type ThemePreference } from '@/theme'
import { ChoiceRow, Divider, IconButton, ListRow, Press, Sheet, Surface, Text, Toggle, confirm, haptic, toast } from '@/ui'

const TOKEN_KEY = 'tubelight.pushToken'
const FCM_KEY = 'tubelight.fcmToken'
const BANNER_H = 172
const AVATAR = 88

export default function ProfileScreen() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const [refreshing, setRefreshing] = useState(false)
  const [round, setRound] = useState(0)

  const signOut = async () => {
    if (!(await confirm({ title: 'Sign out?', body: 'This phone stops getting notifications until you sign in again.', confirmLabel: 'Sign out' }))) return
    for (const key of [TOKEN_KEY, FCM_KEY]) {
      const token = await AsyncStorage.getItem(key).catch(() => null)
      if (token) {
        await supabase.from('push_tokens').delete().eq('token', token)
        await AsyncStorage.removeItem(key).catch(() => {})
      }
    }
    await supabase.auth.signOut()
  }

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: inset + 32 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} progressViewOffset={40} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel}
        onRefresh={() => { setRefreshing(true); setRound((r) => r + 1); setTimeout(() => setRefreshing(false), 600) }} />}
    >
      <Hero key={round} />
      <View style={{ paddingHorizontal: 16, gap: 28, marginTop: 28 }}>
        <Group title="Teammates use">
          <AppsRow />
          <Divider inset={56} />
          <MemoryRow />
          <Divider inset={56} />
          <AutomationsRow />
          <Divider inset={56} />
          <UsageRow />
        </Group>
        <Group title="Where they work">
          <ComputersRow />
          <BrowserRow />
          <PhoneRow />
        </Group>
        <Group title="Preferences">
          <PushSection />
          <Divider />
          <Appearance />
          <ImageModel />
        </Group>
        <Surface style={{ overflow: 'hidden' }}>
          <ListRow title="Advanced" subtitle="Webhook URL, service status" icon={Settings02Icon} chevron onPress={() => router.push('/advanced')} />
          <Divider inset={56} />
          <ListRow title="Sign out" icon={Logout01Icon} destructive onPress={signOut} />
        </Surface>
      </View>
    </ScrollView>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 4 }}>{title}</Text>
      <Surface style={{ overflow: 'hidden' }}>{children}</Surface>
    </View>
  )
}

// ------------------------------------------------------------------ you

function Hero() {
  const { c } = useTheme()
  const top = useSafeAreaInsets().top
  const ws = useWorkspace()
  const { session } = useSession()
  const meta = session?.user.user_metadata ?? {}
  const [g, setG] = useState<{ name: string | null; picture: string | null; email: string | null } | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [focused, setFocused] = useState(true)
  const [picking, setPicking] = useState(false)
  const [banner, setBanner] = useState<BannerId>((meta.banner as BannerId) ?? 'canopy')
  const { connections } = useConnections()
  const [autos, setAutos] = useState<number | null>(null)

  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))
  useEffect(() => {
    identities().then((ids) => { const x = ids.find((i) => i.provider === 'google'); if (x) setG(x) }, () => {})
    supabase.from('profiles').select('*').single().then(({ data }) => { if (data) setProfile(data as Profile) })
    api<Automation[]>('/automations').then((a) => setAutos(a.filter((x) => x.enabled).length), () => {})
  }, [])

  const pickBanner = (id: BannerId) => {
    haptic.tap()
    setBanner(id)
    supabase.auth.updateUser({ data: { banner: id } }).catch(() => {})
  }

  const name = profile?.display_name || g?.name || 'You'
  const email = g?.email ?? session?.user.email ?? ''
  const picture = g?.picture ?? (meta.avatar_url as string | undefined) ?? null
  const apps = (connections ?? []).filter((x) => x.connected).length
  const stats: { n: number | null; label: string; go: () => void }[] = [
    { n: ws.teammates.length, label: ws.teammates.length === 1 ? 'Teammate' : 'Teammates', go: () => router.push('/crew') },
    { n: connections ? apps : null, label: apps === 1 ? 'App' : 'Apps', go: () => router.push('/connections') },
    { n: autos, label: autos === 1 ? 'Automation' : 'Automations', go: () => router.push('/automations') },
  ]

  return (
    <View>
      <Press static radius={0} onPress={() => setPicking(true)} accessibilityLabel="Change banner">
        <Banner id={banner} live={focused && !picking} style={{ height: BANNER_H + top }} />
        <LinearGradient colors={['transparent', c.canvas]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 }} pointerEvents="none" />
      </Press>
      <View style={{ position: 'absolute', right: 12, top: top + 8 }}>
        <IconButton icon={PaintBrush02Icon} accessibilityLabel="Change banner" variant="soft" size={36} iconSize={18} round onPress={() => setPicking(true)} />
      </View>
      <View style={{ paddingHorizontal: 20, marginTop: -AVATAR / 2 }}>
        <View style={{ width: AVATAR + 8, height: AVATAR + 8, borderRadius: (AVATAR + 8) / 2, backgroundColor: c.canvas, padding: 4 }}>
          {picture ? <Image source={picture} style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 }} contentFit="cover" transition={150} accessibilityLabel="Your picture" />
            : <View style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: c.panel }} />}
        </View>
        <Name value={name} profile={profile} onSaved={setProfile} />
        <Text variant="body" color="ink3" numberOfLines={1} style={{ marginTop: 2 }}>{email}</Text>
        <View style={{ flexDirection: 'row', marginTop: 20, gap: 8 }}>
          {stats.map((s) => (
            <Press key={s.label} radius={14} onPress={s.go} outerStyle={{ flex: 1 }} accessibilityLabel={`${s.n ?? ''} ${s.label}`}
              style={{ paddingVertical: 12, paddingHorizontal: 12, gap: 2, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
              <Text variant="title" tabular>{s.n ?? '–'}</Text>
              <Text variant="footnote" color="ink3" numberOfLines={1}>{s.label}</Text>
            </Press>
          ))}
        </View>
      </View>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Banner">
        <View style={{ gap: 10, paddingBottom: 8 }}>
          {BANNERS.map((b) => (
            <Press key={b.id} radius={16} onPress={() => pickBanner(b.id)} accessibilityLabel={b.name} accessibilityState={{ selected: banner === b.id }}
              style={{ overflow: 'hidden', borderWidth: 2, borderColor: banner === b.id ? c.ink : 'transparent' }}>
              <Banner id={b.id} live={picking} style={{ height: 72 }} />
              <Text variant="label" style={{ position: 'absolute', left: 12, bottom: 8, color: '#fafafa' }}>{b.name}</Text>
            </Press>
          ))}
        </View>
      </Sheet>
    </View>
  )
}

/** Your name, as teammates call you: tap it to change it in place. */
function Name({ value, profile, onSaved }: { value: string; profile: Profile | null; onSaved: (p: Profile) => void }) {
  const { c } = useTheme()
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<TextInput>(null)
  const save = async () => {
    const next = draft?.trim()
    setDraft(null)
    if (!profile || next === undefined || next === (profile.display_name ?? '')) return
    const { data, error } = await supabase.from('profiles').update({ display_name: next || null }).eq('id', profile.id).select().single()
    if (error) { toast({ title: 'Unable to save your name', body: 'Check your connection and try again.', tone: 'error' }); return }
    onSaved(data as Profile)
    haptic.success()
  }
  if (draft !== null) return (
    <TextInput ref={ref} value={draft} onChangeText={setDraft} onBlur={save} onSubmitEditing={save} autoFocus maxLength={40}
      returnKeyType="done" autoCapitalize="words" selectionColor={c.tube}
      style={[typeScale.largeTitle, { color: c.ink, marginTop: 10, padding: 0 }]} accessibilityLabel="Your name" />
  )
  return (
    <Press static radius={8} onPress={() => { haptic.tap(); setDraft(profile?.display_name ?? value) }} outerStyle={{ alignSelf: 'flex-start', marginTop: 10 }}
      accessibilityLabel={`${value}. Teammates call you this. Tap to change it.`}>
      <Text variant="largeTitle" numberOfLines={1}>{value}</Text>
    </Press>
  )
}

// ------------------------------------------------------------------ rows

/** Connected apps, their marks stacked on the right; everything about apps lives on its own page. */
function AppsRow() {
  const { c } = useTheme()
  const { connections } = useConnections()
  const on = (connections ?? []).filter((x) => x.connected)
  return (
    <ListRow title="Apps" subtitle={connections === null ? 'Loading…' : on.length ? `${on.length} connected` : 'Connect Gmail, GitHub, Linear and more'}
      icon={Plug01Icon} chevron onPress={() => router.push('/connections')}
      accessory={on.length > 0 && (
        <View style={{ flexDirection: 'row' }}>
          {on.slice(0, 4).map((x, i) => (
            <View key={x.toolkit} style={{ marginLeft: i ? -8 : 0, borderRadius: 9, borderWidth: 2, borderColor: c.panel }}><BrandTile toolkit={x.toolkit} size={22} /></View>
          ))}
        </View>
      )} />
  )
}

function MemoryRow() {
  const [o, setO] = useState<MemoryOverview | null | undefined>(undefined)
  useFocusLater(useCallback(() => { api<MemoryOverview>('/memory/overview').then(setO, () => setO(null)) }, []))
  const n = o?.counts
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const summary = o === undefined ? 'Loading…' : !n || (!n.facts && !n.waiting) ? 'Fills in as you chat'
    : [o!.open.length ? `${o!.open.length} open` : null, plural(n.people, 'person', 'people'), plural(n.facts, 'fact', 'facts'),
      n.waiting ? 'still learning' : null].filter(Boolean).join(' · ')
  return <ListRow title="Memory" subtitle={summary} icon={Brain02Icon} chevron onPress={() => router.push('/memory')} />
}

function AutomationsRow() {
  const [items, setItems] = useState<Automation[] | null>(null)
  useFocusLater(useCallback(() => { api<Automation[]>('/automations').then(setItems, () => setItems([])) }, []))
  const on = (items ?? []).filter((a) => a.enabled)
  const next = on.map((a) => a.next_run).filter((x): x is string => !!x).sort()[0]
  const summary = items === null ? 'Loading…' : items.length === 0 ? 'Ask a teammate to do something on a schedule'
    : [`${on.length} on`, items.length > on.length && `${items.length - on.length} paused`, next && `next ${whenLabel(next)}`].filter(Boolean).join(' · ')
  return <ListRow title="Automations" subtitle={summary} icon={RepeatIcon} chevron onPress={() => router.push('/automations')} />
}

/** How much of the free allowances is left: anything used up first, else this month's tool calls. */
function UsageRow() {
  const [items, setItems] = useState<{ id: string; used: number; limit: number | null; out?: boolean; unit: string }[] | null>(null)
  useFocusLater(useCallback(() => {
    api<{ sections: { items: { id: string; used: number; limit: number | null; out?: boolean; unit: string }[] }[] }>('/usage')
      .then((u) => setItems(u.sections.flatMap((s) => s.items)), () => setItems([]))
  }, []))
  const out = (items ?? []).filter((i) => i.out || (i.limit != null && i.used >= i.limit)).length
  const tools = items?.find((i) => i.id === 'composio')
  const summary = items === null ? 'Loading…' : [out ? `${out} used up for now` : 'Nothing used up',
    tools && `${tools.used.toLocaleString()} tool calls this month`].filter(Boolean).join(' · ')
  return <ListRow title="Usage" subtitle={summary} icon={DashboardSpeed01Icon} chevron onPress={() => router.push('/usage')} />
}

function ComputersRow() {
  const [items, setItems] = useState<{ name: string; online: boolean; folders: string[] }[] | null>(null)
  useFocusLater(useCallback(() => { api<{ computers: { name: string; online: boolean; folders: string[] }[] }>('/computers').then((d) => setItems(d.computers), () => setItems([])) }, []))
  const on = (items ?? []).filter((m) => m.online)
  const summary = items === null ? 'Loading…' : items.length === 0 ? 'Let teammates work on your laptop'
    : on.length ? `${on.map((m) => m.name).join(', ')} online` : `${items.length} linked, none online`
  return <ListRow title="Computers" subtitle={summary} icon={LaptopIcon} chevron onPress={() => router.push('/computers')} />
}

/** Tubelight's browser on the server (hidden where the server has none). */
function BrowserRow() {
  const [b, setB] = useState<{ available: boolean; running: boolean; sites: string[] } | null>(null)
  useFocusLater(useCallback(() => { api<{ available: boolean; running: boolean; sites: string[] }>('/browser').then(setB, () => setB(null)) }, []))
  if (b && !b.available) return null
  const summary = b?.sites.length ? `May act on ${b.sites.join(', ')}` : b?.running ? 'Open: teammates only read pages' : 'Sign in to sites teammates use'
  return (
    <>
      <Divider inset={56} />
      <ListRow title="Browser" subtitle={summary} icon={BrowserIcon} chevron onPress={() => router.push('/browser')} />
    </>
  )
}

function PhoneRow() {
  const ws = useWorkspace()
  const mate = ws.everyone.find(isPhone)
  if (Platform.OS !== 'android' || !mate) return null
  return (
    <>
      <Divider inset={56} />
      <ListRow title="Phone assistant" subtitle={`${mate.name}: side key, calls, what it may use`} icon={SmartPhone01Icon} chevron onPress={() => router.push('/phone-assistant')} />
    </>
  )
}

// Which model draws teammates' pictures (agent: images.py). If it fails, FLUX.1 schnell steps in.
function ImageModel() {
  const [data, setData] = useState<{ model: string; models: { id: string; name: string; about: string; per_day: number }[] } | null>(null)
  useEffect(() => { api<NonNullable<typeof data>>('/images/model').then(setData, () => {}) }, [])
  if (!data) return null
  const pick = async (model: string) => {
    const before = data.model
    setData({ ...data, model })
    try { await api('/images/model', { method: 'PUT', json: { model } }) } catch (e) {
      setData({ ...data, model: before })
      toast({ title: 'Unable to change the image model', body: (e as Error).message, tone: 'error' })
    }
  }
  return (
    <ChoiceRow label="Image model" value={data.model} onChange={pick} options={data.models.map((m) => (
      { value: m.id, title: m.name, subtitle: `${m.about} · about ${m.per_day} a day` }))} />
  )
}

function Appearance() {
  const { preference, setPreference } = useTheme()
  return (
    <ChoiceRow label="Theme" value={preference} onChange={(v) => setPreference(v as ThemePreference)} options={[
      { value: 'system', title: 'System', subtitle: 'Light or dark, as your phone is set' },
      { value: 'light', title: 'Light' },
      { value: 'dark', title: 'Dark' },
    ]} />
  )
}

// ------------------------------------------------------------------ push

function pushUnavailable(): string | null {
  if (Platform.OS === 'web') return 'Notifications work in the iOS and Android app.'
  if (!Device.isDevice) return 'Notifications need a real phone, not a simulator.'
  return null
}

async function registerPush(): Promise<string> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Teammates', importance: Notifications.AndroidImportance.HIGH })
  }
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') throw new Error('Notifications are turned off for Tubelight. Allow them in your phone’s settings, then try again.')
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
  try {
    return (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    if (!projectId) throw new Error('This build has no EAS project ID, which Expo push needs. Run “eas init” to add extra.eas.projectId to app.json, then rebuild.')
    if (/firebase|fcm/i.test(msg)) throw new Error('Android push needs Firebase Cloud Messaging set up for this build (google-services.json).')
    throw new Error(`Unable to get a push token: ${msg}`)
  }
}

function PushSection() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(pushUnavailable())

  useEffect(() => {
    (async () => {
      const token = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null)
      if (!token) { setOn(false); return }
      const { data } = await supabase.from('push_tokens').select('token').eq('token', token).maybeSingle()
      setOn(!!data)
      // Turned on before Firebase delivery existed: add this phone's Firebase token once (see change() below).
      if (data && Platform.OS === 'android' && !(await AsyncStorage.getItem(FCM_KEY).catch(() => null))) {
        try {
          const fcm = (await Notifications.getDevicePushTokenAsync()).data as string
          const { error } = await supabase.from('push_tokens').upsert({ token: fcm, platform: 'fcm' })
          if (!error) await AsyncStorage.setItem(FCM_KEY, fcm)
        } catch { /* stays on Expo delivery */ }
      }
    })()
  }, [])

  const change = async (next: boolean) => {
    setBusy(true)
    setProblem(pushUnavailable())
    try {
      if (next) {
        const token = await registerPush()
        const { error } = await supabase.from('push_tokens').upsert({ token, platform: Platform.OS })
        if (error) throw new Error('Unable to save this phone’s token. Check your connection and try again.')
        await AsyncStorage.setItem(TOKEN_KEY, token)
        // Android also registers its Firebase token: the service sends straight through Firebase so the app can
        // draw notifications with their buttons (Approve, Reply) and faces (agent-service push.py).
        if (Platform.OS === 'android') {
          const fcm = (await Notifications.getDevicePushTokenAsync()).data as string
          await supabase.from('push_tokens').upsert({ token: fcm, platform: 'fcm' })
          await AsyncStorage.setItem(FCM_KEY, fcm)
        }
        haptic.success()
        setOn(true)
      } else {
        for (const key of [TOKEN_KEY, FCM_KEY]) {
          const token = await AsyncStorage.getItem(key)
          if (token) await supabase.from('push_tokens').delete().eq('token', token)
          await AsyncStorage.removeItem(key)
        }
        setOn(false)
      }
    } catch (e) {
      setProblem((e as Error).message)
      setOn(false)
    } finally { setBusy(false) }
  }

  const blocked = !!pushUnavailable()
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 6 }}>
        <Toggle label="Notifications" value={!!on} onChange={change} disabled={blocked || busy || on === null} />
        {problem && <Text variant="footnote" color={blocked ? 'ink3' : 'warning'} accessibilityLiveRegion="polite">{problem}</Text>}
      </View>
      {on && <NotifyChoices />}
    </>
  )
}

