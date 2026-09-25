import { type ReactNode } from 'react'
import { type StyleProp, type ViewStyle } from 'react-native'

import { BorderBeam } from '@/vendor/border-beam-native'
import { useTheme } from '@/theme'

export interface BeamProps {
  children: ReactNode
  /** Radius of the wrapped squircle. */
  radius: number
  active?: boolean
  style?: StyleProp<ViewStyle>
}

/**
 * libraries.dev border beam, tube-coloured. Use sparingly: a composer while a run is live,
 * a pending approval card. Never decorative.
 */
export function Beam({ children, radius, active = true, style }: BeamProps) {
  const { scheme } = useTheme()
  return (
    <BorderBeam size="line" colorVariant="ocean" theme={scheme} staticColors borderRadius={radius} active={active} strength={scheme === 'dark' ? 0.8 : 0.6} style={style}>
      {children}
    </BorderBeam>
  )
}
