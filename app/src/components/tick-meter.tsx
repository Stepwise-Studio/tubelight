import { useState } from 'react'
import { View } from 'react-native'

import { useTheme } from '@/theme'

const TICK = 2
const GAP = 2.5

/** A usage bar made of thin ticks: the used share in `color`, the rest faint. `value` 0..1; null draws an empty track
 * (no known limit). Any use at all shows at least one tick. */
export function TickMeter({ value, color, height = 18 }: { value: number | null; color: string; height?: number }) {
  const { c } = useTheme()
  const [w, setW] = useState(0)
  const n = Math.max(0, Math.floor((w + GAP) / (TICK + GAP)))
  const v = value == null ? 0 : Math.min(1, Math.max(0, value))
  const on = v > 0 ? Math.max(1, Math.round(v * n)) : 0
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height, flexDirection: 'row', gap: GAP }}
      accessible accessibilityRole="progressbar" accessibilityValue={value == null ? undefined : { min: 0, max: 100, now: Math.round(v * 100) }}>
      {Array.from({ length: n }, (_, i) => (
        <View key={i} style={{ width: TICK, height, borderRadius: 1, backgroundColor: i < on ? color : c.line }} />
      ))}
    </View>
  )
}
