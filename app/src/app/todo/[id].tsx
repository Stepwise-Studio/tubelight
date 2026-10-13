// A to-do, full screen, Linear's way: close, the list it's in (Personal or a project) and send along the top; a big
// title and notes; and above the keyboard a panel of properties (status, priority, assignee, due date). `new` makes one; an id opens it, saving as you go. Assigning a teammate hands it to them: it lands in
// their chat and they get on with it.
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Keyboard, ScrollView, TextInput, View } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ArrowRight01Icon, ArrowUp02Icon, Calendar03Icon, Cancel01Icon, CheckListIcon, Delete02Icon, Tag01Icon, Tick02Icon, UserCircleIcon,
} from '@hugeicons/core-free-icons'

import { DayPicker } from '@/components/tasks/day-picker'
import { PriorityGlyph, StatusGlyph } from '@/components/tasks/glyphs'
import { LabelSheet } from '@/components/tasks/label-sheet'
import { PickerSheet } from '@/components/tasks/picker-sheet'
import { LabelDot } from '@/components/tasks/todo-list'
import {
  PRIORITIES, STATUSES, addTodo, deleteTodo, dueLabel, statusLabel, updateTodo, useLabels, useTodos, type Todo, type TodoStatus,
} from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { type, useTheme } from '@/theme'
import { Button, Icon, IconButton, Press, Sheet, Text, TeammateAvatar, confirm, haptic, toast } from '@/ui'

type Draft = Pick<Todo, 'title' | 'notes' | 'status' | 'priority' | 'due' | 'project_id' | 'assignee' | 'labels'>
type Picker = 'status' | 'priority' | 'assignee' | 'due' | 'project' | 'labels' | null

export default function TodoScreen() {
  const { id, status, label } = useLocalSearchParams<{ id: string; status?: TodoStatus; label?: string }>()
  const { todos } = useTodos()
  const todo = id === 'new' ? null : todos?.find((t) => t.id === id) ?? null
  if (id !== 'new' && !todo) return <Shell />
  return <Editor key={todo?.id ?? 'new'} todo={todo} start={status} label={label} />
}

function Shell() {
  const { c } = useTheme()
  return <View style={{ flex: 1, backgroundColor: c.canvas }} />
}

