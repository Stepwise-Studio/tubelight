// iMessage's "typing…": three dots that brighten and swell in turn, a calm wave. The resting frame (dim, small) is
// the first render's, so release builds can't snap to anything else (see the Reanimated gotcha in CLAUDE.md).
import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'

export function TypingDots({ size = 6, color }: { size?: number; color?: string }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.round(size * 0.55) }} accessible accessibilityLabel="Working on a reply">
      {[0, 1, 2].map((i) => <Dot key={i} i={i} size={size} color={color ?? c.ink2} />)}
    </View>
  )
}

function Dot({ i, size, color }: { i: number; size: number; color: string }) {
  const p = useSharedValue(0)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (reduced) return
    const half = { duration: 360, easing: motion.ease.inOut }
    p.value = withDelay(i * 160, withRepeat(withSequence(withTiming(1, half), withTiming(0, half), withTiming(0, { duration: 260 })), -1))
    return () => cancelAnimation(p)
  }, [i, p, reduced])
  const style = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * p.value, transform: [{ scale: 0.82 + 0.18 * p.value }] }))
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />
}
