// A teammate's cursor over the browser's live view, like a collaborator's in Figma: an arrow in its colour with a
// name tag, gliding to wherever it points next (agent-service browser.py `_point`). While it acts, the tag also says
// what it's doing; a click sends a soft ring out from the tip.
//
// Release-build Reanimated rule (CLAUDE.md): the resting state is the rendered one. The cursor sits at its target via
// plain left/top, and only an offset animates, from where it was to 0; the ring rests invisible and only its
// entering animation shows it.
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import Animated, { Keyframe, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'

import { fonts, motion } from '@/theme'
import { Text } from '@/ui'

export interface Cursor { x: number; y: number; did: string; at: number }

const TIP = { x: 2, y: 2 } // where the arrow points, inside its 20×20 box
const ARROW = 'M2 2 L17 8.4 L10 10.3 L7.6 17.2 Z' // the head alone, no tail: points up and to the left

/** Ink or white on the teammate's colour, whichever reads. */
function inkOn(hex: string) {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0a0a0a' : '#ffffff'
}

const ring = new Keyframe({
  0: { opacity: 0.55, transform: [{ scale: 0.3 }] },
  100: { opacity: 0, transform: [{ scale: 1 }], easing: motion.ease.out },
}).duration(motion.duration.verySlow)

export function AgentCursor({ cursor, scale, name, color }: { cursor: Cursor; scale: number; name: string; color: string }) {
  const tx = cursor.x * scale
  const ty = cursor.y * scale
  // Glide: jump the offset to where it was, then ease it to 0 (its resting value).
  const [from, setFrom] = useState({ x: tx, y: ty })
  const dx = useSharedValue(0)
  const dy = useSharedValue(0)
  useEffect(() => {
    dx.set(from.x - tx)
    dy.set(from.y - ty)
    dx.set(withTiming(0, motion.timing(motion.duration.medium)))
    dy.set(withTiming(0, motion.timing(motion.duration.medium)))
    const t = setTimeout(() => setFrom({ x: tx, y: ty }), motion.duration.medium)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- glide only when the target moves
  }, [tx, ty])
  const glide = useAnimatedStyle(() => ({ transform: [{ translateX: dx.get() }, { translateY: dy.get() }] }))

  // What it's doing shows for a few seconds after each move; then the tag is just its name.
  const [quiet, setQuiet] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setQuiet(cursor.at), 3500)
    return () => clearTimeout(t)
  }, [cursor.at])
  const busy = quiet !== cursor.at
  const ink = inkOn(color)
  const clicked = /^(clicking|pressing)/.test(cursor.did)

  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: tx - TIP.x, top: ty - TIP.y }, glide]}>
      {busy && clicked && (
        <Animated.View key={cursor.at} entering={ring}
          style={{ position: 'absolute', left: TIP.x - 18, top: TIP.y - 18, width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: color, opacity: 0 }} />
      )}
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Path d={ARROW} fill="rgba(0,0,0,0.22)" transform="translate(0.6 1)" />
        <Path d={ARROW} fill={color} stroke="#ffffff" strokeWidth={1.4} strokeLinejoin="round" />
      </Svg>
      {/* The tag sits off the arrow's tail, in a row wide enough that its text never wraps. */}
      <View style={{ position: 'absolute', left: 12, top: 16, width: 240, flexDirection: 'row' }}>
        <Animated.View layout={LinearTransition.duration(motion.duration.fast)}
          style={{ flexDirection: 'row', alignItems: 'center', maxWidth: 240, backgroundColor: color, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, gap: 5 }}>
          <Text variant="footnote" style={{ color: ink, fontFamily: fonts.semibold }} numberOfLines={1}>{name}</Text>
          {busy && <Text variant="footnote" style={{ color: ink, opacity: 0.78, flexShrink: 1 }} numberOfLines={1}>{cursor.did}</Text>}
        </Animated.View>
      </View>
    </Animated.View>
  )
}
