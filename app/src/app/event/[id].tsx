// A calendar event in the phone's calendars: title, all day or a start and an end, which calendar, repeat, an alert
// (new ones), place and notes. `new` (with `day`) adds one; an id (with the instance's `start`) edits it; edits to a
// repeating event change the whole series.
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { Calendar03Icon } from '@hugeicons/core-free-icons'

import { DayPicker } from '@/components/tasks/day-picker'
import { Chips, EditorShell, Field } from '@/components/tasks/editor-shell'
import { REPEAT_RULES, deleteEvent, saveEvent, useCalendars, type PhoneEvent } from '@/lib/calendar'
import { dueLabel, isoDay } from '@/lib/tasks'
import { Phone } from '@/lib/phone'
import { type, useTheme } from '@/theme'
import { Icon, PickerField, Press, Sheet, Text, TimePicker, Toggle, haptic, toast } from '@/ui'

const ALERTS = [{ value: -1, label: 'None' }, { value: 0, label: 'At start' }, { value: 10, label: '10 min' }, { value: 30, label: '30 min' }, { value: 60, label: '1 hour' }]

export default function EventScreen() {
  const { id, start, day } = useLocalSearchParams<{ id: string; start?: string; day?: string }>()
  const [event, setEvent] = useState<PhoneEvent | null | undefined>(id === 'new' ? null : undefined)
  useEffect(() => {
    if (id === 'new' || !Phone?.calendarEvents) return
    const at = Number(start) || Date.now()
    Phone.calendarEvents(at - 86_400_000, at + 86_400_000).then((l) => setEvent(l.find((e) => e.id === id) ?? null), () => setEvent(null))
  }, [id, start])
  if (event === undefined) return null
  return <Editor key={event?.id ?? 'new'} event={event} day={day} />
}

