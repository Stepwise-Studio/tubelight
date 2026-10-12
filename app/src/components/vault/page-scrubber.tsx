// The page scrubber: hold the page count and slide. Bars float above it, one a page, swelling under your finger the
// way the Mac's Dock magnifies; a tick on every page you pass, and the document slides along. Let go and you stay.
// It starts from where you are: the bar under your finger is the page you're on, the pages before it spread over
// the room to its left and the pages after over the room to its right, so a hold never jumps and both ends are
// always in reach (short documents get wide steps, long ones finer steps on that side).
import { memo, useState, type ReactNode } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, FadeOut, interpolateColor, runOnJS, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'
import { Text, haptic } from '@/ui'

const EDGE = 24 // the first and last pages sit this far in from the screen's edges
const H = 56 // room the bars swell in
const REST = 10 // a bar away from the finger
const PEAK = 44 // the bar under it
const REACH = 30 // how far the swell spreads either side (px)
const MAX_STEP = 26 // widest step between pages
const MIN_GAP = 7 // bars closer than this are thinned out (every page still counts)

/** Where the hold started, the page it started on, and how far apart pages are on each side. */
interface Anchor { x: number; page: number; left: number; right: number }

/** The step either side of the anchor: the pages before (after) it spread over the room on that side. */
function steps(x: number, page: number, pages: number, width: number) {
  'worklet'
  const left = page > 1 ? Math.min(MAX_STEP, (x - EDGE) / (page - 1)) : MAX_STEP
  const right = page < pages ? Math.min(MAX_STEP, (width - EDGE - x) / (pages - page)) : MAX_STEP
  return { left: Math.max(0.01, left), right: Math.max(0.01, right) }
}

const xOf = (a: Anchor, n: number) => (n < a.page ? a.x - (a.page - n) * a.left : a.x + (n - a.page) * a.right)

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
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const x = useSharedValue(-999) // the finger
  const a = useSharedValue<Anchor>({ x: 0, page: 1, left: 1, right: 1 })
  const last = useSharedValue(0)

  const start = (an: Anchor) => { haptic.medium(); setAnchor(an); setAt(an.page); onHold?.(true) }
  const pick = (n: number) => { haptic.tap(); setAt(n); onScrub(n) }
  const end = () => { setAnchor(null); setAt(null); onHold?.(false) }

  const gesture = Gesture.Pan()
    .enabled(pages > 1)
    .activateAfterLongPress(280)
    .onStart((e) => {
      const an = { x: e.absoluteX, page, ...steps(e.absoluteX, page, pages, width) }
      a.value = an
      x.value = e.absoluteX
      last.value = page
      runOnJS(start)(an)
    })
    .onUpdate((e) => {
      x.value = e.absoluteX
      const an = a.value
      const d = e.absoluteX - an.x
      const n = Math.min(pages, Math.max(1, an.page + Math.round(d / (d < 0 ? an.left : an.right))))
      if (n !== last.value) {
        last.value = n
        runOnJS(pick)(n)
      }
    })
    .onFinalize(() => { runOnJS(end)() })

  return (
    <>
      {anchor && (
        <Animated.View entering={FadeIn.duration(motion.duration.fast).easing(motion.ease.smoothOut)} exiting={FadeOut.duration(motion.duration.quick)}
          pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: bottom + 12, height: H }}>
          <Bars anchor={anchor} pages={pages} x={x} tube={c.tube} />
          {at !== null && (
            <View style={{ position: 'absolute', bottom: H + 8, left: Math.min(width - 56, Math.max(8, xOf(anchor, at) - 24)), width: 48, alignItems: 'center' }}>
              <View style={{ minWidth: 40, height: 28, paddingHorizontal: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: c.tube }}>
                <Text variant="label" color={c.onTube} tabular>{at}</Text>
              </View>
            </View>
          )}
        </Animated.View>
      )}
      <GestureDetector gesture={gesture}>{children(at ?? page)}</GestureDetector>
    </>
  )
}

/** The bars, laid out once a hold (thinned where pages are close) and then moved only by the finger, on the UI thread. */
const Bars = memo(function Bars({ anchor, pages, x, tube }: { anchor: Anchor; pages: number; x: SharedValue<number>; tube: string }) {
  const out: number[] = []
  const every = (step: number) => Math.max(1, Math.ceil(MIN_GAP / step))
  for (let n = anchor.page; n >= 1; n -= every(anchor.left)) out.push(n)
  if (out[out.length - 1] !== 1) out.push(1)
  for (let n = anchor.page + every(anchor.right); n <= pages; n += every(anchor.right)) out.push(n)
  if (!out.includes(pages)) out.push(pages)
  return <>{out.map((n) => <Bar key={n} cx={xOf(anchor, n)} x={x} tube={tube} />)}</>
})

const Bar = memo(function Bar({ cx, x, tube }: { cx: number; x: SharedValue<number>; tube: string }) {
  const style = useAnimatedStyle(() => {
    const d = (x.value - cx) / REACH
    const k = Math.exp(-d * d) // the Dock's swell: tallest under the finger, easing off either side
    return { height: REST + (PEAK - REST) * k, backgroundColor: interpolateColor(k, [0, 0.6, 1], ['#a1a1aa', '#a1a1aa', tube]) }
  })
  // Grey reads on white pages and on the dark canvas; the swell turns the accent. They rise from the bottom, as the Dock does.
  return <Animated.View style={[{ position: 'absolute', left: cx - 2, bottom: 0, width: 4, borderRadius: 2, height: REST, backgroundColor: '#a1a1aa' }, style]} />
})
