// The page scrubber: hold the page count and slide. A row of bars, one a page (a few pages a bar in long documents),
// rises under your finger the way the Mac's Dock magnifies; a tick on every page you pass, and the document follows
// as you go. Let go and you stay there. It first shows where you are; it follows your finger once you move it.
import { memo, useState, type ReactNode } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeInDown, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'
import { Text, haptic } from '@/ui'

const SIDE = 16 // the panel's margin from the screen's edges
const PAD = 14 // inside the panel, before the first bar
const H = 64 // the panel's height
const REST = 8 // a bar away from the finger
const PEAK = 42 // the bar under it
const REACH = 26 // how far the swell spreads either side (px)
const STEP = 6 // narrowest room a bar gets; longer documents share bars

export function PageScrubber({ pages, page, bottom, onScrub, onHold, children }: {
  pages: number
  page: number
  /** Where the page count sits from the bottom; the bars float just above it. */
  bottom: number
  onScrub: (n: number) => void
  onHold?: (holding: boolean) => void
  /** The page count, given the page to show (the one under your finger while scrubbing). */
  children: (shown: number) => ReactNode
}) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const inner = width - SIDE * 2 - PAD * 2
  const bars = Math.max(1, Math.min(pages, Math.floor(inner / STEP)))
  const center = (n: number) => ((Math.floor(((n - 1) / pages) * bars) + 0.5) / bars) * inner // the middle of page n's bar
  const [at, setAt] = useState<number | null>(null)
  const x = useSharedValue(-999)
  const from = useSharedValue(0)
  const live = useSharedValue(0)
  const last = useSharedValue(0)

  const start = () => { haptic.medium(); setAt(page); onHold?.(true) }
  const pick = (n: number) => { haptic.tap(); setAt(n); onScrub(n) }
  const end = () => { setAt(null); onHold?.(false) }

  const here = center(page) // a number the gesture (on the UI thread) can use
  const gesture = Gesture.Pan()
    .enabled(pages > 1)
    .activateAfterLongPress(280)
    .onStart((e) => {
      from.value = e.absoluteX
      live.value = 0
      last.value = page
      x.value = here
      runOnJS(start)()
    })
    .onUpdate((e) => {
      const rel = e.absoluteX - SIDE - PAD
      if (!live.value) {
        if (Math.abs(e.absoluteX - from.value) < 6) return
        live.value = 1
        x.value = withTiming(rel, { duration: 120 }) // glide from where you are to your finger
      } else {
        x.value = rel
      }
      const n = Math.min(pages, Math.max(1, Math.floor((rel / inner) * pages) + 1))
      if (n !== last.value) {
        last.value = n
        runOnJS(pick)(n)
      }
    })
    .onFinalize(() => { runOnJS(end)() })

  const shown = at ?? page
  return (
    <>
      {at !== null && (
        <Animated.View entering={FadeInDown.duration(motion.duration.fast).easing(motion.ease.smoothOut)} exiting={FadeOut.duration(motion.duration.quick)}
          pointerEvents="none" style={{ position: 'absolute', left: SIDE, right: SIDE, bottom: bottom + 44 + 10 }}>
          {/* The page under your finger, over its bar */}
          <Animated.View entering={FadeIn.duration(motion.duration.fast)}
            style={{ position: 'absolute', bottom: H + 8, left: PAD + Math.min(inner - 24, Math.max(-12, center(shown) - 24)), width: 48, alignItems: 'center' }}>
            <View style={{ minWidth: 40, height: 28, paddingHorizontal: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: c.tube }}>
              <Text variant="label" color={c.onTube} tabular>{shown}</Text>
            </View>
          </Animated.View>
          <Bars bars={bars} inner={inner} x={x} />
        </Animated.View>
      )}
      <GestureDetector gesture={gesture}>{children(shown)}</GestureDetector>
    </>
  )
}

/** The row of bars; drawn once a hold, then moved only by the finger (on the UI thread). */
const Bars = memo(function Bars({ bars, inner, x }: { bars: number; inner: number; x: SharedValue<number> }) {
  const step = inner / bars
  const w = Math.min(5, Math.max(2, step * 0.42))
  return (
    <View style={{ height: H, borderRadius: H / 2, paddingHorizontal: PAD, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(24,24,27,0.92)' }}>
      {Array.from({ length: bars }, (_, i) => <Bar key={i} cx={(i + 0.5) * step} step={step} w={w} x={x} />)}
    </View>
  )
})

const Bar = memo(function Bar({ cx, step, w, x }: { cx: number; step: number; w: number; x: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const d = (x.value - cx) / REACH
    const k = Math.exp(-d * d) // the Dock's swell: tallest under the finger, easing off either side
    return { height: REST + (PEAK - REST) * k, opacity: 0.32 + 0.68 * k }
  })
  return (
    <View style={{ width: step, alignItems: 'center' }}>
      <Animated.View style={[{ width: w, borderRadius: w / 2, backgroundColor: '#fff', height: REST, opacity: 0.32 }, style]} />
    </View>
  )
})
