import { Canvas, LinearGradient, Path, usePathValue, vec } from '@shopify/react-native-skia'
import { useImperativeHandle, type Ref } from 'react'
import { View, type ViewStyle } from 'react-native'
import { Easing, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated'

import { useTheme } from '@/theme'

const BAR = 3
const GAP = 3
const STEP = BAR + GAP
const MIN_H = 3
const TICK_MS = 64 // one mic chunk: the strip moves one bar per level update

export interface WaveformHandle {
  /** Push the latest mic level (linear RMS, 0..1). */
  push(level: number): void
}

/**
 * The live dictation waveform: rounded bars that follow your voice, newest on the right, scrolling left smoothly
 * between level updates and fading out at the left edge. Drawn with Skia on the UI thread.
 */
export function Waveform({ ref, style }: { ref?: Ref<WaveformHandle>; style?: ViewStyle }) {
  const { c } = useTheme()
  const width = useSharedValue(0)
  const bars = useSharedValue<number[]>([])
  const shift = useSharedValue(0)

  useImperativeHandle(ref, () => ({
    push(level: number) {
      // Speech RMS sits around 0.02–0.2: lift it into a lively 0..1 with a soft curve.
      const v = Math.min(1, Math.sqrt(Math.max(0, level) * 6))
      const n = Math.max(1, Math.ceil(width.get() / STEP) + 1)
      const prev = bars.get()
      bars.set([...prev.slice(Math.max(0, prev.length - n + 1)), v])
      shift.set(0)
      shift.set(withTiming(1, { duration: TICK_MS, easing: Easing.linear }))
    },
  }))

  const path = usePathValue((p) => {
    'worklet'
    const w = width.value
    const h = 36
    const list = bars.value
    const offset = shift.value * STEP
    for (let i = 0; i < list.length; i++) {
      // The newest bar sits at the right edge; each older one a step further left.
      const x = w - (list.length - i) * STEP + STEP - offset
      if (x < -BAR) continue
      const bh = MIN_H + list[i] * (h - MIN_H - 4)
      p.addRRect({ rect: { x, y: (h - bh) / 2, width: BAR, height: bh }, rx: BAR / 2, ry: BAR / 2 })
    }
  })
  const end = useDerivedValue(() => vec(width.value * 0.45, 0))

  return (
    <View style={[{ height: 36 }, style]} onLayout={(e) => width.set(e.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Canvas style={{ flex: 1 }}>
        <Path path={path}>
          <LinearGradient start={vec(0, 0)} end={end} colors={[`${c.ink}00`, c.ink]} />
        </Path>
      </Canvas>
    </View>
  )
}
