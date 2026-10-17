// The Tasks tab's calendar, Samsung Calendar-like: a month grid (swipe for the next or last month) with each day's
// events as coloured lines, and under it the picked day: all-day events, then events and reminders by time, then
// the to-dos due. Tap an event to edit it, + (or hold a day) to add one. Events are the phone's own calendars
// (lib/calendar.ts), so Samsung and Google Calendar show the same.
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, FadeIn, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Add01Icon, ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon, Layers01Icon, Location01Icon, Notification03Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { useTabBarInset } from '@/components/tab-bar'
import { calendarAccess, eventDays, useCalendars, useEvents, type PhoneEvent } from '@/lib/calendar'
import { reminderNext, useMinute, useReminders, type Reminder } from '@/lib/clock'
import { isoDay, useTodos } from '@/lib/tasks'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, Sheet, Text, haptic } from '@/ui'

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
  const [pickCals, setPickCals] = useState(false)
  const hidden = useHiddenCalendars()
  useEffect(() => { calendarAccess(true).then(setAccess) }, [])

  // Three months are drawn side by side (last, this, next) so a swipe shows the next one already there; events are
  // read for all three at once.
  const months = useMemo(() => [-1, 0, 1].map((n) => new Date(month.getFullYear(), month.getMonth() + n, 1)), [month])
  // Every month has a fixed place on an endless strip (its number counted from the month shown first), so a month's
  // grid is never handed a different month: swiping just slides the strip and mounts the next neighbour off screen.
  const [anchor] = useState(() => monthNo(month))
  const at = monthNo(month) - anchor
  const from = gridStart(months[0]).getTime()
  const to = new Date(gridStart(months[2]).getTime() + 42 * DAY).getTime()
  const events = useEvents(from, to, access === 'ok')
  const byDay = useMemo(() => {
    const m = new Map<number, PhoneEvent[]>()
    // Calendars switched off here are left out; the same event in several calendars (a holiday in two accounts'
    // "Holidays in India" and in "Hindu holidays") shows once.
    const seen = new Set<string>()
    for (const e of events ?? []) {
      if (hidden.has(e.calendar)) continue
      const key = `${e.title.trim().toLowerCase()}|${e.start}|${e.end}|${e.allDay}`
      if (seen.has(key)) continue
      seen.add(key)
      for (const d of eventDays(e)) m.set(d, [...(m.get(d) ?? []), e])
    }
    for (const l of m.values()) l.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
    return m
  }, [events, hidden])
  // Each day's lines: its events in their colours, then reminders (amber) and to-dos due (grey).
  const { todos } = useTodos()
  const reminders = useReminders().rows
  const lines = useMemo(() => {
    const m = new Map<number, string[]>()
    const push = (d: number, color: string) => m.set(d, [...(m.get(d) ?? []), color])
    for (const [d, l] of byDay) for (const e of l) push(d, e.color)
    for (const r of reminders ?? []) for (const d of reminderDays(r, from, to)) push(d, c.warning)
    for (const t of todos ?? []) {
      if (!t.due || t.status === 'done' || t.status === 'canceled') continue
      const [y, mo, dd] = t.due.split('-').map(Number)
      push(new Date(y, mo - 1, dd).getTime(), c.ink3)
    }
    return m
  }, [byDay, reminders, todos, from, to, c])

  // The pager: the strip sits at -at·W (this month in view). A swipe drags it from there and settles on a neighbour;
  // only then does the month change, and since each grid keeps its own place nothing on screen moves or swaps (before,
  // the slots were handed new months while the strip jumped back, and the two landed in different frames: a blink).
  const { width: W } = useWindowDimensions()
  const base = -at * W
  const tx = useSharedValue(base)
  const strip = useAnimatedStyle(() => ({ transform: [{ translateX: tx.get() }] }))
  const [box, setBox] = useState(0)
  const names = useAnimatedStyle(() => ({ transform: [{ translateX: (tx.get() / W) * box }] }))
  // A jump the strip didn't travel itself (Today, a rotation): put it there directly.
  useLayoutEffect(() => { if (Math.abs(tx.get() - base) > 1) tx.set(base) }, [base, tx])
  const shift = useCallback((n: number) => {
    haptic.tap()
    // Only the month changes; the picked day stays what you picked.
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1))
  }, [])
  const settle = { duration: 280, easing: Easing.out(Easing.cubic) }
  const go = (n: number) => tx.set(withTiming(base - n * W, settle, (done) => { if (done) runOnJS(shift)(n) }))
  const swipe = Gesture.Pan().activeOffsetX([-20, 20]).failOffsetY([-14, 14])
    .onUpdate((e) => { tx.set(base + e.translationX) })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > W * 0.2 || Math.abs(e.velocityX) > 500) {
        const n = e.translationX < 0 ? 1 : -1
        tx.set(withTiming(base - n * W, settle, (done) => { if (done) runOnJS(shift)(n) }))
      } else tx.set(withTiming(base, settle))
    })
  const goToday = () => { haptic.tap(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setPicked(today) }
  const add = useCallback((day: number) => { haptic.tap(); router.push({ pathname: '/event/[id]', params: { id: 'new', day: isoDay(new Date(day)) } }) }, [])
  const onPick = useCallback((day: number) => { haptic.tap(); setPicked(day) }, [])

  if (access === 'no' || access === 'missing') {
    return (
      <EmptyState
        art={<View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={Calendar03Icon} size={26} color="tube" /></View>}
        title={access === 'missing' ? 'Update Tubelight for the calendar' : 'Your calendar, here'}
        body={access === 'missing' ? 'This version can’t read the phone’s calendars yet.' : 'Tubelight shows and edits the calendars on this phone, the same ones Google Calendar syncs.'}
        action={access === 'no' ? <Button label="Allow calendar access" onPress={() => calendarAccess(true).then(setAccess)} /> : undefined}
      />
    )
  }

  const thisMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth()
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: inset + 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, height: 44 }}>
        {/* The month names ride the pager: a strip of last / this / next, moved in step with the grid. */}
        <View style={{ flex: 1, overflow: 'hidden' }} onLayout={(e) => setBox(e.nativeEvent.layout.width)} accessible accessibilityRole="header"
          accessibilityLabel={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>
          <Animated.View style={[{ height: 28 }, names]}>
            {months.map((m, i) => (
              <Text key={monthNo(m)} variant="headline" numberOfLines={1} style={{ position: 'absolute', left: (at - 1 + i) * box, width: box }}>
                {m.toLocaleDateString(undefined, { month: 'long' })}
                <Text variant="headline" color="ink3">{m.getFullYear() === now.getFullYear() ? '' : ` ${m.getFullYear()}`}</Text>
              </Text>
            ))}
          </Animated.View>
        </View>
        {(!thisMonth || picked !== today) && (
          <Pressable onPress={goToday} hitSlop={8} accessibilityRole="button" style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', backgroundColor: c.panel2, marginRight: 4 }}>
            <Text variant="label" color="ink2">Today</Text>
          </Pressable>
        )}
        <IconButton icon={Layers01Icon} size={36} iconSize={17} color={c.ink3} accessibilityLabel="Calendars to show" onPress={() => { haptic.tap(); setPickCals(true) }} />
        <IconButton icon={ArrowLeft01Icon} size={36} iconSize={18} color={c.ink3} accessibilityLabel="Last month" onPress={() => go(-1)} />
        <IconButton icon={ArrowRight01Icon} size={36} iconSize={18} color={c.ink3} accessibilityLabel="Next month" onPress={() => go(1)} />
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 8 }}>
        {WEEK.map((d, i) => <Text key={i} variant="caption" color={i > 4 ? 'danger' : 'ink3'} style={{ flex: 1, textAlign: 'center', paddingVertical: 6 }}>{d}</Text>)}
      </View>
      <GestureDetector gesture={swipe}>
        <View style={{ overflow: 'hidden', height: GRID_H }}>
          <Animated.View style={strip}>
            {months.map((m, i) => (
              <MonthGrid key={monthNo(m)} left={(at - 1 + i) * W} month={m} width={W} today={today} picked={picked} lines={lines} byDay={byDay} onPick={onPick} onHold={add} />
            ))}
          </Animated.View>
        </View>
      </GestureDetector>
      <Agenda day={picked} events={byDay.get(picked) ?? []} now={now} onAdd={() => add(picked)} />
      <CalendarsSheet open={pickCals} hidden={hidden} onClose={() => setPickCals(false)} />
    </ScrollView>
  )
}

