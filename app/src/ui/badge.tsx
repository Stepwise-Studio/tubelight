import { View } from 'react-native'
import Animated, { Keyframe } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'

import { NumberPop } from './motion'

const { duration, ease } = motion

// transitions.dev notification badge: slides in diagonally (-8, 12 → 0) 260ms smooth-out while the
// dot pops with the bounce ease (500ms) and fades (400ms); closes faster (180ms), no bounce.
const badgeIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateX: -8 }, { translateY: 12 }, { scale: 0.4 }] },
  52: { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1.05 }], easing: ease.smoothOut },
  80: { opacity: 1 },
  100: { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }], easing: ease.bounce },
}).duration(duration.verySlow)
const badgeOut = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.4 }], easing: ease.close },
}).duration(180)

export interface BadgeProps {
  /** 0 hides the badge. */
  count: number
  /** Dot only, no number. */
  dot?: boolean
  max?: number
}

/** Notification badge. Absolutely position it on a trigger; it animates in and out on its own. */
export function Badge({ count, dot, max = 99 }: BadgeProps) {
  const { c } = useTheme()
  const text = count > max ? `${max}+` : String(count)
  return (
    <View pointerEvents="none">
      {count > 0 && (
        <Animated.View
          entering={badgeIn}
          exiting={badgeOut}
          accessibilityLabel={`${count} pending`}
          style={dot
            ? { width: 8, height: 8, borderRadius: 4, backgroundColor: c.tube }
            : { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: c.tube }}
        >
          {!dot && <NumberPop value={text} variant="footnote" style={{ color: c.onTube, fontSize: 11, lineHeight: 14, fontFamily: 'InterDisplay-SemiBold' }} />}
        </Animated.View>
      )}
    </View>
  )
}
