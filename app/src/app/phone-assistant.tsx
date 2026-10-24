// Tubelight as the phone's digital assistant, and what Android lets it do: moved off Profile onto its own page.
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { AppState, Linking, PermissionsAndroid, Platform, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { FormSection } from '@/components/form-bits'
import { ScreenHeader } from '@/components/screen-header'
import { Phone, syncNotifications } from '@/lib/phone'
import { isPhone, useWorkspace } from '@/lib/workspace'
import { Chip, Divider, ListRow, Surface, TeammateAvatar } from '@/ui'

export default function PhoneAssistantScreen() {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Phone assistant" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <PhoneAssistant />
      </ScrollView>
    </View>
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
