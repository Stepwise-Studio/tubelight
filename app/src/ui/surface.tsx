import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { radius as radii, useTheme } from '@/theme'

import { Press, type PressProps } from './press'
import { Squircle } from './squircle'

type Tone = 'panel' | 'panel2' | 'canvas' | 'tubeSoft' | 'dangerSoft' | 'transparent'

export interface SurfaceProps extends ViewProps {
  tone?: Tone
  radius?: number
  /** Hairline edge (Stepwise's middle border). */
  edge?: boolean
  /** Soft elevation, drawn outside the squircle clip. */
  elevated?: boolean
  padding?: number
}

/** Shadow ring for a raised surface, light and dark (better-ui "shadow as border"). */
export function elevation(scheme: 'light' | 'dark', level: 1 | 2 = 1): ViewStyle {
  if (scheme === 'dark') {
    return { boxShadow: level === 1 ? '0 1px 2px -1px rgba(0,0,0,0.4), 0 2px 8px -2px rgba(0,0,0,0.3)' : '0 12px 32px -8px rgba(0,0,0,0.6), 0 2px 6px -2px rgba(0,0,0,0.4)' }
  }
  return { boxShadow: level === 1 ? '0 1px 2px -1px rgba(0,0,0,0.06), 0 2px 8px -2px rgba(0,0,0,0.05)' : '0 8px 24px -6px rgba(0,0,0,0.14), 0 2px 6px -2px rgba(0,0,0,0.06)' }
}

/** A squircle panel. Cards use radius 16 (default), inner panels 12, sheets 28. */
export function Surface({ tone = 'panel', radius = radii.lg, edge = true, elevated, padding, style, children, ...props }: SurfaceProps) {
  const { c, scheme } = useTheme()
  const bg = tone === 'transparent' ? 'transparent' : c[tone]
  const body = (
    <Squircle
      style={[
        { backgroundColor: bg, borderRadius: radius, padding },
        edge && { borderWidth: 1, borderColor: c.line },
        !elevated && style,
        elevated && { overflow: 'hidden' },
      ]}
      {...props}
    >
      {children}
    </Squircle>
  )
  if (!elevated) return body
  return <View style={[{ borderRadius: radius }, elevation(scheme), style as StyleProp<ViewStyle>]}>{body}</View>
}

/** A pressable card: Surface look + press scale and wash. */
export function Card({ tone = 'panel', radius = radii.lg, style, children, ...props }: Omit<PressProps, 'radius'> & { tone?: Tone; radius?: number }) {
  const { c } = useTheme()
  return (
    <Press radius={radius} style={[{ backgroundColor: tone === 'transparent' ? 'transparent' : c[tone], borderWidth: 1, borderColor: c.line }, style]} {...props}>
      {children}
    </Press>
  )
}