const DAY = 86_400_000
/** A month's number (counted in months), for its place on the pager. */
const monthNo = (d: Date) => d.getFullYear() * 12 + d.getMonth()
const GRID_H = 6 * (CELL_H + 0.5)
/** The Monday on or before the 1st (six weeks are shown from there). */
function gridStart(month: Date) {
  const d = new Date(month)
  d.setDate(1 - ((d.getDay() + 6) % 7))
  return d
}

const MonthGrid = memo(function MonthGrid({ month, left, width, today, picked, lines, byDay, onPick, onHold }: {
  month: Date; left: number; width: number; today: number; picked: number; lines: Map<number, string[]>; byDay: Map<number, PhoneEvent[]>
  onPick: (d: number) => void; onHold: (d: number) => void
}) {
  const { c } = useTheme()
  const first = gridStart(month)
  return (
    <View style={{ position: 'absolute', left, width, paddingHorizontal: 8 }}>
      {[0, 1, 2, 3, 4, 5].map((w) => (
        <View key={w} style={{ flexDirection: 'row', borderTopWidth: 0.5, borderColor: c.line }}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + i)
            const t = d.getTime()
            return <DayCell key={i} day={t} date={d.getDate()} inMonth={d.getMonth() === month.getMonth()} weekend={i > 4}
              today={t === today} picked={t === picked} lines={lines.get(t)} count={byDay.get(t)?.length ?? 0} onPick={onPick} onHold={onHold} />
          })}
        </View>
      ))}
    </View>
  )
})

