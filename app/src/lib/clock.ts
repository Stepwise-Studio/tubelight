// Tubelight's own alarms and reminders (agent-service clock.py): offline lists like the to-dos, handed to the phone
// whole whenever either changes (modules/phone Clock.kt arms them with AlarmManager, so they ring with the app closed).
// A teammate's change arrives as a quiet push; the notification task calls syncClock to pick it up and arm it.
import { useEffect, useState } from 'react'

import { Phone, type ClockItem } from '../../modules/phone'
import { onReturn } from '@/lib/app-state'
import { offlineList } from '@/lib/offline-list'

export interface Alarm {
  id: string
  /** HH:MM, 24-hour */
  time: string
  /** 0 = Monday. None: it rings once, at `at`. */
  days: number[]
  label: string
  enabled: boolean
  /** A one-off's moment (set whenever it's switched on). */
  at: string | null
  /** The tone's content:// uri; '' = the phone's alarm sound. */
  sound: string
  /** The tone's name as shown (a file of their own has no other way to be named). */
  sound_name: string
  created_at: string
  updated_at: string
}
export type Repeat = '' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
export interface Reminder {
  id: string
  title: string
  notes: string
  /** ISO, with its offset */
  at: string
  repeat: Repeat
  done: boolean
  done_at: string | null
  created_at: string
  updated_at: string
}

export const REPEATS: { value: Repeat; label: string }[] = [
  { value: '', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' }, { value: 'monthly', label: 'Every month' }, { value: 'yearly', label: 'Every year' },
]

const alarmList = offlineList<Alarm>({ path: '/alarms', field: 'items', key: 'tl.alarms', noun: 'alarm', sort: (l) => [...l].sort((a, b) => a.time.localeCompare(b.time)) })
const reminderList = offlineList<Reminder>({ path: '/reminders', field: 'items', key: 'tl.reminders', noun: 'reminder', sort: (l) => [...l].sort((a, b) => a.at.localeCompare(b.at)) })

const hm = (t: string) => t.split(':').map(Number) as [number, number]

/** When a once-only alarm at HH:MM rings if switched on now: today, or tomorrow if that's passed. */
export function nextAt(time: string, now = new Date()) {
  const [h, m] = hm(time)
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)
  if (d <= now) d.setDate(d.getDate() + 1)
  return d.toISOString()
}

/** The next time an alarm rings, or null (off, or a one-off that's rung). */
export function alarmNext(a: Alarm, now = new Date()): Date | null {
  if (!a.enabled) return null
  if (!a.days.length) return a.at && new Date(a.at) > now ? new Date(a.at) : null
  const [h, m] = hm(a.time)
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m)
    if (d > now && a.days.includes((d.getDay() + 6) % 7)) return d
  }
  return null
}

/** A reminder's next time: its own, or for a repeating one that's passed, the next repeat. */
export function reminderNext(r: Reminder, now = new Date()): Date {
  const d = new Date(r.at)
  if (!r.repeat || d > now || r.done) return d
  while (d <= now) {
    if (r.repeat === 'daily') d.setDate(d.getDate() + 1)
    else if (r.repeat === 'weekdays') do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6)
    else if (r.repeat === 'weekly') d.setDate(d.getDate() + 7)
    else if (r.repeat === 'monthly') d.setMonth(d.getMonth() + 1)
    else d.setFullYear(d.getFullYear() + 1)
  }
  return d
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export function daysText(days: number[]) {
  if (!days.length) return 'Once'
  if (days.length === 7) return 'Every day'
  if (days.join() === '0,1,2,3,4') return 'Weekdays'
  if (days.join() === '5,6') return 'Weekends'
  return days.map((d) => DAY_NAMES[d]).join(', ')
}

/** "in 7 h 12 min" */
export function untilText(d: Date, now = new Date()) {
  const min = Math.max(1, Math.round((d.getTime() - now.getTime()) / 60_000))
  const days = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  return `in ${[days && `${days} d`, h && `${h} h`, !days && m && `${m} min`].filter(Boolean).join(' ')}`
}

