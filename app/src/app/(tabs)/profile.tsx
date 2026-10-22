import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'
import { useFocusLater } from '@/lib/focus'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, AppState, Linking, PermissionsAndroid, Platform, RefreshControl, ScrollView, View } from 'react-native'
import { BrowserIcon,
  Add01Icon, Brain02Icon, CheckmarkCircle02Icon, Mail01Icon, Copy01Icon, LaptopIcon, Logout01Icon, Plug01Icon, RefreshIcon, RepeatIcon, DashboardSpeed01Icon, ViewIcon, ViewOffIcon,
} from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { FormSection } from '@/components/form-bits'
import { NotifyChoices } from '@/components/notify-prefs'
import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { Phone, syncNotifications } from '@/lib/phone'
import { ApiError, api } from '@/lib/api'
import type { Automation } from '@/lib/automations'
import { whenLabel } from '@/lib/format'
import { connectApp, randomHex, toolkitName, useConnections, useToolkits, type Toolkit } from '@/lib/catalog'
import { useSession } from '@/lib/session'
import { google, identities } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import type { MemoryOverview, Profile } from '@/lib/types'
import { isPhone, useWorkspace } from '@/lib/workspace'
import { useTheme, type ThemePreference } from '@/theme'
import {
  Button, ChoiceRow, Chip, Divider, ListRow, Press, Skeleton, Surface, TeammateAvatar, Text, TextField, Toggle,
  confirm, haptic, toast,
} from '@/ui'

const AGENT_URL = process.env.EXPO_PUBLIC_AGENT_URL ?? 'http://localhost:8787'
const TOKEN_KEY = 'tubelight.pushToken'
const FCM_KEY = 'tubelight.fcmToken'

