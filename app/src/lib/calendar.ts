// The phone's calendars for the Tasks tab (modules/phone Cal.kt): the same events Samsung Calendar and Google Calendar
// show. Needs calendar access (asked the first time the calendar opens). Ranges are read off the JS thread; a change
// made here bumps `version`, so every open range reads again; so does coming back to the app.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { PermissionsAndroid } from 'react-native'

import { Phone, type EventInput, type PhoneCalendar, type PhoneEvent } from '../../modules/phone'
import { onReturn } from '@/lib/app-state'

export type { PhoneCalendar, PhoneEvent }

let version = 0
const subs = new Set<() => void>()
const bump = () => { version++; subs.forEach((f) => f()) }
onReturn(bump)
const useVersion = () => {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => version)
}

const PERMS = [PermissionsAndroid.PERMISSIONS.READ_CALENDAR, PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR]
export async function calendarAccess(ask: boolean) {
  if (!Phone?.calendarEvents) return 'missing' as const
  const has = (await Promise.all(PERMS.map((p) => PermissionsAndroid.check(p)))).every(Boolean)
  if (has || !ask) return has ? 'ok' as const : 'no' as const
  const r = await PermissionsAndroid.requestMultiple(PERMS)
  return PERMS.every((p) => r[p] === PermissionsAndroid.RESULTS.GRANTED) ? 'ok' as const : 'no' as const
}

/** Event instances overlapping [from, to) (ms), repeats expanded; null while loading. */
export function useEvents(from: number, to: number, enabled: boolean) {
  const v = useVersion()
  const [state, setState] = useState<{ key: string; rows: PhoneEvent[] } | null>(null)
  const key = `${from}:${to}:${v}`
  useEffect(() => {
    if (!enabled || !Phone?.calendarEvents) return
    let live = true
    Phone.calendarEvents(from, to).then((rows) => { if (live) setState({ key, rows }) }, () => { if (live) setState({ key, rows: [] }) })
    return () => { live = false }
  }, [key, from, to, enabled])
  // Keep showing the last range while the next one loads (no flash between months).
  return state?.rows ?? null
}

export function useCalendars(enabled: boolean) {
  const v = useVersion()
  const [rows, setRows] = useState<PhoneCalendar[]>([])
  useEffect(() => {
    if (enabled && Phone?.calendars) Phone.calendars().then(setRows, () => {})
  }, [enabled, v])
  return rows
}

export async function saveEvent(e: EventInput) {
  const id = await Phone!.saveEvent!(e)
  bump()
  return id
}

export async function deleteEvent(id: string) {
  await Phone!.deleteEvent!(id)
  bump()
}

/** The local day an instance starts on: all-day ones are stored at UTC midnights. */
export function eventDay(e: PhoneEvent) {
  const d = new Date(e.start)
  return e.allDay ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Every local day (midnight ms) an instance covers. */
export function eventDays(e: PhoneEvent): number[] {
  const first = eventDay(e)
  const endMs = e.allDay ? (() => { const d = new Date(e.end); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime() - 1 })() : e.end - 1
  const out: number[] = []
  for (const d = new Date(first); d.getTime() <= Math.max(endMs, first.getTime()) && out.length < 62; d.setDate(d.getDate() + 1)) out.push(d.getTime())
  return out
}

export const REPEAT_RULES = [
  { value: '', label: 'Once' }, { value: 'FREQ=DAILY', label: 'Every day' }, { value: 'FREQ=WEEKLY', label: 'Every week' },
  { value: 'FREQ=MONTHLY', label: 'Every month' }, { value: 'FREQ=YEARLY', label: 'Every year' },
]
