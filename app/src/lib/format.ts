import { Platform } from 'react-native'

import { haptic, toast } from '@/ui'

const DAY = 86_400_000

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Chat-list time: "09:41" today, "Yesterday", weekday this week, else "12 Sep". */
export function relativeTime(iso: string, now = new Date()) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY)
  if (days <= 0) return clock(d)
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

export const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Day separator label: "Today", "Yesterday", "Monday 22 September". */
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

export const sameDay = (a: string, b: string) => startOfDay(new Date(a)) === startOfDay(new Date(b))

/** Full timestamp for long-press menus. */
export const fullTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Timestamps come back from Postgres and from the client in different ISO shapes; compare as dates. */
export const isUnread = (t: { last_message_at: string | null; last_read_at: string }) =>
  !!t.last_message_at && Date.parse(t.last_message_at) > Date.parse(t.last_read_at)

/** Timeline time: "Now", "4 min", "2 h", then the chat-list style ("Yesterday", "12 Sep"). */
export function ago(iso: string, now = new Date()) {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'Now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h`
  return relativeTime(iso, now)
}

/** Voice replies carry Orpheus vocal cues like [cheerful] or [sigh]: spoken, never shown. Links ([x](url)) are left alone. */
export const stripCues = (s: string) => s.replace(/\s?\[[a-z]+(?: [a-z]+)?\](?!\()/g, '')

/** After copying: Android already shows its own clipboard confirmation, so only iOS gets our toast. */
export function copied() {
  if (Platform.OS === 'ios') toast({ title: 'Copied', tone: 'success' })
  else haptic.light()
}