// ------------------------------------------------------------------ the phone arms what's in the lists
let armed = ''
function arm() {
  if (!Phone?.setClock) return
  const alarms = alarmList.get().rows
  const reminders = reminderList.get().rows
  if (!alarms || !reminders) return // not both loaded yet: keep what the phone has
  const items: ClockItem[] = [
    ...alarms.map((a) => {
      const [hour, minute] = hm(a.time)
      return { id: a.id, kind: 'alarm' as const, title: a.label, hour, minute, days: a.days, at: a.at ? Date.parse(a.at) : 0, repeat: '', enabled: a.enabled,
        sound: a.sound ?? '' }
    }),
    ...reminders.filter((r) => !r.done).map((r) => ({
      id: r.id, kind: 'reminder' as const, title: r.title, body: r.notes, hour: 0, minute: 0, days: [], at: Date.parse(r.at), repeat: r.repeat, enabled: true,
    })),
  ]
  const json = JSON.stringify(items)
  if (json === armed) return
  armed = json
  try { Phone.setClock(json) } catch { armed = '' }
}

/** Reminders ticked Done on their notification while the app was away. */
function collectDone() {
  for (const id of Phone?.takeClockDone?.() ?? []) reminderList.update(id, { done: true, done_at: new Date().toISOString() })
}

let started = false
export function startClock() {
  if (started) return
  started = true
  alarmList.subscribe(arm)
  reminderList.subscribe(arm)
  onReturn(() => { collectDone(); syncClock() })
  Promise.all([alarmList.load(), reminderList.load()]).then(() => { collectDone(); arm() })
  syncClock()
}

export async function syncClock() {
  await Promise.all([alarmList.sync(), reminderList.sync()])
  arm()
}

export function useAlarms() { return alarmList.use() }
export function useReminders() { return reminderList.use() }

/** Re-renders every minute, for "in 7 h" and what's overdue. */
export function useMinute() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // On each minute's turn (a plain 60 s interval from mount runs up to a minute behind the clock).
    let t: ReturnType<typeof setTimeout>
    const tick = () => { setNow(new Date()); t = setTimeout(tick, 60_050 - (Date.now() % 60_000)) }
    t = setTimeout(tick, 60_050 - (Date.now() % 60_000))
    const sub = onReturn(() => setNow(new Date()), 0)
    return () => { clearTimeout(t); sub() }
  }, [])
  return now
}

export function addAlarm(a: Pick<Alarm, 'time' | 'days' | 'label' | 'sound' | 'sound_name'>) {
  const now = new Date().toISOString()
  return alarmList.add({ ...a, enabled: true, at: a.days.length ? null : nextAt(a.time), created_at: now, updated_at: now })
}
export function updateAlarm(a: Alarm, changes: Partial<Alarm>) {
  const next = { ...a, ...changes }
  // Switched on (or moved) once-only: it rings at the next HH:MM from now.
  const at = next.enabled && !next.days.length ? nextAt(next.time) : null
  alarmList.update(a.id, { ...changes, at })
}
export const deleteAlarm = (id: string) => alarmList.remove(id)

export function addReminder(r: Pick<Reminder, 'title' | 'notes' | 'at' | 'repeat'>) {
  const now = new Date().toISOString()
  return reminderList.add({ ...r, done: false, done_at: null, created_at: now, updated_at: now })
}
export const updateReminder = (id: string, changes: Partial<Reminder>) => reminderList.update(id, changes)
export const deleteReminder = (id: string) => reminderList.remove(id)
/** Done: a one-off is ticked off; a repeating one moves to its next time. */
export function finishReminder(r: Reminder) {
  if (r.repeat) {
    const after = new Date(Math.max(Date.now(), Date.parse(r.at)) + 60_000)
    updateReminder(r.id, { at: reminderNext(r, after).toISOString() })
  } else updateReminder(r.id, { done: !r.done, done_at: r.done ? null : new Date().toISOString() })
}
