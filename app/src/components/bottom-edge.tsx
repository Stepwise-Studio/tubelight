import { BlurTargetView, BlurView } from 'expo-blur'
import { useRef, type ReactNode, type RefObject } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/theme'

// [height from the screen's bottom edge, intensity]: thin steps, each a little stronger nearer the edge (a progressive
// blur); everything above the tallest one stays fully clear.
const BLUR_STEPS = [[30, 3], [22, 7], [14, 12], [7, 20]] as const

/** The progressive blur along the screen's bottom edge. The chrome tints match the canvas, so steps add no grey band. */
export function EdgeBlur({ blurTarget }: { blurTarget?: RefObject<View | null> }) {
  const { scheme } = useTheme()
  return BLUR_STEPS.map(([height, intensity]) => (
    <BlurView
      key={height}
      blurTarget={blurTarget}
      blurMethod="dimezisBlurViewSdk31Plus"
      intensity={intensity}
      tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height }}
    />
  ))
}

/** Content fading out at the bottom of the screen: clear at the top of `height`, easing into the canvas, blurred at the edge. */
export function BottomEdge({ blurTarget, height }: { blurTarget?: RefObject<View | null>; height: number }) {
  const { c } = useTheme()
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height }}>
      <EdgeBlur blurTarget={blurTarget} />
      <View style={[StyleSheet.absoluteFill, {
        experimental_backgroundImage: `linear-gradient(to bottom, ${c.canvas}00 0%, ${c.canvas}00 20%, ${c.canvas}40 45%, ${c.canvas}8C 70%, ${c.canvas}CC 100%)`,
      }]} />
    </View>
  )
}

/**
 * A screen whose content blurs and fades under the bottom edge (used as a navigator's `screenLayout`). `height` is how
 * far up the fade reaches: over a floating bar, pass the bar's inset so it sits under the bar, not on top of it.
 */
export function EdgeScreen({ children, height }: { children: ReactNode; height?: number }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const target = useRef<View>(null)
  return (
    <View style={{ flex: 1 }}>
      <BlurTargetView ref={target} style={{ flex: 1, backgroundColor: c.canvas }}>{children}</BlurTargetView>
      <BottomEdge blurTarget={target} height={height ?? Math.max(insets.bottom, 12) + 28} />
    </View>
  )
}
