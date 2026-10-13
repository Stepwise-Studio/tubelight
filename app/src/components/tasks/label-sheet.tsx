// A to-do's labels: tick any number, make a new one by typing its name (it's ticked at once), hold one to rename or
// delete it everywhere.
import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { Add01Icon, Delete02Icon, Edit02Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { LABEL_COLORS, addLabel, deleteLabel, updateLabel, useLabels, type Label } from '@/lib/tasks'
import { type, useTheme } from '@/theme'
import { Icon, Sheet, Text, confirm, haptic, showMenu } from '@/ui'

import { LabelDot } from './todo-list'

export function LabelSheet({ open, value, onChange, onClose }: { open: boolean; value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const { c } = useTheme()
  const labels = useLabels()
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<Label | null>(null)
  const toggle = (id: string) => { haptic.tap(); onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]) }
  const submit = () => {
    const n = name.trim().replace(/\s+/g, ' ')
    if (!n) return
    if (renaming) updateLabel(renaming.id, { name: n })
    else {
      const have = labels.find((l) => l.name.toLowerCase() === n.toLowerCase())
      const id = have?.id ?? addLabel(n).id
      if (!value.includes(id)) onChange([...value, id])
    }
    haptic.success()
    setName('')
    setRenaming(null)
  }
  const hold = (l: Label) => showMenu({
    title: l.name,
    items: [
      { label: 'Rename', icon: Edit02Icon, onPress: () => { setRenaming(l); setName(l.name) } },
      { label: 'Change colour', onPress: () => updateLabel(l.id, { color: LABEL_COLORS[(LABEL_COLORS.indexOf(l.color) + 1) % LABEL_COLORS.length] }) },
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
            <Pressable key={l.id} onPress={() => toggle(l.id)} onLongPress={() => hold(l)} android_ripple={{ color: c.wash }}
              accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={l.name} accessibilityHint="Hold to rename or delete"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 50, paddingHorizontal: 10, borderRadius: 14 }}>
              <LabelDot color={l.color} size={12} />
              <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{l.name}</Text>
              {on && <Icon icon={Tick02Icon} size={20} color="ink" strokeWidth={2} />}
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
