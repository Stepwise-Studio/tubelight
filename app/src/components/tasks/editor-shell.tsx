// The full-screen editors' frame (to-do, alarm, reminder, event): close on the left, what it is in the middle, save on
// the right (an arrow up while new, a tick while editing), the form scrolling below, delete at the end.
import { router } from 'expo-router'
import type { ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp02Icon, Cancel01Icon, Delete02Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'
import { Button, Icon, Press, Text, confirm, haptic } from '@/ui'

export function RoundButton({ icon, label, onPress, solid, disabled }: { icon: Parameters<typeof Icon>[0]['icon']; label: string; onPress: () => void; solid?: boolean; disabled?: boolean }) {
  const { c } = useTheme()
  return (
    <Press radius={26} smoothing={0} onPress={onPress} disabled={disabled} accessibilityLabel={label}
      style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: solid ? c.ink : c.panel2, borderWidth: solid ? 0 : 1, borderColor: c.line }}>
      <Icon icon={icon} size={22} color={solid ? c.canvas : disabled ? 'ink4' : 'ink'} strokeWidth={2} />
    </Press>
  )
}

export function EditorShell({ title, editing, ready, onSave, onDelete, deleteWhat, children }: {
  title: string; editing: boolean; ready: boolean; onSave: () => void
  /** Asked first ("Delete this alarm?"), then run. */
  onDelete?: () => void; deleteWhat?: string; children: ReactNode
}) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <RoundButton icon={Cancel01Icon} label="Close" onPress={() => router.back()} />
        <Text variant="headline" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{title}</Text>
        <RoundButton icon={editing ? Tick02Icon : ArrowUp02Icon} label="Save" solid={ready} disabled={!ready} onPress={onSave} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: insets.bottom + 40, gap: 22 }}>
        {children}
        {editing && onDelete && (
          <Button label={`Delete ${deleteWhat}`} variant="ghost" icon={Delete02Icon} onPress={async () => {
            if (!await confirm({ title: `Delete this ${deleteWhat}?`, confirmLabel: `Delete ${deleteWhat}`, destructive: true })) return
            router.back()
            onDelete()
          }} />
        )}
      </ScrollView>
    </View>
  )
}

/** A labelled block of the form. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" color="ink3" style={{ paddingLeft: 2 }}>{label}</Text>
      {children}
    </View>
  )
}

/** One of a few choices, as pills (repeat, alert). */
export function Chips({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable key={o.value} onPress={() => { haptic.tap(); onChange(o.value) }} accessibilityRole="radio" accessibilityState={{ checked: on }}
            style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: on ? c.ink : c.panel2, borderWidth: on ? 0 : 1, borderColor: c.line }}>
            <Text variant="label" style={{ color: on ? c.canvas : c.ink2 }}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
