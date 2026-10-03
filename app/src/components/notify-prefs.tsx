// Notification choices (agent-service push.py): what notifies you, everywhere or per chat, and the sound.
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Notification03Icon, NotificationOff02Icon, VolumeHighIcon, VolumeOffIcon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { SOUNDS, SOUND_FILES, type SoundId } from '@/lib/notifications'
import { ChoiceRow, ChoiceSheet, Divider, Icon, Rise, haptic, toast } from '@/ui'

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

const MODES: { value: NotifyMode; label: string; about: string }[] = [
  { value: 'all', label: 'Everything', about: 'Replies (bundled when several land at once), approvals, questions and automations' },
  { value: 'needed', label: 'When needed', about: 'Only what waits on you: approvals, questions, apps to connect, a stopped automation' },
  { value: 'off', label: 'Nothing', about: 'No notifications' },
]
const modeOptions = MODES.map((m) => ({ value: m.value, title: m.label, subtitle: m.about }))

/** Profile, under the notifications switch: what notifies you and how it sounds, rows that open radio sheets. They
 * rise in one after the other when the switch turns on. */
export function NotifyChoices() {
  const { prefs, change } = useNotifyPrefs()
  if (!prefs) return null
  const own = Object.keys(prefs.chats).length
  return (
    <>
      <Rise index={0}>
        <Divider />
        <ChoiceRow label="Notify me about" value={prefs.mode} options={modeOptions} onChange={(v) => change({ mode: v as NotifyMode })}
          intro={own ? `${own} chat${own > 1 ? 's have' : ' has'} its own setting (long-press it in the inbox).` : undefined} />
      </Rise>
      <Rise index={1}>
        <Divider />
        <ChoiceRow label="Sound" value={prefs.sound} stayOpen
          onChange={(v) => { const sound = v as SoundId; previewSound(sound); change({ sound }) }}
          intro="Tap one to hear it; the last one you tap is used."
          options={SOUNDS.map((x) => ({
            value: x.id, title: x.name, subtitle: x.about,
            leading: <View style={{ width: 32, alignItems: 'center' }}><Icon icon={x.id === 'silent' ? VolumeOffIcon : VolumeHighIcon} size={20} color="ink2" /></View>,
          }))} />
      </Rise>
    </>
  )
}

/** This chat's notification setting, from the inbox's long-press menu: an item showing the current setting that opens
 * the radio sheet (render `sheet` next to the row). */
export function useChatNotify(threadId: string, title: string) {
  const { prefs, change } = useNotifyPrefs()
  const [open, setOpen] = useState(false)
  const own = prefs?.chats[threadId] ?? null
  const effective = own ?? prefs?.mode ?? 'all'
  const label = (m: NotifyMode) => MODES.find((x) => x.value === m)!.label
  const options = [
    ...MODES.map((m) => ({ value: m.value as string, title: m.label, subtitle: m.about })),
    ...(prefs ? [{ value: 'default', title: 'Use my setting', subtitle: `What you chose in Profile: ${label(prefs.mode)}` }] : []),
  ]
  return {
    muted: effective === 'off',
    item: {
      label: 'Notifications',
      value: own ? label(own) : 'My setting',
      icon: effective === 'off' ? NotificationOff02Icon : Notification03Icon,
      onPress: () => setTimeout(() => setOpen(true), 320),  // after the menu's close animation
    },
    sheet: (
      <ChoiceSheet open={open} onClose={() => setOpen(false)} title={`Notifications for ${title}`} value={own ?? 'default'}
        options={options} onPick={(v) => change({ chats: { [threadId]: v === 'default' ? null : (v as NotifyMode) } })} />
    ),
  }
}
