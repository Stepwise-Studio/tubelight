// A property's choices as a sheet of rows (Linear's pickers): a glyph, the label, a check on the current one.
import { type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { Tick02Icon } from '@hugeicons/core-free-icons'

import { Icon, Press, Sheet, Text, haptic } from '@/ui'

export interface Choice<T> { value: T; label: string; glyph?: ReactNode; sub?: string }

export function PickerSheet<T>({ open, title, choices, value, onPick, onClose, footer }: {
  open: boolean; title: string; choices: Choice<T>[]; value: T; onPick: (v: T) => void; onClose: () => void; footer?: ReactNode
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 14 }}>
        {choices.map((ch) => {
          const on = ch.value === value
          return (
            <Press key={String(ch.value)} radius={14} onPress={() => { haptic.tap(); onPick(ch.value); onClose() }}
              accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={ch.label}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 50, paddingHorizontal: 12 }}>
              <View style={{ width: 24, alignItems: 'center' }}>{ch.glyph}</View>
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium">{ch.label}</Text>
                {ch.sub && <Text variant="footnote" color="ink3" numberOfLines={1}>{ch.sub}</Text>}
              </View>
              {on && <Icon icon={Tick02Icon} size={18} color="ink" strokeWidth={2} />}
            </Press>
          )
        })}
        {footer}
      </ScrollView>
    </Sheet>
  )
}
