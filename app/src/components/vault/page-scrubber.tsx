// The page scrubber: hold the page count and slide. Bars float above it, one a page and evenly spaced, swelling
// under your finger the way the Mac's Dock magnifies; a tick on every page you pass, and the document slides along.
// Let go and you stay. It starts from where you are: the bar under your finger is the page you're on. A long
// document doesn't fit on the screen: hold near either edge and the bars keep moving (faster the closer you are)
// until the first or last page.
// Everything moves on the UI thread: a fixed set of bars, each showing whichever page falls in its slot.
import { memo, useState, type ReactNode } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeOut, interpolateColor, runOnJS, useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'
import { Text, haptic } from '@/ui'

const STEP = 12 // px between pages
const H = 56 // room the bars swell in
const REST = 10 // a bar away from the finger
const PEAK = 44 // the bar under it
const REACH = 30 // how far the swell spreads either side (px)
const ZONE = 56 // near an edge, the bars keep moving
const SPEED = 150 // px a second at the very edge (about 12 pages)

export function PageScrubber({ pages, page, bottom, onScrub, onHold, children }: {
  pages: number
  page: number
  /** The top of the page count, from the bottom of the reader; the bars float just above it. */
  bottom: number
  onScrub: (n: number) => void
  onHold?: (holding: boolean) => void
  /** The page count, given the page to show (the one under your finger while scrubbing). */
  children: (shown: number) => ReactNode
}) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const slots = Math.ceil(width / STEP) + 3
  const [held, setHeld] = useState(false)
  const [at, setAt] = useState<number | null>(null)
  const x = useSharedValue(-999) // the finger
  const origin = useSharedValue(0) // where page 1 sits on the screen (moves as the bars do)
  const last = useSharedValue(0)
  const under = useSharedValue(0) // the page under the finger, for the bubble

  const start = () => { haptic.medium(); setHeld(true); setAt(page); onHold?.(true) }
  const pick = (n: number) => { haptic.tap(); setAt(n); onScrub(n) }
  const end = () => { setHeld(false); setAt(null); onHold?.(false) }

  const settle = () => {
    'worklet'
    const n = Math.min(pages, Math.max(1, Math.round((x.get() - origin.get()) / STEP) + 1))
    under.set(n)
    if (n !== last.get()) {
      last.set(n)
      runOnJS(pick)(n)
    }
  }

  const gesture = Gesture.Pan()
    .enabled(pages > 1)
    .activateAfterLongPress(280)
    .onStart((e) => {
      x.set(e.absoluteX)
      origin.set(e.absoluteX - (page - 1) * STEP)
      last.set(page)
      under.set(page)
      runOnJS(start)()
    })
    .onUpdate((e) => {
      x.set(e.absoluteX)
      settle()
    })
    .onFinalize(() => {
      runOnJS(end)()
    })

  return (
    <>
      {held && (
        <Animated.View entering={FadeIn.duration(motion.duration.fast).easing(motion.ease.smoothOut)} exiting={FadeOut.duration(motion.duration.quick)}
          pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: bottom + 12, height: H }}>
          <Edges x={x} origin={origin} last={last} pages={pages} width={width} settle={settle} />
          {Array.from({ length: slots }, (_, i) => <Bar key={i} slot={i} slots={slots} pages={pages} x={x} origin={origin} tube={c.tube} />)}
          <Bubble origin={origin} under={under} width={width} color={c.tube}>
            <Text variant="label" color={c.onTube} tabular>{at ?? page}</Text>
          </Bubble>
        </Animated.View>
      )}
      <GestureDetector gesture={gesture}>{children(at ?? page)}</GestureDetector>
    </>
  )
}

/** Near an edge, the bars keep moving: pages come in from that side until the first or last one is under the finger.
 * Mounted only while held (a frame callback restarts on every render, so it starts itself here). */
function Edges({ x, origin, last, pages, width, settle }: {
  x: SharedValue<number>; origin: SharedValue<number>; last: SharedValue<number>; pages: number; width: number; settle: () => void
}) {
  useFrameCallback((f) => {
    const dt = (f.timeSincePreviousFrame ?? 16) / 1000
    const left = ZONE - x.get()
    const right = x.get() - (width - ZONE)
    if (left > 0 && last.get() > 1) origin.set(origin.get() + SPEED * Math.min(1, left / ZONE) * dt)
    else if (right > 0 && last.get() < pages) origin.set(origin.get() - SPEED * Math.min(1, right / ZONE) * dt)
    else return
    settle()
  }, true)
  return null
}

/** The page under the finger, over its bar. */
function Bubble({ origin, under, width, color, children }: { origin: SharedValue<number>; under: SharedValue<number>; width: number; color: string; children: ReactNode }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.min(width - 56, Math.max(8, origin.get() + (under.get() - 1) * STEP - 24)) }],
  }))
  return (
    <Animated.View style={[{ position: 'absolute', left: 0, bottom: H + 8, width: 48, alignItems: 'center' }, style]}>
      <View style={{ minWidth: 40, height: 28, paddingHorizontal: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: color }}>
        {children}
      </View>
    </Animated.View>
  )
}

/** One bar slot: shows whichever page falls in it as the bars move (the slots wrap around), hidden past the ends. */
const Bar = memo(function Bar({ slot, slots, pages, x, origin, tube }: {
  slot: number; slots: number; pages: number; x: SharedValue<number>; origin: SharedValue<number>; tube: string
}) {
  const style = useAnimatedStyle(() => {
    const first = Math.floor(-origin.get() / STEP) - 1 // the page index just left of the screen
    const p = first + ((((slot - first) % slots) + slots) % slots) // this slot's page index (0-based)
    const cx = origin.get() + p * STEP
    const d = (x.get() - cx) / REACH
    const k = Math.exp(-d * d) // the Dock's swell: tallest under the finger, easing off either side
    return {
      opacity: p >= 0 && p < pages ? 1 : 0,
      transform: [{ translateX: cx - 2 }],
      height: REST + (PEAK - REST) * k,
      backgroundColor: interpolateColor(k, [0, 0.6, 1], ['#a1a1aa', '#a1a1aa', tube]),
    }
  })
  // Grey reads on white pages and on the dark canvas; the swell turns the accent. They rise from the bottom, as the Dock does.
  return <Animated.View style={[{ position: 'absolute', left: 0, bottom: 0, width: 4, borderRadius: 2, height: REST, backgroundColor: '#a1a1aa' }, style]} />
})
