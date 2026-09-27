import { useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { useAnimatedStyle, withSequence, withSpring, withTiming } from 'react-native-reanimated'
import { Tick02Icon } from '@hugeicons/core-free-icons'

import { motion, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { AnimatedSquircle } from './squircle'
import { Text } from './text'

const t = (v: number | string) => { 'worklet'; return withTiming(v as number, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) }

export type ToggleSize = 'sm' | 'default' | 'lg'

// Stepwise UI Toggle geometry: equal gap on all four sides, knob = track height − 2 × gap.
const SIZES = {
  sm: { w: 36, h: 22, gap: 3 },
  default: { w: 44, h: 26, gap: 4 },
  lg: { w: 54, h: 32, gap: 4 },
} as const
const SPRING = { stiffness: 500, damping: 32 }

export interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  /** Describe the ON state ("Send read receipts"). */
  label?: string
  description?: string
  disabled?: boolean
  size?: ToggleSize
}

/**
 * Switch (port of Stepwise UI's Toggle). The knob springs across and squashes a little mid-travel after a real
 * flip, so it has some weight. On = tube. With `label`, the whole row is the hit target.
 */
export function Toggle({ value, onChange, label, description, disabled, size = 'default' }: ToggleProps) {
  const { c, scheme } = useTheme()
  const { w, h, gap } = SIZES[size]
  const knob = h - gap * 2
  const travel = w - knob - gap * 2
  // The squash is feedback for a real flip (by this switch or a row around it), never a first-paint effect.
  const [seen, setSeen] = useState(value)
  const [flipped, setFlipped] = useState(false)
  if (seen !== value) {
    setSeen(value)
    setFlipped(true)
  }
  const off = scheme === 'dark' ? 'rgba(63,63,70,0.7)' : 'rgba(228,228,231,0.8)'
  const track = useAnimatedStyle(() => ({ backgroundColor: withTiming(value ? c.tube : off, { duration: 200 }) }), [value, c, off])
  const knobStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: withSpring(value ? travel : 0, SPRING) },
      { scaleX: flipped ? withSequence(withTiming(1.12, { duration: 110 }), withTiming(1, { duration: 110 })) : 1 },
    ],
  }), [value, travel, flipped])
  const sw = (
    <Animated.View style={[{ width: w, height: h, borderRadius: h / 2, opacity: disabled ? 0.4 : 1 }, track]}>
      <Animated.View style={[{ position: 'absolute', top: gap, left: gap, width: knob, height: knob, borderRadius: knob / 2, backgroundColor: '#ffffff', boxShadow: '0 1px 2px rgba(0,0,0,0.12)' }, knobStyle]} />
    </Animated.View>
  )
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => { haptic.tap(); onChange(!value) }}
      hitSlop={label ? 0 : 10}
      style={label ? { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 } : undefined}
    >
      {label && (
        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium">{label}</Text>
          {description && <Text variant="caption" color="ink3">{description}</Text>}
        </View>
      )}
      {sw}
    </Pressable>
  )
}

export interface CheckboxProps {
  value: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}

/** Square check (squircle, radius 7). Label and box share one hit target. */
export function Checkbox({ value, onChange, label, disabled }: CheckboxProps) {
  const { c } = useTheme()
  const box = useAnimatedStyle(() => ({
    backgroundColor: withTiming(value ? c.ink : c.panel, { duration: motion.duration.quick }),
    borderColor: withTiming(value ? c.ink : c.edge, { duration: motion.duration.quick }),
  }), [value, c])
  const tick = useAnimatedStyle(() => ({ opacity: t(value ? 1 : 0), transform: [{ scale: t(value ? 1 : 0.25) }] }), [value])
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => { haptic.tap(); onChange(!value) }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, opacity: disabled ? 0.45 : 1 }}
    >
      <AnimatedSquircle style={[{ width: 20, height: 20, borderRadius: 7, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, box]}>
        <Animated.View style={tick}><Icon icon={Tick02Icon} size={14} color={c.panel} strokeWidth={2.5} /></Animated.View>
      </AnimatedSquircle>
      {label && <Text variant="body" style={{ flex: 1 }}>{label}</Text>}
    </Pressable>
  )
}
