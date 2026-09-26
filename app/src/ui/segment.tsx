import { useState } from 'react'
import { Pressable } from 'react-native'
import Animated, { useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated'

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
  /** Page position (0..n-1) of a swipeable pager: the pill follows the finger instead of waiting for the tap. */
  progress?: SharedValue<number>
}

/**
 * Segmented control with a sliding pill (transitions.dev "tabs sliding": 250ms, smooth out).
 * The first position is written without animation, so it never slides in from 0.
 */
export function Segment<T extends string>({ value, onChange, options, accessibilityLabel, progress }: SegmentProps<T>) {
  const { c, scheme } = useTheme()
  const [width, setWidth] = useState(0)
  const [placed, setPlaced] = useState(false)
  const n = options.length
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  // Tabs are flex: 1, so every slot is the same width: inner width (minus 1px border and 3px padding each side) / n.
  const seg = width ? (width - 8) / n : 0
  const pill = useAnimatedStyle(() => {
    if (!seg) return { opacity: 0 }
    const x = progress ? 3 + progress.value * seg : 3 + index * seg
    return {
      opacity: 1,
      width: seg,
      transform: [{ translateX: progress || !placed ? x : withTiming(x, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) }],
    }
  }, [seg, index, placed])

  return (
    <Squircle
      cornerSmoothing={0}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: 'row', padding: 3, borderRadius: 21, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line }}
      onLayout={(e) => { setWidth(e.nativeEvent.layout.width); requestAnimationFrame(() => setPlaced(true)) }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          { position: 'absolute', top: 3, bottom: 3, left: 0, borderRadius: 17, backgroundColor: scheme === 'dark' ? c.panel3 : c.panel },
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

