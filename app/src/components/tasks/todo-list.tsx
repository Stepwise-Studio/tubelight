// The to-do board as a list: grouped by status (Backlog, Todo, In progress, Done, Canceled folded) or by label (each
// label's to-dos in status order, then "No label"). Tap a to-do to open it; double tap to move it on (to do → in
// progress → done; a finished one opens again); hold it for every status and Delete, in place; keep the finger moving
// after the hold and the menu gives way to a drag: up or down its group, or into another (a new status or label).
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pressable, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  FadeOut, runOnJS, runOnUI, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated'
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
const LAND = { duration: 280, easing: motion.ease.smoothOut }

interface Group { key: string; title: string; glyph: React.ReactNode; rows: Todo[]; foldable: boolean }
/** The view being dragged (key '' = none): where it started, its height, how far it has moved, and the middle the
 * others step aside for (held still once it's let go). `landing`: let go, gliding into its slot. `spots`: every
 * view's resting place, for working out the landing slot on the UI thread. */
interface Drag {
  key: SharedValue<string>; y0: SharedValue<number>; h: SharedValue<number>; dy: SharedValue<number>; cy: SharedValue<number>
  landing: SharedValue<boolean>; spots: SharedValue<Record<string, Spot>>
}
type Spot = { y: number; h: number }
type Item = { k: string; group: string; todo?: Todo }
/** Where one view is drawn. The list stacks its views itself (each absolutely placed at `base`, by measured height)
 * instead of leaving it to layout, so where a view shows is one animated number: a drop can swap the order and zero
 * every offset in one step, with nothing left to land a frame late. `top` is its resting place, `off` its step aside
 * during a drag, `shown` false until it has been placed. */
interface Place { top: SharedValue<number>; base: SharedValue<number>; off: SharedValue<number>; shown: SharedValue<boolean> }
/** What the list's views share: the drag, every view's place and height, and how to ask for a re-stack / a drop. */
interface Ctx {
  d: Drag; places: Map<string, Place>; heights: Map<string, number>
  relayout: () => void; drop: (k: string, center: number) => void
}

