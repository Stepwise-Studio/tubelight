import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSequence, withTiming,
} from 'react-native-reanimated'

import { useTheme } from '@/theme'

import { Text } from './text'

/**
 * The tube: a lit fluorescent bar + "Tubelight". `flicker` plays the switch-on once
 * (two stutters, then steady). Only on the sign-in screen.
 */
export function Logo({ flicker = false, wordmark = true, scale = 1 }: { flicker?: boolean; wordmark?: boolean; scale?: number }) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const o = useSharedValue(flicker && !reduced ? 0.15 : 1)
  useEffect(() => {
    if (!flicker || reduced) return
    // 1400ms, linear, 200ms delay; opacity keyframes from the web brand CSS.
    const s = (v: number, ms: number) => withTiming(v, { duration: ms })
    o.value = withDelay(200, withSequence(s(0.15, 112), s(1, 28), s(0.2, 42), s(0.2, 126), s(0.9, 28), s(0.35, 42), s(1, 182)))
  }, [flicker, reduced, o])
  const tube = useAnimatedStyle(() => ({ opacity: o.value }))
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 * scale }} accessible accessibilityRole="image" accessibilityLabel="Tubelight">
      <Animated.View
        style={[
          {
            width: 22 * scale, height: 7 * scale, borderRadius: 4 * scale, backgroundColor: c.tube,
            boxShadow: `0 0 ${12 * scale}px ${1 * scale}px ${c.tubeGlow}, 0 0 ${2 * scale}px 0 ${c.tubeGlow}`,
          },
          tube,
        ]}
      />
      {wordmark && <Text variant="headline" style={{ fontSize: 17 * scale, lineHeight: 22 * scale, letterSpacing: -0.2 * scale }}>Tubelight</Text>}
    </View>
  )
}
