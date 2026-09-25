import { type ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'

import { radius, useTheme } from '@/theme'

import { Icon, type IconSvgElement } from './icon'
import { Press } from './press'
import { Text } from './text'

export interface ListRowProps {
  title: string
  subtitle?: string
  /** A leading icon, or pass `leading` for an avatar. */
  icon?: IconSvgElement
  leading?: ReactNode
  /** Trailing content: a value, Badge, Toggle, time. */
  accessory?: ReactNode
  chevron?: boolean
  destructive?: boolean
  onPress?: () => void
  onLongPress?: () => void
  subtitleLines?: number
  accessibilityLabel?: string
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
}

/** A list row, 56pt min (44pt touch floor), radius 12 press wash. */
export function ListRow({
  title, subtitle, icon, leading, accessory, chevron, destructive, onPress, onLongPress, subtitleLines = 1,
  accessibilityLabel, accessibilityHint, style,
}: ListRowProps) {
  const body = (
    <>
      {leading ?? (icon && (
        <View style={{ width: 28, alignItems: 'center' }}><Icon icon={icon} size={18} color={destructive ? 'danger' : 'ink2'} /></View>
      ))}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1} color={destructive ? 'danger' : 'ink'}>{title}</Text>
        {subtitle ? <Text variant="caption" color="ink3" numberOfLines={subtitleLines}>{subtitle}</Text> : null}
      </View>
      {accessory}
      {chevron && <Icon icon={ArrowRight01Icon} size={18} color="ink3" />}
    </>
  )
  const row: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 12 }
  if (!onPress && !onLongPress) return <View style={[row, style]} accessible accessibilityLabel={accessibilityLabel}>{body}</View>
  return (
    <Press
      radius={radius.md}
      static
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      outerStyle={style}
      style={row}
    >
      {body}
    </Press>
  )
}

/** Small section label above a group ("Projects", "Direct messages"). */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6, minHeight: 44 }}>
      <Text variant="overline" color="ink3" accessibilityRole="header">{title}</Text>
      {action}
    </View>
  )
}

/** Hairline divider, inset to align with row text. */
export function Divider({ inset = 0 }: { inset?: number }) {
  const { c } = useTheme()
  return <View style={{ height: 1, backgroundColor: c.line, marginLeft: inset }} />
}
