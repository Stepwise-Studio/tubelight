// The phone side of a teammate's reply (modules/phone): actions it carries out as it lands, and the notifications
// the phone shares with teammates (opt-in) synced to the server when the app opens or a message goes out.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect } from 'react'

import { Phone, type PhoneAction } from '../../modules/phone'
import { api } from './api'
import { onReturn } from './app-state'
import type { ChatMessage } from './use-thread'
import { toast } from '@/ui'

export type { PhoneAction }
export { Phone }

const pad = (n = 0) => String(n).padStart(2, '0')

/** What the action does, for its chip under the reply. */
export function phoneLabel(a: PhoneAction): string {
  const who = a.name || a.number
  switch (a.action) {
    case 'alarm': return `Alarm ${pad(a.hour)}:${pad(a.minute)}`
    case 'alarms': return 'Open your alarms'
    case 'alarm_off': return a.hour != null ? `Turn off the ${pad(a.hour)}:${pad(a.minute)} alarm` : a.title ? `Turn off “${a.title}”` : 'Turn off the alarm'
    case 'snooze': return 'Snooze the alarm'
    case 'timer': return `Timer ${a.seconds && a.seconds >= 60 ? `${Math.round(a.seconds / 60)} min` : `${a.seconds} s`}`
    case 'timers': return 'Open your timers'
    case 'timer_off': return 'Open your timers'
    case 'call': return `Call ${who}`
    case 'text': return `Text ${who}`
    case 'sms': return `Send SMS to ${who}`
    case 'reply': return 'Reply'
    case 'whatsapp': return `WhatsApp ${who}`
    case 'email': return `Email ${a.to}`
    case 'navigate': return `Directions to ${a.place}`
    case 'calendar': return `Add “${a.title}” to calendar`
    case 'open_app': return `Open ${a.app}`
    case 'open_url': return 'Open link'
    case 'search': return `Search “${a.text}”`
    case 'settings': return `Open ${a.text ?? ''} settings`.replace('  ', ' ')
    case 'panel': return `Open ${a.text ?? ''}`
    case 'flashlight': return `Flashlight ${a.text === 'off' ? 'off' : 'on'}`
    case 'volume': return `${a.text ? a.text[0].toUpperCase() + a.text.slice(1) : 'Media'} volume ${a.level ?? 0}%`
    case 'dnd': return `Do Not Disturb ${a.text === 'off' ? 'off' : 'on'}`
    case 'brightness': return `Brightness ${a.level ?? 0}%`
    case 'media': return a.text ? a.text[0].toUpperCase() + a.text.slice(1) : 'Play/pause'
    case 'play': return `Play ${a.text}`
    case 'photo': return 'Open the camera'
    case 'use_app': return `${a.app}: ${a.goal}`
  }
}

export function runPhoneAction(a: PhoneAction, threadId?: string) {
  if (!Phone) { toast({ title: 'Update Tubelight to do this on your phone', tone: 'error' }); return }
  if (a.action === 'use_app') { workInApp(a, threadId); return }
  try {
    toast({ title: Phone.act(a), tone: 'success' })
  } catch (e) {
    toast({ title: `Couldn’t: ${phoneLabel(a)}`, body: (e as Error).message, tone: 'error' })
  }
}

/**
 * An OK'd task in an app on this phone (Apps.kt): open it, then a fast model on the server picks one action at a time
 * from what's on screen (POST /phone/step, the same loop computer use runs on Linux) until it's done, stuck or needs
 * something; the outcome goes to the phone's chat as the teammate's message. It may only type the texts it was given.
 */
