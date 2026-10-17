// Tasks: your to-dos by default; the header's two icons open the calendar and the clock (alarms, reminders and what
// teammates will come back to), and the icon of the open one turns into the to-dos icon to come back. Each view
// mounts the first time it's opened and stays mounted, so switching back is instant.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Add01Icon, AlarmClockIcon, ArrowDown01Icon, Calendar03Icon, CheckListIcon, Tag01Icon } from '@hugeicons/core-free-icons'

import { TabHeader } from '@/components/screen-header'
import { useTabBarInset } from '@/components/tab-bar'
import { CalendarView } from '@/components/tasks/calendar-view'
import { ClockView } from '@/components/tasks/clock-view'
import { LabelSheet } from '@/components/tasks/label-sheet'
import { TodoList, type GroupBy } from '@/components/tasks/todo-list'
import { dueLabel, refreshTasks, useLabels, useTodos, type Todo, type TodoStatus } from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Button, EmptyState, Icon, IconButton, IconSwap, Press, Reveal, Skeleton, Text, elevation, haptic, showContextMenu } from '@/ui'

type Mode = 'todos' | 'calendar' | 'clock'
const TITLES: Record<Mode, string> = { todos: 'Tasks', calendar: 'Calendar', clock: 'Clock' }
const GROUP_KEY = 'tl.tasks.groupBy'

