// An alarm: its name, the time on big wheels, the days it repeats (none: once). `new` makes one.
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'

import { ClockWheel } from '@/components/tasks/clock-wheel'
import { EditorShell, Field } from '@/components/tasks/editor-shell'
import { addAlarm, alarmNext, daysText, deleteAlarm, nextAt, untilText, updateAlarm, useAlarms, type Alarm } from '@/lib/clock'
import { Phone } from '@/lib/phone'
import { type, useTheme } from '@/theme'
import { PickerField, Text, haptic, toast } from '@/ui'

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
  const [sound, setSound] = useState(alarm?.sound ?? '')
  const [tones, setTones] = useState<{ title: string; uri: string; kind: 'alarm' | 'ringtone' }[]>([])
  useEffect(() => {
    Phone?.alarmTones?.().then(setTones, () => {})
    return () => Phone?.stopTone?.()
  }, [])
  const [h, m] = time.split(':').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = alarmNext({ ...(alarm ?? { id: '', created_at: '', updated_at: '' }), time, days, label, sound, enabled: true, at: days.length ? null : nextAt(time) })

  const save = () => {
    Phone?.stopTone?.()
    if (alarm) updateAlarm(alarm, { time, days, label: label.trim(), sound, enabled: true })
    else addAlarm({ time, days, label: label.trim(), sound })
    haptic.success()
    if (at) toast({ title: `Alarm ${untilText(at)}` })
    router.back()
  }

  return (
    <EditorShell title={alarm ? 'Edit alarm' : 'New alarm'} editing={!!alarm} ready onSave={save}
      onDelete={alarm ? () => deleteAlarm(alarm.id) : undefined} deleteWhat="alarm">
      <TextInput value={label} onChangeText={setLabel} placeholder="Alarm name" placeholderTextColor={c.ink4} maxLength={60}
        cursorColor={c.tube} selectionColor={c.tube} returnKeyType="done"
        style={[type.title, { color: c.ink, padding: 0 }]} accessibilityLabel="Alarm name" />
      <View style={{ gap: 8 }}>
        <ClockWheel hour={h} minute={m} onChange={(hh, mm) => setTime(`${pad(hh)}:${pad(mm)}`)} />
        {at && <Text variant="footnote" color="ink3" style={{ textAlign: 'center' }}>Rings {untilText(at)}</Text>}
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
      {tones.length > 0 && (
        <PickerField label="Sound" value={sound} stayOpen placeholder="Phone’s alarm sound"
          onChange={(v) => { setSound(v); Phone?.previewTone?.(v) }}
          options={[{ value: '', title: 'Phone’s alarm sound', group: 'Alarm sounds' }, ...tones.map((t) => ({ value: t.uri, title: t.title.replace(/_/g, ' '), group: t.kind === 'alarm' ? 'Alarm sounds' : 'Ringtones' }))]} />
      )}
      <Pressable onPress={() => { haptic.tap(); Phone?.previewAlarm?.(JSON.stringify({ id: '', title: label.trim() })) }}
        accessibilityRole="button" style={{ height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2 }}>
        <Text variant="label" color="ink2">Preview the ringing screen</Text>
      </Pressable>
    </EditorShell>
  )
}
