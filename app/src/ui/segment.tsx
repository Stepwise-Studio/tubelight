import { useState } from 'react'
import { Pressable, type LayoutChangeEvent } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'

import { haptic } from './haptics'
import { elevation } from './surface'
import { Squircle } from './squircle'
import { Text } from './text'

export interface SegmentProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; count?: number }[]
  accessibilityLabel?: string
}

/**
 * Segmented control with a sliding pill (transitions.dev "tabs sliding": 250ms, smooth out).
 * The first position is written without animation, so it never slides in from 0.
 */
export function Segment<T extends string>({ value, onChange, options, accessibilityLabel }: SegmentProps<T>) {
  const { c, scheme } = useTheme()
  const [layouts, setLayouts] = useState<Record<string, { x: number; w: number }>>({})
  const [placed, setPlaced] = useState(false)
  const cur = layouts[value]
  const pill = useAnimatedStyle(() => {
    if (!cur) return { opacity: 0 }
    const t = (v: number) => (placed ? withTiming(v, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) : v)
    return { opacity: 1, width: t(cur.w), transform: [{ translateX: t(cur.x) }] }
  }, [cur, placed])

  return (
    <Squircle
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          { position: 'absolute', top: 3, bottom: 3, left: 0, borderRadius: 9, backgroundColor: scheme === 'dark' ? c.panel3 : c.panel },
          scheme === 'light' && elevation('light'),
          pill,
        ]}
      />
      {options.map((o) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.count != null ? `${o.label}, ${o.count}` : o.label}
            onLayout={(e: LayoutChangeEvent) => {
              const { x, width } = e.nativeEvent.layout
              setLayouts((l) => ({ ...l, [o.value]: { x, w: width } }))
              if (o.value === value) requestAnimationFrame(() => setPlaced(true))
            }}
            onPress={() => { if (!active) { haptic.tap(); onChange(o.value) } }}
            style={{ flex: 1, height: 34, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, paddingHorizontal: 12 }}
          >
            <Text variant="label" color={active ? 'ink' : 'ink3'}>{o.label}</Text>
            {o.count != null && o.count > 0 && <Text variant="footnote" tabular color={active ? 'ink2' : 'ink3'}>{o.count}</Text>}
          </Pressable>
        )
      })}
    </Squircle>
  )
}

