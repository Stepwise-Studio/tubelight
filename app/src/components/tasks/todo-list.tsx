// The to-do board as a list, Linear-style: groups by status (In progress, Todo, Backlog, then Done and Canceled
// folded), each row a status circle you tap to finish, the title, and its due date, priority and who added it.
// Swipe right to finish (or reopen), left to delete.
import { useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, {
  Extrapolation, FadeIn, FadeOut, LinearTransition, interpolate, useAnimatedStyle, useSharedValue, withTiming, type SharedValue,
} from 'react-native-reanimated'
import { Add01Icon, ArrowDown01Icon, Calendar03Icon, Delete02Icon, Tick02Icon, ArrowTurnBackwardIcon } from '@hugeicons/core-free-icons'

import { STATUSES, deleteTodo, dueLabel, statusLabel, updateTodo, type Todo, type TodoStatus } from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Icon, IconButton, IconSwap, Press, TeammateAvatar, Text, haptic, showMenu, toast } from '@/ui'

import { PriorityGlyph, StatusGlyph } from './glyphs'

const FOLDED: TodoStatus[] = ['done', 'canceled']
/** Notes as one quiet line: no list marks, checkboxes, quotes or code fences. */
const plain = (s: string) => s.replace(/^\s*(?:[-*>]|```)\s?(?:\[[ xX]\]\s?)?/gm, '').replace(/\s+/g, ' ').trim()
const layout = LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)

export function TodoList({ todos, onOpen, onAdd }: { todos: Todo[]; onOpen: (t: Todo) => void; onAdd: (s: TodoStatus) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ done: false, canceled: false })
  const [monthAgo] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString())
  return (
    <View>
      {STATUSES.map(({ value }) => {
        let rows = todos.filter((t) => t.status === value)
        if (value === 'done') rows = rows.filter((t) => (t.completed_at ?? t.updated_at) >= monthAgo)
          .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
        if (!rows.length && (FOLDED.includes(value) || value === 'backlog')) return null
        const shown = open[value] ?? !FOLDED.includes(value)
        return (
          <Animated.View key={value} layout={layout}>
            <GroupHeader status={value} count={rows.length} open={shown}
              onToggle={() => { haptic.tap(); setOpen((o) => ({ ...o, [value]: !shown })) }}
              onAdd={FOLDED.includes(value) ? undefined : () => onAdd(value)} />
            {shown && rows.map((t) => <TodoRow key={t.id} todo={t} onOpen={() => onOpen(t)} />)}
            {shown && !rows.length && (
              <Text variant="footnote" color="ink4" style={{ paddingLeft: 52, paddingBottom: 12, paddingTop: 2 }}>Nothing here</Text>
            )}
          </Animated.View>
        )
      })}
    </View>
  )
}

function GroupHeader({ status, count, open, onToggle, onAdd }: {
  status: TodoStatus; count: number; open: boolean; onToggle: () => void; onAdd?: () => void
}) {
  const { c } = useTheme()
  // The chevron points down while the group is open, right while it's folded.
  const p = useSharedValue(open ? 1 : 0)
  useEffect(() => { p.value = withTiming(open ? 1 : 0, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) }, [open, p])
  const flip = useAnimatedStyle(() => ({ transform: [{ rotate: `${(p.value - 1) * 90}deg` }] }))
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 8, marginTop: 10 }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={`${statusLabel(status)}, ${count}`}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: 40, paddingHorizontal: 4 }}>
        <Animated.View style={flip}><Icon icon={ArrowDown01Icon} size={14} color="ink3" strokeWidth={2} /></Animated.View>
        <StatusGlyph status={status} size={16} />
        <Text variant="label">{statusLabel(status)}</Text>
        <Text variant="label" color="ink3" tabular>{count}</Text>
      </Pressable>
      {onAdd && <IconButton icon={Add01Icon} size={34} iconSize={16} color={c.ink3} accessibilityLabel={`Add to ${statusLabel(status)}`} onPress={() => { haptic.tap(); onAdd() }} />}
    </View>
  )
}

function TodoRow({ todo: t, onOpen }: { todo: Todo; onOpen: () => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const swipe = useRef<SwipeableMethods>(null)
  const finished = t.status === 'done' || t.status === 'canceled'
  const due = t.due && !finished ? dueLabel(t.due) : null
  const who = t.assignee ? ws.teammate(t.assignee) : t.added_by ? ws.teammate(t.added_by) : null
  const project = t.project_id ? ws.projects.find((p) => p.id === t.project_id) : null

  const toggle = () => {
    const next: TodoStatus = finished ? 'todo' : 'done'
    if (next === 'done') haptic.success()
    else haptic.tap()
    updateTodo(t.id, { status: next }).catch((e) => toast({ title: 'Unable to update', body: (e as Error).message, tone: 'error' }))
  }
  const remove = () => {
    haptic.warning()
    deleteTodo(t.id).then(
      () => toast({ title: 'To-do deleted', body: t.title }),
      (e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' }),
    )
  }
  const menu = () => {
    haptic.light()
    showMenu({
      title: t.title,
      items: [
        ...STATUSES.filter((s) => s.value !== t.status).map((s) => ({
          label: `Move to ${s.label}`, onPress: () => updateTodo(t.id, { status: s.value }).catch(() => toast({ title: 'Unable to update', tone: 'error' })),
        })),
        { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: remove },
      ],
    })
  }

  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <ReanimatedSwipeable
        ref={swipe}
        friction={1.6}
        leftThreshold={72}
        rightThreshold={72}
        overshootFriction={8}
        renderLeftActions={(p) => <SwipeAction progress={p} side="left" color={finished ? c.ink3 : c.success} icon={finished ? ArrowTurnBackwardIcon : Tick02Icon} />}
        renderRightActions={(p) => <SwipeAction progress={p} side="right" color={c.danger} icon={Delete02Icon} />}
        onSwipeableOpen={(direction) => { swipe.current?.close(); if (direction === 'right') toggle(); else remove() }}
      >
        <Press radius={0} onPress={onOpen} onLongPress={menu} wash={c.wash} accessibilityLabel={`${t.title}, ${statusLabel(t.status)}`}
          accessibilityHint="Opens it. Swipe right to finish, left to delete."
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 11, backgroundColor: c.canvas }}>
          <Pressable onPress={toggle} onLongPress={menu} hitSlop={12} accessibilityRole="checkbox"
            accessibilityState={{ checked: t.status === 'done' }} accessibilityLabel={finished ? 'Reopen' : 'Mark done'}
            style={{ paddingTop: 2 }}>
            <IconSwap swapKey={t.status}><StatusGlyph status={t.status} size={20} /></IconSwap>
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text variant="body" color={finished ? 'ink3' : 'ink'} numberOfLines={2}
              style={t.status === 'canceled' ? { textDecorationLine: 'line-through' } : undefined}>{t.title}</Text>
            {(t.notes || project) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {project && <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: project.color }} />}
                <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flex: 1 }}>
                  {[project?.name, plain(t.notes)].filter(Boolean).join(' · ')}
                </Text>
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
        </Press>
      </ReanimatedSwipeable>
    </Animated.View>
  )
}

function SwipeAction({ progress, side, color, icon }: { progress: SharedValue<number>; side: 'left' | 'right'; color: string; icon: Parameters<typeof Icon>[0]['icon'] }) {
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4, 1], [0, 0.6, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.6, 1], Extrapolation.CLAMP) }],
  }))
  return (
    <View style={{ width: 88, backgroundColor: color, alignItems: side === 'left' ? 'flex-start' : 'flex-end', justifyContent: 'center', paddingHorizontal: 28 }}>
      <Animated.View style={style}><Icon icon={icon} size={22} color="#fff" strokeWidth={2} /></Animated.View>
    </View>
  )
}
