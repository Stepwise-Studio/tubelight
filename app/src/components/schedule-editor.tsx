import { useRef } from 'react'
import { ScrollView, View } from 'react-native'

import {
  ALL_DAYS, DAY_SHORT, DEFAULT_SCHEDULE, EVERY_HOURS, describeSchedule, type Schedule,
} from '@/lib/schedule'
import { useTheme } from '@/theme'
import { Chip, Press, Segment, Text, haptic } from '@/ui'

const HOUR_W = 64
const HOUR_GAP = 8
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
const MINUTES = [0, 15, 30, 45]

/** Pick when an automation runs, in plain terms: a time on some days (like an alarm), or every few hours. */
export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const kind = value.kind === 'custom' ? null : value.kind
  return (
    <View style={{ gap: 16 }}>
      <Segment<'time' | 'hours'>
        value={kind ?? 'time'}
        onChange={(k) => onChange(k === 'time' ? DEFAULT_SCHEDULE : { kind: 'hours', every: 3 })}
        accessibilityLabel="Repeat"
        options={[{ value: 'time', label: 'At a time' }, { value: 'hours', label: 'Every few hours' }]}
      />
      {value.kind === 'custom' && (
        <Text variant="caption" color="ink3">
          It was set up in chat as a custom schedule ({value.cron}). Pick a new one above to replace it, or leave it as is.
        </Text>
      )}
      {value.kind === 'time' && <AtTime value={value} onChange={onChange} />}
      {value.kind === 'hours' && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
          {EVERY_HOURS.map((n) => (
            <Chip key={n} label={n === 1 ? 'Every hour' : `Every ${n} hours`} selected={value.every === n}
              onPress={() => { haptic.tap(); onChange({ kind: 'hours', every: n }) }} />
          ))}
        </View>
      )}
      {value.kind !== 'custom' && (
        <Text variant="footnote" color="ink2" accessibilityLiveRegion="polite">Runs {describeSchedule(value)}, your time.</Text>
      )}
    </View>
  )
}

function AtTime({ value, onChange }: { value: Extract<Schedule, { kind: 'time' }>; onChange: (s: Schedule) => void }) {
  const { c } = useTheme()
  const hours = useRef<ScrollView>(null)
  const set = (patch: Partial<typeof value>) => { haptic.tap(); onChange({ ...value, ...patch }) }
  const toggleDay = (d: number) => {
    const on = value.days.includes(d)
    if (on && value.days.length === 1) return // at least one day
    set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d].sort() })
  }
  // Monday first, like most calendars people set alarms in.
  const week = [1, 2, 3, 4, 5, 6, 0]
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 8 }}>
        <Text variant="footnote" color="ink3">Hour</Text>
        <ScrollView
          ref={hours}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal: -20 }}
          contentContainerStyle={{ paddingHorizontal: 20, gap: HOUR_GAP }}
          onLayout={(e) => hours.current?.scrollTo({ x: Math.max(0, value.hour * (HOUR_W + HOUR_GAP) - e.nativeEvent.layout.width / 2 + HOUR_W / 2 + 20), animated: false })}
          accessibilityRole="radiogroup"
        >
          {Array.from({ length: 24 }, (_, h) => {
            const on = value.hour === h
            return (
              <Press key={h} radius={18} onPress={() => set({ hour: h })} accessibilityRole="radio" accessibilityState={{ selected: on }}
                style={{ width: HOUR_W, height: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.ink : c.panel2 }}>
                <Text variant="label" style={{ color: on ? c.canvas : c.ink2 }}>{hourLabel(h)}</Text>
              </Press>
            )
          })}
        </ScrollView>
      </View>
      <View style={{ gap: 8 }}>
        <Text variant="footnote" color="ink3">Minute</Text>
        <Segment<string>
          value={String(value.minute)}
          onChange={(m) => set({ minute: +m })}
          accessibilityLabel="Minute"
          // A teammate may have picked an odd minute (8:10): keep it selectable.
          options={[...new Set([...MINUTES, value.minute])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: `:${String(m).padStart(2, '0')}` }))}
        />
      </View>
      <View style={{ gap: 8 }}>
        <Text variant="footnote" color="ink3">Days</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {week.map((d) => {
            const on = value.days.includes(d)
            return (
              <Press key={d} radius={20} onPress={() => toggleDay(d)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={DAY_SHORT[d]}
                style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.tube : c.panel2 }}>
                <Text variant="label" style={{ color: on ? '#ffffff' : c.ink3 }}>{DAY_SHORT[d].slice(0, 1)}</Text>
              </Press>
            )
          })}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {([['Every day', ALL_DAYS], ['Weekdays', [1, 2, 3, 4, 5]], ['Weekends', [0, 6]]] as const).map(([label, days]) => (
            <Chip key={label} size="sm" label={label} selected={value.days.join() === days.join()} onPress={() => set({ days: [...days] })} />
          ))}
        </View>
      </View>
    </View>
  )
}
