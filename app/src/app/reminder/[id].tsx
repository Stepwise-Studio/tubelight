// A reminder: what, when (a day and a time), whether it repeats, notes. `new` makes one (in the next hour by default).
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { Calendar03Icon } from '@hugeicons/core-free-icons'

import { DayPicker } from '@/components/tasks/day-picker'
import { Chips, EditorShell, Field } from '@/components/tasks/editor-shell'
import { REPEATS, addReminder, deleteReminder, updateReminder, useReminders, type Reminder, type Repeat } from '@/lib/clock'
import { dueLabel, isoDay } from '@/lib/tasks'
import { type, useTheme } from '@/theme'
import { Icon, Press, Sheet, Text, TimePicker, haptic } from '@/ui'

export default function ReminderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const rows = useReminders().rows
  const reminder = id === 'new' ? null : rows?.find((r) => r.id === id) ?? null
  if (id !== 'new' && !reminder) return null
  return <Editor key={reminder?.id ?? 'new'} reminder={reminder} />
}

function Editor({ reminder }: { reminder: Reminder | null }) {
  const { c } = useTheme()
  const [title, setTitle] = useState(reminder?.title ?? '')
  const [notes, setNotes] = useState(reminder?.notes ?? '')
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? '')
  const [at, setAt] = useState(() => {
    if (reminder) return new Date(reminder.at)
    const d = new Date()
    d.setHours(d.getHours() + 1, 0, 0, 0)
    return d
  })
  const [picking, setPicking] = useState(false)
  const titleRef = useRef<TextInput>(null)
  useEffect(() => {
    if (reminder) return
    const t = setTimeout(() => titleRef.current?.focus(), 250)
    return () => clearTimeout(t)
  }, [reminder])
  const ready = !!title.trim()
  const day = dueLabel(isoDay(at))

  const save = () => {
    const fields = { title: title.trim(), notes, repeat, at: at.toISOString() }
    if (reminder) updateReminder(reminder.id, { ...fields, done: false, done_at: null })
    else addReminder(fields)
    haptic.success()
    router.back()
  }

  return (
    <EditorShell title={reminder ? 'Edit reminder' : 'New reminder'} editing={!!reminder} ready={ready} onSave={save}
      onDelete={reminder ? () => deleteReminder(reminder.id) : undefined} deleteWhat="reminder">
      <TextInput ref={titleRef} value={title} onChangeText={setTitle} placeholder="Remind me to…" placeholderTextColor={c.ink4}
        multiline maxLength={300} submitBehavior="blurAndSubmit" cursorColor={c.tube} selectionColor={c.tube}
        style={[type.title, { color: c.ink, padding: 0 }]} accessibilityLabel="What to be reminded of" />
      <Field label="When">
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <Press radius={18} static onPress={() => setPicking(true)} accessibilityLabel={`Day, ${day.label}. Change`}
            style={{ height: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(138,138,141,0.23)', backgroundColor: c.panel }}>
            <Icon icon={Calendar03Icon} size={18} color={day.overdue ? 'danger' : 'ink3'} />
            <Text variant="bodyMedium" color={day.overdue ? 'danger' : 'ink'}>{day.label}</Text>
          </Press>
          <View style={{ flex: 1 }}>
            <TimePicker hour={at.getHours()} minute={at.getMinutes()} onChange={(h, m) => setAt(new Date(at.getFullYear(), at.getMonth(), at.getDate(), h, m))} />
          </View>
        </View>
      </Field>
      <Field label="Repeat">
        <Chips options={REPEATS} value={repeat} onChange={(v) => setRepeat(v as Repeat)} />
      </Field>
      <Field label="Notes">
        <TextInput value={notes} onChangeText={setNotes} placeholder="Add notes…" placeholderTextColor={c.ink4} multiline maxLength={2000}
          cursorColor={c.tube} selectionColor={c.tube}
          style={[type.body, { color: c.ink, minHeight: 96, padding: 14, borderRadius: 16, backgroundColor: c.panel2, textAlignVertical: 'top' }]} accessibilityLabel="Notes" />
      </Field>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Day">
        <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <DayPicker value={isoDay(at)} onChange={(d) => {
            const [y, mo, dd] = d.split('-').map(Number)
            setAt(new Date(y, mo - 1, dd, at.getHours(), at.getMinutes()))
            setPicking(false)
          }} />
        </View>
      </Sheet>
    </EditorShell>
  )
}
