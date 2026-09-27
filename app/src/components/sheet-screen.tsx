import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import Animated, { FadeIn, Keyframe, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'

import { motion, useTheme } from '@/theme'
import { Squircle } from '@/ui'

// Which full-height sheet is open. They render above the navigator (see SheetsHost), not as routes:
// Android's native stack drew the screen underneath over a transparent-modal route a moment after it opened.
export type SheetName = 'teammate' | 'project'
let current: SheetName | null = null
const listeners = new Set<() => void>()
const setCurrent = (s: SheetName | null) => { current = s; listeners.forEach((l) => l()) }
/** Opens a sheet; it replaces whichever one is open. */
export const openSheet = (s: SheetName) => setCurrent(s)
export const useOpenSheet = () => useSyncExternalStore(
  (l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => current, () => current,
)

interface SheetCtx {
  /** Only the header drags the sheet; the content scrolls freely and can never dismiss it. */
  drag: ReturnType<typeof Gesture.Pan>
  /** Slides the sheet away; `then` runs as it starts (e.g. navigate to what was just created, underneath). */
  close: (then?: () => void) => void
  /** True once the slide-in finishes: mount heavy sections then, so the open stays at 60 fps. */
  ready: boolean
}
const Ctx = createContext<SheetCtx | null>(null)
export const useSheet = () => useContext(Ctx)

const OPEN_MS = 300
const CLOSE_MS = 200

/**
 * A full-height bottom sheet over everything: slides up 300 ms,
 * closes on ✕, back, backdrop tap, or dragging its header down past a third (or flicking it).
 */
export function SheetScreen({ children }: { children: ReactNode }) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const top = insets.top + 12
  const travel = height - top
  // The drag/close offset rests at 0 and the slide-in is an entering animation, so the resting state is the
  // rendered one: in release builds a later React commit re-applied an animated style's first value
  // (off screen), and the sheet vanished a moment after opening.
  const y = useSharedValue(0)
  const [ready, setReady] = useState(false)
  const slideIn = new Keyframe({
    0: { transform: [{ translateY: travel }] },
    100: { transform: [{ translateY: 0 }], easing: motion.ease.smoothOut },
  }).duration(OPEN_MS)

  const leave = () => setCurrent(null)
  const slideOut = () => {
    'worklet'
    y.set(withTiming(travel, { duration: CLOSE_MS, easing: motion.ease.close }, (done) => { if (done) scheduleOnRN(leave) }))
  }
  const close = (then?: () => void) => { then?.(); slideOut() }

  useEffect(() => {
    const t = setTimeout(() => setReady(true), OPEN_MS)
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true })
    return () => { clearTimeout(t); back.remove() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const drag = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-16, 16])
    .onUpdate((e) => { y.set(Math.max(0, e.translationY)) })
    .onEnd((e) => {
      if (e.translationY > travel / 3 || e.velocityY > 1100) {
        slideOut()
      } else {
        y.set(withSpring(0, motion.spring))
      }
    })

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }))
  const scrim = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [0, travel], [1, 0]) }))

  return (
    <Ctx value={{ drag, close, ready }}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View entering={FadeIn.duration(OPEN_MS)} style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(9,9,11,0.32)' }, scrim]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} accessibilityLabel="Close" />
          </Animated.View>
        </Animated.View>
        <Animated.View entering={slideIn} style={{ position: 'absolute', left: 0, right: 0, top, bottom: 0 }}>
          <Animated.View style={[{ flex: 1 }, panel]} accessibilityViewIsModal>
            <Squircle style={{ flex: 1, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: c.panel, overflow: 'hidden', paddingBottom: insets.bottom }}>
              {children}
            </Squircle>
          </Animated.View>
        </Animated.View>
      </View>
    </Ctx>
  )
}

/** The grab handle drawn at the top of a sheet header. */
export function Grabber() {
  const { c } = useTheme()
  return <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: c.lineStrong, marginTop: 8 }} />
}