export function TodoList({ todos, labels, groupBy, teammate, projects, onOpen }: {
  todos: Todo[]; labels: Label[]; groupBy: GroupBy; teammate: (id: string) => Teammate | undefined; projects: Project[]
  onOpen: (t: Todo) => void
}) {
  const { c } = useTheme()
  // Folded by default: canceled (by status), finished ones stay in their label's group, dimmed, at the end.
  const [fold, setFold] = useState<Record<string, boolean>>({ canceled: true })
  const [since] = useState(() => new Date(Date.now() - MONTH_MS).toISOString())
  // Done more than a month ago drops off the board.
  const live = todos.filter((t) => t.status !== 'done' || (t.completed_at ?? t.updated_at) >= since)
  const byLabel = new Map(labels.map((l) => [l.id, l]))
  const d: Drag = { key: useSharedValue(''), y0: useSharedValue(0), h: useSharedValue(0), dy: useSharedValue(0), cy: useSharedValue(0),
    landing: useSharedValue(false), spots: useSharedValue<Record<string, Spot>>({}) }
  const total = useSharedValue(0)
  const [spots] = useState(() => new Map<string, Spot>())
  const items: Item[] = []
  const itemsRef = useRef<Item[]>([])
  const landingRef = useRef(false)
  const settled = useRef(false)
  const [, setLanded] = useState(0)
  const placeRef = useRef<(landing: boolean) => void>(() => {})
  const dropRef = useRef<(k: string, center: number) => void>(() => {})
  const [ctx] = useState<Ctx>(() => {
    let frame = 0
    return {
      d, places: new Map(), heights: new Map(),
      relayout: () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; placeRef.current(false) }) },
      drop: (k, center) => dropRef.current(k, center),
    }
  })

  // Stack the views by height. Moves glide once the list has been placed in full (a status change, rows coming and
  // going); the first placing is instant. A drop: every view already stands where its new place is, so the new
  // places and zeroed offsets go in one UI-thread step and the drag ends.
  const place = (landing: boolean) => {
    let y = 0
    let complete = true
    const next: Record<string, Spot> = {}
    const moves: [Place, number][] = []
    spots.clear()
    for (const i of itemsRef.current) {
      const h = ctx.heights.get(i.k)
      const p = ctx.places.get(i.k)
      if (h === undefined || !p) { complete = false; continue }
      next[i.k] = { y, h }
      spots.set(i.k, { y, h })
      moves.push([p, y])
      y += h
    }
    const glide = settled.current && !landing
    if (complete) settled.current = true
    const { key, dy, landing: flag, spots: shared } = d
    runOnUI(() => {
      'worklet'
      for (const [p, top] of moves) {
        p.top.value = top
        p.base.value = glide && p.shown.value ? withTiming(top, LAND) : top
        if (landing) p.off.value = 0
        p.shown.value = true
      }
      shared.value = next
      total.value = y
      if (landing) { dy.value = 0; key.value = ''; flag.value = false }
    })()
  }

  // The drop line: where the dragged view would land if let go now.
  const lineY = useSharedValue(0)
  useAnimatedReaction(() => (d.key.get() && !d.landing.get() ? landingTop(d) : -1), (y, was) => {
    if (y < 0 || y === was) return
    lineY.set(was === null || was < 0 ? y : withTiming(y, { duration: 160, easing: motion.ease.smoothOut }))
  })
  const lineStyle = useAnimatedStyle(() => ({
    opacity: withTiming(d.key.get() && !d.landing.get() ? 1 : 0, { duration: 120 }),
    transform: [{ translateY: lineY.get() - 1 }],
  }))

  // Where the dragged view lands: before the first other view whose middle is below its middle. It joins that
  // spot's group, its sort halfway between its new neighbours.
  const drop = (k: string, center: number) => {
    const list = itemsRef.current
    const t = list.find((i) => i.k === k)?.todo
    if (!t) { landingRef.current = true; setLanded((n) => n + 1); return }
    const from = list.find((i) => i.k === k)!.group
    const rest = list.filter((i) => i.k !== k)
    let at = rest.findIndex((i) => { const s = spots.get(i.k); return !!s && center < s.y + s.h / 2 })
    if (at < 0) at = rest.length
    const group = (at > 0 ? rest[at - 1] : rest[0])?.group ?? from
    // Neighbours in the same group (and, grouped by label, the same status: rows sort by status first there).
    const near = (step: number) => {
      for (let j = step < 0 ? at - 1 : at; j >= 0 && j < rest.length && rest[j].group === group; j += step) {
        const x = rest[j].todo
        if (x && (groupBy === 'status' || x.status === t.status)) return x
      }
    }
    const prev = near(-1)
    const next = near(1)
    const sort = prev && next ? (prev.sort + next.sort) / 2 : prev ? prev.sort + 1 : next ? next.sort - 1 : t.sort
    const changes: Partial<Todo> = {}
    if (sort !== t.sort) changes.sort = sort
    if (group !== from) {
      if (groupBy === 'status') changes.status = group as TodoStatus
      else changes.labels = group === '_none' ? [] : [...(t.labels ?? []).filter((id) => id !== from), group]
    }
    landingRef.current = true
    setLanded((n) => n + 1)
    if (!Object.keys(changes).length) return
    if (changes.status === 'done') haptic.success()
    else haptic.light()
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
      <Slot key={`h:${g.key}`} k={`h:${g.key}`} ctx={ctx}>
        <GroupHeader title={g.title} glyph={g.glyph} count={g.rows.length} open={shown}
          onToggle={() => { haptic.tap(); setFold((f) => ({ ...f, [g.key]: shown })) }} />
      </Slot>,
    )
    if (!shown) continue
    g.rows.forEach((t) => {
      const k = groupBy === 'status' ? t.id : `${g.key}:${t.id}`
      items.push({ k, group: g.key, todo: t })
      views.push(
      <TodoRow key={k} k={k} ctx={ctx} todo={t} onOpen={onOpen} labels={labels} group={g.key}
        who={t.assignee ? teammate(t.assignee) : t.added_by ? teammate(t.added_by) : undefined}
        project={t.project_id ? projects.find((p) => p.id === t.project_id) : undefined} />,
      )
    })
    if (!g.rows.length) {
      items.push({ k: `e:${g.key}`, group: g.key })
      views.push(
        <Slot key={`e:${g.key}`} k={`e:${g.key}`} ctx={ctx}>
          <Text variant="footnote" color="ink4" style={{ paddingLeft: 52, paddingBottom: 12, paddingTop: 2 }}>Nothing here</Text>
        </Slot>,
      )
    }
  }
  useLayoutEffect(() => {
    itemsRef.current = items
    placeRef.current = place
    dropRef.current = drop
    const landing = landingRef.current
    landingRef.current = false
    place(landing)
  })
  const height = useAnimatedStyle(() => ({ height: total.get() }))
  return (
    <Animated.View style={height}>
      {/* First, so the lifted row draws over it. */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 48, right: 16, top: 0, height: 2, borderRadius: 1, backgroundColor: c.tube }, lineStyle]} />
      {views}
    </Animated.View>
  )
}

/** Top of the slot the dragged view would land in: past every view whose middle it has crossed. */
function landingTop(d: Drag) {
  'worklet'
  const all = d.spots.get()
  const s0 = all[d.key.get()]
  if (!s0) return -1
  const center = d.cy.get()
  let top = s0.y
  for (const key in all) {
    const s = all[key]
    if (key === d.key.get()) continue
    if (s.y > s0.y && center > s.y + s.h / 2) top = Math.max(top, s.y + s.h - s0.h)
    if (s.y < s0.y && center < s.y + s.h / 2) top = Math.min(top, s.y)
  }
  return top
}

/** A view of the list, placed by the list (see Place) and stepping aside while another is dragged past it: up by
 * the dragged view's height when that came from above and its middle is now below this one's middle, down for the
 * mirror case. Each view animates only when its own place changes (a tick of haptics then), never per finger move;
 * the dragged one rides the finger. */
