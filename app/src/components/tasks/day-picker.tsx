// A day picker: quick picks (Today, Tomorrow, This weekend, Next week) over a month grid you page through.
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'

import { isoDay } from '@/lib/tasks'
import { motion, useTheme } from '@/theme'
import { Chip, IconButton, Text, haptic } from '@/ui'

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const plus = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)

function quick(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (today.getDay() + 6) % 7 // Monday 0
  return [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: plus(today, 1) },
    ...(dow < 5 ? [{ label: 'This weekend', day: plus(today, 5 - dow) }] : []),
    { label: 'Next week', day: plus(today, 7 - dow) },
  ]
}

export function DayPicker({ value, onChange, min }: { value: string | null; onChange: (day: string) => void; min?: string }) {
  const { c } = useTheme()
  const start = value ? new Date(`${value}T00:00`) : new Date()
  const [month, setMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1))
  const today = isoDay(new Date())
  const lead = (month.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))]
  while (cells.length % 7) cells.push(null)
  const pick = (d: Date) => { haptic.tap(); onChange(isoDay(d)) }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {quick().map((q) => (
          <Chip key={q.label} label={q.label} selected={value === isoDay(q.day)} onPress={() => pick(q.day)} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Animated.View key={month.toISOString()} entering={FadeIn.duration(motion.duration.quick)} exiting={FadeOut.duration(motion.duration.micro)} style={{ flex: 1 }}>
          <Text variant="headline">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        </Animated.View>
        <IconButton icon={ArrowLeft01Icon} size={36} iconSize={18} accessibilityLabel="Previous month"
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
        <IconButton icon={ArrowRight01Icon} size={36} iconSize={18} accessibilityLabel="Next month"
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
      </View>
      <View>
        <View style={{ flexDirection: 'row' }}>
          {WEEK.map((w, i) => <Text key={i} variant="footnote" color="ink3" align="center" style={{ flex: 1 }}>{w}</Text>)}
        </View>
        {Array.from({ length: cells.length / 7 }, (_, row) => (
          <View key={row} style={{ flexDirection: 'row' }}>
            {cells.slice(row * 7, row * 7 + 7).map((d, i) => {
              if (!d) return <View key={i} style={{ flex: 1, height: 40 }} />
              const iso = isoDay(d)
              const on = iso === value
              const off = !!min && iso < min
              return (
                <Pressable key={i} disabled={off} onPress={() => pick(d)} style={{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' }}
                  accessibilityRole="button" accessibilityState={{ selected: on, disabled: off }}
                  accessibilityLabel={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}>
                  <View style={{
                    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: on ? c.tube : 'transparent', borderWidth: iso === today && !on ? 1 : 0, borderColor: c.tube,
                  }}>
                    <Text variant="label" tabular color={on ? c.onTube : off ? 'ink4' : iso === today ? 'tube' : 'ink'}>{d.getDate()}</Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        ))}
      </View>
    </View>
  )
}
