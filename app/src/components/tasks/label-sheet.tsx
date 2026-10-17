// Labels. For a to-do (`value`/`onChange`): tick any number, type a name to make one (ticked at once), hold one to
// rename, recolour or delete it everywhere. Without them (the Labels button on Tasks): all labels, tap one to edit it.
import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { Add01Icon, Delete02Icon, Edit02Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { LABEL_COLORS, addLabel, deleteLabel, updateLabel, useLabels, useTodos, type Label } from '@/lib/tasks'
import { type, useTheme } from '@/theme'
import { Icon, Sheet, Text, confirm, haptic, showMenu } from '@/ui'

import { LabelDot } from './todo-list'

const NONE: string[] = []
const COLOR_NAMES = ['Blue', 'Green', 'Amber', 'Pink', 'Violet', 'Teal', 'Red', 'Slate']

export function LabelSheet({ open, value = NONE, onChange, onClose }: { open: boolean; value?: string[]; onChange?: (ids: string[]) => void; onClose: () => void }) {
  const { c } = useTheme()
  const labels = useLabels()
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<Label | null>(null)
  const counts = new Map<string, number>()
  for (const t of useTodos().todos ?? []) for (const id of t.labels ?? []) if (t.status !== 'done' && t.status !== 'canceled') counts.set(id, (counts.get(id) ?? 0) + 1)
  const toggle = (id: string) => { haptic.tap(); onChange?.(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]) }
  const submit = () => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    if (renaming) updateLabel(renaming.id, { name: n })
    else {
      const have = labels.find((l) => l.name.toLowerCase() === n.toLowerCase())
      const id = have?.id ?? addLabel(n).id
      if (onChange && !value.includes(id)) onChange([...value, id])
    }
    haptic.success()
    setName('')
    setRenaming(null)
  }
  const hold = (l: Label) => showMenu({
    title: l.name,
    items: [
      { label: 'Rename', icon: Edit02Icon, onPress: () => { setRenaming(l); setName(l.name) } },
      { label: 'Colour', glyph: <LabelDot color={l.color} size={14} />, onPress: () => setTimeout(() => showMenu({
        title: `${l.name} colour`,
        items: LABEL_COLORS.map((color, i) => ({ label: COLOR_NAMES[i], glyph: <LabelDot color={color} size={14} />, checked: color === l.color, onPress: () => updateLabel(l.id, { color }) })),
      }), 250) },
      { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: async () => {
        if (await confirm({ title: `Delete “${l.name}”?`, body: 'It comes off every to-do that has it.', confirmLabel: 'Delete label', destructive: true })) deleteLabel(l.id)
      } },
    ],
  })

  return (
    <Sheet open={open} onClose={onClose} title="Labels">
      <View style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
        {labels.map((l) => {
          const on = value.includes(l.id)
          return (
            <Pressable key={l.id} onPress={() => (onChange ? toggle(l.id) : hold(l))} onLongPress={() => hold(l)} android_ripple={{ color: c.wash }}
              accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={l.name} accessibilityHint="Hold to rename or delete"
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
          <Icon icon={renaming ? Edit02Icon : Add01Icon} size={18} color="ink3" />
          <TextInput value={name} onChangeText={setName} onSubmitEditing={submit} submitBehavior="submit" returnKeyType="done"
            placeholder={renaming ? `Rename ${renaming.name}` : 'New label'} placeholderTextColor={c.ink4} maxLength={40}
            cursorColor={c.tube} selectionColor={c.tube} style={[type.body, { flex: 1, color: c.ink, padding: 0 }]} accessibilityLabel="Label name" />
          {!!name.trim() && (
            <Pressable onPress={submit} hitSlop={10} accessibilityRole="button" accessibilityLabel={renaming ? 'Rename' : 'Add label'}>
              <Text variant="label" color="tube">{renaming ? 'Rename' : 'Add'}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Sheet>
  )
}
