// The to-do board as a list: grouped by status (Backlog, Todo, In progress, Done, Canceled folded) or by label (each
// label's to-dos in status order, then "No label"). Tap a to-do to open it; double tap to move it on (to do → in
// progress → done; a finished one opens again); hold it for every status and Delete, in place.
import { memo, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeOut, LinearTransition, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { ArrowDown01Icon, Calendar03Icon, Delete02Icon } from '@hugeicons/core-free-icons'

import { STATUSES, deleteTodo, dueLabel, nextStatus, statusLabel, updateTodo, type Label, type Todo, type TodoStatus } from '@/lib/tasks'
import type { Project, Teammate } from '@/lib/types'
import { motion, useTheme } from '@/theme'
import { Icon, IconSwap, Text, TeammateAvatar, haptic, showContextMenu, toast, type MenuItem } from '@/ui'

import { PriorityGlyph, StatusGlyph } from './glyphs'

export type GroupBy = 'status' | 'label'
const ORDER: Record<TodoStatus, number> = { backlog: 0, todo: 1, doing: 2, done: 3, canceled: 4 }
const MONTH_MS = 30 * 86_400_000
/** Notes as one quiet line: no list marks, checkboxes, quotes or code fences. */
const plain = (s: string) => s.replace(/^\s*(?:[-*>]|```)\s?(?:\[[ xX]\]\s?)?/gm, '').replace(/\s+/g, ' ').trim()
const layout = LinearTransition.duration(280).easing(motion.ease.smoothOut)
/** Rows that appear (a group opened, the first load) fade in together: one native fade, no per-row timing. */
const ENTER = FadeIn.duration(200)

interface Group { key: string; title: string; glyph: React.ReactNode; rows: Todo[]; foldable: boolean }

export function TodoList({ todos, labels, groupBy, teammate, projects, onOpen }: {
  todos: Todo[]; labels: Label[]; groupBy: GroupBy; teammate: (id: string) => Teammate | undefined; projects: Project[]
  onOpen: (t: Todo) => void
}) {
  // Folded by default: canceled (by status), finished ones stay in their label's group, dimmed, at the end.
  const [fold, setFold] = useState<Record<string, boolean>>({ canceled: true })
  const [since] = useState(() => new Date(Date.now() - MONTH_MS).toISOString())
  // Done more than a month ago drops off the board.
  const live = todos.filter((t) => t.status !== 'done' || (t.completed_at ?? t.updated_at) >= since)
  const byLabel = new Map(labels.map((l) => [l.id, l]))

  let groups: Group[]
  if (groupBy === 'status') {
    groups = STATUSES.map(({ value }) => {
      let rows = live.filter((t) => t.status === value)
      if (value === 'done') rows = rows.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
      return { key: value, title: statusLabel(value), glyph: <StatusGlyph status={value} size={16} />, rows,
        foldable: true }
    }).filter((g) => g.rows.length || g.key === 'todo' || g.key === 'doing')
  } else {
    const inOrder = (rows: Todo[]) => rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.sort - b.sort)
    groups = labels.map((l) => ({
      key: l.id, title: l.name, glyph: <LabelDot color={l.color} size={10} />, foldable: true,
      rows: inOrder(live.filter((t) => t.labels?.includes(l.id))),
    }))
    const none = inOrder(live.filter((t) => !t.labels?.some((id) => byLabel.has(id))))
    if (none.length) groups.push({ key: '_none', title: 'No label', glyph: <LabelDot color="transparent" size={10} ring />, rows: none, foldable: true })
  }

  // One flat list (headers, rows, "Nothing here"), keyed by to-do: a to-do that changes status keeps its view and
  // glides to its new place (layout transition) instead of vanishing from one group and popping into another.
  const views: React.ReactNode[] = []
  for (const g of groups) {
    const shown = !fold[g.key]
    views.push(
      <Animated.View key={`h:${g.key}`} layout={layout}>
        <GroupHeader title={g.title} glyph={g.glyph} count={g.rows.length} open={shown}
          onToggle={() => { haptic.tap(); setFold((f) => ({ ...f, [g.key]: shown })) }} />
      </Animated.View>,
    )
    if (!shown) continue
    g.rows.forEach((t) => views.push(
      <TodoRow key={groupBy === 'status' ? t.id : `${g.key}:${t.id}`} todo={t} onOpen={onOpen} labels={labels} group={g.key}
        who={t.assignee ? teammate(t.assignee) : t.added_by ? teammate(t.added_by) : undefined}
        project={t.project_id ? projects.find((p) => p.id === t.project_id) : undefined} />,
    ))
    if (!g.rows.length) views.push(
      <Animated.View key={`e:${g.key}`} layout={layout} entering={ENTER} exiting={FadeOut.duration(motion.duration.quick)}>
        <Text variant="footnote" color="ink4" style={{ paddingLeft: 52, paddingBottom: 12, paddingTop: 2 }}>Nothing here</Text>
      </Animated.View>,
    )
  }
  return <View>{views}</View>
}

export function LabelDot({ color, size = 8, ring }: { color: string; size?: number; ring?: boolean }) {
  const { c } = useTheme()
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: ring ? 1.5 : 0, borderColor: c.ink4 }} />
}

function GroupHeader({ title, glyph, count, open, onToggle }: {
  title: string; glyph: React.ReactNode; count: number; open: boolean; onToggle: () => void
}) {
  // The chevron points down while the group is open, right while it's folded.
  const p = useSharedValue(open ? 1 : 0)
  useEffect(() => { p.value = withTiming(open ? 1 : 0, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) }, [open, p])
  const flip = useAnimatedStyle(() => ({ transform: [{ rotate: `${(p.value - 1) * 90}deg` }] }))
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 8, marginTop: 10 }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${count}`}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: 40, paddingHorizontal: 4 }}>
        <Animated.View style={flip}><Icon icon={ArrowDown01Icon} size={14} color="ink3" strokeWidth={2} /></Animated.View>
        <View style={{ width: 16, alignItems: 'center' }}>{glyph}</View>
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</Text>
        <Text variant="label" color="ink3" tabular>{count}</Text>
      </Pressable>
    </View>
  )
}