export default function ProfileScreen() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const { session } = useSession()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [healthKey, setHealthKey] = useState(0)

  const loadProfile = useCallback(() => supabase.from('profiles').select('*').single()
    .then(({ data }) => { if (data) setProfile(data as Profile) }), [])
  useEffect(() => { loadProfile() }, [loadProfile])

  const refresh = async () => { setRefreshing(true); setHealthKey((k) => k + 1); await loadProfile(); setRefreshing(false) }

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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
    >
      <TabHeader title="Profile" />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 36 }}>
        <ProfileSection profile={profile} email={session?.user.email} onSaved={setProfile} />
        <SignInSection />
        <AppsSection />
        <AutomationsSection />
        <ComputersSection />
        <BrowserSection />
        <UsageSection />
        <MemorySection />
        <Appearance />
        <ImageModel />
        <PhoneAssistant />
        <PushSection />
        <WebhookSection profile={profile} onChanged={setProfile} />
        <ServiceStatus key={healthKey} />
        <View style={{ gap: 12 }}>
          <Surface style={{ overflow: 'hidden' }}>
            <ListRow title="Sign out" icon={Logout01Icon} destructive onPress={signOut} />
          </Surface>
          {__DEV__ && (
            <Surface style={{ overflow: 'hidden' }}>
              <ListRow title="UI gallery" subtitle="Every primitive, for development" chevron onPress={() => router.push('/ui-gallery')} />
            </Surface>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

// ------------------------------------------------------------------ profile

function ProfileSection({ profile, email, onSaved }: { profile: Profile | null; email?: string; onSaved: (p: Profile) => void }) {
  const [name, setName] = useState<string | null>(null)
  const value = name ?? profile?.display_name ?? ''

  const save = async () => {
    if (!profile || name === null || name.trim() === (profile.display_name ?? '')) return
    const { data, error } = await supabase.from('profiles').update({ display_name: name.trim() || null }).eq('id', profile.id).select().single()
    if (error) { toast({ title: 'Unable to save your name', body: 'Check your connection and try again.', tone: 'error' }); return }
    onSaved(data as Profile)
    setName(null)
    haptic.success()
    toast({ title: 'Name saved' })
  }

  return (
    <FormSection title="You" hint={email ? `Signed in as ${email}` : undefined}>
      {profile ? (
        <TextField
          label="Display name"
          value={value}
          onChangeText={setName}
          onBlur={save}
          onSubmitEditing={save}
          returnKeyType="done"
          placeholder="Your name"
          hint="Teammates call you this."
          maxLength={40}
          autoCapitalize="words"
        />
      ) : (
        <View style={{ gap: 8 }}><Skeleton width={96} height={12} /><Skeleton height={48} radius={12} /></View>
      )}
    </FormSection>
  )
}

const PEOPLE = [
  PermissionsAndroid.PERMISSIONS.READ_CONTACTS, PermissionsAndroid.PERMISSIONS.CALL_PHONE, PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
  PermissionsAndroid.PERMISSIONS.READ_CALENDAR, PermissionsAndroid.PERMISSIONS.SEND_SMS,
]

// Tubelight as the phone's digital assistant (plugins/with-assistant.js): who answers, and where Android sets it.
function PhoneAssistant() {
  const ws = useWorkspace()
  const mate = ws.everyone.find(isPhone)
  const open = () => Linking.sendIntent('android.settings.VOICE_INPUT_SETTINGS')
    .catch(() => Linking.sendIntent('android.settings.MANAGE_DEFAULT_APPS_SETTINGS')).catch(() => Linking.openSettings())
  // Android settings pages decide these; read them again whenever you come back from one.
  const read = () => ({
    notes: !!Phone?.notificationAccess(), ring: !!Phone?.canRing(), usage: !!Phone?.usageAccess(),
    dnd: !!Phone?.canDnd?.(), brightness: !!Phone?.canBrightness?.(), apps: !!Phone?.appsOn?.(),
    standIn: Phone?.standIn?.() ?? { on: false, answer: false, access: false },
  })
  const [access, setAccess] = useState(read)
  const [people, setPeople] = useState(false)
  useEffect(() => {
    const check = () => { setAccess(read()); PermissionsAndroid.check(PEOPLE[0]).then(setPeople, () => {}) }
    check()
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check() })
    return () => sub.remove()
  }, [])
  // Contacts, calls, calendar and SMS are ordinary runtime permissions: asked right here, all at once.
  const askPeople = async () => {
    const got = await PermissionsAndroid.requestMultiple(PEOPLE)
    const all = PEOPLE.every((p) => got[p] === 'granted')
    setPeople(got[PEOPLE[0]] === 'granted')
    if (!all && Object.values(got).includes('never_ask_again')) Linking.openSettings()
    syncNotifications().catch(() => {}) // the status (what's allowed, calendar, calls) goes up with it
  }
  // The call stand-in: answering needs two runtime permissions; hearing the caller needs a one-time grant over USB.
  const toggleStandIn = async () => {
    if (!Phone?.standIn) return
    if (access.standIn.on) { Phone.setStandIn(false); setAccess(read()); return }
    const got = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.ANSWER_PHONE_CALLS, PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE])
    if (Object.values(got).some((g) => g !== 'granted')) {
      if (Object.values(got).includes('never_ask_again')) Linking.openSettings()
      return
    }
    Phone.setStandIn(true)
    setAccess(read())
  }
  const row = (on: boolean, title: string, sub: [string, string], onPress: () => void) => (
    <>
      <Divider />
      <ListRow title={title} subtitle={on ? sub[0] : sub[1]} onPress={onPress}
        accessory={<Chip label={on ? 'On' : 'Off'} color={on ? 'success' : 'idle'} size="sm" dot />} />
    </>
  )
  if (Platform.OS !== 'android' || !mate) return null
  return (
    <FormSection title="Phone assistant" hint="Your phone has its own teammate: hold the side key (or swipe up from a bottom corner) to talk to it over any app, even the lock screen. Only it can use the phone; other teammates ask it, and you OK what they ask. Pick Tubelight as the digital assistant app, then on Samsung: Settings → Advanced features → Side button → Press and hold → Digital assistant.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title={mate.name} subtitle="Its chat: what it did, and what other teammates asked it" leading={<TeammateAvatar teammate={mate} size={36} interactive={false} />}
          chevron onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId: `dm:${mate.id}` } })} />
        <Divider />
        <ListRow title="Make Tubelight your assistant" subtitle="Opens Android's digital assistant setting" chevron onPress={open} />
        {Phone && (
          <>
            <Divider />
            <ListRow title="Notifications" subtitle={access.notes ? 'On: teammates can look through the last day’s, when you ask' : 'Off: let teammates look through your notifications when you ask'}
              accessory={<Chip label={access.notes ? 'On' : 'Off'} color={access.notes ? 'success' : 'idle'} size="sm" dot />} onPress={() => Phone?.openNotificationAccess()} />
            <Divider />
            <ListRow title="What's using storage" subtitle={access.usage ? `On: ${mate.name} can see storage by kind and by app` : `Off: let ${mate.name} see which apps and files take the space`}
              accessory={<Chip label={access.usage ? 'On' : 'Off'} color={access.usage ? 'success' : 'idle'} size="sm" dot />} onPress={() => Phone?.openUsageAccess()} />
            <Divider />
            <ListRow title="When a teammate needs you" subtitle={access.ring ? 'Over the lock screen: the decision opens with voice' : 'Allow full-screen alerts so decisions open over the lock screen'}
              accessory={<Chip label={access.ring ? 'On' : 'Off'} color={access.ring ? 'success' : 'idle'} size="sm" dot />} onPress={() => Phone?.openRingSettings()} />
            {row(people, 'Contacts, calls and calendar', [`On: ${mate.name} calls and texts people by name and knows your day`,
              'Off: let it call and text by name, see recent calls and your calendar, and send SMS you OK'], askPeople)}
            {row(access.dnd, 'Do Not Disturb', ['On: it can turn Do Not Disturb on and off', 'Off: let it switch Do Not Disturb (and silence the ringer)'], () => Phone?.openDndAccess())}
            {row(access.brightness, 'Brightness', ['On: it can set the screen brightness', 'Off: let it set the screen brightness'], () => Phone?.openBrightnessAccess())}
            {row(access.standIn.on, 'Answer calls for me', [
              access.standIn.access ? 'On: when a call rings, tap “Let my assistant answer”' : 'On, but it needs its one-time setup from your computer to hear the caller',
              'Off: let your assistant take calls you can’t, as your assistant'], toggleStandIn)}
            {row(access.apps, 'Use apps for you', ['On: after your OK, it works through a task inside an app',
              'Off: Settings → Accessibility → Tubelight (first: App info → ⋮ → Allow restricted settings)'], () => Phone?.openAppsAccess())}
          </>
        )}
      </Surface>
    </FormSection>
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
    <FormSection title="Images" hint="The model teammates draw pictures with. All run free on Cloudflare’s daily allowance.">
      <Surface style={{ overflow: 'hidden' }}>
        <ChoiceRow label="Image model" value={data.model} onChange={pick} options={data.models.map((m) => (
          { value: m.id, title: m.name, subtitle: `${m.about} · about ${m.per_day} a day` }))} />
      </Surface>
    </FormSection>
  )
}

