// Profile: you up top (a live dithered banner you pick, your Google picture, name, email and three numbers), then
// short groups of rows: what teammates use and know, where they work, your preferences, then Advanced and Sign out.
// Anything with more than a row's worth of settings has its own page.
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as ImagePicker from 'expo-image-picker'
import { Image } from 'expo-image'
import { LinearGradient } from 'expo-linear-gradient'
import * as Notifications from 'expo-notifications'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Platform, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Brain02Icon, BrowserIcon, DashboardSpeed01Icon, LaptopIcon, Logout01Icon, Plug01Icon,
  Settings02Icon, SmartPhone01Icon,
} from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { NotifyChoices } from '@/components/notify-prefs'
import { BANNERS, Banner, bannerOf } from '@/components/profile/banner'
import { useTabBarInset } from '@/components/tab-bar'
import { api } from '@/lib/api'
import { upload } from '@/lib/attachments'
import { identities } from '@/lib/auth'
import { useConnections } from '@/lib/catalog'
import { useFocusLater } from '@/lib/focus'
import { useSession } from '@/lib/session'
import { setGarageTone, useGarageTone, type GarageTone } from '@/lib/garage-tone'
import { supabase } from '@/lib/supabase'
import type { MemoryOverview, Profile } from '@/lib/types'
import { isPhone, useWorkspace } from '@/lib/workspace'
import { useTheme, type ThemePreference } from '@/theme'
import { AvatarGroup, AvatarStack, Button, ChoiceRow, Divider, ListRow, Press, Sheet, Surface, Text, TextField, Toggle, confirm, haptic, toast } from '@/ui'

