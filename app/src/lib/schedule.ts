// Schedules in plain words <-> 5-field cron in the user's own time zone (agent-service runs automations there).
// Two shapes cover what people ask for: at a time on some days ("weekdays at 9"), or every few hours.
// Anything else a teammate set up ("0 9,17 * * *") stays a custom cron and is shown as-is until it's edited here.

export type Schedule =
  | { kind: 'time'; hour: number; minute: number; days: number[] } // days 0-6, Sunday = 0; all seven = every day
  | { kind: 'hours'; every: number } // on the hour
  | { kind: 'custom'; cron: string }

export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12]
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const DEFAULT_SCHEDULE: Schedule = { kind: 'time', hour: 8, minute: 0, days: ALL_DAYS }

/** "1-5" / "0,6" / "*" -> sorted days, or null for anything fancier. 7 is Sunday too. */
function days(field: string): number[] | null {
  if (field === '*') return ALL_DAYS
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^([0-7])(?:-([0-7]))?$/.exec(part)
    if (!m) return null
    const [a, b] = [+m[1], m[2] ? +m[2] : +m[1]]
    if (b < a) return null
    for (let d = a; d <= b; d++) out.add(d % 7)
  }
  return [...out].sort()
}

export function parseCron(cron: string): Schedule {
  const f = cron.trim().split(/\s+/)
  if (f.length === 5 && f[2] === '*' && f[3] === '*') {
    const [mi, h, , , dow] = f
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && +mi < 60 && +h < 24) {
      const d = days(dow)
      if (d) return { kind: 'time', hour: +h, minute: +mi, days: d }
    }
    const every = h === '*' ? 1 : /^\*\/\d+$/.test(h) ? +h.slice(2) : 0
    if (mi === '0' && dow === '*' && EVERY_HOURS.includes(every)) return { kind: 'hours', every }
  }
  return { kind: 'custom', cron }
}

export function toCron(s: Schedule): string {
  if (s.kind === 'custom') return s.cron
  if (s.kind === 'hours') return s.every === 1 ? '0 * * * *' : `0 */${s.every} * * *`
  return `${s.minute} ${s.hour} * * ${s.days.length === 7 ? '*' : s.days.join(',')}`
}

export const timeLabel = (hour: number, minute: number) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** "every day at 8:00 AM", "weekdays at 9:00 AM", "Mon, Wed at 6:30 PM", "every 3 hours". */
export function describeSchedule(s: Schedule): string {
  if (s.kind === 'custom') return `on a custom schedule (${s.cron})`
  if (s.kind === 'hours') return s.every === 1 ? 'every hour' : `every ${s.every} hours`
  const at = timeLabel(s.hour, s.minute)
  const d = s.days.join(',')
  const when = d === '0,1,2,3,4,5,6' ? 'every day' : d === '1,2,3,4,5' ? 'weekdays' : d === '0,6' ? 'weekends'
    : s.days.length === 1 ? `${DAY_LONG[s.days[0]]}s` : s.days.map((x) => DAY_SHORT[x]).join(', ')
  return `${when} at ${at}`
}

export const sameSchedule = (a: Schedule, b: Schedule) => toCron(a) === toCron(b)

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** How the Repeat chips read a schedule: presets for the day sets people pick most, or custom days. */
export type Repeat = 'daily' | 'weekdays' | 'weekends' | 'days' | 'hours'
export function repeatOf(s: Schedule): Repeat | null {
  if (s.kind === 'custom') return null
  if (s.kind === 'hours') return 'hours'
  const d = s.days.join(',')
  return d === '0,1,2,3,4,5,6' ? 'daily' : d === '1,2,3,4,5' ? 'weekdays' : d === '0,6' ? 'weekends' : 'days'
}
export function withRepeat(s: Schedule, r: Repeat): Schedule {
  const at = s.kind === 'time' ? { hour: s.hour, minute: s.minute } : { hour: 8, minute: 0 }
  if (r === 'hours') return { kind: 'hours', every: s.kind === 'hours' ? s.every : 3 }
  const days = r === 'daily' ? ALL_DAYS : r === 'weekdays' ? [1, 2, 3, 4, 5] : r === 'weekends' ? [0, 6]
    : s.kind === 'time' && s.days.length < 7 ? s.days : [1, 3, 5]
  return { kind: 'time', ...at, days }
}

/** The next `n` run times in this device's time zone (the form's preview; the service computes the real ones). */
export function nextRuns(s: Schedule, n = 3, from = new Date()): Date[] {
  if (s.kind === 'custom') return []
  const out: Date[] = []
  const t = new Date(from)
  t.setSeconds(0, 0)
  for (let i = 0; i < 60 * 24 * 8 && out.length < n; i++) {
    t.setMinutes(t.getMinutes() + 1)
    const ok = s.kind === 'hours'
      ? t.getMinutes() === 0 && t.getHours() % s.every === 0
      : t.getMinutes() === s.minute && t.getHours() === s.hour && s.days.includes(t.getDay())
    if (ok) out.push(new Date(t))
  }
  return out
}
