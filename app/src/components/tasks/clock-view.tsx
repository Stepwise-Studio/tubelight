// The Tasks tab's clock: when the next alarm rings, your alarms (big times with a switch, Samsung Clock-like),
// reminders (overdue and today first; tap the circle when it's done), and what teammates will come back to.
import { router } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { Add01Icon, AlarmClockIcon, Delete02Icon, Edit02Icon, Notification03Icon, RepeatIcon, Tick02Icon } from '@hugeicons/core-free-icons'

import { Phone } from '@/lib/phone'
import {
  alarmNext, daysText, deleteAlarm, nextAt, deleteReminder, finishReminder, reminderNext, untilText, updateAlarm, useAlarms, useMinute, useReminders,
  syncClock, type Alarm, type Reminder,
} from '@/lib/clock'
import { refreshTasks, useFollowups, type Followup } from '@/lib/tasks'
import { useTabBarInset } from '@/components/tab-bar'
import { fonts, motion, useTheme } from '@/theme'
import { Icon, IconButton, IconSwap, Notice, Text, Toggle, haptic, showContextMenu, toast } from '@/ui'

import { FollowupList, FollowupSheet } from './followups'

const layout = LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)

export function ClockView() {
  const { c } = useTheme()
  const inset = useTabBarInset()
  const now = useMinute()
  const alarms = useAlarms().rows ?? []
  const reminders = useReminders().rows ?? []
  const follow = useFollowups()
  const [fsheet, setFsheet] = useState<{ open: boolean; f: Followup | null; n: number }>({ open: false, f: null, n: 0 })
  const [showDone, setShowDone] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const onFollow = useCallback((f: Followup) => setFsheet((s) => ({ open: true, f, n: s.n + 1 })), [])

  const next = alarms.map((a) => ({ a, at: alarmNext(a, now) })).filter((x): x is { a: Alarm; at: Date } => !!x.at).sort((x, y) => x.at.getTime() - y.at.getTime())[0]
  const open = reminders.filter((r) => !r.done).map((r) => ({ r, at: reminderNext(r, now) })).sort((x, y) => x.at.getTime() - y.at.getTime())
  const done = reminders.filter((r) => r.done).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? '')).slice(0, 20)
  // Alarms can't show over the lock screen until it's allowed (Android 14+).
  const blocked = alarms.some((a) => a.enabled) && Phone?.canRing && !Phone.canRing()

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: inset + 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await Promise.all([syncClock(), refreshTasks()]); setRefreshing(false) }}
        tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}>
      <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 4, gap: 2 }}>
        <IconSwap swapKey={next ? `${next.a.id}${next.at.getTime()}` : 'none'}>
          <Text variant="headline">{next ? `Alarm ${untilText(next.at, now)}` : 'No alarms on'}</Text>
        </IconSwap>
        <Text variant="footnote" color="ink3">
          {next ? next.at.toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : 'Add one below, or ask a teammate “wake me at 6:30”.'}
        </Text>
      </View>
      {blocked && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <Notice tone="warning" title="Let alarms ring over the lock screen" body="Android asks once: allow full-screen alerts for Tubelight."
            action={{ label: 'Allow', onPress: () => Phone?.openRingSettings() }} />
        </View>
      )}

      <Header title="Alarms" onAdd={() => router.push({ pathname: '/alarm/[id]', params: { id: 'new' } })} />
      {alarms.map((a) => <AlarmRow key={a.id} a={a} now={now} />)}
      {!alarms.length && <Empty icon={AlarmClockIcon} text="No alarms yet" />}

      <Header title="Reminders" onAdd={() => router.push({ pathname: '/reminder/[id]', params: { id: 'new' } })} />
      {open.map(({ r, at }) => <ReminderRow key={r.id} r={r} at={at} now={now} />)}
      {!open.length && <Empty icon={Notification03Icon} text="Nothing to be reminded of" />}
      {done.length > 0 && (
        <Pressable onPress={() => { haptic.tap(); setShowDone((s) => !s) }} accessibilityRole="button" style={{ paddingHorizontal: 20, height: 40, justifyContent: 'center' }}>
          <Text variant="footnote" color="ink3">{showDone ? 'Hide done' : `${done.length} done`}</Text>
        </Pressable>
      )}
      {showDone && done.map((r) => <ReminderRow key={r.id} r={r} at={new Date(r.at)} now={now} />)}

      {!!(follow.pending?.length || follow.done.length) && (
        <>
          <Header title="Teammates will come back" />
          <FollowupList pending={follow.pending ?? []} done={follow.done} onOpen={onFollow} />
        </>
      )}
      <FollowupSheet key={`f${fsheet.n}`} open={fsheet.open} f={fsheet.f} onClose={() => setFsheet((s) => ({ ...s, open: false }))} />
    </ScrollView>
  )
}

function Header({ title, onAdd }: { title: string; onAdd?: () => void }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, marginTop: 18, minHeight: 40 }}>
      <Text variant="overline" color="ink3" style={{ flex: 1 }} accessibilityRole="header">{title}</Text>
      {onAdd && <IconButton icon={Add01Icon} size={34} iconSize={16} color={c.ink3} accessibilityLabel={`New ${title.toLowerCase().replace(/s$/, '')}`} onPress={() => { haptic.tap(); onAdd() }} />}
    </View>
  )
}