const TodoRow = memo(function TodoRow({ todo: t, labels: all, group, who, project, onOpen }: {
  todo: Todo; labels: Label[]; group: string; who?: Teammate; project?: Project; onOpen: (t: Todo) => void
}) {
  const { c } = useTheme()
  // Its labels, less the one it's grouped under.
  const labels = t.labels?.length ? all.filter((l) => l.id !== group && t.labels.includes(l.id)) : []
  const ref = useRef<View>(null)
  const finished = t.status === 'done' || t.status === 'canceled'
  const due = t.due && !finished ? dueLabel(t.due) : null
  const fail = (e: unknown) => toast({ title: 'Unable to update', body: (e as Error).message, tone: 'error' })
  const move = (status: TodoStatus) => {
    if (status === 'done') haptic.success()
    else haptic.tap()
    updateTodo(t.id, { status }).catch(fail)
  }
  const remove = () => {
    haptic.warning()
    deleteTodo(t.id).then(() => toast({ title: 'To-do deleted', body: t.title }), fail)
  }
  // Hold: every status (the current one ticked) and Delete; tapping it opens it, so there's no Edit here.
  const hold = () => showContextMenu(ref.current, body(true), [
    ...STATUSES.map((s): MenuItem => ({ label: s.label, glyph: <StatusGlyph status={s.value} size={18} />, checked: t.status === s.value, onPress: () => { if (t.status !== s.value) move(s.value) } })),
    { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: remove },
  ])
  // Tap opens it; double tap moves it on; hold for the statuses. The single tap waits out a double tap (250 ms).
  const wash = useSharedValue(0)
  const washStyle = useAnimatedStyle(() => ({ backgroundColor: c.wash, opacity: wash.get() }))
  const gesture = (() => {
    const press = { onBegin: () => { 'worklet'; wash.set(withTiming(1, { duration: motion.duration.micro })) },
      onFinalize: () => { 'worklet'; wash.set(withTiming(0, { duration: motion.duration.quick })) } }
    return Gesture.Exclusive(
      // `hold` reads the row's ref only when the press happens, not while rendering.
      // eslint-disable-next-line react-hooks/refs
      Gesture.LongPress().minDuration(320).onBegin(press.onBegin).onFinalize(press.onFinalize).onStart(() => runOnJS(hold)()),
      Gesture.Tap().numberOfTaps(2).maxDelay(250).onEnd(() => runOnJS(move)(nextStatus(t.status))),
      Gesture.Tap().onBegin(press.onBegin).onFinalize(press.onFinalize).onEnd(() => runOnJS(onOpen)(t)),
    )
  })()

  const body = (lifted?: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 11,
      backgroundColor: lifted ? c.panel : undefined, borderRadius: lifted ? 16 : 0 }}>
      <View style={{ paddingTop: 2 }}><IconSwap swapKey={t.status}><StatusGlyph status={t.status} size={20} /></IconSwap></View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text variant="body" color={finished ? 'ink3' : 'ink'} numberOfLines={2}
          style={t.status === 'canceled' ? { textDecorationLine: 'line-through' } : undefined}>{t.title}</Text>
        {(!!t.notes || project || labels.length > 0) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {labels.map((l) => (
              <View key={l.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <LabelDot color={l.color} size={7} />
                <Text variant="footnote" color="ink2" numberOfLines={1}>{l.name}</Text>
              </View>
            ))}
            {project && <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: project.color }} />}
            {(!!t.notes || project) && (
              <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flex: 1 }}>{[project?.name, plain(t.notes)].filter(Boolean).join(' · ')}</Text>
            )}
          </View>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 }}>
        {due && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon icon={Calendar03Icon} size={13} color={due.overdue ? 'danger' : due.today ? 'warning' : 'ink3'} />
            <Text variant="footnote" color={due.overdue ? 'danger' : due.today ? 'warning' : 'ink3'}>{due.label}</Text>
          </View>
        )}
        {t.priority > 0 && !finished && <PriorityGlyph priority={t.priority} size={15} />}
        {who && <TeammateAvatar teammate={who} size={20} interactive={false} />}
      </View>
    </View>
  )

  return (
    <Animated.View layout={layout} entering={ENTER} exiting={FadeOut.duration(motion.duration.quick)}>
      <GestureDetector gesture={gesture}>
        <View ref={ref} collapsable={false} accessible accessibilityRole="button"
          accessibilityLabel={`${t.title}, ${statusLabel(t.status)}`} accessibilityHint="Opens it. Use the actions to change its status."
          accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: 'Change status' }, { name: 'next', label: `Move to ${statusLabel(nextStatus(t.status))}` }]}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' ? onOpen(t) : e.nativeEvent.actionName === 'next' ? move(nextStatus(t.status)) : hold()}>
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, washStyle]} />
          {body()}
        </View>
      </GestureDetector>
    </Animated.View>
  )
}, (a, b) =>
  // A fresh list from the server is all new objects: redraw a row only when its to-do or what it shows changed.
  a.todo.id === b.todo.id && a.todo.updated_at === b.todo.updated_at && a.todo.status === b.todo.status && a.labels === b.labels
  && a.group === b.group && a.who?.id === b.who?.id && a.project?.id === b.project?.id && a.project?.color === b.project?.color && a.onOpen === b.onOpen)