function Appearance() {
  const { preference, setPreference } = useTheme()
  return (
    <FormSection title="Appearance">
      <Surface style={{ overflow: 'hidden' }}>
        <ChoiceRow label="Theme" value={preference} onChange={(v) => setPreference(v as ThemePreference)} options={[
          { value: 'system', title: 'System', subtitle: 'Light or dark, as your phone is set' },
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ]} />
      </Surface>
    </FormSection>
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
    <Surface style={{ overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 6 }}>
        <Toggle label="Notifications" value={!!on} onChange={change} disabled={blocked || busy || on === null} />
        {problem && <Text variant="footnote" color={blocked ? 'ink3' : 'warning'} accessibilityLiveRegion="polite">{problem}</Text>}
      </View>
      {on && <NotifyChoices />}
    </Surface>
  )
}

/** Connected apps, a grid of popular ones to connect in a tap, and the way into all of Composio's catalog. */
/** How much of the free allowances is left, in one row: anything used up first, else the busiest. */
function UsageSection() {
  const [items, setItems] = useState<{ id: string; used: number; limit: number | null; out?: boolean; unit: string }[] | null>(null)
  useFocusLater(useCallback(() => {
    api<{ sections: { items: { id: string; used: number; limit: number | null; out?: boolean; unit: string }[] }[] }>('/usage')
      .then((u) => setItems(u.sections.flatMap((s) => s.items)), () => setItems([]))
  }, []))
  const out = (items ?? []).filter((i) => i.out || (i.limit != null && i.used >= i.limit)).length
  const tools = items?.find((i) => i.id === 'composio')
  const summary = items === null ? 'Loading…' : [
    out ? `${out} used up for now` : 'Nothing used up',
    tools && `${tools.used.toLocaleString()} tool calls this month`,
  ].filter(Boolean).join(' · ')
  return (
    <FormSection title="Usage" hint="How much of each free allowance is left: models, app tool calls, storage.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title="Open usage" subtitle={summary} icon={DashboardSpeed01Icon} chevron onPress={() => router.push('/usage')} />
      </Surface>
    </FormSection>
  )
}

