import { View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { ArrowTurnBackwardIcon } from '@hugeicons/core-free-icons'

import { motion } from '@/theme'
import { Icon, haptic } from '@/ui'

const THRESHOLD = 56
const MAX = 72

/**
 * WhatsApp-style swipe right to reply. The row follows the finger (rubber-banded past MAX), a reply
 * arrow scales in (icon recipe: scale .25→1, opacity 0→1), one haptic tick on crossing the threshold,
 * spring back on release. Vertical scrolls win: the pan only activates after 14px of rightward travel.
 */
export function SwipeToReply({ onReply, enabled = true, children }: { onReply: () => void; enabled?: boolean; children: React.ReactNode }) {
  const x = useSharedValue(0)
  const armed = useSharedValue(false)
  const tick = () => haptic.light()

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX(14)
    .failOffsetX(-10)
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      const d = Math.max(0, e.translationX)
      x.value = d < MAX ? d : MAX + (d - MAX) * 0.2
      const past = x.value >= THRESHOLD
      if (past !== armed.value) {
        armed.value = past
        if (past) scheduleOnRN(tick)
      }
    })
    .onEnd(() => {
      if (armed.value) scheduleOnRN(onReply)
      armed.value = false
      x.value = withSpring(0, motion.spring)
    })
    .onFinalize(() => { if (x.value !== 0) x.value = withSpring(0, motion.spring) })

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const icon = useAnimatedStyle(() => {
    const t = interpolate(x.value, [16, THRESHOLD], [0, 1], 'clamp')
    return { opacity: t, transform: [{ scale: 0.25 + 0.75 * t }] }
  })

  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 6, top: 0, bottom: 0, justifyContent: 'center' }, icon]}>
          <Icon icon={ArrowTurnBackwardIcon} size={20} color="ink3" />
        </Animated.View>
        <Animated.View style={row}>{children}</Animated.View>
      </View>
    </GestureDetector>
  )
}
