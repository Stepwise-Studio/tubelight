import { BlurTargetView, BlurView } from 'expo-blur'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { FadeIn, FadeOut, interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { useTheme } from '@/theme'

import { Squircle } from './squircle'

// Frosted glass: a translucent panel over a blurred copy of the page behind it (Dimezis BlurView on Android). The
// page being blurred is a SceneTarget; a Glass names the one it floats over. Until that target exists, or when the
// blur isn't available, the panel is a nearly opaque tint, so it never looks broken.
type Target = RefObject<View | null>
const targets: Record<string, Target> = {}
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }

/** A page whose picture frosted glass above it can blur. Wrap each tab's scene (the glass must sit outside it). */
export function SceneTarget({ name, children }: { name: string; children: ReactNode }) {
  const ref = useRef<View>(null)
  useLayoutEffect(() => {
    targets[name] = ref
    listeners.forEach((f) => f())
    return () => { delete targets[name]; listeners.forEach((f) => f()) }
  }, [name])
  return <BlurTargetView ref={ref} style={{ flex: 1 }}>{children}</BlurTargetView>
}

// A mounted BlurView makes Android redraw the screen on every frame (about 90 a second here, idle or not; the
// library's auto-update switch doesn't stop it on API 31+). So the blur exists only while something can be moving behind
// the glass: a finger down, 3 s after it (a fling), and a moment after a tab or the workspace changes. At rest the
// panel is a denser tint, cross-faded, and the screen stays still.
let down = false
let live = true
let timer: ReturnType<typeof setTimeout> | undefined
const liveListeners = new Set<() => void>()
const setLive = (v: boolean) => { if (live !== v) { live = v; liveListeners.forEach((f) => f()) } }
const rest = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { if (!down) setLive(false) }, ms) }
rest(3000)
/** Something behind glass may have changed: keep the blur for a moment. */
export function wakeGlass(ms = 1500) { setLive(true); if (!down) rest(ms) }
/** Fingers on or off the screen (the root view's touch events). */
export function touchGlass(isDown: boolean) { down = isDown; setLive(true); if (!isDown) rest(3000) }
const subscribeLive = (f: () => void) => { liveListeners.add(f); return () => { liveListeners.delete(f) } }

/** A frosted panel (a squircle) floating over the scene `over`. `always` keeps the blur on (sheets and menus: short-lived). */
export function Glass({ over, radius, veil, always, style, children }: { over: string; radius: number; /** tint strength 0–1 over the blur */ veil?: number; always?: boolean; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const { c, scheme } = useTheme()
  const target = useSyncExternalStore(subscribe, () => targets[over])
  const moving = useSyncExternalStore(subscribeLive, () => live)
  const blurred = !!target && (always || moving)
  const dark = scheme === 'dark'
  const tint = dark ? '24,24,27' : '255,255,255'
  const lit = veil ?? (dark ? 0.3 : 0.25)
  const t = useSharedValue(blurred ? 1 : 0)
  useEffect(() => { t.value = withTiming(blurred ? 1 : 0, { duration: blurred ? 150 : 350 }) }, [blurred, t])
  const dim = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(t.value, [0, 1], [`rgba(${tint},${Math.max(lit, 0.8)})`, `rgba(${tint},${lit})`]) }), [tint, lit])
  return (
    <Squircle style={[{ borderRadius: radius, borderWidth: 1, borderColor: c.line, overflow: 'hidden', backgroundColor: c.panel }, style]}>
      {target && blurred && (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(350)} pointerEvents="none" style={StyleSheet.absoluteFill}>
          <BlurView key={over} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" intensity={100} blurReductionFactor={5}
            tint={dark ? 'systemUltraThinMaterialDark' : 'light'} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, dim]} />
      {children}
    </Squircle>
  )
}