export default function Tasks() {
  const [mode, setMode] = useState<Mode>('todos')
  const [seen, setSeen] = useState<Record<Mode, boolean>>({ todos: true, calendar: false, clock: false })
  const fade = useSharedValue(1)
  const shown = useAnimatedStyle(() => ({ opacity: fade.get() }))
  // An alarm's or reminder's notification opens the clock (tubelight://tasks?view=clock).
  const { view } = useLocalSearchParams<{ view?: string }>()
  const [linked, setLinked] = useState<string | undefined>(undefined)
  if (view !== linked) {
    setLinked(view)
    if (view === 'clock' || view === 'calendar') { setSeen((s) => ({ ...s, [view]: true })); setMode(view) }
  }
  const open = (m: Mode) => {
    haptic.tap()
    fade.set(0)
    fade.set(withTiming(1, { duration: motion.duration.fast, easing: motion.ease.smoothOut }))
    setSeen((s) => (s[m] ? s : { ...s, [m]: true }))
    setMode(m)
  }

  // Teammates add to-dos, alarms and follow-ups from chats: catch up whenever the tab comes into view.
  useFocusEffect(useCallback(() => { refreshTasks() }, []))

  // The calendar's and the clock's places: the open one shows the to-dos icon instead.
  const slot = (m: Mode, icon: typeof Calendar03Icon, label: string) => {
    const back = mode === m
    return (
      <IconButton variant="soft" round accessibilityLabel={back ? 'To-dos' : label} onPress={() => open(back ? 'todos' : m)}
        icon={back ? CheckListIcon : icon} />
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <TabHeader title={TITLES[mode]} right={<>{slot('calendar', Calendar03Icon, 'Calendar')}{slot('clock', AlarmClockIcon, 'Alarms and reminders')}</>} />
      <View style={{ flex: 1 }}>
        {(['todos', 'calendar', 'clock'] as const).map((m) => seen[m] && (
          <Animated.View key={m} style={[StyleSheet.absoluteFill, mode === m ? shown : { display: 'none' }]}>
            {m === 'todos' ? <Todos /> : m === 'calendar' ? <CalendarView /> : <ClockView />}
          </Animated.View>
        ))}
      </View>
    </View>
  )
}

function Todos() {
  const { c, scheme } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const { todos, error, offline, unsynced } = useTodos()
  const labels = useLabels()
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [refreshing, setRefreshing] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  useEffect(() => { AsyncStorage.getItem(GROUP_KEY).then((g) => { if (g === 'label' || g === 'status') setGroupBy(g) }, () => {}) }, [])
  const group = (g: GroupBy) => { setGroupBy(g); AsyncStorage.setItem(GROUP_KEY, g).catch(() => {}) }

  const live = (todos ?? []).filter((t) => t.status !== 'done' && t.status !== 'canceled')
  const dueToday = live.filter((t) => t.due && dueLabel(t.due).today).length
  const overdue = live.filter((t) => t.due && dueLabel(t.due).overdue).length
  // Offline, changes wait on the phone and go out when the server's back.
  const sync = offline ? (unsynced ? `Offline, ${unsynced} ${unsynced === 1 ? 'change' : 'changes'} to sync` : 'Offline') : unsynced ? 'Syncing…' : null
  const summary = [`${live.length} open`, dueToday && `${dueToday} due today`, overdue && `${overdue} overdue`, sync].filter(Boolean).join(' · ')
  const add = useCallback((o: { status?: TodoStatus; label?: string } = {}) => {
    haptic.tap()
    router.push({ pathname: '/todo/[id]', params: { id: 'new', ...o } })
  }, [])
  const onOpen = useCallback((t: Todo) => router.push({ pathname: '/todo/[id]', params: { id: t.id } }), [])

  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      contentContainerStyle={{ paddingBottom: inset + 88, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshTasks(); setRefreshing(false) }}
        tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}
    >
      {!!todos?.length && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 10 }}>
          <Text variant="footnote" color="ink3" style={{ flex: 1 }} numberOfLines={1}>{summary}</Text>
          <IconButton icon={Tag01Icon} size={32} iconSize={16} color={c.ink3} accessibilityLabel="Labels" onPress={() => { haptic.tap(); setLabelsOpen(true) }} />
          <GroupButton value={groupBy} onChange={group} />
        </View>
      )}
      <Reveal ready={todos !== null || !!error} style={{ flexGrow: 1 }} skeleton={<Rows />}>
        {todos?.length ? (
          <TodoList todos={todos} labels={labels} groupBy={groupBy} teammate={ws.teammate} projects={ws.projects} onOpen={onOpen} />
        ) : (
          <EmptyState
            art={<View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}><Icon icon={CheckListIcon} size={26} color="tube" /></View>}
            title={error ? 'Unable to load your to-dos' : 'A clear list'}
            body={error ?? (sync || 'Add what’s on your plate, or tell a teammate “add renewing my passport to my to-dos”.')}
            action={<Button label={error ? 'Try again' : 'Add a to-do'} onPress={() => (error ? refreshTasks() : add())} />}
          />
        )}
      </Reveal>
    </ScrollView>
    {/* New to-do: one button, bottom right, just above the tab bar. */}
    {!!todos?.length && (
      <Press radius={28} smoothing={0} onPress={() => add()} accessibilityLabel="New to-do" outerStyle={[{ position: 'absolute', right: 20, bottom: inset + 6 }, elevation(scheme)]}
        style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center', backgroundColor: c.ink }}>
        <Icon icon={Add01Icon} size={24} color={c.canvas} strokeWidth={2} />
      </Press>
    )}
    <LabelSheet open={labelsOpen} onClose={() => setLabelsOpen(false)} />
    </View>
  )
}

/** Group by status or by label, in a menu grown out of the button. */
function GroupButton({ value, onChange }: { value: GroupBy; onChange: (g: GroupBy) => void }) {
  const ref = useRef<View>(null)
  const label = value === 'status' ? 'By status' : 'By label'
  const face = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 32 }}>
      <IconSwap swapKey={value}><Text variant="footnote" color="ink2">{label}</Text></IconSwap>
      <Icon icon={ArrowDown01Icon} size={13} color="ink3" strokeWidth={2} />
    </View>
  )
  return (
    <View ref={ref} collapsable={false}>
      <Press radius={10} static accessibilityLabel={`Grouped ${label.toLowerCase()}. Change`}
        onPress={() => showContextMenu(ref.current, face, [
          { label: 'By status', checked: value === 'status', onPress: () => onChange('status') },
          { label: 'By label', checked: value === 'label', onPress: () => onChange('label') },
        ])}>
        {face}
      </Press>
    </View>
  )
}

function Rows() {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 22, gap: 22 }} accessible accessibilityLabel="Loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Skeleton width={20} height={20} radius={16} />
          <Skeleton width={`${50 + ((i * 17) % 40)}%`} height={12} />
        </View>
      ))}
    </View>
  )
}