// Which of the phone's calendars to show here (kept on the phone; Google Calendar's own choice doesn't come through).
const HIDDEN_KEY = 'tl.calendar.hidden'
let hiddenNow = new Set<string>()
const hiddenSubs = new Set<() => void>()
AsyncStorage.getItem(HIDDEN_KEY).then((v) => { if (v) { hiddenNow = new Set(JSON.parse(v)); hiddenSubs.forEach((f) => f()) } }, () => {})
function setHidden(next: Set<string>) {
  hiddenNow = next
  hiddenSubs.forEach((f) => f())
  AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])).catch(() => {})
}
const useHiddenCalendars = () => useSyncExternalStore((f) => { hiddenSubs.add(f); return () => { hiddenSubs.delete(f) } }, () => hiddenNow)

function CalendarsSheet({ open, hidden, onClose }: { open: boolean; hidden: Set<string>; onClose: () => void }) {
  const { c } = useTheme()
  const cals = useCalendars(open).filter((x) => x.visible)
  const accounts = [...new Set(cals.map((x) => x.account))]
  return (
    <Sheet open={open} onClose={onClose} title="Calendars">
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {accounts.map((a) => (
          <View key={a}>
            <Text variant="overline" color="ink3" numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}>{a === 'local account' ? 'On this phone' : a}</Text>
            {cals.filter((x) => x.account === a).map((x) => {
              const on = !hidden.has(x.id)
              return (
                <Pressable key={x.id} onPress={() => { haptic.tap(); const n = new Set(hidden); if (on) n.add(x.id); else n.delete(x.id); setHidden(n) }}
                  android_ripple={{ color: c.wash }} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={x.name}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 12 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 7, backgroundColor: on ? x.color : undefined, borderWidth: on ? 0 : 1.5, borderColor: c.edge, alignItems: 'center', justifyContent: 'center' }}>
                    {on && <Icon icon={Tick02Icon} size={14} color="#fff" strokeWidth={2.4} />}
                  </View>
                  <Text variant="body" numberOfLines={1} style={{ flex: 1, color: on ? c.ink : c.ink3 }}>{x.name === a ? 'Main calendar' : x.name}</Text>
                </Pressable>
              )
            })}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  )
}