const TOKEN_KEY = 'tubelight.pushToken'
const FCM_KEY = 'tubelight.fcmToken'
const BANNER_H = 172
const AVATAR = 112

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
          <Divider />
          <MemoryRow />
          <Divider />
          <Divider />
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
          <GarageLook />
          <ImageModel />
        </Group>
        <Surface style={{ overflow: 'hidden' }}>
          <ListRow title="Advanced" subtitle="Webhook URL, service status" icon={Settings02Icon} chevron onPress={() => router.push('/advanced')} />
          <Divider />
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
  const crew = ws.teammates
  const { session } = useSession()
  const meta = session?.user.user_metadata ?? {}
  const [g, setG] = useState<{ name: string | null; picture: string | null; email: string | null } | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [focused, setFocused] = useState(true)
  const [editing, setEditing] = useState(false)
  const [look, setLook] = useState<Look>({ banner: meta.banner as string | undefined, avatar_path: (meta.avatar_path as string | undefined) ?? null })
  const own = useSignedUrl(look.avatar_path ?? null)

  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))
  useEffect(() => {
    identities().then((ids) => { const x = ids.find((i) => i.provider === 'google'); if (x) setG(x) }, () => {})
    // The session cached on the phone carries the metadata from sign-in time; the server has what you picked since.
    supabase.auth.getUser().then(({ data }) => {
      const m = data.user?.user_metadata
      if (m) setLook({ banner: m.banner as string | undefined, avatar_path: (m.avatar_path as string | undefined) ?? null })
    }, () => {})
    supabase.from('profiles').select('*').single().then(({ data }) => { if (data) setProfile(data as Profile) })
  }, [])

  /** Banner, dither and your own photo live on the account (auth metadata), so every phone shows the same. */
  const change = (next: Partial<Look>) => {
    setLook((l) => ({ ...l, ...next }))
    supabase.auth.updateUser({ data: next }).then(({ error }) => {
      if (error) toast({ title: 'Unable to save that', body: 'Check your connection and try again.', tone: 'error' })
    })
  }

  const name = profile?.display_name || g?.name || 'You'
  const email = g?.email ?? session?.user.email ?? ''
  const picture = look.avatar_path ? own : g?.picture ?? (meta.avatar_url as string | undefined) ?? null

  return (
    <View>
      <Banner id={look.banner} live={focused && !editing} style={{ height: BANNER_H + top }} />
      <LinearGradient colors={[`${c.canvas}00`, c.canvas]} style={{ position: 'absolute', left: 0, right: 0, top: BANNER_H + top - 90, height: 90 }} pointerEvents="none" />
      <View style={{ alignItems: 'center', paddingHorizontal: 24, marginTop: -AVATAR / 2 - 4, gap: 14 }}>
        <Press static radius={(AVATAR + 8) / 2} onPress={() => { haptic.tap(); setEditing(true) }} accessibilityLabel="Your picture. Edit profile">
          <View style={{ width: AVATAR + 8, height: AVATAR + 8, borderRadius: (AVATAR + 8) / 2, backgroundColor: c.canvas, padding: 4 }}>
            <Face uri={picture} size={AVATAR} />
          </View>
        </Press>
        <View style={{ alignItems: 'center', gap: 4 }}>
          <Text variant="title" numberOfLines={1}>{name}</Text>
          <Text variant="caption" color="ink2" numberOfLines={1}>{email}</Text>
        </View>
        {crew.length > 0 && (
          <Press radius={18} onPress={() => router.push('/crew')} accessibilityLabel={`Your crew: ${crew.map((t) => t.name).join(', ')}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingLeft: 6, paddingRight: 14, borderRadius: 18, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
            <AvatarStack teammates={crew} size={26} max={5} ring={c.panel} />
            <Text variant="footnote" color="ink2">Your crew</Text>
          </Press>
        )}
      </View>
      <EditProfile open={editing} onClose={() => setEditing(false)} profile={profile} name={name} picture={picture}
        google={g?.picture ?? null} look={look} onLook={change} onSaved={setProfile} />
    </View>
  )
}

function Face({ uri, size }: { uri: string | null; size: number }) {
  const { c } = useTheme()
  return uri ? <Image source={{ uri, cacheKey: uri.split('?')[0] }} style={{ width: size, height: size, borderRadius: size / 2 }} contentFit="cover" transition={150} />
    : <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.panel }} />
}

/** A week-long link to a file in your private `attachments` folder (your own photo). */
function useSignedUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return
    supabase.storage.from('attachments').createSignedUrl(path, 7 * 86_400).then(({ data }) => setUrl(data?.signedUrl ?? null))
  }, [path])
  return path ? url : null
}

type Look = { banner?: string; avatar_path?: string | null }

/** Everything about how you look, in one sheet: photo, name and banner. */
function EditProfile({ open, onClose, profile, name, picture, google, look, onLook, onSaved }: {
  open: boolean; onClose: () => void; profile: Profile | null; name: string; picture: string | null; google: string | null
  look: Look; onLook: (l: Look) => void; onSaved: (p: Profile) => void
}) {
  const { c } = useTheme()
  const [draft, setDraft] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const value = draft ?? profile?.display_name ?? name

  const saveName = async () => {
    const next = draft?.trim()
    if (!profile || next === undefined || next === (profile.display_name ?? '')) return
    const { data, error } = await supabase.from('profiles').update({ display_name: next || null }).eq('id', profile.id).select().single()
    if (error) { toast({ title: 'Unable to save your name', body: 'Check your connection and try again.', tone: 'error' }); return }
    onSaved(data as Profile)
    setDraft(null)
    haptic.success()
  }
  const pickPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', allowsEditing: true, aspect: [1, 1], quality: 0.7 })
    if (r.canceled || !r.assets[0]) return
    setUploading(true)
    try {
      const a = r.assets[0]
      const { path } = await upload({ id: String(Date.now()), uri: a.uri, name: 'profile-photo.jpg', mime: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 0 })
      onLook({ avatar_path: path })
      haptic.success()
    } catch (e) {
      toast({ title: 'Unable to change your photo', body: (e as Error).message, tone: 'error' })
    } finally { setUploading(false) }
  }

  return (
    <Sheet open={open} onClose={() => { saveName(); onClose() }} title="Edit profile">
      <View style={{ gap: 22, paddingBottom: 8, paddingHorizontal: 16 }}>
        <View style={{ alignItems: 'center', gap: 12 }}>
          <View style={{ opacity: uploading ? 0.5 : 1 }}><Face uri={picture} size={88} /></View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={uploading ? 'Uploading…' : 'Change photo'} size="sm" variant="soft" onPress={pickPhoto} disabled={uploading} />
            {!!look.avatar_path && google && <Button label="Use Google photo" size="sm" variant="ghost" onPress={() => onLook({ avatar_path: null })} />}
          </View>
        </View>
        <TextField label="Name" value={value} onChangeText={setDraft} onBlur={saveName} onSubmitEditing={saveName} returnKeyType="done"
          hint="Teammates call you this." maxLength={40} autoCapitalize="words" />
        <View style={{ gap: 10 }}>
          <Text variant="label" color="ink2">Banner</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
            {BANNERS.map((b) => {
              const on = bannerOf(look.banner).id === b.id
              return (
                <Press key={b.id} radius={14} onPress={() => { haptic.tap(); onLook({ banner: b.id }) }} accessibilityLabel={b.name} accessibilityState={{ selected: on }}
                  style={{ padding: 2, borderRadius: 14, borderWidth: 2, borderColor: on ? c.ink : 'transparent' }}>
                  <Image source={b.src} style={{ width: 112, height: 72, borderRadius: 10 }} contentFit="cover" />
                </Press>
              )
            })}
          </ScrollView>
        </View>
      </View>
    </Sheet>
  )
}

// ------------------------------------------------------------------ rows

/** Connected apps, their logos stacked on the right; everything about apps lives on its own page. */
function AppsRow() {
  const { c } = useTheme()
  const { connections } = useConnections()
  const on = (connections ?? []).filter((x) => x.connected)
  return (
    <ListRow title="Apps" subtitle={connections === null ? 'Loading…' : on.length ? `${on.length} connected` : 'Connect Gmail, GitHub, Linear and more'}
      icon={Plug01Icon} chevron onPress={() => router.push('/connections')}
      accessory={on.length > 0 && <AvatarGroup size={24} max={4} ring={c.panel} items={on.map((x) => (
        { key: x.toolkit, name: x.name, render: (s) => <BrandTile toolkit={x.toolkit} size={s} /> }))} />} />
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
      <Divider />
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
      <Divider />
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

function GarageLook() {
  const tone = useGarageTone()
  return (
    <ChoiceRow label="Garage colour" value={tone} onChange={(v) => setGarageTone(v as GarageTone)} options={[
      { value: 'auto', title: 'Auto', subtitle: 'Cream on quiet days, blue on normal ones, orange on busy ones' },
      { value: 'cream', title: 'Cream' },
      { value: 'blue', title: 'Blue' },
      { value: 'orange', title: 'Orange' },
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