function Editor({ event, day }: { event: PhoneEvent | null; day?: string }) {
  const { c } = useTheme()
  const calendars = useCalendars(true).filter((x) => x.writable && x.visible)
  const [title, setTitle] = useState(event?.title ?? '')
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [from, setFrom] = useState(() => {
    if (event) return event.allDay ? utcDay(event.start) : new Date(event.start)
    const d = day ? new Date(`${day}T00:00`) : new Date()
    const now = new Date()
    d.setHours(day && isoDay(d) !== isoDay(now) ? 9 : now.getHours() + 1, 0, 0, 0)
    return d
  })
  const [until, setUntil] = useState(() => event ? (event.allDay ? new Date(utcDay(event.end).getTime() - 86_400_000) : new Date(event.end)) : new Date(from.getTime() + 3_600_000))
  const [chosen, setCalendar] = useState(event?.calendar ?? '')
  // A new one goes to the main synced calendar (Google's), else the first one that takes events.
  const calendar = chosen || (calendars.find((x) => x.primary && !x.local) ?? calendars[0])?.id || ''
  const [rrule, setRrule] = useState(event?.rrule ?? '')
  const [alert, setAlert] = useState(10)
  const [place, setPlace] = useState(event?.place ?? '')
  const [notes, setNotes] = useState(event?.notes ?? '')
  const [picking, setPicking] = useState<'from' | 'until' | null>(null)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<TextInput>(null)
  useEffect(() => {
    if (event) return
    const t = setTimeout(() => titleRef.current?.focus(), 250)
    return () => clearTimeout(t)
  }, [event])

  const moveFrom = (d: Date) => {
    // The end keeps the length it had.
    setUntil(new Date(until.getTime() + (d.getTime() - from.getTime())))
    setFrom(d)
  }
  const ready = !!title.trim() && !!calendar && !saving
  const save = async () => {
    const end = allDay ? new Date(until.getFullYear(), until.getMonth(), until.getDate() + 1) : until
    if (end <= from) { toast({ title: 'It ends before it starts', tone: 'error' }); return }
    setSaving(true)
    try {
      await saveEvent({ id: event?.id, calendar, title: title.trim(), start: from.getTime(), end: end.getTime(), allDay, place, notes, rrule, alert: event ? undefined : alert })
      haptic.success()
      router.back()
    } catch (e) {
      setSaving(false)
      toast({ title: 'Unable to save it', body: (e as Error).message, tone: 'error' })
    }
  }

  return (
    <EditorShell title={event ? 'Edit event' : 'New event'} editing={!!event} ready={ready} onSave={save}
      onDelete={event ? () => deleteEvent(event.id).catch((e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' })) : undefined} deleteWhat="event">
      <TextInput ref={titleRef} value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={c.ink4}
        multiline maxLength={300} submitBehavior="blurAndSubmit" cursorColor={c.tube} selectionColor={c.tube}
        style={[type.title, { color: c.ink, padding: 0 }]} accessibilityLabel="Title" />
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text variant="body" style={{ flex: 1 }}>All day</Text>
          <Toggle value={allDay} onChange={(v) => { haptic.tap(); setAllDay(v) }} accessibilityLabel="All day" />
        </View>
        <When label="Starts" at={from} allDay={allDay} onDay={() => setPicking('from')} onTime={(h, m) => moveFrom(new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m))} />
        <When label="Ends" at={until} allDay={allDay} onDay={() => setPicking('until')} onTime={(h, m) => setUntil(new Date(until.getFullYear(), until.getMonth(), until.getDate(), h, m))} />
      </View>
      {event?.rrule ? <Text variant="footnote" color="ink3" style={{ marginTop: -10 }}>A repeating event: changes apply to every time it happens.</Text> : null}
      {calendars.length > 1 && (
        <PickerField label="Calendar" value={calendar} onChange={setCalendar}
          options={calendars.map((x) => ({ value: x.id, title: x.name, subtitle: x.account !== x.name ? x.account : undefined,
            leading: <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: x.color }} /> }))} />
      )}
      <Field label="Repeat">
        <Chips options={REPEAT_RULES.some((r) => r.value === rrule) ? REPEAT_RULES : [...REPEAT_RULES, { value: rrule, label: 'Custom' }]} value={rrule} onChange={setRrule} />
      </Field>
      {!event && (
        <Field label="Alert">
          <Chips options={ALERTS.map((a) => ({ value: String(a.value), label: a.label }))} value={String(alert)} onChange={(v) => setAlert(Number(v))} />
        </Field>
      )}
      <Field label="Place">
        <TextInput value={place} onChangeText={setPlace} placeholder="Add a place" placeholderTextColor={c.ink4} maxLength={300}
          cursorColor={c.tube} selectionColor={c.tube}
          style={[type.body, { color: c.ink, height: 48, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.panel2 }]} accessibilityLabel="Place" />
      </Field>
      <Field label="Notes">
        <TextInput value={notes} onChangeText={setNotes} placeholder="Add notes…" placeholderTextColor={c.ink4} multiline maxLength={5000}
          cursorColor={c.tube} selectionColor={c.tube}
          style={[type.body, { color: c.ink, minHeight: 96, padding: 14, borderRadius: 16, backgroundColor: c.panel2, textAlignVertical: 'top' }]} accessibilityLabel="Notes" />
      </Field>
      <Sheet open={!!picking} onClose={() => setPicking(null)} title={picking === 'until' ? 'Ends' : 'Starts'}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <DayPicker value={isoDay(picking === 'until' ? until : from)} onChange={(d) => {
            const [y, mo, dd] = d.split('-').map(Number)
            const base = picking === 'until' ? until : from
            const next = new Date(y, mo - 1, dd, base.getHours(), base.getMinutes())
            if (picking === 'until') setUntil(next)
            else moveFrom(next)
            setPicking(null)
          }} />
        </View>
      </Sheet>
    </EditorShell>
  )
}

/** The local day an all-day instance's UTC midnight stands for. */
function utcDay(ms: number) {
  const d = new Date(ms)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function When({ label, at, allDay, onDay, onTime }: { label: string; at: Date; allDay: boolean; onDay: () => void; onTime: (h: number, m: number) => void }) {
  const { c } = useTheme()
  const day = dueLabel(isoDay(at))
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <Text variant="label" color="ink3" style={{ width: 52, paddingTop: 13 }}>{label}</Text>
      <Press radius={18} static onPress={onDay} accessibilityLabel={`${label}, ${day.label}. Change`}
        style={{ height: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(138,138,141,0.23)', backgroundColor: c.panel }}>
        <Icon icon={Calendar03Icon} size={18} color="ink3" />
        <Text variant="bodyMedium">{at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</Text>
      </Press>
      {!allDay && <View style={{ flex: 1 }}><TimePicker hour={at.getHours()} minute={at.getMinutes()} onChange={onTime} /></View>}
    </View>
  )
}
