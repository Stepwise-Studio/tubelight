import { type ReactNode } from 'react'
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'

import { haptic as haptics } from './haptics'
import { AnimatedSquircle } from './squircle'

const { duration, ease, scale: scales } = motion

/** Scale-on-press + wash, shared by every pressable primitive. */
export function usePressFeedback({ scaleTo = scales.press as number, disabled = false }: { scaleTo?: number; disabled?: boolean } = {}) {
  const reduced = useReducedMotion()
  const p = useSharedValue(0)
  const pressIn = () => { if (!disabled) p.value = withTiming(1, { duration: duration.micro, easing: ease.smoothOut }) }
  const pressOut = () => { p.value = withTiming(0, { duration: duration.quick, easing: ease.smoothOut }) }
  const to = reduced ? 1 : scaleTo
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - (1 - to) * p.value }] }))
  const washStyle = useAnimatedStyle(() => ({ opacity: p.value }))
  return { pressIn, pressOut, scaleStyle, washStyle }
}

export interface PressProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode
  /** Squircle radius of the pressable surface. */
  radius?: number
  /** Style of the squircle surface (background, padding, size). */
  style?: StyleProp<ViewStyle>
  /** Style of the outer (unclipped) wrapper: margins, elevation shadow, flex. */
  outerStyle?: StyleProp<ViewStyle>
  /** Press wash colour. Defaults to the theme wash. `null` for none. */
  wash?: string | null
  /** No scale on press, for places where motion would distract. */
  static?: boolean
  haptic?: keyof typeof haptics
  /** Corner smoothing; 0 for a true circle or capsule. Defaults to the squircle's. */
  smoothing?: number
}

/**
 * A squircle that scales to 0.96 and washes on press. Defaults to `accessibilityRole="button"`.
 * The wash is clipped by the squircle; elevation lives on `outerStyle` so the clip never cuts it.
 */
export function Press({
  children, radius = 12, style, outerStyle, wash, static: isStatic, haptic, disabled, smoothing,
  onPressIn, onPressOut, onPress, accessibilityRole = 'button', accessibilityState, ...props
}: PressProps) {
  const { c } = useTheme()
  const fb = usePressFeedback({ scaleTo: isStatic ? 1 : scales.press, disabled: !!disabled })
  const washColor = wash === undefined ? c.wash : wash
  return (
    <Animated.View style={[{ borderRadius: radius }, outerStyle, fb.scaleStyle]}>
      <Pressable
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
        onPressIn={(e) => { fb.pressIn(); onPressIn?.(e) }}
        onPressOut={(e) => { fb.pressOut(); onPressOut?.(e) }}
        onPress={(e) => { if (haptic) haptics[haptic](); onPress?.(e) }}
        {...props}
      >
        <AnimatedSquircle cornerSmoothing={smoothing} style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
          {washColor && (
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: washColor }, fb.washStyle]} />
          )}
          {children}
        </AnimatedSquircle>
      </Pressable>
    </Animated.View>
  )
}
