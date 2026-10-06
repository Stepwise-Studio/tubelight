/**
 * React Native (Skia) port of Libraries.dev `voice-glow` (VoiceBeam), `type="mobile"`.
 * Source: https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/voice-glow (MIT, Jakub Antalik),
 * after its own native port (ports/ios/VoiceGlowKit, Metal shaders).
 *
 * The web original paints CSS layers (inner light, edge ring, blurred bloom), an SVG displacement warp and a 2D
 * canvas band, driven per frame by `voiceDriver.ts`. Here the driver runs as-is on the UI thread and only produces
 * numbers; one GPU shader draws every layer in the stylesheet's z order, per pixel, in a single pass: the lobes'
 * radial gradients, the masks, the ring, the inset shadow, the warp under the band line (fractal noise), the
 * bloom's blur (its edge fades and softened falloff), the band's blurred strokes (exact Gaussian profiles of the
 * stacked ramp, halo included) and the light theme's epicentre wash. No layers, pictures or filters per frame.
 *
 * Tubelight patch: resolved to the `mobile` preset only; `input` is a shared value [level, low, mid, high]: the
 * raw RMS (×gain) and the three voice bands from an AnalyserNode-style FFT (modules/live-audio), for listening
 * and speaking alike; `radius` is the host's corner radius (the phone screen's); `processing` gathers the lobes
 * into one beam that travels the edge (VoiceGlow Pro's state, approximated).
 */
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia'
import { memo, useEffect, useMemo, useState } from 'react'
import { PixelRatio, View, type ViewStyle } from 'react-native'
import Animated, { FadeOut, useFrameCallback, useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated'

import { MODES, resolve, source, step, type State, type Uniforms, type VoiceBeamMode } from './glow'

export type { VoiceBeamMode } from './glow'

/** Pixels per point the glow is drawn at (the screen has ~2.6): soft light needs no more. */
const DENSITY = 1.25

const effects: Partial<Record<'dark' | 'light', ReturnType<typeof Skia.RuntimeEffect.Make>>> = {}
function effect(theme: 'dark' | 'light') {
  if (!(theme in effects)) {
    effects[theme] = Skia.RuntimeEffect.Make(source(theme === 'dark'))
    if (!effects[theme]) console.warn('voice-glow: the shader did not compile')
  }
  return effects[theme]!
}

export interface VoiceBeamProps {
  mode: VoiceBeamMode
  /** [level, low, mid, high]: the raw level (RMS × gain) and, when there is a spectrum, the three voice bands. */
  input: SharedValue<number[]>
  theme: 'dark' | 'light'
  style?: ViewStyle
  /** The host's corner radius (the phone screen's, for a full-screen host). */
  radius?: number
}

/** Fills its parent, never takes touches; draw it over the content, like the web component's layers. */
export const VoiceBeam = memo(function VoiceBeam({ mode, input, theme, style, radius = 0 }: VoiceBeamProps) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  return (
    <Animated.View exiting={FadeOut.duration(450)} pointerEvents="none"
      style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, style]}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {size.w > 0 && <Glow mode={mode} input={input} theme={theme} radius={radius} W={size.w} H={size.h} />}
    </Animated.View>
  )
})

function Glow({ mode, input, theme, radius, W, H }: { mode: VoiceBeamMode; input: SharedValue<number[]>; theme: 'dark' | 'light'; radius: number; W: number; H: number }) {
  const still = useReducedMotion()
  const k = useMemo(() => resolve(theme), [theme])
  const fx = effect(theme)
  const modeValue = useSharedValue(MODES[mode])
  const state = useSharedValue<State>({ level: 0, b0: 0, b1: 0, b2: 0, phase: 0, scanA: 0, scanT: 0, t: 0, last: 0, warp: 1, opacity: 0 })
  // Drawn at DENSITY pixels per point and scaled up to fill the host: a fraction of the screen's pixels, the same light.
  const scale = Math.max(1, PixelRatio.get() / DENSITY)
  const uniforms = useSharedValue<Uniforms>(useMemo(
    () => step({ level: 0, b0: 0, b1: 0, b2: 0, phase: 0, scanA: 0, scanT: 0, t: 0, last: 0, warp: 1, opacity: 0 }, k, 0, [0], W, H, radius, 0, true, scale),
    [k, W, H, radius, scale]))

  useEffect(() => { modeValue.value = MODES[mode] }, [mode, modeValue])

  useFrameCallback(({ timestamp }) => {
    'worklet'
    const s = state.value
    uniforms.value = step(s, k, modeValue.value, input.value, W, H, radius, timestamp, still, scale)
    state.value = s
  })

  if (!fx) return null
  return (
    <View style={{ width: W, height: H }}>
      <Canvas style={{ position: 'absolute', left: 0, top: 0, width: W / scale, height: H / scale, transform: [{ scale }], transformOrigin: 'left top' }}>
        <Fill>
          <Shader source={fx} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  )
}
