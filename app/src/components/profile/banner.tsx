// The Profile banner, live: the dither shader (banner-shader.ts) with time stepped ~12 times a second, only while
// `live` (the tab is in view and the app is open), so an idle Profile costs nothing.
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia'
import { useEffect } from 'react'
import { AppState, type LayoutChangeEvent, View, type ViewStyle } from 'react-native'
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated'

import { BANNERS, BANNER_SKSL, type BannerId } from './banner-shader'

const effect = Skia.RuntimeEffect.Make(BANNER_SKSL)
const STEP_MS = 83
const CELL = 3

export function Banner({ id, live, style }: { id: BannerId; live: boolean; style?: ViewStyle }) {
  const scene = Math.max(0, BANNERS.findIndex((b) => b.id === id))
  const size = useSharedValue({ w: 1, h: 1 })
  const t = useSharedValue(3)
  const last = useSharedValue(0)
  const tick = useFrameCallback((f) => {
    if (f.timeSinceFirstFrame - last.get() < STEP_MS) return
    last.set(f.timeSinceFirstFrame)
    t.set(t.get() + STEP_MS / 1000)
  }, false)
  useEffect(() => {
    const set = () => tick.setActive(live && AppState.currentState === 'active')
    set()
    const sub = AppState.addEventListener('change', set)
    return () => { sub.remove(); tick.setActive(false) }
  }, [live, tick])
  const uniforms = useDerivedValue(() => ({ size: [size.get().w, size.get().h], t: t.get(), scene, cell: CELL }))
  const onLayout = (e: LayoutChangeEvent) => size.set({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
  if (!effect) return <View style={[{ backgroundColor: '#09090b' }, style]} />
  return (
    <View style={style} onLayout={onLayout}>
      <Canvas style={{ flex: 1 }}>
        <Fill><Shader source={effect} uniforms={uniforms} /></Fill>
      </Canvas>
    </View>
  )
}
