import type { ReactNode } from 'react'
import { View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/theme'

// An eased ramp (slow start, strong finish), many stops so there's no banding: clear at the top, nearly solid canvas
// at the very bottom. A stepped blur always left visible lines on Android (each blur view has a hard edge).
const RAMP: [number, string][] = [[0, '00'], [15, '05'], [30, '12'], [45, '29'], [60, '4D'], [75, '80'], [88, 'B8'], [100, 'E6']]

/** Content fading out toward the screen's bottom edge, over `height` (or `style` for a custom box). */
export function BottomEdge({ height, style }: { height?: number; style?: ViewStyle }) {
  const { c } = useTheme()
  return (
    <View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, height }, style, {
        experimental_backgroundImage: `linear-gradient(to bottom, ${RAMP.map(([at, a]) => `${c.canvas}${a} ${at}%`).join(', ')})`,
      }]}
    />
  )
}

/**
 * A screen whose content fades out under the bottom edge (a navigator's `screenLayout`). `height` is how far up the
 * fade reaches: over a floating bar, pass the bar's inset.
 */
export function EdgeScreen({ children, height }: { children: ReactNode; height?: number }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1 }}>
      {children}
      <BottomEdge height={height ?? Math.max(insets.bottom, 12) + 28} />
    </View>
  )
}