const DayCell = memo(function DayCell({ day, date, inMonth, weekend, today, picked, lines, count, onPick, onHold }: {
  day: number; date: number; inMonth: boolean; weekend: boolean; today: boolean; picked: boolean; lines?: string[]; count: number
  onPick: (d: number) => void; onHold: (d: number) => void
}) {
  const { c } = useTheme()
  // Today: a solid circle in the tube's colour. The picked day: a ring (around today's circle too, when it's today).
  return (
    <Pressable onPress={() => onPick(day)} onLongPress={() => onHold(day)} delayLongPress={320}
      accessibilityRole="button" accessibilityState={{ selected: picked }}
      accessibilityLabel={`${new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${count ? `, ${count} events` : ''}`}
      style={{ flex: 1, height: CELL_H, paddingTop: 4, gap: 2, opacity: inMonth ? 1 : 0.35 }}>
      {/* The day's number; today's circle and the picked ring are their own layers (a fill inside a bordered view, or one
          switched on later, drew square on Android). */}
      <View style={{ alignSelf: 'center', width: 28, height: 28, margin: 2 }}>
        {picked && <View pointerEvents="none" style={{ position: 'absolute', top: -3, left: -3, right: -3, bottom: -3, borderRadius: 17, borderWidth: 1.5, borderColor: today ? c.tube : c.ink2 }} />}
        {/* Mounted only for today: a fill switched on later on an existing view lost its roundness on Android. */}
        {today && <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: 28, height: 28, borderRadius: 14, backgroundColor: c.tube }} />}
        <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="caption" tabular style={{ color: today ? '#fff' : weekend ? c.danger : c.ink, fontWeight: today || picked ? '600' : '400' }}>{date}</Text>
        </View>
      </View>
      {/* One line per event, reminder and to-do due (the day's list below has the words). */}
      <View style={{ gap: 3, paddingHorizontal: 8, paddingTop: 2 }}>
        {lines?.slice(0, LINES).map((color, i) => <View key={i} style={{ height: 3, borderRadius: 1.5, backgroundColor: color }} />)}
      </View>
    </Pressable>
  )
}, (a, b) => a.day === b.day && a.today === b.today && a.picked === b.picked && a.inMonth === b.inMonth && a.count === b.count
  && a.onPick === b.onPick && a.onHold === b.onHold && (a.lines ?? []).join() === (b.lines ?? []).join())

/** Every local day (midnight ms) in [from, to) a reminder rings on, repeats included. */
function reminderDays(r: Reminder, from: number, to: number): number[] {
  if (r.done) return []
  const out: number[] = []
  const d = new Date(r.at)
  for (let i = 0; i < 400 && d.getTime() < to; i++) {
    if (d.getTime() >= from) out.push(midnight(d))
    if (!r.repeat) break
    if (r.repeat === 'daily') d.setDate(d.getDate() + 1)
    else if (r.repeat === 'weekdays') do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6)
    else if (r.repeat === 'weekly') d.setDate(d.getDate() + 7)
    else if (r.repeat === 'monthly') d.setMonth(d.getMonth() + 1)
    else d.setFullYear(d.getFullYear() + 1)
  }
  return out
}

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
