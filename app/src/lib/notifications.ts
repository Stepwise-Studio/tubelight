// Notifications on the phone (agent-service push.py sends them): one Android channel per sound (a channel's sound
// can't change after it's created, so the chosen sound is a choice of channel), the button sets the service
// picks with `categoryId`, and what the buttons do. A button pressed while the app is closed or in the background
// runs in the background task below without opening the app; in the foreground, push-routing.ts calls handleAction.
import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import { Platform } from 'react-native'

import { api } from '@/lib/api'

export const SOUNDS = [
  { id: 'chime', name: 'Chime', about: 'Two rising bell notes' },
  { id: 'pop', name: 'Pop', about: 'A soft bubble pop' },
  { id: 'drop', name: 'Drop', about: 'A water drop' },
  { id: 'bell', name: 'Bell', about: 'A small desk bell' },
  { id: 'pulse', name: 'Pulse', about: 'Two gentle beeps' },
  { id: 'classic', name: 'Phone default', about: 'Your phone’s notification sound' },
  { id: 'silent', name: 'Silent', about: 'Shows up, makes no sound' },
] as const
export type SoundId = (typeof SOUNDS)[number]['id']

/** Preview files for the sound picker (the channels play the copies bundled by the expo-notifications plugin). */
export const SOUND_FILES: Partial<Record<SoundId, number>> = {
  chime: require('../../assets/sounds/chime.wav'),
  pop: require('../../assets/sounds/pop.wav'),
  drop: require('../../assets/sounds/drop.wav'),
  bell: require('../../assets/sounds/bell.wav'),
  pulse: require('../../assets/sounds/pulse.wav'),
}

/** Channels and button sets; safe to call on every start (Android keeps existing channels as they are). */
export async function setupNotifications() {
  if (Platform.OS !== 'android') return
  for (const s of SOUNDS) {
    const silent = s.id === 'silent'
    await Notifications.setNotificationChannelAsync(`tl-${s.id}`, {
      name: `Teammates · ${s.name}`,
      importance: silent ? Notifications.AndroidImportance.DEFAULT : Notifications.AndroidImportance.HIGH,
      // 'classic' leaves the sound unset: Android then plays the phone's own notification sound.
      ...(s.id === 'classic' ? {} : { sound: silent ? null : s.id }),
      enableVibrate: !silent,
      vibrationPattern: silent ? null : [0, 140, 90, 140],
      lightColor: '#0EA5E9',
    })
  }
  await Notifications.setNotificationCategoryAsync('approval', [
    // Approving does something real (sends, posts, pays), so it needs the phone unlocked; rejecting doesn't.
    { identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: false, isAuthenticationRequired: true } },
    { identifier: 'reject', buttonTitle: 'Reject', options: { opensAppToForeground: false, isDestructive: true } },
  ])
  await Notifications.setNotificationCategoryAsync('question', [
    { identifier: 'answer', buttonTitle: 'Answer', textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' }, options: { opensAppToForeground: false } },
  ])
  await Notifications.setNotificationCategoryAsync('reply', [
    { identifier: 'reply', buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Message' }, options: { opensAppToForeground: false } },
  ])
}

interface PushData { thread_id?: string; approval_id?: string; kind?: string }

/** The service's `data` from a response, however the platform hands it over (an object, or a JSON string). */
export function pushData(content: { data?: unknown; dataString?: string } | undefined | null): PushData {
  const d = content?.data ?? (content?.dataString ? safeJson(content.dataString) : null)
  return (d && typeof d === 'object' ? d : {}) as PushData
}
const safeJson = (s: string) => { try { return JSON.parse(s) } catch { return null } }

/** A quiet note in the shade saying what happened (or what didn't), since the app didn't open. */
async function confirm(title: string, body: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, ...(Platform.OS === 'android' ? {} : { sound: false }) },
    trigger: Platform.OS === 'android' ? { channelId: 'tl-silent' } : null,
  }).catch(() => {})
}

const handled = new Set<string>()

/** What a notification button does. Returns false for a plain tap (the caller opens the chat). */
export async function handleAction(actionId: string, userText: string | undefined, data: PushData, notificationId?: string) {
  if (actionId === Notifications.DEFAULT_ACTION_IDENTIFIER) return false
  // With the app alive in the background, both the background task and the in-app listener get the same press.
  const key = `${notificationId}:${actionId}:${userText ?? ''}`
  if (handled.has(key)) return true
  handled.add(key)
  if (notificationId) await Notifications.dismissNotificationAsync(notificationId).catch(() => {})
  try {
    if ((actionId === 'approve' || actionId === 'reject') && data.approval_id) {
      await api(`/approvals/${data.approval_id}`, { method: 'POST', json: { action: actionId } })
      await confirm(actionId === 'approve' ? 'Approved' : 'Rejected', actionId === 'approve' ? 'Your teammate is on it.' : 'Your teammate won’t do it.')
    } else if (actionId === 'answer' && data.approval_id && userText?.trim()) {
      await api(`/approvals/${data.approval_id}`, { method: 'POST', json: { action: 'answer', answer: userText.trim() } })
    } else if (actionId === 'reply' && data.thread_id && userText?.trim()) {
      await api(`/threads/${encodeURIComponent(data.thread_id)}/messages`, { method: 'POST', json: { text: userText.trim() } })
    }
  } catch (e) {
    await confirm('Couldn’t do that from here', `${(e as Error).message} Open Tubelight to try again.`)
  }
  return true
}

const TASK = 'tubelight-notification-actions'

// Must be defined at startup (imported from the root layout), so a button pressed while the app is closed lands here.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if (!data || !('actionIdentifier' in data)) return
  const r = data as unknown as {
    actionIdentifier: string; userText?: string
    notification?: { request?: { identifier?: string; content?: { data?: unknown; dataString?: string } } }
  }
  await handleAction(r.actionIdentifier, r.userText, pushData(r.notification?.request?.content), r.notification?.request?.identifier)
})

export const registerBackgroundActions = () =>
  Platform.OS === 'android' ? Notifications.registerTaskAsync(TASK).catch(() => {}) : Promise.resolve()
