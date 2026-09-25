import { Pressable, View } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { Tick02Icon } from '@hugeicons/core-free-icons'

import { motion, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { AnimatedSquircle } from './squircle'
import { Text } from './text'

const t = (v: number | string) => withTiming(v as number, { duration: motion.duration.fast, easing: motion.ease.smoothOut })

export interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  /** Describe the ON state ("Send read receipts"). */
  label?: string
  description?: string
  disabled?: boolean
}

/** Switch. On = tube. With `label`, the whole row is the hit target. */
export function Toggle({ value, onChange, label, description, disabled }: ToggleProps) {
  const { c } = useTheme()
  const track = useAnimatedStyle(() => ({ backgroundColor: withTiming(value ? c.tube : c.panel3, { duration: motion.duration.fast }) }), [value, c])
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: t(value ? 20 : 0) }] }), [value])
  const sw = (
    <Animated.View style={[{ width: 51, height: 31, borderRadius: 16, padding: 2, opacity: disabled ? 0.45 : 1 }, track]}>
      <Animated.View style={[{ width: 27, height: 27, borderRadius: 14, backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }, knob]} />
    </Animated.View>
  )
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => { haptic.tap(); onChange(!value) }}
      hitSlop={label ? 0 : 8}
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