function useSlot(k: string, ctx: Ctx) {
  const { d } = ctx
  const top = useSharedValue(0)
  const base = useSharedValue(0)
  const off = useSharedValue(0)
  const shown = useSharedValue(false)
  const lift = useSharedValue(0)
  const h = useSharedValue(0)
  useEffect(() => {
    ctx.places.set(k, { top, base, off, shown })
    ctx.relayout()
    return () => { ctx.places.delete(k); ctx.heights.delete(k); ctx.relayout() }
  }, [k, ctx, top, base, off, shown])
  const onLayout = (e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height
    h.set(height)
    if (ctx.heights.get(k) === height) return
    ctx.heights.set(k, height)
    ctx.relayout()
  }
  useAnimatedReaction(() => {
    const key = d.key.get()
    if (!key || key === k) return 0
    const mid = top.get() + h.get() / 2
    const center = d.cy.get()
    return d.y0.get() < top.get() && center > mid ? -d.h.get() : d.y0.get() > top.get() && center < mid ? d.h.get() : 0
  }, (to, was) => {
    if (was === null || to === was || d.landing.get()) return
    off.set(withTiming(to, { duration: 200, easing: motion.ease.smoothOut }))
    if (d.key.get()) runOnJS(haptic.tap)()
  })
  useAnimatedReaction(() => d.key.get() === k, (on, was) => {
    if (was === null || on === was) return
    lift.set(on ? withSpring(1, { damping: 18, stiffness: 320 }) : withTiming(0, { duration: 160 }))
    // Let go without a new place (cancelled): glide back.
    if (!on && d.dy.get() !== 0) { off.set(d.dy.get()); off.set(withTiming(0, LAND)); d.dy.set(0) }
  })
  const style = useAnimatedStyle(() => {
    const mine = d.key.get() === k
    return {
      opacity: withTiming(shown.get() ? 1 : 0, { duration: 200 }),
      transform: [{ translateY: base.get() + (mine ? d.dy.get() : off.get()) }, { scale: 1 + 0.03 * lift.get() }],
      zIndex: mine ? 10 : 0, elevation: 8 * lift.get(),
    }
  })
  const card = useAnimatedStyle(() => ({ opacity: lift.get() }))
  return { top, h, lift, onLayout, style, card }
}

const SLOT = { position: 'absolute', left: 0, right: 0, top: 0 } as const

function Slot({ k, ctx, children }: { k: string; ctx: Ctx; children: React.ReactNode }) {
  const { onLayout, style } = useSlot(k, ctx)
  return (
    <Animated.View style={[SLOT, style]} exiting={FadeOut.duration(motion.duration.quick)} onLayout={onLayout}>{children}</Animated.View>
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

const TodoRow = memo(function TodoRow({ k, ctx, todo: t, labels: all, group, who, project, onOpen }: {
  k: string; ctx: Ctx
  todo: Todo; labels: Label[]; group: string; who?: Teammate; project?: Project; onOpen: (t: Todo) => void
}) {
  const { c } = useTheme()
  const slot = useSlot(k, ctx)
  const { d } = ctx
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
    const { top, h, lift } = slot
    return Gesture.Exclusive(
      Gesture.Pan().activateAfterLongPress(320).onBegin(press.onBegin)
        // `hold` reads the row's ref only when the press happens, not while rendering.
        // eslint-disable-next-line react-hooks/refs
        .onStart(() => { runOnJS(hold)() })
        .onUpdate((e) => {
          if (d.key.get() !== k) {
            if (Math.abs(e.translationY) < 12) return
            d.y0.set(top.get()); d.h.set(h.get()); d.key.set(k)
            runOnJS(closeContextMenu)()
            runOnJS(haptic.medium)()
          }
          d.dy.set(e.translationY)
          d.cy.set(d.y0.get() + d.h.get() / 2 + e.translationY)
        })
        // Let go: glide into the slot the others opened, then commit the new order.
        .onEnd(() => {
          if (d.key.get() !== k) return
          const center = d.cy.get()
          // It settles flat as it glides in, so it lands already at rest.
          lift.set(withTiming(0, { duration: 220, easing: motion.ease.smoothOut }))
          d.landing.set(true) // the drop line goes; the others hold their places
          d.dy.set(withTiming(landingTop(d) - d.y0.get(), { duration: 220, easing: motion.ease.smoothOut }, () => {
            runOnJS(ctx.drop)(k, center) // even if cut short, so the drag always ends
          }))
        })
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
    <Animated.View style={[SLOT, slot.style]} exiting={FadeOut.duration(motion.duration.quick)} onLayout={slot.onLayout}>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 16, backgroundColor: c.panel }, slot.card]} />
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
  a.k === b.k && a.ctx === b.ctx && a.todo.id === b.todo.id && a.todo.updated_at === b.todo.updated_at && a.todo.status === b.todo.status && a.labels === b.labels
  && a.group === b.group && a.who?.id === b.who?.id && a.project?.id === b.project?.id && a.project?.color === b.project?.color && a.onOpen === b.onOpen)
