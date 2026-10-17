// The Tasks tab's clock. On top, the next alarm in big numerals over the next 24 hours as a track (now lit in the
// tube's colour, alarms and reminders marked where they fall). Then alarms as full-width cards, each with its
// days and a switch; reminders in one card grouped Overdue / Today / Tomorrow / Later (tap the ring when it's done);
// and what teammates will come back to.
import { router } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { Add01Icon, Delete02Icon, Notification03Icon, RepeatIcon, Tick02Icon } from '@hugeicons/core-free-icons'

import { useTabBarInset } from '@/components/tab-bar'
import {
  alarmNext, daysText, deleteAlarm, deleteReminder, finishReminder, nextAt, reminderNext, syncClock, untilText, updateAlarm,
  useAlarms, useMinute, useReminders, type Alarm, type Reminder,
} from '@/lib/clock'
import { Phone } from '@/lib/phone'
import { refreshTasks, useFollowups, type Followup } from '@/lib/tasks'
import { fonts, motion, useTheme } from '@/theme'
import { Icon, IconButton, IconSwap, Notice, Squircle, Text, Toggle, haptic, showContextMenu, toast } from '@/ui'

import { FollowupList, FollowupSheet } from './followups'

const layout = LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)
const DAY_MS = 86_400_000
const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** "7:00" and "AM" apart, the way clocks print them. */
function clockParts(d: Date) {
  const s = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const ap = s.match(/\s?([AaPp]\.?\s?[Mm]\.?)$/)
  return ap ? { main: s.slice(0, ap.index), suffix: ap[1].toUpperCase() } : { main: s, suffix: '' }
}
const ofTime = (time: string) => { const [h, m] = time.split(':').map(Number); return new Date(2000, 0, 1, h, m) }

/** "Today", "Tomorrow", "Fri 17 Oct" */
function dayWord(d: Date, now: Date) {
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY_MS)
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function ClockView() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const now = useMinute()
  const alarms = useAlarms().rows ?? []
  const reminders = useReminders().rows ?? []
  const follow = useFollowups()
  const [fsheet, setFsheet] = useState<{ open: boolean; f: Followup | null; n: number }>({ open: false, f: null, n: 0 })
  const [refreshing, setRefreshing] = useState(false)
  const onFollow = useCallback((f: Followup) => setFsheet((s) => ({ open: true, f, n: s.n + 1 })), [])

  const rings = alarms.map((a) => ({ a, at: alarmNext(a, now) })).filter((x): x is { a: Alarm; at: Date } => !!x.at).sort((x, y) => x.at.getTime() - y.at.getTime())
  const open = reminders.filter((r) => !r.done).map((r) => ({ r, at: reminderNext(r, now) })).sort((x, y) => x.at.getTime() - y.at.getTime())
  const done = reminders.filter((r) => r.done).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? '')).slice(0, 20)
  // Alarms can't show over the lock screen until it's allowed (Android 14+).
  const blocked = alarms.some((a) => a.enabled) && Phone?.canRing && !Phone.canRing()
  const newAlarm = () => { haptic.tap(); router.push({ pathname: '/alarm/[id]', params: { id: 'new' } }) }
  const newReminder = () => { haptic.tap(); router.push({ pathname: '/reminder/[id]', params: { id: 'new' } }) }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: inset + 24, paddingHorizontal: 16, gap: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await Promise.all([syncClock(), refreshTasks()]); setRefreshing(false) }}
        tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}>
      <Hero next={rings[0]} now={now} marks={[
        ...rings.filter((x) => x.at.getTime() - now.getTime() < DAY_MS).map((x) => ({ at: x.at, kind: 'alarm' as const, key: x.a.id })),
        ...open.filter((x) => x.at.getTime() >= now.getTime() && x.at.getTime() - now.getTime() < DAY_MS).map((x) => ({ at: x.at, kind: 'reminder' as const, key: x.r.id })),
      ]} />
      {blocked && (
        <Notice tone="warning" title="Let alarms ring over the lock screen" body="Android asks once: allow full-screen alerts for Tubelight."
          action={{ label: 'Allow', onPress: () => Phone?.openRingSettings() }} />
      )}

      <Section title="Alarms" count={rings.length ? `${rings.length} on` : undefined} onAdd={newAlarm} add="New alarm" />
      <AlarmGrid alarms={alarms} now={now} onAdd={newAlarm} />

      <Section title="Reminders" count={open.length ? String(open.length) : undefined} onAdd={newReminder} add="New reminder" />
      <Reminders open={open} done={done} now={now} onAdd={newReminder} />

      {!!(follow.pending?.length || follow.done.length) && (
        <>
          <Section title="Teammates will come back" count={follow.pending?.length ? String(follow.pending.length) : undefined} />
          <Squircle style={{ borderRadius: 24, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, paddingBottom: 10, overflow: 'hidden' }}>
            <FollowupList pending={follow.pending ?? []} done={follow.done} onOpen={onFollow} />
          </Squircle>
        </>
      )}
      <FollowupSheet key={`f${fsheet.n}`} open={fsheet.open} f={fsheet.f} onClose={() => setFsheet((s) => ({ ...s, open: false }))} />
    </ScrollView>
  )
}

