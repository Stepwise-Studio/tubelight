// Web preview: no Skia; a steady tube hairline stands in for the moving beam.
import { View } from 'react-native'

import { useTheme } from '@/theme'

import type { BeamProps } from './beam'

export function Beam({ children, radius, active = true, style }: BeamProps) {
  const { c } = useTheme()
  return <View style={[{ borderRadius: radius, boxShadow: active ? `0 0 0 1px ${c.tube}` : undefined }, style]}>{children}</View>
}