function Empty({ icon, text }: { icon: typeof AlarmClockIcon; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 8 }}>
      <Icon icon={icon} size={16} color="ink4" />
      <Text variant="footnote" color="ink4">{text}</Text>
    </View>
  )
}

/** "7:00" and "AM" apart, the way clocks print them. */
function clockParts(time: string) {
  const [h, m] = time.split(':').map(Number)
  const s = new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const ap = s.match(/\s?([AaPp]\.?[Mm]\.?)$/)
  return ap ? { main: s.slice(0, ap.index), suffix: ap[1] } : { main: s, suffix: '' }
}

function AlarmRow({ a, now }: { a: Alarm; now: Date }) {
  const { c } = useTheme()
  const ref = useRef<View>(null)
  const on = !!alarmNext(a, now)
  const { main, suffix } = clockParts(a.time)
  const toggle = (v: boolean) => {
    if (v) haptic.success()
    else haptic.tap()
    updateAlarm(a, { enabled: v })
    const at = v && alarmNext({ ...a, enabled: true, at: a.days.length ? null : nextAt(a.time) })
    if (at) toast({ title: `Alarm ${untilText(at)}` })
  }
  const hold = () => showContextMenu(ref.current, row(true), [
    { label: 'Edit', icon: Edit02Icon, onPress: () => router.push({ pathname: '/alarm/[id]', params: { id: a.id } }) },
    { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => { haptic.warning(); deleteAlarm(a.id) } },
  ])
  const row = (lifted?: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 12,
      backgroundColor: lifted ? c.panel : undefined, borderRadius: lifted ? 18 : 0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
          <Text style={{ fontFamily: fonts.regular, fontSize: 40, lineHeight: 46, letterSpacing: -1, color: on ? c.ink : c.ink3, fontVariant: ['tabular-nums'] }}>{main}</Text>
          {!!suffix && <Text variant="label" color={on ? 'ink2' : 'ink3'}>{suffix}</Text>}
        </View>
        <Text variant="footnote" color="ink3" numberOfLines={1}>{[a.label, daysText(a.days)].filter(Boolean).join(' · ')}</Text>
      </View>
      {!lifted && <Toggle value={on} onChange={toggle} accessibilityLabel={`Alarm ${a.time}`} />}
    </View>
  )
  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: a.id } })} onLongPress={hold} delayLongPress={320}
          android_ripple={{ color: c.wash }} accessibilityRole="button" accessibilityLabel={`Alarm ${main} ${suffix}, ${daysText(a.days)}, ${on ? 'on' : 'off'}`}>
          {row()}
        </Pressable>
      </View>
    </Animated.View>
  )
}

/** "Today 6:00 PM", "Tomorrow 9:00 AM", "Fri 14 Oct, 9:00 AM" */
export function whenText(d: Date, now = new Date()) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.round((day - today) / 86_400_000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (diff === 0) return `Today ${time}`
  if (diff === 1) return `Tomorrow ${time}`
  if (diff === -1) return `Yesterday ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`
}

function ReminderRow({ r, at, now }: { r: Reminder; at: Date; now: Date }) {
  const { c } = useTheme()
  const ref = useRef<View>(null)
  const late = !r.done && at < now
  const tick = () => { if (!r.done) haptic.success(); else haptic.tap(); finishReminder(r) }
  const hold = () => showContextMenu(ref.current, row(true), [
    { label: 'Edit', icon: Edit02Icon, onPress: () => router.push({ pathname: '/reminder/[id]', params: { id: r.id } }) },
    { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => { haptic.warning(); deleteReminder(r.id) } },
  ])
  const row = (lifted?: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 11,
      backgroundColor: lifted ? c.panel : undefined, borderRadius: lifted ? 16 : 0 }}>
      <Pressable onPress={tick} hitSlop={12} accessibilityRole="checkbox" accessibilityState={{ checked: r.done }} accessibilityLabel={r.done ? 'Not done' : 'Done'} style={{ paddingTop: 1 }}>
        <IconSwap swapKey={String(r.done)}>
          <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: r.done ? 0 : 1.5, borderColor: late ? c.danger : c.ink4,
            backgroundColor: r.done ? '#22a55b' : undefined, alignItems: 'center', justifyContent: 'center' }}>
            {r.done && <Icon icon={Tick02Icon} size={13} color="#fff" strokeWidth={2.4} />}
          </View>
        </IconSwap>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text variant="body" color={r.done ? 'ink3' : 'ink'} numberOfLines={2}>{r.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text variant="footnote" color={late ? 'danger' : 'ink3'}>{whenText(at, now)}</Text>
          {!!r.repeat && <Icon icon={RepeatIcon} size={12} color="ink3" />}
          {!!r.notes && <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flex: 1 }}>· {r.notes.replace(/\s+/g, ' ')}</Text>}
        </View>
      </View>
    </View>
  )
  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={() => router.push({ pathname: '/reminder/[id]', params: { id: r.id } })} onLongPress={hold} delayLongPress={320}
          android_ripple={{ color: c.wash }} accessibilityRole="button" accessibilityLabel={`${r.title}, ${whenText(at, now)}`}>
          {row()}
        </Pressable>
      </View>
    </Animated.View>
  )
}
