import { Canvas, LinearGradient, Text as SkText, useFont, vec } from '@shopify/react-native-skia'
import { useEffect } from 'react'
import { Easing, cancelAnimation, useDerivedValue, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'

import { useTheme } from '@/theme'

import { Text } from './text'

const BAND = 56 // width of the bright sweep, dp
const SWEEP_MS = 1500

/**
 * A live status line: quiet text with a light sweep running through it (Claude Code / Codex style),
 * drawn with Skia so the gradient is clipped to the glyphs. Plain text until the font loads.
 */
export function ShimmerText({ text, size = 15 }: { text: string; size?: number }) {
  const { c } = useTheme()
  const font = useFont(require('@/assets/fonts/InterDisplay-Regular.ttf'), size)
  const t = useSharedValue(0)
  useEffect(() => {
    t.set(withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1))
    return () => cancelAnimation(t)
  }, [t])

  const width = font ? Math.ceil(font.measureText(text).width) + 2 : 0
  const start = useDerivedValue(() => vec(-BAND + t.value * (width + BAND), 0))
  const end = useDerivedValue(() => vec(t.value * (width + BAND), 0))

  if (!font) return <Text variant="body" color="ink3" numberOfLines={1}>{text}</Text>
  const m = font.getMetrics()
  return (
    <Canvas style={{ width, height: Math.ceil(m.descent - m.ascent) + 2 }} accessibilityLabel={text}>
      <SkText x={0} y={-m.ascent + 1} text={text} font={font}>
        <LinearGradient start={start} end={end} colors={[c.ink3, c.ink, c.ink3]} />
      </SkText>
    </Canvas>
  )
}
