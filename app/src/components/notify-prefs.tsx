// Notification choices (agent-service push.py): what notifies you, everywhere or per chat, and the sound.
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Notification03Icon, NotificationOff02Icon, VolumeHighIcon, VolumeOffIcon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { SOUNDS, SOUND_FILES, type SoundId } from '@/lib/notifications'
import { Icon, PickerField, Segment, Text, haptic, showMenu, toast } from '@/ui'

export type NotifyMode = 'all' | 'needed' | 'off'
interface Prefs { mode: NotifyMode; sound: SoundId; chats: Record<string, NotifyMode> }

let cache: Prefs | null = null
const listeners = new Set<(p: Prefs) => void>()

/** The user's notification choices, shared by every screen that shows them. */
export function useNotifyPrefs() {
  const [p, setP] = useState<Prefs | null>(cache)
  useEffect(() => {
    listeners.add(setP)
    if (!cache) api<Prefs>('/notifications/prefs').then((r) => { cache = r; listeners.forEach((l) => l(r)) }, () => {})
    return () => { listeners.delete(setP) }
  }, [])
  const change = async (patch: Partial<Omit<Prefs, 'chats'>> & { chats?: Record<string, NotifyMode | null> }) => {
    const before = cache
    try {
      const r = await api<Prefs>('/notifications/prefs', { method: 'PATCH', json: patch })
      cache = r
      listeners.forEach((l) => l(r))
      haptic.tap()
    } catch (e) {
      cache = before
      toast({ title: 'Unable to save that', body: (e as Error).message, tone: 'error' })
    }
  }
  return { prefs: p, change }
}

let player: AudioPlayer | null = null
/** Plays a sound from the picker so you hear it before choosing. */
export function previewSound(id: SoundId) {
  const file = SOUND_FILES[id]
  if (!file) return
  try {
    player?.remove()
    player = createAudioPlayer(file)
    player.play()
  } catch { /* preview is a nicety */ }
}

const MODES: { value: NotifyMode; label: string }[] = [
  { value: 'all', label: 'Everything' }, { value: 'needed', label: 'When needed' }, { value: 'off', label: 'Nothing' },
]
const MODE_HINT: Record<NotifyMode, string> = {
  all: 'Replies (bundled when several land at once), approvals, questions and automations.',
  needed: 'Only what waits on you: approvals, questions, apps to connect, an automation that stopped.',
  off: 'No notifications. Chats you set on their own still follow their setting.',
}

/** Profile: what notifies you and how it sounds. */
export function NotifyChoices() {
  const { prefs, change } = useNotifyPrefs()
  if (!prefs) return null
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Segment<NotifyMode> value={prefs.mode} onChange={(mode) => change({ mode })} accessibilityLabel="What notifies you" options={MODES} />
        <Text variant="footnote" color="ink3">{MODE_HINT[prefs.mode]}</Text>
      </View>
      <PickerField
        label="Sound"
        value={prefs.sound}
        onChange={(v) => { const sound = v as SoundId; previewSound(sound); change({ sound }) }}
        stayOpen
        intro="Tap one to hear it; the last one you tap is used. Notifications from every chat use it."
        options={SOUNDS.map((s) => ({
          value: s.id, title: s.name, subtitle: s.about,
          leading: <View style={{ width: 32, alignItems: 'center' }}><Icon icon={s.id === 'silent' ? VolumeOffIcon : VolumeHighIcon} size={20} color="ink2" /></View>,
        }))}
      />
      {Object.keys(prefs.chats).length > 0 && (
        <Text variant="footnote" color="ink3">{Object.keys(prefs.chats).length} chat{Object.keys(prefs.chats).length > 1 ? 's have' : ' has'} its own setting (from the bell in the chat).</Text>
      )}
    </View>
  )
}

/** This chat's notification setting, from the inbox's long-press menu: a menu item that opens the choices. */
export function useChatNotify(threadId: string, title: string) {
  const { prefs, change } = useNotifyPrefs()
  const own = prefs?.chats[threadId] ?? null
  const label = (m: NotifyMode) => MODES.find((x) => x.value === m)!.label
  const effective = own ?? prefs?.mode ?? 'all'
  const open = () => prefs && showMenu({
    title: `Notifications for ${title}`,
    message: own ? `This chat: ${label(own)}` : `Following your setting: ${label(prefs.mode)}`,
    items: [
      ...MODES.map((m) => ({ label: `${m.label}${own === m.value ? ' ✓' : ''}`, onPress: () => change({ chats: { [threadId]: m.value } }) })),
      ...(own ? [{ label: `Use my setting (${label(prefs.mode)})`, onPress: () => change({ chats: { [threadId]: null } }) }] : []),
    ],
  })
  return {
    muted: effective === 'off',
    item: {
      label: `Notifications: ${label(effective)}`,
      icon: effective === 'off' ? NotificationOff02Icon : Notification03Icon,
      onPress: () => setTimeout(open, 320),  // after the first menu's close animation
    },
  }
}
