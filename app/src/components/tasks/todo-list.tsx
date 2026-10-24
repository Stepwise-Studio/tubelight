// The to-do board as a list: grouped by status (Backlog, Todo, In progress, Done, Canceled folded) or by label (each
// label's to-dos in status order, then "No label"). Tap a to-do to open it; double tap to move it on (to do → in
// progress → done; a finished one opens again); hold it for every status and Delete, in place; keep the finger moving
// after the hold and the menu gives way to a drag: up or down its group, or into another (a new status or label).
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pressable, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeOut, LinearTransition, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated'
import { ArrowDown01Icon, Calendar03Icon, Delete02Icon } from '@hugeicons/core-free-icons'

import { STATUSES, deleteTodo, dueLabel, nextStatus, statusLabel, updateTodo, type Label, type Todo, type TodoStatus } from '@/lib/tasks'
import type { Project, Teammate } from '@/lib/types'
import { motion, useTheme } from '@/theme'
import { Icon, IconSwap, Text, TeammateAvatar, closeContextMenu, confirm, haptic, showContextMenu, toast, type MenuItem } from '@/ui'

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
/** The view being dragged (key '' = none): where it started, its height and how far it has moved. */
interface Drag { key: SharedValue<string>; y0: SharedValue<number>; h: SharedValue<number>; dy: SharedValue<number> }
type Spot = { y: number; h: number }
type Item = { k: string; group: string; todo?: Todo }

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
  const d: Drag = { key: useSharedValue(''), y0: useSharedValue(0), h: useSharedValue(0), dy: useSharedValue(0) }
  const [spots] = useState(() => new Map<string, Spot>())
  const items: Item[] = []
  const itemsRef = useRef<Item[]>([])
  // A drop lays the list out in its new order with no layout glide (the rows already stand where they land), then
  // the drag's offsets go back to 0 in the same frame.
  const [quiet, setQuiet] = useState(false)
  useLayoutEffect(() => {
    if (!quiet) return
    d.key.set(''); d.dy.set(0)
    const f = requestAnimationFrame(() => setQuiet(false))
    return () => cancelAnimationFrame(f)
  }, [quiet, d.key, d.dy])

  // Where the dragged view lands: before the first other view whose middle is below its middle. It joins that
  // spot's group, its sort halfway between its new neighbours.
  const drop = (k: string, center: number) => {
    const list = itemsRef.current
    const t = list.find((i) => i.k === k)?.todo
    if (!t) { setQuiet(true); return }
    const from = list.find((i) => i.k === k)!.group
    const rest = list.filter((i) => i.k !== k)
    let at = rest.findIndex((i) => { const s = spots.get(i.k); return !!s && center < s.y + s.h / 2 })
    if (at < 0) at = rest.length
    const group = (at > 0 ? rest[at - 1] : rest[0])?.group ?? from
    const prev = rest[at - 1]?.group === group ? rest[at - 1].todo : undefined
    const next = rest[at]?.group === group ? rest[at].todo : undefined
    const sort = prev && next ? (prev.sort + next.sort) / 2 : prev ? prev.sort + 1 : next ? next.sort - 1 : t.sort
    const changes: Partial<Todo> = {}
    if (sort !== t.sort) changes.sort = sort
    if (group !== from) {
      if (groupBy === 'status') changes.status = group as TodoStatus
      else changes.labels = group === '_none' ? [] : [...(t.labels ?? []).filter((id) => id !== from), group]
    }
    setQuiet(true)
    if (!Object.keys(changes).length) return
    if (changes.status === 'done') haptic.success()
    else haptic.tap()
    updateTodo(t.id, changes).catch((e) => toast({ title: 'Unable to move it', body: (e as Error).message, tone: 'error' }))
  }

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
    items.push({ k: `h:${g.key}`, group: g.key })
    views.push(
      <Slot key={`h:${g.key}`} k={`h:${g.key}`} d={d} spots={spots} quiet={quiet}>
        <GroupHeader title={g.title} glyph={g.glyph} count={g.rows.length} open={shown}
          onToggle={() => { haptic.tap(); setFold((f) => ({ ...f, [g.key]: shown })) }} />
      </Slot>,
    )
    if (!shown) continue
    g.rows.forEach((t) => {
      const k = groupBy === 'status' ? t.id : `${g.key}:${t.id}`
      items.push({ k, group: g.key, todo: t })
      views.push(
      <TodoRow key={k} k={k} d={d} spots={spots} quiet={quiet} onDrop={drop} todo={t} onOpen={onOpen} labels={labels} group={g.key}
        who={t.assignee ? teammate(t.assignee) : t.added_by ? teammate(t.added_by) : undefined}
        project={t.project_id ? projects.find((p) => p.id === t.project_id) : undefined} />,
      )
    })
    if (!g.rows.length) {
      items.push({ k: `e:${g.key}`, group: g.key })
      views.push(
        <Slot key={`e:${g.key}`} k={`e:${g.key}`} d={d} spots={spots} quiet={quiet} fade>
          <Text variant="footnote" color="ink4" style={{ paddingLeft: 52, paddingBottom: 12, paddingTop: 2 }}>Nothing here</Text>
        </Slot>,
      )
    }
  }
  useLayoutEffect(() => { itemsRef.current = items })
  return <View>{views}</View>
}

/** A view of the list that steps aside while another is dragged past it: up by the dragged view's height when that
 * came from above and its middle is now below this one's middle, down for the mirror case. */
