import { BlurTargetView, BlurView } from 'expo-blur'
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/theme'

import { Squircle } from './squircle'

// Frosted glass: a translucent tinted panel with a faint lit top edge. A real backdrop blur (expo-blur's BlurView) was
// tried and dropped: once one has been mounted on Android, the screen keeps redrawing every frame (~90 a second, idle),
// even after it is removed, so it costs battery and smoothness everywhere. Revisit if expo-blur fixes that.

// Real blur, always on and always the same: the tab capsule blurs the page behind it (per-tab scene target).
type Target = RefObject<View | null>
const targets: Record<string, Target> = {}
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }

/** A tab's page, which the glass above it blurs. */
export function SceneTarget({ name, children }: { name: string; children: ReactNode }) {
  const ref = useRef<View>(null)
  useLayoutEffect(() => {
    targets[name] = ref
    listeners.forEach((f) => f())
    return () => { delete targets[name]; listeners.forEach((f) => f()) }
  }, [name])
  return <BlurTargetView ref={ref} style={{ flex: 1 }}>{children}</BlurTargetView>
}

/** A frosted panel (a squircle). With `over` (a SceneTarget's name) the page behind it is blurred. `veil` is the tint's opacity 0–1: lower lets more of the page show through. */
export function Glass({ over, radius, veil = 0.8, style, children }: { over?: string; radius: number; veil?: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const { c, scheme } = useTheme()
  const dark = scheme === 'dark'
  const target = useSyncExternalStore(subscribe, () => (over ? targets[over] : undefined))
  return (
    <Squircle style={[{ borderRadius: radius, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }, style]}>
      {target && <BlurView blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" intensity={100} blurReductionFactor={5} tint={dark ? 'systemUltraThinMaterialDark' : 'light'} style={StyleSheet.absoluteFill} />}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dark ? `rgba(24,24,27,${veil})` : `rgba(255,255,255,${veil})` }]} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: radius / 2, right: radius / 2, height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.9)' }} />
      {children}
    </Squircle>
  )
}
