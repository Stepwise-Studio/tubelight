// The Tasks tab's calendar, Samsung Calendar-like: a month grid (swipe for the next or last month) with each day's
// events as coloured lines, and under it the picked day: all-day events, then events and reminders by time, then
// the to-dos due. Tap an event to edit it, + (or hold a day) to add one. Events are the phone's own calendars
// (lib/calendar.ts), so Samsung and Google Calendar show the same.
import { router } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeInLeft, FadeInRight } from 'react-native-reanimated'
import { Add01Icon, ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon, Location01Icon, Notification03Icon } from '@hugeicons/core-free-icons'

import { useTabBarInset } from '@/components/tab-bar'
import { calendarAccess, eventDays, useEvents, type PhoneEvent } from '@/lib/calendar'
import { reminderNext, useMinute, useReminders } from '@/lib/clock'
import { isoDay, useTodos } from '@/lib/tasks'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Text, haptic } from '@/ui'

import { StatusGlyph } from './glyphs'

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const CELL_H = 62
const LINES = 4
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export function CalendarView() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const now = useMinute()
  const today = midnight(now)
  const [access, setAccess] = useState<'ok' | 'no' | 'missing' | null>(null)
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
  const [picked, setPicked] = useState(today)
  const [dir, setDir] = useState(0)
  useEffect(() => { calendarAccess(true).then(setAccess) }, [])

  // Six weeks from the Monday on or before the 1st.
  const first = useMemo(() => {
    const d = new Date(month)
    d.setDate(1 - ((d.getDay() + 6) % 7))
    return d
  }, [month])
  const from = first.getTime()
  const to = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 42).getTime()
  const events = useEvents(from, to, access === 'ok')
  const byDay = useMemo(() => {
    const m = new Map<number, PhoneEvent[]>()
    for (const e of events ?? []) for (const d of eventDays(e)) m.set(d, [...(m.get(d) ?? []), e])
    for (const l of m.values()) l.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
    return m
  }, [events])

  const shift = useCallback((n: number) => {
    haptic.tap()
    setDir(n)
    setMonth((m) => {
      const next = new Date(m.getFullYear(), m.getMonth() + n, 1)
      // The picked day follows: today in this month, else the 1st.
      const t = new Date()
      setPicked(next.getFullYear() === t.getFullYear() && next.getMonth() === t.getMonth() ? midnight(t) : next.getTime())
      return next
    })
  }, [])
  const swipe = useMemo(() => Gesture.Pan().runOnJS(true).activeOffsetX([-24, 24]).failOffsetY([-14, 14])
    .onEnd((e) => { if (Math.abs(e.translationX) > 50 || Math.abs(e.velocityX) > 500) shift(e.translationX < 0 ? 1 : -1) }), [shift])
  const goToday = () => { haptic.tap(); setDir(0); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setPicked(today) }
  const add = useCallback((day: number) => { haptic.tap(); router.push({ pathname: '/event/[id]', params: { id: 'new', day: isoDay(new Date(day)) } }) }, [])
  const onPick = useCallback((day: number) => { haptic.tap(); setPicked(day) }, [])

  if (access === 'no' || access === 'missing') {
    return (
      <EmptyState
        art={<View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={Calendar03Icon} size={26} color="tube" /></View>}
        title={access === 'missing' ? 'Update Tubelight for the calendar' : 'Your calendar, here'}
        body={access === 'missing' ? 'This version can’t read the phone’s calendars yet.' : 'Tubelight shows and edits the calendars on this phone, the same ones Samsung and Google Calendar show.'}
        action={access === 'no' ? <Button label="Allow calendar access" onPress={() => calendarAccess(true).then(setAccess)} /> : undefined}
      />
    )
  }

  const thisMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth()
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: inset + 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, height: 44 }}>
        <Text variant="headline" style={{ flex: 1 }} accessibilityRole="header">
          {month.toLocaleDateString(undefined, { month: 'long' })}
          <Text variant="headline" color="ink3">{month.getFullYear() === now.getFullYear() ? '' : ` ${month.getFullYear()}`}</Text>
        </Text>
        {(!thisMonth || picked !== today) && (
          <Pressable onPress={goToday} hitSlop={8} accessibilityRole="button" style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', backgroundColor: c.panel2, marginRight: 4 }}>
            <Text variant="label" color="ink2">Today</Text>
          </Pressable>
        )}
        <IconButton icon={ArrowLeft01Icon} size={36} iconSize={18} color={c.ink3} accessibilityLabel="Last month" onPress={() => shift(-1)} />
        <IconButton icon={ArrowRight01Icon} size={36} iconSize={18} color={c.ink3} accessibilityLabel="Next month" onPress={() => shift(1)} />
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 8 }}>
        {WEEK.map((d, i) => <Text key={i} variant="caption" color={i > 4 ? 'danger' : 'ink3'} style={{ flex: 1, textAlign: 'center', paddingVertical: 6 }}>{d}</Text>)}
      </View>
      <GestureDetector gesture={swipe}>
        <Animated.View key={month.getTime()} entering={(dir > 0 ? FadeInRight : dir < 0 ? FadeInLeft : FadeIn).duration(motion.duration.fast)}
          style={{ paddingHorizontal: 8 }}>
          {[0, 1, 2, 3, 4, 5].map((w) => (
            <View key={w} style={{ flexDirection: 'row', borderTopWidth: 0.5, borderColor: c.line }}>
              {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + i)
                const t = d.getTime()
                return <DayCell key={i} day={t} date={d.getDate()} inMonth={d.getMonth() === month.getMonth()} weekend={i > 4}
                  today={t === today} picked={t === picked} events={byDay.get(t)} onPick={onPick} onHold={add} />
              })}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
      <Agenda day={picked} events={byDay.get(picked) ?? []} now={now} onAdd={() => add(picked)} />
    </ScrollView>
  )
}

