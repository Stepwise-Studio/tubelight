import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { type Palette, fonts, useTheme } from '@/theme'

import { Icon, type IconSvgElement } from './icon'
import { IconSwap } from './motion'
import { Press, type PressProps } from './press'
import { elevation } from './surface'
import { Text } from './text'

export type ButtonVariant = 'solid' | 'soft' | 'outline' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

const metrics = {
  sm: { h: 34, r: 14, px: 12, gap: 6, icon: 16, font: 13 },
  md: { h: 44, r: 18, px: 16, gap: 8, icon: 18, font: 15 },
  lg: { h: 50, r: 20, px: 20, gap: 8, icon: 20, font: 16 },
} as const

/*
 * Surface stack, ported from Stepwise UI's button:
 *   1. Fill       top-to-bottom gradient layer inside the squircle
 *   2. Edge       1px border on the squircle
 *   3. Elevation  boxShadow on the outer wrapper, outside the clip
 *   4. Wash       overlay for press (Press)
 */
function look(v: ButtonVariant, c: Palette) {
  switch (v) {
    case 'solid': return { from: c.solidFrom, to: c.solidTo, edge: c.solidEdge, ink: c.solidInk, wash: 'rgba(255,255,255,0.10)', elevated: true }
    case 'destructive': return { from: c.dangerFrom, to: c.dangerTo, edge: 'rgba(0,0,0,0.2)', ink: '#ffffff', wash: 'rgba(255,255,255,0.12)', elevated: true }
    case 'soft': return { from: c.softFrom, to: c.softTo, edge: c.softEdge, ink: c.ink, wash: c.washStrong, elevated: true }
    case 'outline': return { from: undefined, to: 'transparent', edge: c.edge, ink: c.ink, wash: c.wash, elevated: false }
    case 'ghost': return { from: undefined, to: 'transparent', edge: undefined, ink: c.ink2, wash: c.wash, elevated: false }
  }
}

export interface ButtonProps extends Omit<PressProps, 'children' | 'style' | 'radius'> {
  /** Say what happens: "Approve and send", not "Confirm". */
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconSvgElement
  iconPosition?: 'left' | 'right'
  loading?: boolean
  fullWidth?: boolean
  style?: StyleProp<ViewStyle>
}

export function Button({
  label, variant = 'solid', size = 'md', icon, iconPosition = 'left', loading, fullWidth,
  disabled, style, haptic, ...props
}: ButtonProps) {
  const { c, scheme } = useTheme()
  const m = metrics[size]
  const l = look(variant, c)
  const off = disabled || loading
  const iconEl = icon && <Icon icon={icon} size={m.icon} color={l.ink} strokeWidth={1.75} />
  return (
    <Press
      radius={m.r}
      wash={l.wash}
      haptic={haptic}
      disabled={off}
      accessibilityLabel={label}
      accessibilityState={{ busy: !!loading, disabled: !!off }}
      hitSlop={size === 'sm' ? 5 : undefined}
      outerStyle={[l.elevated && !off && elevation(scheme), fullWidth ? { alignSelf: 'stretch' } : { alignSelf: 'flex-start' }, { opacity: disabled ? 0.45 : 1 }, style]}
      style={{
        height: m.h,
        paddingLeft: icon && iconPosition === 'left' ? m.px - 2 : m.px, // optical: icon side gets 2 less
        paddingRight: icon && iconPosition === 'right' ? m.px - 2 : m.px,
        backgroundColor: l.to,
        borderWidth: l.edge ? 1 : 0,
        borderColor: l.edge,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      {...props}
    >
      {l.from && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: `linear-gradient(to bottom, ${l.from}, ${l.to})` }]} />
      )}
      <View style={{ flexDirection: iconPosition === 'right' ? 'row-reverse' : 'row', alignItems: 'center', gap: m.gap, opacity: loading ? 0 : 1 }}>
        {iconEl}
        <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: m.font, lineHeight: Math.round(m.font * 1.25), letterSpacing: -0.2, color: l.ink }}>
          {label}
        </Text>
      </View>
      {loading && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="small" color={l.ink} />
        </View>
      )}
    </Press>
  )
}

export interface IconButtonProps extends Omit<PressProps, 'children' | 'style' | 'radius'> {
  icon: IconSvgElement
  /** Required: icon-only controls need a name. */
  accessibilityLabel: string
  variant?: 'ghost' | 'soft' | 'solid' | 'tube'
  size?: number
  iconSize?: number
  color?: keyof Palette | (string & {})
  style?: StyleProp<ViewStyle>
  /** Change it with the icon to cross-fade the swap (transitions.dev icon swap). */
  swapKey?: string
}

/** Icon-only button, 44pt by default. Circular-ish squircle. */
export function IconButton({ icon, variant = 'ghost', size = 44, iconSize = 20, color, style, disabled, swapKey, ...props }: IconButtonProps) {
  const { c } = useTheme()
  const bg = variant === 'soft' ? c.panel2 : variant === 'solid' ? c.solidTo : variant === 'tube' ? c.tube : 'transparent'
  const ink = color ?? (variant === 'solid' ? c.solidInk : variant === 'tube' ? c.onTube : c.ink2)
  return (
    <Press
      radius={size * 0.42}
      disabled={disabled}
      outerStyle={[{ opacity: disabled ? 0.45 : 1 }, style]}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      {...props}
    >
      {swapKey
        ? <IconSwap swapKey={swapKey}><Icon icon={icon} size={iconSize} color={ink} strokeWidth={1.75} /></IconSwap>
        : <Icon icon={icon} size={iconSize} color={ink} strokeWidth={1.75} />}
    </Press>
  )
}
