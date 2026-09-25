import { View } from 'react-native'

import { type Palette, radius, useTheme } from '@/theme'

import { Icon, type IconSvgElement } from './icon'
import { Press } from './press'
import { Squircle } from './squircle'
import { Text } from './text'

export type ChipTone = 'neutral' | 'tube' | 'success' | 'warning' | 'danger'

const tones: Record<ChipTone, { ink: keyof Palette; bg: keyof Palette }> = {
  neutral: { ink: 'ink2', bg: 'panel2' },
  tube: { ink: 'tube', bg: 'tubeSoft' },
  success: { ink: 'success', bg: 'successSoft' },
  warning: { ink: 'warning', bg: 'warningSoft' },
  danger: { ink: 'danger', bg: 'dangerSoft' },
}

export interface ChipProps {
  label: string
  tone?: ChipTone
  icon?: IconSvgElement
  /** A status dot before the label. */
  dot?: boolean
  /** Selected state for filter chips (tube tint + edge). */
  selected?: boolean
  onPress?: () => void
  accessibilityLabel?: string
}

/** Small status or filter pill. Pressable when `onPress` is set. Radius 8. */
export function Chip({ label, tone = 'neutral', icon, dot, selected, onPress, accessibilityLabel }: ChipProps) {
  const { c } = useTheme()
  const t = selected ? tones.tube : tones[tone]
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c[t.ink] }} />}
      {icon && <Icon icon={icon} size={14} color={t.ink} />}
      <Text variant="label" color={t.ink} numberOfLines={1}>{label}</Text>
    </View>
  )
  const box = { height: 28, paddingHorizontal: 10, justifyContent: 'center' as const, backgroundColor: c[t.bg], borderWidth: 1, borderColor: selected ? c.tube : 'transparent' }
  if (!onPress) return <Squircle style={[box, { borderRadius: radius.sm, alignSelf: 'flex-start' }]}>{content}</Squircle>
  return (
    <Press
      radius={radius.sm}
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected }}
      outerStyle={{ alignSelf: 'flex-start' }}
      style={box}
    >
      {content}
    </Press>
  )
}