const DayCell = memo(function DayCell({ day, date, inMonth, weekend, today, picked, events, onPick, onHold }: {
  day: number; date: number; inMonth: boolean; weekend: boolean; today: boolean; picked: boolean; events?: PhoneEvent[]
  onPick: (d: number) => void; onHold: (d: number) => void
}) {
  const { c } = useTheme()
  return (
    <Pressable onPress={() => onPick(day)} onLongPress={() => onHold(day)} delayLongPress={320}
      accessibilityRole="button" accessibilityState={{ selected: picked }}
      accessibilityLabel={`${new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${events?.length ? `, ${events.length} events` : ''}`}
      style={{ flex: 1, height: CELL_H, paddingTop: 4, paddingHorizontal: 2, gap: 2, borderRadius: 12, backgroundColor: picked && !today ? c.panel2 : undefined, opacity: inMonth ? 1 : 0.35 }}>
      <View style={{ alignSelf: 'center', width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: today ? c.tube : undefined }}>
        <Text variant="caption" tabular style={{ color: today ? '#fff' : weekend ? c.danger : c.ink, fontWeight: today || picked ? '600' : '400' }}>{date}</Text>
      </View>
      {/* One coloured line per event (the day's list below has the words). */}
      <View style={{ gap: 3, paddingHorizontal: 6, paddingTop: 3 }}>
        {events?.slice(0, LINES).map((e) => <View key={`${e.id}:${e.start}`} style={{ height: 3, borderRadius: 1.5, backgroundColor: e.color }} />)}
      </View>
    </Pressable>
  )
})