/** What runs on its own, in one row: how many are on and when the next one runs. */
/** How you sign in: everything (chats, teammates, memory, to-dos, vault) belongs to this account, so adding Google
 * here means signing in with Google on any phone brings it all back. */
function SignInSection() {
  const [ids, setIds] = useState<{ provider: string; email: string | null }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { identities().then(setIds, () => setIds([])) }, [])
  useFocusLater(load)
  const g = ids?.find((i) => i.provider === 'google')
  const mail = ids?.find((i) => i.provider === 'email')
  return (
    <FormSection title="Sign-in" hint="Your chats, teammates, memory, to-dos and vault belong to this account, not this phone. Sign in the same way on a new phone and it all comes back.">
      <Surface style={{ overflow: 'hidden' }}>
        {mail && <ListRow title="Email and password" subtitle={mail.email ?? undefined} icon={Mail01Icon} />}
        {g ? <ListRow title="Google" subtitle={g.email ?? 'Linked'} icon={CheckmarkCircle02Icon} />
          : <ListRow title={busy ? 'Opening Google…' : 'Add Google sign-in'} subtitle="Sign in with Google from now on, keeping everything" icon={Add01Icon}
              onPress={async () => {
                setBusy(true)
                try {
                  if (await google(true)) { toast({ title: 'Google is linked', body: 'Sign in with it on any phone.', tone: 'success' }); load() }
                } catch (e) {
                  toast({ title: 'Unable to link Google', body: (e as Error).message, tone: 'error' })
                } finally {
                  setBusy(false)
                }
              }} />}
      </Surface>
    </FormSection>
  )
}

function AutomationsSection() {
  const [items, setItems] = useState<Automation[] | null>(null)
  useFocusLater(useCallback(() => { api<Automation[]>('/automations').then(setItems, () => setItems([])) }, []))
  const on = (items ?? []).filter((a) => a.enabled)
  const next = on.map((a) => a.next_run).filter((x): x is string => !!x).sort()[0]
  const summary = items === null ? 'Loading…' : items.length === 0 ? 'None yet: ask a teammate to do something on a schedule'
    : [`${on.length} on`, items.length > on.length && `${items.length - on.length} paused`, next && `next ${whenLabel(next)}`].filter(Boolean).join(' · ')
  return (
    <FormSection title="Automations" hint="What your teammates do on their own, on a schedule or when something happens in an app.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title="Open automations" subtitle={summary} icon={RepeatIcon} chevron onPress={() => router.push('/automations')} />
      </Surface>
    </FormSection>
  )
}

/** Your computers, in one row: which are online and what they share. */
function ComputersSection() {
  const [items, setItems] = useState<{ name: string; online: boolean; folders: string[] }[] | null>(null)
  useFocusLater(useCallback(() => { api<{ computers: { name: string; online: boolean; folders: string[] }[] }>('/computers').then((d) => setItems(d.computers), () => setItems([])) }, []))
  const on = (items ?? []).filter((m) => m.online)
  const summary = items === null ? 'Loading…' : items.length === 0 ? 'Let teammates work on your laptop: run code, edit files you share'
    : on.length ? `${on.map((m) => m.name).join(', ')} online · ${on.reduce((n, m) => n + m.folders.length, 0)} shared folders` : `${items.length} linked, none online`
  return (
    <FormSection title="Computers" hint="Your own machines as a place teammates can work, with your approval.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title="Open computers" subtitle={summary} subtitleLines={2} icon={LaptopIcon} chevron onPress={() => router.push('/computers')} />
      </Surface>
    </FormSection>
  )
}

/** Tubelight's browser on the server: which sites teammates may act on right now; the live view signs you in. */
function BrowserSection() {
  const [b, setB] = useState<{ available: boolean; running: boolean; sites: string[] } | null>(null)
  useFocusLater(useCallback(() => { api<{ available: boolean; running: boolean; sites: string[] }>('/browser').then(setB, () => setB(null)) }, []))
  if (b && !b.available) return null
  const summary = !b ? 'Sign in to sites teammates use for you' : b.sites.length ? `Teammates may act on ${b.sites.join(', ')}`
    : b.running ? 'Open: teammates only read pages' : 'Sign in to sites teammates use for you'
  return (
    <FormSection title="Browser" hint="A browser on your server. Teammates post or send only after you see the screen and approve it, and never type your passwords: you sign in here.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title="Open browser" subtitle={summary} subtitleLines={2} icon={BrowserIcon} chevron onPress={() => router.push('/browser')} />
      </Surface>
    </FormSection>
  )
}

