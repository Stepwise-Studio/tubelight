// Labels. For a to-do (`value`/`onChange`): tick any number, type a name to make one (ticked at once), hold one to edit
// it. Without them (the Labels button on Tasks): every label with its open to-dos, tap one to edit it. Editing happens in
// place in the same sheet: the name, a row of colours, Save and Delete.
import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { Add01Icon, ArrowLeft01Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { LABEL_COLORS, addLabel, deleteLabel, updateLabel, useLabels, useTodos, type Label } from '@/lib/tasks'
import { motion, type, useTheme } from '@/theme'
import { Icon, IconButton, Sheet, Text, confirm, haptic } from '@/ui'

import { LabelDot } from './todo-list'

const NONE: string[] = []

export function LabelSheet({ open, value = NONE, onChange, onClose }: { open: boolean; value?: string[]; onChange?: (ids: string[]) => void; onClose: () => void }) {
  const { c } = useTheme()
  const labels = useLabels()
  const { todos } = useTodos()
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Label | null>(null)
  const counts = new Map<string, number>()
  for (const t of todos ?? []) for (const id of t.labels ?? []) if (t.status !== 'done' && t.status !== 'canceled') counts.set(id, (counts.get(id) ?? 0) + 1)
  const toggle = (id: string) => { haptic.tap(); onChange?.(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]) }
  const add = () => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    const have = labels.find((l) => l.name.toLowerCase() === n.toLowerCase())
    const id = have?.id ?? addLabel(n).id
    if (onChange && !value.includes(id)) onChange([...value, id])
    haptic.success()
    setName('')
  }
  const close = () => { setEditing(null); onClose() }

  return (
    <Sheet open={open} onClose={close} title={editing ? undefined : 'Labels'} accessibilityLabel={editing ? 'Edit label' : 'Labels'}>
      {editing ? (
        <LabelEditor key={editing.id} label={editing} uses={counts.get(editing.id) ?? 0} onDone={() => setEditing(null)} />
      ) : (
        <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
          {labels.map((l) => {
            const on = value.includes(l.id)
            return (
              <Pressable key={l.id} onPress={() => (onChange ? toggle(l.id) : setEditing(l))} onLongPress={() => { haptic.light(); setEditing(l) }}
                android_ripple={{ color: c.wash }} accessibilityRole={onChange ? 'checkbox' : 'button'} accessibilityState={{ checked: on }}
                accessibilityLabel={l.name} accessibilityHint={onChange ? 'Hold to edit' : 'Edit'}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 50, paddingHorizontal: 10, borderRadius: 14 }}>
                <LabelDot color={l.color} size={12} />
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{l.name}</Text>
                {onChange ? on && <Icon icon={Tick02Icon} size={20} color="ink" strokeWidth={2} /> : <Text variant="label" color="ink3" tabular>{counts.get(l.id) ?? 0}</Text>}
              </Pressable>
            )
          })}
          {!labels.length && (
            <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 10, paddingBottom: 10 }}>Labels group to-dos across statuses: study, dev, home…</Text>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, marginTop: 6, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.panel2 }}>
            <Icon icon={Add01Icon} size={18} color="ink3" />
            <TextInput value={name} onChangeText={setName} onSubmitEditing={add} submitBehavior="submit" returnKeyType="done"
              placeholder="New label" placeholderTextColor={c.ink4} maxLength={40}
              cursorColor={c.tube} selectionColor={c.tube} style={[type.body, { flex: 1, color: c.ink, padding: 0 }]} accessibilityLabel="New label name" />
            {!!name.trim() && (
              <Pressable onPress={add} hitSlop={10} accessibilityRole="button" accessibilityLabel="Add label">
                <Text variant="label" color="tube">Add</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </Sheet>
  )
}

/** One label: how it reads on a to-do, its name, a row of colours, Save and Delete. */
function LabelEditor({ label, uses, onDone }: { label: Label; uses: number; onDone: () => void }) {
  const { c } = useTheme()
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState(label.color)
  const clean = name.trim().replace(/\s+/g, ' ')
  const save = () => {
    if (!clean) return
    if (clean !== label.name || color !== label.color) updateLabel(label.id, { name: clean, color })
    haptic.success()
    onDone()
  }
  return (
    <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ paddingHorizontal: 20, paddingBottom: 18, gap: 18 }}>
      {/* The sheet's title row, with the way back beside it. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -12, marginTop: -4, marginBottom: -8 }}>
        <IconButton icon={ArrowLeft01Icon} size={36} iconSize={18} color={c.ink2} accessibilityLabel="Back to labels" onPress={onDone} />
        <Text variant="headline" accessibilityRole="header">Edit label</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: `${color}22` }}>
          <LabelDot color={color} size={8} />
          <Text variant="label" numberOfLines={1}>{clean || 'Label'}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text variant="footnote" color="ink3">{uses ? `${uses} open to-do${uses === 1 ? '' : 's'}` : 'Not on any open to-do'}</Text>
      </View>
      <TextInput value={name} onChangeText={setName} onSubmitEditing={save} submitBehavior="blurAndSubmit" returnKeyType="done" maxLength={40}
        placeholder="Label name" placeholderTextColor={c.ink4} cursorColor={c.tube} selectionColor={c.tube}
        style={[type.body, { color: c.ink, height: 52, paddingHorizontal: 16, borderRadius: 16, backgroundColor: c.panel2, fontSize: 17 }]} accessibilityLabel="Label name" />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {LABEL_COLORS.map((col) => {
          const on = col === color
          return (
            <Pressable key={col} onPress={() => { haptic.tap(); setColor(col) }} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`Colour ${col}`}
              style={{ width: 36, height: 36, borderRadius: 18, padding: 3, borderWidth: 2, borderColor: on ? c.ink : 'transparent' }}>
              <View style={{ flex: 1, borderRadius: 14, backgroundColor: col }} />
            </Pressable>
          )
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Delete label" onPress={async () => {
            if (!await confirm({ title: `Delete “${label.name}”?`, body: 'It comes off every to-do that has it.', confirmLabel: 'Delete label', destructive: true })) return
            deleteLabel(label.id)
            onDone()
          }} style={{ height: 44, borderRadius: 22, backgroundColor: c.dangerSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Text variant="bodyMedium" color="danger">Delete</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Save label" accessibilityState={{ disabled: !clean }} disabled={!clean} onPress={save}
            style={{ height: 44, borderRadius: 22, backgroundColor: c.ink, opacity: clean ? 1 : 0.4, alignItems: 'center', justifyContent: 'center' }}>
            <Text variant="bodyMedium" style={{ color: c.canvas }}>Save</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  )
}
