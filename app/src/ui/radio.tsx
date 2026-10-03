import { type ReactNode, useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { UnfoldMoreIcon } from '@hugeicons/core-free-icons'

import { motion, radius, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { Press } from './press'
import { SearchField } from './text-field'
import { Sheet } from './sheet'
import { Surface } from './surface'
import { Text } from './text'

const SIZES = { sm: { sq: 16, dot: 6 }, default: { sq: 20, dot: 8 }, lg: { sq: 24, dot: 10 } } as const

/** Stepwise UI's Radio (ui.stepwise.studio/r/radio): a filled circle with a dot that pops in when checked. Visual
 * only: the row around it is the hit target (see RadioRow). */
export function Radio({ checked, size = 'default' }: { checked: boolean; size?: keyof typeof SIZES }) {
  const { c, scheme } = useTheme()
  const s = SIZES[size]
  const on = scheme === 'dark' ? '#ffffff' : '#18181b'
  const dot = useAnimatedStyle(() => ({
    opacity: withTiming(checked ? 1 : 0, { duration: 180, easing: motion.ease.smoothOut }),
    transform: [{ scale: withTiming(checked ? 1 : 0, { duration: 180, easing: motion.ease.smoothOut }) }],
  }), [checked])
  return (
    <View style={{
      width: s.sq, height: s.sq, borderRadius: s.sq / 2, alignItems: 'center', justifyContent: 'center',
      backgroundColor: checked ? on : c.panel, borderWidth: checked ? 0 : 1, borderColor: 'rgba(138,138,141,0.23)',
    }}>
      <Animated.View style={[{ width: s.dot, height: s.dot, borderRadius: s.dot / 2, backgroundColor: scheme === 'dark' ? '#18181b' : '#ffffff' }, dot]} />
    </View>
  )
}

/** A choosable row: leading art, title, subtitle, a radio at the end. The whole row is the radio. */
export function RadioRow({ title, subtitle, leading, trailing, checked, onPress, subtitleLines = 1 }: {
  title: string; subtitle?: string; leading?: ReactNode; trailing?: ReactNode; checked: boolean; onPress: () => void; subtitleLines?: number
}) {
  return (
    <Press
      radius={radius.md}
      static
      onPress={() => { haptic.tap(); onPress() }}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 12 }}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text variant="caption" color="ink3" numberOfLines={subtitleLines}>{subtitle}</Text> : null}
      </View>
      {trailing}
      <Radio checked={checked} />
    </Press>
  )
}

export interface PickerOption {
  value: string
  title: string
  subtitle?: string
  leading?: ReactNode
  trailing?: ReactNode
  /** Groups options under a small heading, in first-seen order. */
  group?: string
  /** Extra words the search matches (a provider name, a handle). */
  keywords?: string
}

/** The radio-list sheet (as in the model picker): pick one; with many options (8+) a search box. `intro` is a line of
 * context at the top. Used by PickerField, ChoiceRow and anything that opens choices from a menu. */
export function ChoiceSheet({ open, onClose, title, value, options, onPick, intro, stayOpen }: {
  open: boolean; onClose: () => void; title: string; value: string | null; options: PickerOption[]
  onPick: (v: string) => void; intro?: string
  /** Keep the sheet open after a pick (e.g. sounds, where you try a few before settling). */
  stayOpen?: boolean
}) {
  const [q, setQ] = useState('')
  const { height } = useWindowDimensions()
  const query = q.trim().toLowerCase()
  const shown = query ? options.filter((o) => `${o.title} ${o.subtitle ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(query)) : options
  const groups: [string, PickerOption[]][] = []
  for (const o of shown) {
    const g = groups.find(([k]) => k === (o.group ?? ''))
    if (g) g[1].push(o)
    else groups.push([o.group ?? '', [o]])
  }
  const close = () => { onClose(); setQ('') }
  return (
    <Sheet open={open} onClose={close} title={title}>
      <View style={{ maxHeight: height * 0.7 }}>
        {options.length >= 8 && <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}><SearchField value={q} onChangeText={setQ} /></View>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}>
          {intro && <Text variant="caption" color="ink3" style={{ paddingHorizontal: 12, paddingBottom: 6 }}>{intro}</Text>}
          {groups.map(([g, list]) => (
            <View key={g || 'all'} accessibilityRole="radiogroup">
              {g ? <Text variant="footnote" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 2 }}>{g}</Text> : null}
              {list.map((o) => (
                <RadioRow key={o.value} title={o.title} subtitle={o.subtitle} leading={o.leading} trailing={o.trailing} subtitleLines={2}
                  checked={o.value === value} onPress={() => { onPick(o.value); if (!stayOpen) close() }} />
              ))}
            </View>
          ))}
          {!shown.length && <Text variant="caption" color="ink3" style={{ textAlign: 'center', paddingVertical: 24 }}>Nothing called “{q.trim()}”.</Text>}
        </ScrollView>
      </View>
    </Sheet>
  )
}

/** A field showing the current choice that opens a ChoiceSheet. */
export function PickerField({ label, value, options, onChange, intro, placeholder = 'Choose', disabled, stayOpen }: {
  label: string; value: string | null; options: PickerOption[]; onChange: (v: string) => void
  intro?: string; placeholder?: string; disabled?: boolean
  /** Keep the sheet open after a pick (e.g. sounds, where you try a few before settling). */
  stayOpen?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <Surface style={{ overflow: 'hidden', opacity: disabled ? 0.5 : 1 }}>
        <Press
          radius={radius.md}
          static
          disabled={disabled}
          onPress={() => { haptic.tap(); setOpen(true) }}
          accessibilityLabel={`${label}, ${current?.title ?? placeholder}`}
          accessibilityHint="Opens the choices"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 12 }}
        >
          {current?.leading}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyMedium" numberOfLines={1} color={current ? 'ink' : 'ink3'}>{current?.title ?? placeholder}</Text>
            {current?.subtitle ? <Text variant="caption" color="ink3" numberOfLines={1}>{current.subtitle}</Text> : null}
          </View>
          <Icon icon={UnfoldMoreIcon} size={18} color="ink3" />
        </Press>
      </Surface>
      <ChoiceSheet open={open} onClose={() => setOpen(false)} title={label} value={value} options={options} onPick={onChange} intro={intro} stayOpen={stayOpen} />
    </>
  )
}

/** A settings row, "Label ··· Current ⌄", that opens a ChoiceSheet. Sits in a Surface with other rows. */
export function ChoiceRow({ label, value, options, onChange, intro, stayOpen, icon }: {
  label: string; value: string; options: PickerOption[]; onChange: (v: string) => void; intro?: string; stayOpen?: boolean
  icon?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <Press radius={0} static onPress={() => { haptic.tap(); setOpen(true) }} accessibilityLabel={`${label}, ${current?.title ?? ''}`}
        accessibilityHint="Opens the choices"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10, paddingHorizontal: 16 }}>
        {icon}
        <Text variant="bodyMedium" style={{ flex: 1 }}>{label}</Text>
        <Text variant="body" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>{current?.title ?? ''}</Text>
        <Icon icon={UnfoldMoreIcon} size={16} color="ink3" />
      </Press>
      <ChoiceSheet open={open} onClose={() => setOpen(false)} title={label} value={value} options={options} onPick={onChange} intro={intro} stayOpen={stayOpen} />
    </>
  )
}
