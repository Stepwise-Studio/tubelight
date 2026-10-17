// An alarm: its name, the time on big wheels, the days it repeats (none: once). `new` makes one.
import { router, useLocalSearchParams } from 'expo-router'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'

import { ClockWheel } from '@/components/tasks/clock-wheel'
import { EditorShell, Field } from '@/components/tasks/editor-shell'
import { LOOKS, addAlarm, alarmNext, daysText, deleteAlarm, lookColors, nextAt, untilText, updateAlarm, useAlarms, type Alarm, type Look } from '@/lib/clock'
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
  const [look, setLook] = useState<Look>(alarm?.look ?? 'aurora')
  const [tones, setTones] = useState<{ title: string; uri: string }[]>([])
  useEffect(() => {
    Phone?.alarmTones?.().then(setTones, () => {})
    return () => Phone?.stopTone?.()
  }, [])
  const [h, m] = time.split(':').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = alarmNext({ ...(alarm ?? { id: '', created_at: '', updated_at: '' }), time, days, label, sound, look, enabled: true, at: days.length ? null : nextAt(time) })

  const save = () => {
    Phone?.stopTone?.()
    if (alarm) updateAlarm(alarm, { time, days, label: label.trim(), sound, look, enabled: true })
    else addAlarm({ time, days, label: label.trim(), sound, look })
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
          options={[{ value: '', title: 'Phone’s alarm sound' }, ...tones.map((t) => ({ value: t.uri, title: t.title }))]} />
      )}
      <Field label={`Ringing screen · ${LOOKS[look].label}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {(Object.keys(LOOKS) as Look[]).map((k) => {
            const on = k === look
            return (
              <Pressable key={k} onPress={() => { haptic.tap(); setLook(k) }} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={LOOKS[k].label}
                style={{ width: 48, height: 48, borderRadius: 24, padding: 3, borderWidth: 2, borderColor: on ? c.ink : 'transparent' }}>
                <LinearGradient colors={[...LOOKS[k].a]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, borderRadius: 20 }} />
              </Pressable>
            )
          })}
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => { haptic.tap(); Phone?.previewAlarm?.(JSON.stringify({ id: '', title: label.trim() || 'Alarm', colors: lookColors(look) })) }}
            accessibilityRole="button" style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: c.panel2 }}>
            <Text variant="label" color="ink2">Preview</Text>
          </Pressable>
        </View>
      </Field>
    </EditorShell>
  )
}