function Editor({ todo, start, label }: { todo: Todo | null; start?: TodoStatus; label?: string }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const [d, setD] = useState<Draft>(() => todo
    ? { title: todo.title, notes: todo.notes, status: todo.status, priority: todo.priority, due: todo.due, project_id: todo.project_id, assignee: todo.assignee, labels: todo.labels ?? [] }
    : { title: '', notes: '', status: start ?? 'todo', priority: 0, due: null, project_id: null, assignee: null, labels: label ? [label] : [] })
  const [picker, setPickerState] = useState<Picker>(null)
  // A picker gets the whole bottom of the screen: the keyboard goes first.
  const setPicker = (p: Picker) => { if (p) Keyboard.dismiss(); setPickerState(p) }
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<TextInput>(null)
  const notesRef = useRef<TextInput>(null)
  const editing = !!todo

  // A new one: the keyboard is up for the title as the screen arrives.
  useEffect(() => {
    if (editing) return
    const t = setTimeout(() => titleRef.current?.focus(), 250)
    return () => clearTimeout(t)
  }, [editing])

  // Editing: the words save shortly after you stop typing; properties save the moment they change.
  useEffect(() => {
    if (!todo || !d.title.trim() || (d.title.trim() === todo.title && d.notes === todo.notes)) return
    const t = setTimeout(() => {
      updateTodo(todo.id, { title: d.title.trim(), notes: d.notes }).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
    }, 600)
    return () => clearTimeout(t)
  }, [d.title, d.notes, todo])

  const set = (changes: Partial<Draft>) => {
    setD((x) => ({ ...x, ...changes }))
    if (todo) {
      updateTodo(todo.id, changes).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
      if (changes.assignee) toast({ title: `${ws.teammate(changes.assignee)?.name ?? 'They'}’s on it`, body: 'It’s in their chat now.' })
    }
  }

  const create = async () => {
    if (!d.title.trim()) { titleRef.current?.focus(); return }
    setSaving(true)
    try {
      await addTodo({ ...d, title: d.title.trim() })
      haptic.success()
      if (d.assignee) toast({ title: `${ws.teammate(d.assignee)?.name ?? 'They'}’s on it`, body: 'It’s in their chat now.' })
      router.back()
    } catch (e) {
      toast({ title: 'Unable to add it', body: (e as Error).message, tone: 'error' })
      setSaving(false)
    }
  }

  const project = ws.projects.find((p) => p.id === d.project_id)
  const mate = d.assignee ? ws.teammate(d.assignee) : null
  const due = d.due ? dueLabel(d.due) : null
  const adder = todo?.added_by ? ws.teammate(todo.added_by) : null
  const ready = !!d.title.trim()
  const labels = useLabels()
  const mine = labels.filter((l) => d.labels.includes(l.id))

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <RoundButton icon={Cancel01Icon} label="Close" onPress={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Press radius={24} onPress={() => setPicker('project')} accessibilityLabel={`In ${project?.name ?? 'Personal'}. Change`}
            style={{ height: 48, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, maxWidth: 220 }}>
            {project ? <View style={{ width: 14, height: 14, borderRadius: 4.5, backgroundColor: project.color }} /> : <Icon icon={CheckListIcon} size={18} color="tube" />}
            <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>{project?.name ?? 'Personal'}</Text>
          </Press>
        </View>
        {editing
          ? <RoundButton icon={Tick02Icon} label="Done" onPress={() => router.back()} />
          : <RoundButton icon={ArrowUp02Icon} label="Add to-do" solid={ready} disabled={!ready || saving} onPress={create} />}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 28, paddingBottom: 220, gap: 10 }}>
        <TextInput cursorColor={c.tube} selectionColor={c.tube} selectionHandleColor={c.tube} ref={titleRef} value={d.title} onChangeText={(title) => setD((x) => ({ ...x, title }))}
          placeholder="To-do title" placeholderTextColor={c.ink4} multiline maxLength={300}
          submitBehavior="blurAndSubmit" returnKeyType="next" onSubmitEditing={() => notesRef.current?.focus()}
          style={[type.title, { color: c.ink, padding: 0 }]} accessibilityLabel="Title" />
        <TextInput cursorColor={c.tube} selectionColor={c.tube} selectionHandleColor={c.tube} ref={notesRef} value={d.notes} onChangeText={(notes) => setD((x) => ({ ...x, notes }))}
          placeholder="Add notes…" placeholderTextColor={c.ink4} multiline maxLength={5000}
          style={[type.body, { fontSize: 17, lineHeight: 25, color: c.ink2, padding: 0, minHeight: 120, textAlignVertical: 'top' }]} accessibilityLabel="Notes" />
        {editing && (adder || todo?.thread_id) && (
          <Press radius={10} static outerStyle={{ alignSelf: 'flex-start', marginLeft: -6, marginTop: 8 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, minHeight: 32 }} disabled={!todo?.thread_id}
            onPress={() => router.push({ pathname: '/chat/[threadId]', params: { threadId: todo!.thread_id! } })}>
            {adder && <TeammateAvatar teammate={adder} size={18} interactive={false} />}
            <Text variant="footnote" color="ink3">
              {[adder && `Added by ${adder.name}`, todo?.thread_id && `in ${ws.threadTitle(todo.thread_id)}`].filter(Boolean).join(' ')}
            </Text>
            {todo?.thread_id && <Icon icon={ArrowRight01Icon} size={13} color="ink3" />}
          </Press>
        )}
      </ScrollView>

      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <View style={{ paddingBottom: insets.bottom, backgroundColor: c.canvas }}>
          <View style={{ marginHorizontal: 12, padding: 10, borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Pill glyph={<StatusGlyph status={d.status} size={17} />} label={statusLabel(d.status)} onPress={() => setPicker('status')} a11y="Status" />
            <Pill glyph={<PriorityGlyph priority={d.priority} size={16} />} label={d.priority ? PRIORITIES[d.priority].label : 'Priority'} quiet={!d.priority} onPress={() => setPicker('priority')} a11y="Priority" />
            <Pill glyph={mate ? <TeammateAvatar teammate={mate} size={20} interactive={false} /> : <Icon icon={UserCircleIcon} size={18} color="ink3" />}
              label={mate?.name ?? 'Assignee'} quiet={!mate} onPress={() => setPicker('assignee')} a11y="Assignee" />
            <Pill glyph={<Icon icon={Calendar03Icon} size={17} color={due?.overdue ? 'danger' : due?.today ? 'warning' : due ? 'ink2' : 'ink3'} />}
              label={due?.label ?? 'Due date'} quiet={!due} tone={due?.overdue ? 'danger' : undefined} onPress={() => setPicker('due')} a11y="Due date" />
            <Pill glyph={mine.length ? <View style={{ flexDirection: 'row', gap: 3 }}>{mine.slice(0, 3).map((l) => <LabelDot key={l.id} color={l.color} size={9} />)}</View> : <Icon icon={Tag01Icon} size={17} color="ink3" />}
              label={mine.length ? mine.map((l) => l.name).join(', ') : 'Labels'} quiet={!mine.length} onPress={() => setPicker('labels')} a11y="Labels" />
          </View>
          {editing && (
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 14, height: 52, alignItems: 'center' }}>
              <IconButton icon={Delete02Icon} iconSize={21} color={c.ink3} accessibilityLabel="Delete to-do" onPress={async () => {
                if (!await confirm({ title: 'Delete this to-do?', body: todo!.title, confirmLabel: 'Delete to-do', destructive: true })) return
                router.back()
                deleteTodo(todo!.id).catch((e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' }))
              }} />
            </View>
          )}
          {!editing && <View style={{ height: 12 }} />}
        </View>
      </KeyboardStickyView>

      <PickerSheet open={picker === 'status'} title="Status" value={d.status} onClose={() => setPicker(null)} onPick={(status) => set({ status })}
        choices={STATUSES.map((s) => ({ value: s.value, label: s.label, glyph: <StatusGlyph status={s.value} size={18} /> }))} />
      <PickerSheet open={picker === 'priority'} title="Priority" value={d.priority} onClose={() => setPicker(null)} onPick={(priority) => set({ priority })}
        choices={[0, 1, 2, 3, 4].map((p) => ({ value: p, label: PRIORITIES[p].label, glyph: <PriorityGlyph priority={p} size={16} /> }))} />
      <PickerSheet open={picker === 'assignee'} title="Assignee" value={d.assignee} onClose={() => setPicker(null)} onPick={(assignee) => set({ assignee })}
        choices={[
          { value: null, label: 'Me', sub: 'On your own list', glyph: <Icon icon={UserCircleIcon} size={22} color="ink2" /> },
          ...ws.teammates.map((t) => ({ value: t.id as string | null, label: t.name, sub: t.role || undefined, glyph: <TeammateAvatar teammate={t} size={24} interactive={false} /> })),
        ]}
        footer={<Text variant="footnote" color="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>A teammate gets it in their chat, starts on it and keeps its status up to date.</Text>} />
      <PickerSheet open={picker === 'project'} title="List" value={d.project_id} onClose={() => setPicker(null)} onPick={(project_id) => set({ project_id })}
        choices={[
          { value: null, label: 'Personal', glyph: <Icon icon={CheckListIcon} size={18} color="tube" /> },
          ...ws.projects.map((p) => ({ value: p.id as string | null, label: p.name, glyph: <View style={{ width: 14, height: 14, borderRadius: 4.5, backgroundColor: p.color }} /> })),
        ]} />
      <LabelSheet open={picker === 'labels'} value={d.labels} onChange={(labels) => set({ labels })} onClose={() => setPicker(null)} />
      <Sheet open={picker === 'due'} onClose={() => setPicker(null)} title="Due date">
        <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 10 }}>
          <DayPicker value={d.due} onChange={(due) => { set({ due }); setPicker(null) }} />
          {d.due && <Button label="No due date" variant="ghost" onPress={() => { set({ due: null }); setPicker(null) }} />}
        </View>
      </Sheet>
    </View>
  )
}

function RoundButton({ icon, label, onPress, solid, disabled }: { icon: Parameters<typeof Icon>[0]['icon']; label: string; onPress: () => void; solid?: boolean; disabled?: boolean }) {
  const { c } = useTheme()
  return (
    <Press radius={26} smoothing={0} onPress={onPress} disabled={disabled} accessibilityLabel={label}
      style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: solid ? c.ink : c.panel2, borderWidth: solid ? 0 : 1, borderColor: c.line }}>
      <Icon icon={icon} size={22} color={solid ? c.canvas : disabled ? 'ink4' : 'ink'} strokeWidth={2} />
    </Press>
  )
}

function Pill({ glyph, label, quiet, tone, onPress, a11y }: { glyph: React.ReactNode; label: string; quiet?: boolean; tone?: 'danger'; onPress: () => void; a11y: string }) {
  const { c } = useTheme()
  return (
    <Press radius={20} onPress={onPress} accessibilityLabel={`${a11y}: ${label}`} accessibilityRole="button"
      style={{ height: 40, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.panel2 }}>
      {glyph}
      <Text variant="bodyMedium" color={tone ?? (quiet ? 'ink3' : 'ink')}>{label}</Text>
    </Press>
  )
}

