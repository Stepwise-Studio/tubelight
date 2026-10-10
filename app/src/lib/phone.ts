// The phone side of a teammate's reply (modules/phone): actions it carries out as it lands, and the notifications
// the phone shares with teammates (opt-in) synced to the server when the app opens or a message goes out.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect } from 'react'
import { AppState } from 'react-native'

import { Phone, type PhoneAction } from '../../modules/phone'
import { api } from './api'
import type { ChatMessage } from './use-thread'
import { toast } from '@/ui'

export type { PhoneAction }
export { Phone }

const pad = (n = 0) => String(n).padStart(2, '0')

/** What the action does, for its chip under the reply. */
export function phoneLabel(a: PhoneAction): string {
  switch (a.action) {
    case 'alarm': return `Alarm ${pad(a.hour)}:${pad(a.minute)}`
    case 'timer': return `Timer ${a.seconds && a.seconds >= 60 ? `${Math.round(a.seconds / 60)} min` : `${a.seconds} s`}`
    case 'call': return `Call ${a.number}`
    case 'text': return `Text ${a.number}`
    case 'whatsapp': return `WhatsApp ${a.number}`
    case 'email': return `Email ${a.to}`
    case 'navigate': return `Directions to ${a.place}`
    case 'calendar': return `Add “${a.title}” to calendar`
    case 'open_app': return `Open ${a.app}`
    case 'open_url': return 'Open link'
    case 'search': return `Search “${a.text}”`
    case 'settings': return `Open ${a.text ?? ''} settings`.replace('  ', ' ')
    case 'alarms': return 'Open your alarms'
  }
}

export function runPhoneAction(a: PhoneAction) {
  if (!Phone) { toast({ title: 'Update Tubelight to do this on your phone', tone: 'error' }); return }
  try {
    toast({ title: Phone.act(a), tone: 'success' })
  } catch (e) {
    toast({ title: `Couldn’t: ${phoneLabel(a)}`, body: (e as Error).message, tone: 'error' })
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
        for (const a of m.meta.phone_actions as PhoneAction[]) runPhoneAction(a)
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
  await api('/phone/status', { method: 'POST', json: { status: Phone.status() } }).catch(() => {})
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
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') syncNotifications().catch(() => {}) })
    return () => sub.remove()
  }, [signedIn])
}
