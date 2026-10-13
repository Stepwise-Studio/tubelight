// The to-do board as a list: grouped by status (Backlog, Todo, In progress, Done, Canceled folded) or by label (each
// label's to-dos in status order, then "No label"). Tap a to-do to move it on (to do → in progress → done; a finished
// one opens again); hold it for its menu in place: edit, backlog, cancel, delete.
import { memo, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Add01Icon, ArrowDown01Icon, Calendar03Icon, Delete02Icon, Edit02Icon } from '@hugeicons/core-free-icons'

import { STATUSES, deleteTodo, dueLabel, nextStatus, statusLabel, updateTodo, type Label, type Todo, type TodoStatus } from '@/lib/tasks'
import type { Project, Teammate } from '@/lib/types'
import { motion, useTheme } from '@/theme'
import { Icon, IconButton, IconSwap, Text, TeammateAvatar, haptic, showContextMenu, toast, type MenuItem } from '@/ui'

import { PriorityGlyph, StatusGlyph } from './glyphs'

export type GroupBy = 'status' | 'label'
const ORDER: Record<TodoStatus, number> = { backlog: 0, todo: 1, doing: 2, done: 3, canceled: 4 }
const MONTH_MS = 30 * 86_400_000
/** Notes as one quiet line: no list marks, checkboxes, quotes or code fences. */
const plain = (s: string) => s.replace(/^\s*(?:[-*>]|```)\s?(?:\[[ xX]\]\s?)?/gm, '').replace(/\s+/g, ' ').trim()
const layout = LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)

interface Group { key: string; title: string; glyph: React.ReactNode; rows: Todo[]; foldable: boolean; add?: () => void }

export function TodoList({ todos, labels, groupBy, teammate, projects, onOpen, onAdd }: {
  todos: Todo[]; labels: Label[]; groupBy: GroupBy; teammate: (id: string) => Teammate | undefined; projects: Project[]
  onOpen: (t: Todo) => void; onAdd: (o: { status?: TodoStatus; label?: string }) => void
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
        foldable: true, add: value === 'done' || value === 'canceled' ? undefined : () => onAdd({ status: value }) }
    }).filter((g) => g.rows.length || g.key === 'todo' || g.key === 'doing')
  } else {
    const inOrder = (rows: Todo[]) => rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.sort - b.sort)
    groups = labels.map((l) => ({
      key: l.id, title: l.name, glyph: <LabelDot color={l.color} size={10} />, foldable: true,
      rows: inOrder(live.filter((t) => t.labels?.includes(l.id))), add: () => onAdd({ label: l.id }),
    }))
    const none = inOrder(live.filter((t) => !t.labels?.some((id) => byLabel.has(id))))
    if (none.length) groups.push({ key: '_none', title: 'No label', glyph: <LabelDot color="transparent" size={10} ring />, rows: none, foldable: true, add: () => onAdd({}) })
  }

  return (
    <View>
      {groups.map((g) => {
        const shown = !fold[g.key]
        return (
          <Animated.View key={g.key} layout={layout}>
            <GroupHeader title={g.title} glyph={g.glyph} count={g.rows.length} open={shown}
              onToggle={() => { haptic.tap(); setFold((f) => ({ ...f, [g.key]: shown })) }} onAdd={g.add} />
            {shown && g.rows.map((t) => (
              <TodoRow key={t.id} todo={t} onOpen={onOpen} labels={labels} group={g.key}
                who={t.assignee ? teammate(t.assignee) : t.added_by ? teammate(t.added_by) : undefined}
                project={t.project_id ? projects.find((p) => p.id === t.project_id) : undefined} />
            ))}
            {shown && !g.rows.length && (
              <Text variant="footnote" color="ink4" style={{ paddingLeft: 52, paddingBottom: 12, paddingTop: 2 }}>Nothing here</Text>
            )}
          </Animated.View>
        )
      })}
    </View>
  )
}

export function LabelDot({ color, size = 8, ring }: { color: string; size?: number; ring?: boolean }) {
  const { c } = useTheme()
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: ring ? 1.5 : 0, borderColor: c.ink4 }} />
}

function GroupHeader({ title, glyph, count, open, onToggle, onAdd }: {
  title: string; glyph: React.ReactNode; count: number; open: boolean; onToggle: () => void; onAdd?: () => void
}) {
  const { c } = useTheme()
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
      {onAdd && <IconButton icon={Add01Icon} size={34} iconSize={16} color={c.ink3} accessibilityLabel={`Add to ${title}`} onPress={() => { haptic.tap(); onAdd() }} />}
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
  const hold = () => {
    const to = (s: TodoStatus, label: string): MenuItem[] => (t.status === s ? [] : [{ label, onPress: () => move(s) }])
    showContextMenu(ref.current, body(true), [
      { label: 'Edit', icon: Edit02Icon, onPress: () => onOpen(t) },
      ...to('backlog', 'Move to Backlog'),
      ...(t.status === 'todo' || t.status === 'backlog' ? [] : to('todo', 'Back to Todo')),
      ...to('canceled', 'Cancel'),
      { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: remove },
    ])
  }

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
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={() => move(nextStatus(t.status))} onLongPress={hold} delayLongPress={320}
          android_ripple={{ color: c.wash }} accessibilityRole="button"
          accessibilityLabel={`${t.title}, ${statusLabel(t.status)}`}
          accessibilityHint={`Moves it to ${statusLabel(nextStatus(t.status))}. Hold for more.`}>
          {body()}
        </Pressable>
      </View>
    </Animated.View>
  )
})