/** The picked day: all-day events, then events and reminders by time, then the to-dos due that day. */
function Agenda({ day, events, now, onAdd }: { day: number; events: PhoneEvent[]; now: Date; onAdd: () => void }) {
  const { c } = useTheme()
  const reminders = useReminders().rows ?? []
  const { todos } = useTodos()
  const iso = isoDay(new Date(day))
  const allDay = events.filter((e) => e.allDay)
  const timed = [
    ...events.filter((e) => !e.allDay).map((e) => ({ at: Math.max(e.start, day), kind: 'event' as const, e })),
    ...reminders.filter((r) => !r.done).map((r) => ({ r, at: reminderNext(r, new Date(day)).getTime() }))
      .filter(({ at }) => midnight(new Date(at)) === day).map(({ r, at }) => ({ at, kind: 'reminder' as const, r })),
  ].sort((a, b) => a.at - b.at)
  const due = (todos ?? []).filter((t) => t.due === iso && t.status !== 'canceled')
  const open = (e: PhoneEvent) => router.push({ pathname: '/event/[id]', params: { id: e.id, start: String(e.start) } })

  return (
    <Animated.View key={day} entering={FadeIn.duration(motion.duration.fast)} style={{ paddingTop: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, minHeight: 40, borderTopWidth: 0.5, borderColor: c.line }}>
        <Text variant="label" style={{ flex: 1 }}>{new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
        <IconButton icon={Add01Icon} size={34} iconSize={16} color={c.ink3} accessibilityLabel="New event" onPress={onAdd} />
      </View>
      {allDay.map((e) => (
        <Row key={`${e.id}:${e.start}`} onPress={() => open(e)} left={<Text variant="footnote" color="ink3">All day</Text>} color={e.color} title={e.title} sub={e.place} />
      ))}
      {timed.map((x) => x.kind === 'event'
        ? <Row key={`${x.e.id}:${x.e.start}`} onPress={() => open(x.e)} color={x.e.color} title={x.e.title} sub={x.e.place} past={x.e.end < now.getTime()}
            left={<><Text variant="footnote" tabular>{x.e.start < day ? '…' : time(x.e.start)}</Text><Text variant="caption" color="ink3" tabular>{midnight(new Date(x.e.end - 1)) > day ? '…' : time(x.e.end)}</Text></>} />
        : <Row key={x.r.id} onPress={() => router.push({ pathname: '/reminder/[id]', params: { id: x.r.id } })} past={x.at < now.getTime()}
            left={<Text variant="footnote" tabular>{time(x.at)}</Text>} icon={<Icon icon={Notification03Icon} size={14} color="ink3" />} title={x.r.title} />)}
      {due.map((t) => (
        <Row key={t.id} onPress={() => router.push({ pathname: '/todo/[id]', params: { id: t.id } })} left={<Text variant="footnote" color="ink3">Due</Text>}
          icon={<StatusGlyph status={t.status} size={15} />} title={t.title} past={t.status === 'done'} />
      ))}
      {!allDay.length && !timed.length && !due.length && (
        <Pressable onPress={onAdd} accessibilityRole="button" style={{ paddingHorizontal: 20, paddingVertical: 14 }}>
          <Text variant="footnote" color="ink4">Nothing on this day. Tap + to add an event.</Text>
        </Pressable>
      )}
    </Animated.View>
  )
}

function Row({ left, color, icon, title, sub, past, onPress }: {
  left: React.ReactNode; color?: string; icon?: React.ReactNode; title: string; sub?: string; past?: boolean; onPress: () => void
}) {
  const { c } = useTheme()
  return (
    <Pressable onPress={onPress} android_ripple={{ color: c.wash }} accessibilityRole="button" accessibilityLabel={title}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 9, opacity: past ? 0.5 : 1 }}>
      <View style={{ width: 62, gap: 1 }}>{left}</View>
      {color ? <View style={{ width: 4, alignSelf: 'stretch', minHeight: 30, borderRadius: 2, backgroundColor: color }} /> : <View style={{ width: 4, alignItems: 'center', overflow: 'visible' }}><View style={{ width: 16, alignItems: 'center' }}>{icon}</View></View>}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="body" numberOfLines={2}>{title || '(No title)'}</Text>
        {!!sub && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon icon={Location01Icon} size={12} color="ink3" />
            <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flex: 1 }}>{sub}</Text>
          </View>
        )}
      </View>
    </Pressable>
  )
}