function useSlot(k: string, d: Drag, spots: Map<string, Spot>) {
  const { c } = useTheme()
  const y = useSharedValue(0)
  const h = useSharedValue(0)
  const onLayout = (e: LayoutChangeEvent) => {
    const l = e.nativeEvent.layout
    y.set(l.y); h.set(l.height); spots.set(k, { y: l.y, h: l.height })
  }
  const style = useAnimatedStyle(() => {
    const key = d.key.get()
    if (key === k) return { transform: [{ translateY: d.dy.get() }, { scale: withTiming(1.02, { duration: motion.duration.fast }) }],
      zIndex: 10, backgroundColor: c.panel, borderRadius: 16, elevation: 6 }
    if (!key) return { transform: [{ translateY: 0 }, { scale: 1 }], zIndex: 0, backgroundColor: 'transparent', borderRadius: 0, elevation: 0 }
    const mid = y.get() + h.get() / 2
    const center = d.y0.get() + d.h.get() / 2 + d.dy.get()
    const shift = d.y0.get() < y.get() && center > mid ? -d.h.get() : d.y0.get() > y.get() && center < mid ? d.h.get() : 0
    return { transform: [{ translateY: withTiming(shift, { duration: 180, easing: motion.ease.smoothOut }) }, { scale: 1 }],
      zIndex: 0, backgroundColor: 'transparent', borderRadius: 0, elevation: 0 }
  })
  return { y, h, onLayout, style }
}

function Slot({ k, d, spots, quiet, fade, children }: { k: string; d: Drag; spots: Map<string, Spot>; quiet: boolean; fade?: boolean; children: React.ReactNode }) {
  const { onLayout, style } = useSlot(k, d, spots)
  return (
    <Animated.View layout={quiet ? undefined : layout} entering={fade ? ENTER : undefined} exiting={fade ? FadeOut.duration(motion.duration.quick) : undefined} onLayout={onLayout}>
      <Animated.View style={style}>{children}</Animated.View>
    </Animated.View>
  )
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

const TodoRow = memo(function TodoRow({ k, d, spots, quiet, onDrop, todo: t, labels: all, group, who, project, onOpen }: {
  k: string; d: Drag; spots: Map<string, Spot>; quiet: boolean; onDrop: (k: string, center: number) => void
  todo: Todo; labels: Label[]; group: string; who?: Teammate; project?: Project; onOpen: (t: Todo) => void
}) {
  const { c } = useTheme()
  const slot = useSlot(k, d, spots)
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
  const remove = async () => {
    if (!await confirm({ title: 'Delete this to-do?', body: t.title, confirmLabel: 'Delete to-do', destructive: true })) return
    haptic.warning()
    deleteTodo(t.id).then(() => toast({ title: 'To-do deleted', body: t.title }), fail)
  }
  // Hold: every status (the current one ticked) and Delete; tapping it opens it, so there's no Edit here.
  const hold = () => showContextMenu(ref.current, body(true), [
    ...STATUSES.map((s): MenuItem => ({ label: s.label, glyph: <StatusGlyph status={s.value} size={18} />, checked: t.status === s.value, onPress: () => { if (t.status !== s.value) move(s.value) } })),
    { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: remove },
  ])
  // Tap opens it; double tap moves it on; hold for the statuses, and moving on from the hold drags it instead.
  // The single tap waits out a double tap (250 ms).
  const wash = useSharedValue(0)
  const washStyle = useAnimatedStyle(() => ({ backgroundColor: c.wash, opacity: wash.get() }))
  const gesture = (() => {
    const press = { onBegin: () => { 'worklet'; wash.set(withTiming(1, { duration: motion.duration.micro })) },
      onFinalize: () => { 'worklet'; wash.set(withTiming(0, { duration: motion.duration.quick })) } }
    const { y, h } = slot
    return Gesture.Exclusive(
      Gesture.Pan().activateAfterLongPress(320).onBegin(press.onBegin)
        // `hold` reads the row's ref only when the press happens, not while rendering.
        // eslint-disable-next-line react-hooks/refs
        .onStart(() => { runOnJS(hold)() })
        .onUpdate((e) => {
          if (d.key.get() !== k) {
            if (Math.abs(e.translationY) < 12) return
            d.y0.set(y.get()); d.h.set(h.get()); d.key.set(k)
            runOnJS(closeContextMenu)()
            runOnJS(haptic.light)()
          }
          d.dy.set(e.translationY)
        })
        .onEnd((e) => { if (d.key.get() === k) runOnJS(onDrop)(k, d.y0.get() + d.h.get() / 2 + e.translationY) })
        .onFinalize((_, ok) => { press.onFinalize(); if (!ok && d.key.get() === k) d.key.set('') }),
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
    <Animated.View layout={quiet ? undefined : layout} entering={ENTER} exiting={FadeOut.duration(motion.duration.quick)} onLayout={slot.onLayout}>
      <Animated.View style={slot.style}>
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
    </Animated.View>
  )
}, (a, b) =>
  // A fresh list from the server is all new objects: redraw a row only when its to-do or what it shows changed.
  a.quiet === b.quiet && a.k === b.k && a.onDrop === b.onDrop && a.todo.id === b.todo.id && a.todo.updated_at === b.todo.updated_at && a.todo.status === b.todo.status && a.labels === b.labels
  && a.group === b.group && a.who?.id === b.who?.id && a.project?.id === b.project?.id && a.project?.color === b.project?.color && a.onOpen === b.onOpen)
