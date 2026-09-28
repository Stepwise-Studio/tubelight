// Human previews for 5-field cron expressions. agent-service runs them in the rule's `match.tz` (UTC when it has none).
// ponytail: covers the shapes people actually write (daily, weekdays, weekly, monthly, every n
// minutes/hours); anything else reads "Custom schedule". Swap for a real parser if that shows up a lot.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')
const int = (s: string, lo: number, hi: number) => (/^\d+$/.test(s) && +s >= lo && +s <= hi ? +s : null)

const FIELD = /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/

/** null when valid, else a sentence saying how to fix it. */
export function cronError(expr: string): string | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5 || !f.every((x) => FIELD.test(x))) {
    return 'Use five fields: minute hour day month weekday, like 0 9 * * 1-5.'
  }
  return null
}

/** "Every day at 09:00", "Weekdays at 09:00", "Every 15 minutes". `local`: the cron is in the user's own time zone;
 * otherwise it runs in UTC and says so. */
export function describeCron(expr: string, local = false): string {
  const utc = local ? '' : ' UTC'

  if (cronError(expr)) return 'Not a valid schedule yet'
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/)
  const m = int(mi, 0, 59)
  const hr = int(h, 0, 23)
  const everyMin = /^\*\/(\d+)$/.exec(mi)
  const everyHr = /^\*\/(\d+)$/.exec(h)

  if (dom === '*' && mon === '*' && dow === '*') {
    if (mi === '*' && h === '*') return 'Every minute'
    if (everyMin && h === '*') return `Every ${everyMin[1]} minutes`
    if (m !== null && h === '*') return m === 0 ? 'Every hour, on the hour' : `Every hour at :${pad(m)}`
    if (m !== null && everyHr) return `Every ${everyHr[1]} hours at :${pad(m)}${utc}`
  }
  if (m === null || hr === null || mon !== '*') return `Custom schedule${local ? '' : ' (UTC)'}`
  const at = `${pad(hr)}:${pad(m)}${utc}`
  if (dom === '*' && dow === '*') return `Every day at ${at}`
  if (dom === '*' && (dow === '1-5')) return `Weekdays at ${at}`
  if (dom === '*' && (dow === '0,6' || dow === '6,0')) return `Weekends at ${at}`
  if (dom === '*' && /^\d(,\d)*$/.test(dow)) {
    const days = dow.split(',').map((d) => DAYS[+d % 7])
    return `Every ${days.length > 1 ? days.slice(0, -1).join(', ') + ' and ' + days.at(-1) : days[0]} at ${at}`
  }
  const day = int(dom, 1, 31)
  if (day !== null && dow === '*') return `Monthly on day ${day} at ${at}`
  return `Custom schedule${local ? '' : ' (UTC)'}`
}

export const CRON_PRESETS = [
  { label: 'Every morning', cron: '0 9 * * *' },
  { label: 'Weekdays', cron: '0 9 * * 1-5' },
  { label: 'Mondays', cron: '0 10 * * 1' },
  { label: 'Hourly', cron: '0 * * * *' },
]