function Section({ title, count, onAdd, add }: { title: string; count?: string; onAdd?: () => void; add?: string }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4, marginTop: 18, minHeight: 36 }}>
      <Text variant="heading" accessibilityRole="header">{title}</Text>
      {count && <Text variant="label" color="ink3" tabular>{count}</Text>}
      <View style={{ flex: 1 }} />
      {onAdd && <IconButton icon={Add01Icon} variant="soft" round size={34} iconSize={16} color={c.ink2} accessibilityLabel={add ?? 'Add'} onPress={onAdd} />}
    </View>
  )
}

/** The next alarm, big (or the time now), over today as a line: the part gone filled, what's left said. */
function Hero({ next, now, marks }: { next?: { a: Alarm; at: Date }; now: Date; marks: { at: Date; kind: 'alarm' | 'reminder'; key: string }[] }) {
  const { c } = useTheme()
  const t = clockParts(next?.at ?? now)
  return (
    <Squircle style={{ borderRadius: 28, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 20, paddingBottom: 16, marginTop: 4 }}>
      <Text variant="overline" color={next ? 'tube' : 'ink3'}>
        {next ? ['Next alarm', dayWord(next.at, now), next.a.label].filter(Boolean).join(' · ') : 'Now'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={{ fontFamily: fonts.regular, fontSize: 64, lineHeight: 74, letterSpacing: -2.5, color: c.ink, fontVariant: ['tabular-nums'] }}>{t.main}</Text>
        {!!t.suffix && <Text variant="headline" color="ink2">{t.suffix}</Text>}
      </View>
      <DayLine now={now} marks={marks} />
    </Squircle>
  )
}

/** Today, midnight to midnight: filled up to now (the lit dot), today's alarms as bars and reminders as dots, the hours
 *  every six under it, and how much of the day is left. */
function DayLine({ now, marks }: { now: Date; marks: { at: Date; kind: 'alarm' | 'reminder'; key: string }[] }) {
  const { c } = useTheme()
  const [w, setW] = useState(0)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const x = (ms: number) => ((ms - start) / DAY_MS) * w
  const left = Math.max(0, Math.round((start + DAY_MS - now.getTime()) / 60_000))
  const today = marks.filter((m) => m.at.getTime() < start + DAY_MS)
  return (
    <View style={{ marginTop: 14, gap: 8 }}>
      <View style={{ height: 18 }} onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {w > 0 && (
          <>
            <View style={{ position: 'absolute', left: 0, right: 0, top: 8, height: 2, borderRadius: 1, backgroundColor: c.line }} />
            <View style={{ position: 'absolute', left: 0, width: x(now.getTime()), top: 8, height: 2, borderRadius: 1, backgroundColor: c.tube, opacity: 0.55 }} />
            {[6, 12, 18].map((h) => <View key={h} style={{ position: 'absolute', left: x(start + h * 3_600_000), top: 5, width: 1, height: 8, backgroundColor: c.edge }} />)}
            {today.map((m) => m.kind === 'alarm'
              ? <View key={m.key} style={{ position: 'absolute', left: x(m.at.getTime()) - 2, top: 1, width: 4, height: 16, borderRadius: 2, backgroundColor: c.ink }} />
              : <View key={m.key} style={{ position: 'absolute', left: x(m.at.getTime()) - 4, top: 5, width: 8, height: 8, borderRadius: 4, backgroundColor: c.warning, borderWidth: 2, borderColor: c.panel }} />)}
            <View style={{ position: 'absolute', left: x(now.getTime()) - 7, top: 2, width: 14, height: 14, borderRadius: 7, backgroundColor: c.tubeSoft }} />
            <View style={{ position: 'absolute', left: x(now.getTime()) - 4, top: 5, width: 8, height: 8, borderRadius: 4, backgroundColor: c.tube }} />
          </>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ flex: 1, fontSize: 11, lineHeight: 14, color: c.ink4 }}>12 am</Text>
        <Text variant="caption" color="ink2" tabular>{`${Math.floor(left / 60)} h ${left % 60} min left today`}</Text>
        <Text style={{ flex: 1, fontSize: 11, lineHeight: 14, color: c.ink4, textAlign: 'right' }}>12 am</Text>
      </View>
    </View>
  )
}

function AlarmGrid({ alarms, now, onAdd }: { alarms: Alarm[]; now: Date; onAdd: () => void }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const cell = width - 32
  return (
    <View style={{ gap: 10 }}>
      {alarms.map((a) => <AlarmCard key={a.id} a={a} now={now} width={cell} />)}
      {!alarms.length && (
        <Pressable onPress={onAdd} accessibilityRole="button" accessibilityLabel="New alarm"
          style={{ width: cell, minHeight: 88, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.edge, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Icon icon={Add01Icon} size={20} color="ink3" />
          <Text variant="footnote" color="ink3">Your first alarm</Text>
        </Pressable>
      )}
    </View>
  )
}

function AlarmCard({ a, now, width }: { a: Alarm; now: Date; width: number }) {
  const { c } = useTheme()
  const ref = useRef<View>(null)
  const next = alarmNext(a, now)
  const on = !!next
  const t = clockParts(ofTime(a.time))
  const toggle = (v: boolean) => {
    if (v) haptic.success()
    else haptic.tap()
    updateAlarm(a, { enabled: v })
    const at = v && alarmNext({ ...a, enabled: true, at: a.days.length ? null : nextAt(a.time) })
    if (at) toast({ title: `Alarm ${untilText(at)}` })
  }
  const edit = () => router.push({ pathname: '/alarm/[id]', params: { id: a.id } })
  const card = (lifted?: boolean) => (
    <Squircle style={{ width, borderRadius: 24, padding: 16, gap: 10, backgroundColor: c.panel, borderWidth: 1, borderColor: lifted ? c.edge : c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, minWidth: 0, opacity: on ? 1 : 0.45 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
            <Text style={{ fontFamily: fonts.regular, fontSize: 42, lineHeight: 50, letterSpacing: -1.5, color: c.ink, fontVariant: ['tabular-nums'] }}>{t.main}</Text>
            {!!t.suffix && <Text variant="caption" color="ink2">{t.suffix}</Text>}
          </View>
          <Text variant="footnote" color="ink2" numberOfLines={1}>{a.label || (a.days.length ? daysText(a.days) : 'Alarm')}</Text>
        </View>
        <Toggle value={on} onChange={toggle} accessibilityLabel={`Alarm ${t.main} ${t.suffix}`} />
      </View>
      {a.days.length ? (
        <View style={{ flexDirection: 'row', gap: 12, opacity: on ? 1 : 0.45 }}>
          {LETTERS.map((l, i) => (
            <Text key={i} style={{ fontSize: 12, lineHeight: 16, fontFamily: a.days.includes(i) ? fonts.semibold : fonts.regular, color: a.days.includes(i) ? (i > 4 ? c.danger : c.ink) : c.ink4 }}>{l}</Text>
          ))}
        </View>
      ) : (
        <Text variant="caption" color={on ? 'tube' : 'ink4'}>{on && next ? `Once · ${dayWord(next, now)}` : 'Once · off'}</Text>
      )}
    </Squircle>
  )
  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={edit} delayLongPress={320} accessibilityRole="button" accessibilityLabel={`Alarm ${t.main} ${t.suffix}, ${daysText(a.days)}, ${on ? 'on' : 'off'}`}
          onLongPress={() => showContextMenu(ref.current, card(true), [
            { label: on ? 'Turn off' : 'Turn on', onPress: () => toggle(!on) },
            { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => { haptic.warning(); deleteAlarm(a.id) } },
          ])}>
          {card()}
        </Pressable>
      </View>
    </Animated.View>
  )
}

function Reminders({ open, done, now, onAdd }: { open: { r: Reminder; at: Date }[]; done: Reminder[]; now: Date; onAdd: () => void }) {
  const { c } = useTheme()
  const [showDone, setShowDone] = useState(false)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const group = (at: Date) => at < now ? 'Overdue' : at.getTime() < today + DAY_MS ? 'Today' : at.getTime() < today + 2 * DAY_MS ? 'Tomorrow' : 'Later'
  const groups = ['Overdue', 'Today', 'Tomorrow', 'Later'].map((g) => ({ g, rows: open.filter((x) => group(x.at) === g) })).filter((x) => x.rows.length)
  return (
    <Squircle style={{ borderRadius: 24, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, paddingVertical: 6, overflow: 'hidden' }}>
      {groups.map(({ g, rows }) => (
        <Animated.View key={g} layout={layout}>
          <Text variant="overline" color={g === 'Overdue' ? 'danger' : 'ink3'} style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2 }}>{g}</Text>
          {rows.map(({ r, at }) => <ReminderRow key={r.id} r={r} at={at} now={now} />)}
        </Animated.View>
      ))}
      {!open.length && (
        <Pressable onPress={onAdd} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={Notification03Icon} size={17} color="ink3" />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium">Nothing to be reminded of</Text>
            <Text variant="footnote" color="ink3">Add one, or tell a teammate “remind me at 6 to call Mom”.</Text>
          </View>
        </Pressable>
      )}
      {done.length > 0 && (
        <Pressable onPress={() => { haptic.tap(); setShowDone((s) => !s) }} accessibilityRole="button" accessibilityState={{ expanded: showDone }}
          style={{ paddingHorizontal: 16, height: 40, justifyContent: 'center', borderTopWidth: open.length ? 0.5 : 0, borderColor: c.line, marginTop: 6 }}>
          <Text variant="footnote" color="ink3">{showDone ? 'Hide done' : `Done · ${done.length}`}</Text>
        </Pressable>
      )}
      {showDone && done.map((r) => <ReminderRow key={r.id} r={r} at={new Date(r.at)} now={now} />)}
    </Squircle>
  )
}

function ReminderRow({ r, at, now }: { r: Reminder; at: Date; now: Date }) {
  const { c } = useTheme()
  const ref = useRef<View>(null)
  const late = !r.done && at < now
  const tick = () => { if (!r.done) haptic.success(); else haptic.tap(); finishReminder(r) }
  const edit = () => router.push({ pathname: '/reminder/[id]', params: { id: r.id } })
  const row = (lifted?: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: lifted ? c.panel : undefined, borderRadius: lifted ? 16 : 0 }}>
      <View style={{ width: 54 }}>
        <Text variant="bodyMedium" tabular color={late ? 'danger' : r.done ? 'ink3' : 'ink'}>{clockParts(at).main}</Text>
        <Text variant="caption" color="ink3">{clockParts(at).suffix || ' '}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="body" color={r.done ? 'ink3' : 'ink'} numberOfLines={2} style={r.done ? { textDecorationLine: 'line-through' } : undefined}>{r.title}</Text>
        {(!!r.repeat || !!r.notes || at.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime()) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {at.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime() && <Text variant="footnote" color="ink3">{dayWord(at, now)}</Text>}
            {!!r.repeat && <Icon icon={RepeatIcon} size={12} color="ink3" />}
            {!!r.notes && <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flex: 1 }}>{r.notes.replace(/\s+/g, ' ')}</Text>}
          </View>
        )}
      </View>
      <Pressable onPress={tick} hitSlop={12} accessibilityRole="checkbox" accessibilityState={{ checked: r.done }} accessibilityLabel={r.done ? 'Not done' : 'Done'}>
        <IconSwap swapKey={String(r.done)}>
          <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: r.done ? 0 : 1.5, borderColor: late ? c.danger : c.edge,
            backgroundColor: r.done ? '#22a55b' : undefined, alignItems: 'center', justifyContent: 'center' }}>
            {r.done && <Icon icon={Tick02Icon} size={14} color="#fff" strokeWidth={2.4} />}
          </View>
        </IconSwap>
      </Pressable>
    </View>
  )
  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={edit} delayLongPress={320} android_ripple={{ color: c.wash }} accessibilityRole="button" accessibilityLabel={`${r.title}, ${dayWord(at, now)} ${clockParts(at).main}`}
          onLongPress={() => showContextMenu(ref.current, row(true), [
            { label: r.done ? 'Not done' : 'Done', icon: Tick02Icon, onPress: tick },
            { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => { haptic.warning(); deleteReminder(r.id) } },
          ])}>
          {row()}
        </Pressable>
      </View>
    </Animated.View>
  )
}
