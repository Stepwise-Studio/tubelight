// An alarm: the time on drums, the days it repeats (none: once), its name. `new` makes one.
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'

import { EditorShell, Field } from '@/components/tasks/editor-shell'
import { addAlarm, alarmNext, daysText, deleteAlarm, nextAt, untilText, updateAlarm, useAlarms, type Alarm } from '@/lib/clock'
import { type, useTheme } from '@/theme'
import { Text, TimePicker, haptic, toast } from '@/ui'

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export default function AlarmScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const rows = useAlarms().rows
  const alarm = id === 'new' ? null : rows?.find((a) => a.id === id) ?? null
  if (id !== 'new' && !alarm) return null
  return <Editor key={alarm?.id ?? 'new'} alarm={alarm} />
}

function Editor({ alarm }: { alarm: Alarm | null }) {
  const { c } = useTheme()
  const [time, setTime] = useState(alarm?.time ?? '07:00')
  const [days, setDays] = useState<number[]>(alarm?.days ?? [])
  const [label, setLabel] = useState(alarm?.label ?? '')
  const [h, m] = time.split(':').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = alarmNext({ ...(alarm ?? { id: '', created_at: '', updated_at: '' }), time, days, label, enabled: true, at: days.length ? null : nextAt(time) })

  const save = () => {
    if (alarm) updateAlarm(alarm, { time, days, label: label.trim(), enabled: true })
    else addAlarm({ time, days, label: label.trim() })
    haptic.success()
    if (at) toast({ title: `Alarm ${untilText(at)}` })
    router.back()
  }

  return (
    <EditorShell title={alarm ? 'Edit alarm' : 'New alarm'} editing={!!alarm} ready onSave={save}
      onDelete={alarm ? () => deleteAlarm(alarm.id) : undefined} deleteWhat="alarm">
      <View style={{ gap: 6 }}>
        <TimePicker hour={h} minute={m} step={1} startOpen onChange={(hh, mm) => setTime(`${pad(hh)}:${pad(mm)}`)} />
        {at && <Text variant="footnote" color="ink3" style={{ paddingLeft: 2 }}>Rings {untilText(at)}</Text>}
      </View>
      <Field label={`Repeat · ${daysText(days)}`}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {DAYS.map((d, i) => {
            const on = days.includes(i)
            return (
              <Pressable key={i} onPress={() => { haptic.tap(); setDays(on ? days.filter((x) => x !== i) : [...days, i].sort()) }}
                accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={NAMES[i]}
                style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: on ? c.ink : c.panel2, borderWidth: on ? 0 : 1, borderColor: c.line }}>
                <Text variant="label" style={{ color: on ? c.canvas : i > 4 ? c.danger : c.ink2 }}>{d}</Text>
              </Pressable>
            )
          })}
        </View>
      </Field>
      <Field label="Name">
        <TextInput value={label} onChangeText={setLabel} placeholder="Alarm" placeholderTextColor={c.ink4} maxLength={60}
          cursorColor={c.tube} selectionColor={c.tube} returnKeyType="done"
          style={[type.body, { color: c.ink, height: 48, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.panel2 }]} accessibilityLabel="Alarm name" />
      </Field>
    </EditorShell>
  )
}