async function workInApp(a: PhoneAction, threadId?: string) {
  const steps: string[] = []
  const finish = (text: string) => api('/phone/result', { method: 'POST', json: { thread_id: threadId, text } }).catch(() => {})
  if (!Phone!.appsOn()) {
    toast({ title: 'Turn on app control first', body: 'Profile → Phone assistant → Use apps for you.', tone: 'error' })
    return finish(`Couldn't use ${a.app}: app control is off on the phone (Profile → Phone assistant).`)
  }
  toast({ title: `Working in ${a.app}…` })
  try {
    let screen = await Phone!.appOpen(a.app ?? '')
    if (__DEV__) console.log('[app task] screen\n' + screen.text)
    for (let i = 0; i < 20; i++) {
      const d = await api<{ action: string; element?: string; value?: string; keys?: string[]; why?: string }>('/phone/step', {
        method: 'POST', json: { goal: a.goal, inputs: a.inputs ?? [], done_when: a.done_when ?? '', steps, screen: screen.text },
      })
      if (['DONE', 'BLOCKED', 'NEEDS_INPUT'].includes(d.action)) {
        toast({ title: d.action === 'DONE' ? `Done in ${a.app}` : `Stopped in ${a.app}`, body: d.why, tone: d.action === 'DONE' ? 'success' : 'error' })
        return finish(`${d.action === 'DONE' ? 'Done' : d.action === 'BLOCKED' ? 'Couldn’t finish' : 'Needs something from you'} in ${screen.app}: ${d.why ?? ''}`
          + (d.action === 'DONE' ? '' : `\nSteps: ${steps.join('; ') || 'none'}`))
      }
      if (d.action === 'KEYS') screen = await Phone!.appKey(String(d.keys?.[0] ?? 'back'))
      else screen = await Phone!.appAct(screen.snapshot ?? '', d.element ?? '', d.action, d.value ?? '')
      // What the text fields show now, so the model sees what each tap did ("125×8"), not just that it tapped.
      const shows = (screen.text ?? '').split('\n').filter((l) => l.includes('] text field ')).map((l) => l.split(' = ')[1]?.replace(/\s*\([^)]*\)\s*$/, '').trim())
        .filter(Boolean).slice(0, 2)
      steps.push(`${d.action.toLowerCase()} ${d.element ?? d.keys?.join(' ') ?? ''}${d.value ? ` "${d.value}"` : ''}: ${screen.did ?? screen.status ?? ''}`
        + `${screen.status === 'stale' ? ` (${screen.why})` : ''}${shows.length ? ` → field shows ${shows.map((x) => `“${x}”`).join(', ')}` : ''}`)
      if (__DEV__) console.log('[app task]', steps[steps.length - 1])
    }
    return finish(`Stopped after 20 steps in ${a.app} without finishing. Steps: ${steps.join('; ')}`)
  } catch (e) {
    toast({ title: `Couldn’t finish in ${a.app}`, body: (e as Error).message, tone: 'error' })
    return finish(`Couldn't finish in ${a.app}: ${(e as Error).message}\nSteps: ${steps.join('; ') || 'none'}`)
  }
}

const DONE = 'tubelight.phone.done'
const running = new Set<string>() // one JS runtime, two roots (app + assistant panel): do each once
const FRESH_MS = 3 * 60_000

/** A teammate's reply that carries phone actions does them as it lands (only fresh ones: never on a reload). */
export function usePhoneActions(messages: ChatMessage[]) {
  useEffect(() => {
    const fresh = messages.filter((m) => m.sender_type === 'teammate' && Array.isArray(m.meta?.phone_actions)
      && Date.now() - Date.parse(m.created_at) < FRESH_MS && !running.has(m.id))
    if (!fresh.length) return
    fresh.forEach((m) => running.add(m.id))
    ;(async () => {
      const done = new Set<string>(JSON.parse((await AsyncStorage.getItem(DONE).catch(() => null)) ?? '[]'))
      for (const m of fresh) {
        if (done.has(m.id)) continue
        done.add(m.id)
        for (const a of m.meta.phone_actions as PhoneAction[]) runPhoneAction(a, m.thread_id)
      }
      AsyncStorage.setItem(DONE, JSON.stringify([...done].slice(-100))).catch(() => {})
    })()
  }, [messages])
}

/** Made once per phone (agent phone.ensure): the phone's own teammate and chat. */
export async function registerPhone() {
  if (!Phone) return null
  return api<{ teammate_id: string; name: string }>('/phone/register', { method: 'POST', json: { name: Phone.deviceName() } })
}

const SYNCED = 'tubelight.phone.notesSynced'

/** What the phone's teammate can know about it, passed to the server: its status (storage, battery…) and, with
 *  notification access, the notifications since the last sync. */
export async function syncNotifications() {
  if (!Phone) return
  await api('/phone/status', { method: 'POST', json: { status: await Phone.status() } }).catch(() => {})
  if (!Phone.notificationAccess()) return
  const last = Number((await AsyncStorage.getItem(SYNCED).catch(() => null)) ?? 0)
  const items = Phone.recentNotifications(last)
  if (!items.length) return
  await api('/phone/notifications', { method: 'POST', json: { items } })
  await AsyncStorage.setItem(SYNCED, String(Math.max(...items.map((i) => i.at)))).catch(() => {})
}

export function useNotificationSync(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return
    syncNotifications().catch(() => {})
    return onReturn(() => { syncNotifications().catch(() => {}) })
  }, [signedIn])
}
