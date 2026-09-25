import { BlurMask, Canvas, Group, LinearGradient, Path, usePathValue, vec } from '@shopify/react-native-skia'
import { useEffect } from 'react'
import { useWindowDimensions } from 'react-native'
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated'

import { useTheme } from '@/theme'

// A native port of the libraries.dev Voice glow: seven lobes rising from the bottom edge, each drawn as a
// blurred bloom, an inner light and a bright edge. Centre lobe first, then pairs outwards.
const DARK = ['rgb(255,70,120)', 'rgb(60,190,255)', 'rgb(175,70,255)', 'rgb(60,220,130)', 'rgb(255,150,40)', 'rgb(90,100,255)', 'rgb(40,200,190)']
const LIGHT = ['rgb(255,201,21)', 'rgb(126,196,255)', 'rgb(180,40,230)', 'rgb(235,100,160)', 'rgb(255,176,122)', 'rgb(154,160,255)', 'rgb(127,217,238)']
const SLOT = [0, -1, 1, -2, 2, -3, 3] // lobe i sits at SLOT[i] steps from the centre
const WEIGHT = [1, 0.86, 0.9, 0.68, 0.72, 0.5, 0.55] // the middle reaches highest
const PHASE = [0, 1.7, 3.1, 4.6, 0.9, 2.4, 5.3]
const SPEED = [1, 1.3, 0.9, 1.45, 1.15, 0.8, 1.25]

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'
const MODE: Record<VoiceState, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3 }

export function VoiceGlow({ state, level, height = 320 }: {
  state: VoiceState
  /** 0..1 microphone level while listening. */
  level: SharedValue<number>
  height?: number
}) {
  const { width } = useWindowDimensions()
  const { scheme } = useTheme()
  const mode = useSharedValue(MODE[state])
  useEffect(() => { mode.value = MODE[state] }, [state, mode])
  const heights = useSharedValue([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])

  useFrameCallback(({ timeSinceFirstFrame: t, timeSincePreviousFrame: dt }) => {
    'worklet'
    const m = mode.value
    const next = heights.value.slice()
    const ease = Math.min(1, (dt ?? 16) / 110) // ~110ms time constant: fluid, not twitchy
    const sweep = Math.sin((t / 1100) * Math.PI) * 3 // thinking: a bright band crossing side to side
    for (let i = 0; i < 7; i++) {
      const wobble = Math.sin(t * 0.0021 * SPEED[i] + PHASE[i])
      let target = 0.14 + 0.03 * wobble // idle: breathing
      if (m === 1) target = 0.18 + level.value * 1.02 * WEIGHT[i] + 0.05 * wobble
      else if (m === 2) {
        const d = SLOT[i] - sweep
        target = 0.16 + 0.55 * Math.exp(-(d * d) / 1.6) * WEIGHT[i] + 0.03 * wobble
      } else if (m === 3) {
        const syllable = Math.abs(Math.sin(t * 0.0085 * SPEED[i] + PHASE[i])) * (0.6 + 0.4 * Math.sin(t * 0.0023 + PHASE[i]))
        target = 0.22 + 0.62 * syllable * WEIGHT[i]
      }
      next[i] += (target - next[i]) * ease
    }
    heights.value = next
  })

  const colors = scheme === 'dark' ? DARK : LIGHT
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      {/* Draw the outer pairs first so the centre lobe sits on top. */}
      {[6, 5, 4, 3, 2, 1, 0].map((i) => (
        <Lobe key={i} i={i} color={colors[i]} width={width} height={height} heights={heights} dark={scheme === 'dark'} />
      ))}
    </Canvas>
  )
}

function Lobe({ i, color, width, height, heights, dark }: {
  i: number; color: string; width: number; height: number; heights: SharedValue<number[]>; dark: boolean
}) {
  const step = width / 6.2
  const cx = width / 2 + SLOT[i] * step
  const half = step * 1.25
  const path = usePathValue((p) => {
    'worklet'
    const top = height - Math.min(1.2, heights.value[i]) * height * 0.78
    p.moveTo(cx - half, height + 2)
    p.cubicTo(cx - half * 0.55, height, cx - half * 0.45, top, cx, top)
    p.cubicTo(cx + half * 0.45, top, cx + half * 0.55, height, cx + half, height + 2)
    p.close()
  })
  const blend = dark ? 'screen' : 'multiply'
  return (
    <Group blendMode={blend}>
      {/* bloom */}
      <Path path={path} color={color} opacity={dark ? 0.55 : 0.4}>
        <BlurMask blur={34} style="normal" />
      </Path>
      {/* inner light: bright at the base, fading up */}
      <Path path={path} opacity={dark ? 0.8 : 0.55}>
        <LinearGradient start={vec(0, height)} end={vec(0, height * 0.25)} colors={[color, 'transparent']} />
        <BlurMask blur={10} style="normal" />
      </Path>
      {/* edge */}
      <Path path={path} style="stroke" strokeWidth={1.5} color={color} opacity={dark ? 0.9 : 0.7}>
        <BlurMask blur={1.5} style="solid" />
      </Path>
    </Group>
  )
}
