// New / edit to-do, Linear-style: a big title, notes, and a row of property pills (status, priority, due, project).
// Editing saves as you go: pills at once, the words when the sheet closes.
import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import { ArrowRight01Icon, Calendar03Icon, Delete02Icon } from '@hugeicons/core-free-icons'

import {
  PRIORITIES, STATUSES, addTodo, deleteTodo, dueLabel, statusLabel, updateTodo, type Todo, type TodoStatus,
} from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { type, useTheme } from '@/theme'
import { Button, Collapse, Icon, Press, Sheet, Squircle, Text, confirm, haptic, showMenu, toast } from '@/ui'

import { DayPicker } from './day-picker'
import { PriorityGlyph, StatusGlyph } from './glyphs'

interface Draft { title: string; notes: string; status: TodoStatus; priority: number; due: string | null; project_id: string | null }

const blank = (status: TodoStatus = 'todo'): Draft => ({ title: '', notes: '', status, priority: 0, due: null, project_id: null })

/** Mount it with a new `key` for each opening: it starts from `todo` (or a blank one). */
export function TodoSheet({ open, onClose, todo, status }: {
  open: boolean
  onClose: () => void
  /** Editing this one; otherwise a new to-do. */
  todo?: Todo | null
  /** A new one's starting status (a group's +). */
  status?: TodoStatus
}) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const [d, setD] = useState<Draft>(() => (todo
    ? { title: todo.title, notes: todo.notes, status: todo.status, priority: todo.priority, due: todo.due, project_id: todo.project_id }
    : blank(status)))
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<TextInput>(null)
  const editing = !!todo

  // A new one: the keyboard comes up once the sheet has risen.
  useEffect(() => {
    if (!open || todo) return
    const t = setTimeout(() => titleRef.current?.focus(), 350)
    return () => clearTimeout(t)
  }, [open, todo])

  /** A property: in the draft, and saved straight away when editing. */
  const set = (changes: Partial<Draft>) => {
    setD((x) => ({ ...x, ...changes }))
    if (todo) updateTodo(todo.id, changes).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
  }

  const close = () => {
    if (todo && (d.title.trim() !== todo.title || d.notes !== todo.notes) && d.title.trim()) {
      updateTodo(todo.id, { title: d.title.trim(), notes: d.notes }).catch((e) => toast({ title: 'Unable to save', body: (e as Error).message, tone: 'error' }))
    }
    onClose()
  }

  const create = async () => {
    if (!d.title.trim()) { titleRef.current?.focus(); return }
    setSaving(true)
    try {
      await addTodo({ ...d, title: d.title.trim() })
      haptic.success()
      onClose()
    } catch (e) {
      toast({ title: 'Unable to add it', body: (e as Error).message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const project = ws.projects.find((p) => p.id === d.project_id)
  const due = d.due ? dueLabel(d.due) : null
  const adder = todo?.added_by ? ws.teammate(todo.added_by) : null

  return (
    <Sheet open={open} onClose={close} accessibilityLabel={editing ? 'Edit to-do' : 'New to-do'}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 640 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <TextInput
            ref={titleRef}
            value={d.title}
            onChangeText={(title) => setD((x) => ({ ...x, title }))}
            placeholder="What needs doing?"
            placeholderTextColor={c.ink4}
            multiline
            maxLength={300}
            submitBehavior="blurAndSubmit"
            returnKeyType={editing ? 'done' : 'next'}
            onSubmitEditing={() => { if (!editing) create() }}
            style={[type.heading, { color: c.ink, padding: 0, paddingTop: 4 }]}
            accessibilityLabel="Title"
          />
          <TextInput
            value={d.notes}
            onChangeText={(notes) => setD((x) => ({ ...x, notes }))}
            placeholder="Add notes…"
            placeholderTextColor={c.ink4}
            multiline
            maxLength={5000}
            style={[type.body, { color: c.ink2, padding: 0, minHeight: 44, maxHeight: 180, textAlignVertical: 'top' }]}
            accessibilityLabel="Notes"
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -20 }}>
          <View style={{ width: 12 }} />
          <Pill label={statusLabel(d.status)} accessibilityLabel={`Status: ${statusLabel(d.status)}`} glyph={<StatusGlyph status={d.status} size={16} />}
            onPress={() => showMenu({ title: 'Status', items: STATUSES.map((s) => ({ label: s.label, value: s.value === d.status ? '✓' : undefined, onPress: () => set({ status: s.value }) })) })} />
          <Pill label={d.priority ? PRIORITIES[d.priority].label : 'Priority'} quiet={!d.priority} accessibilityLabel={`Priority: ${PRIORITIES[d.priority].label}`}
            glyph={<PriorityGlyph priority={d.priority} size={15} />}
            onPress={() => showMenu({ title: 'Priority', items: PRIORITIES.map((p) => ({ label: p.label, value: p.value === d.priority ? '✓' : undefined, onPress: () => set({ priority: p.value }) })) })} />
          <Pill label={due?.label ?? 'Due date'} quiet={!due} tone={due?.overdue ? c.danger : due?.today ? c.warning : undefined}
            accessibilityLabel={due ? `Due ${due.label}` : 'Set a due date'} icon={Calendar03Icon} active={picking}
            onPress={() => { haptic.tap(); setPicking((v) => !v) }} />
          {ws.projects.length > 0 && (
            <Pill label={project?.name ?? 'Project'} quiet={!project} accessibilityLabel={project ? `Project: ${project.name}` : 'Add to a project'}
              glyph={<View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: project?.color ?? c.ink4 }} />}
              onPress={() => showMenu({
                title: 'Project',
                items: [{ label: 'No project', onPress: () => set({ project_id: null }) },
                  ...ws.projects.map((p) => ({ label: p.name, value: p.id === d.project_id ? '✓' : undefined, onPress: () => set({ project_id: p.id }) }))],
              })} />
          )}
          <View style={{ width: 12 }} />
        </ScrollView>

        <Collapse open={picking}>
          <Squircle style={{ borderRadius: 20, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, padding: 14, gap: 10 }}>
            <DayPicker value={d.due} onChange={(due) => { set({ due }); setPicking(false) }} />
            {d.due && <Button label="No due date" variant="ghost" size="sm" onPress={() => { set({ due: null }); setPicking(false) }} />}
          </Squircle>
        </Collapse>

        {editing && (adder || todo?.thread_id) && (
          <Press radius={10} static outerStyle={{ alignSelf: 'flex-start', marginLeft: -6 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 32 }}
            disabled={!todo?.thread_id}
            onPress={() => { onClose(); router.push({ pathname: '/chat/[threadId]', params: { threadId: todo!.thread_id! } }) }}
            accessibilityLabel={todo?.thread_id ? `Open ${ws.threadTitle(todo.thread_id)}` : undefined}>
            <Text variant="footnote" color="ink3">
              {[adder && `Added by ${adder.name}`, todo?.thread_id && `in ${ws.threadTitle(todo.thread_id)}`].filter(Boolean).join(' ')}
            </Text>
            {todo?.thread_id && <Icon icon={ArrowRight01Icon} size={13} color="ink3" />}
          </Press>
        )}

        {editing ? (
          <Button label="Delete to-do" variant="ghost" icon={Delete02Icon} fullWidth
            onPress={async () => {
              if (!await confirm({ title: 'Delete this to-do?', body: todo!.title, confirmLabel: 'Delete to-do', destructive: true })) return
              onClose()
              deleteTodo(todo!.id).catch((e) => toast({ title: 'Unable to delete', body: (e as Error).message, tone: 'error' }))
            }} />
        ) : (
          <Button label="Add to-do" fullWidth size="lg" loading={saving} disabled={!d.title.trim()} onPress={create} />
        )}
      </ScrollView>
    </Sheet>
  )
}

/** A property pill: glyph + value; quiet (placeholder ink) when unset. */
function Pill({ label, glyph, icon, quiet, tone, active, onPress, accessibilityLabel }: {
  label: string; glyph?: React.ReactNode; icon?: Parameters<typeof Icon>[0]['icon']; quiet?: boolean; tone?: string; active?: boolean
  onPress: () => void; accessibilityLabel: string
}) {
  const { c } = useTheme()
  return (
    <Press radius={12} onPress={onPress} accessibilityLabel={accessibilityLabel} accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 11, borderWidth: 1,
        borderColor: active ? c.tube : c.edge, backgroundColor: active ? c.tubeSoft : c.panel,
      }}>
      {glyph ?? (icon && <Icon icon={icon} size={15} color={tone ?? (quiet ? 'ink3' : 'ink2')} />)}
      <Text variant="label" color={tone ?? (quiet ? 'ink3' : 'ink')}>{label}</Text>
    </Press>
  )
}