/** What memory holds, in one row: open loops, people, facts, and whether it's still learning. */
function MemorySection() {
  const [o, setO] = useState<MemoryOverview | null | undefined>(undefined)
  useFocusLater(useCallback(() => { api<MemoryOverview>('/memory/overview').then(setO, () => setO(null)) }, []))
  const n = o?.counts
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const summary = o === undefined ? 'Loading…' : !n || (!n.facts && !n.waiting) ? 'Nothing yet: it fills in as you chat'
    : [o!.open.length ? `${o!.open.length} open` : null, plural(n.people, 'person', 'people'), plural(n.facts, 'fact', 'facts'),
      n.waiting ? 'still learning' : null].filter(Boolean).join(' · ')
  return (
    <FormSection title="Memory" hint="Who is who, what\u2019s open and how you like things, learned from your chats and calls, with where each fact came from.">
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow title="Open memory" subtitle={summary} icon={Brain02Icon} chevron onPress={() => router.push('/memory')} />
      </Surface>
    </FormSection>
  )
}

function AppsSection() {
  const { c } = useTheme()
  const { connections, reload } = useConnections()
  const { toolkits } = useToolkits()
  const [busy, setBusy] = useState<string | null>(null)
  const connected = (connections ?? []).filter((x) => x.connected)
  const have = new Set(connected.map((x) => x.toolkit))
  const popular = (toolkits ?? []).filter((t) => t.auth !== 'none' && !have.has(t.toolkit)).slice(0, 8)

  const connect = async (t: Toolkit) => {
    if (busy) return
    setBusy(t.toolkit)
    try { await connectApp(t.toolkit, t.name); await reload() } catch (e) {
      toast({ title: `Unable to connect ${t.name}`, body: (e as Error).message, tone: 'error' })
    } finally { setBusy(null) }
  }

  return (
    <FormSection
      title="Apps"
      hint="Sign in once and every teammate you allow can use it."
      action={<Button label="See all" size="sm" variant="ghost" onPress={() => router.push('/connections')} />}
    >
      {connected.length > 0 && (
        <Surface style={{ overflow: 'hidden' }}>
          {connected.map((x, i) => (
            <View key={x.toolkit}>
              {i > 0 && <Divider inset={60} />}
              <Press radius={0} static onPress={() => router.push('/connections')} accessibilityLabel={`${x.name}, connected`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
                <BrandTile toolkit={x.toolkit} size={34} />
                <Text variant="bodyMedium" numberOfLines={1} style={{ flex: 1 }}>{x.name || toolkitName(x.toolkit)}</Text>
                <Chip label="Connected" color="success" dot />
              </Press>
            </View>
          ))}
        </Surface>
      )}
      <Surface style={{ paddingVertical: 12, paddingHorizontal: 6 }}>
        <Text variant="label" color="ink3" style={{ paddingHorizontal: 8, paddingBottom: 6 }}>{connected.length ? 'Add more' : 'Popular'}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {toolkits === null
            ? Array.from({ length: 8 }, (_, i) => (
                <View key={i} style={{ width: '25%', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
                  <Skeleton width={48} height={48} radius={14} /><Skeleton width={44} height={10} />
                </View>
              ))
            : popular.map((t) => (
                <Press
                  key={t.toolkit}
                  radius={16}
                  onPress={() => connect(t)}
                  accessibilityLabel={`Connect ${t.name}`}
                  outerStyle={{ width: '25%' }}
                  style={{ alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 4 }}
                >
                  <View>
                    <BrandTile toolkit={t.toolkit} size={48} />
                    {busy === t.toolkit && (
                      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: c.scrim, borderRadius: 12 }}>
                        <ActivityIndicator color="#fff" size="small" />
                      </View>
                    )}
                  </View>
                  <Text variant="footnote" color="ink2" numberOfLines={1}>{t.name}</Text>
                </Press>
              ))}
        </View>
      </Surface>
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow
          title={toolkits ? `Browse all ${toolkits.length.toLocaleString()} apps` : 'Browse all apps'}
          subtitle="Search by name or category"
          icon={Plug01Icon}
          chevron
          onPress={() => router.push('/connections')}
        />
      </Surface>
    </FormSection>
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
