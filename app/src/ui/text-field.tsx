import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native'
import Animated, {
  FadeIn, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming,
} from 'react-native-reanimated'
import { Cancel01Icon, Search01Icon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons'

import { motion, type as typeScale, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon, type IconSvgElement } from './icon'
import { IconSwap } from './motion'
import { Press } from './press'
import { AnimatedSquircle } from './squircle'
import { Text } from './text'

const { duration, ease, distance } = motion

/** transitions.dev error shake: 80 / 80 / 60 / 60 ms legs, 6px swing, 4px overshoot. */
export function useShake() {
  const reduced = useReducedMotion()
  const x = useSharedValue(0)
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const shake = () => {
    if (reduced) return
    const t = (v: number, d: number) => withTiming(v, { duration: d, easing: ease.smoothOut })
    x.set(withSequence(t(distance.small, 80), t(-distance.small, 80), t(distance.micro, 60), t(0, 60)))
  }
  return { style, shake }
}

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string
  hint?: string
  /** Say what went wrong and how to fix it. Setting it shakes the field. */
  error?: string | null
  /** Shows a count against `maxLength`. */
  showCount?: boolean
  icon?: IconSvgElement
  style?: StyleProp<ViewStyle>
  /** Extra style for the input itself (e.g. a monospace font for prompts). */
  inputStyle?: StyleProp<TextStyle>
  inputRef?: Ref<TextInput>
}

/**
 * Stepwise UI's Input (ui.stepwise.studio/r/input): 44 px squircle (radius 18, smoothing 0.6), 1 px hairline
 * that turns zinc on focus and red on error, label above that darkens on focus, optional left icon whose
 * stroke thickens on focus, 12 px hint/error below, 280 ms error shake. Plus multiline and a character count.
 */
export function TextField({
  label, hint, error, showCount, icon, secureTextEntry, multiline, maxLength, value, style, inputStyle, inputRef,
  onFocus, onBlur, editable = true, ...props
}: TextFieldProps) {
  const { c, scheme } = useTheme()
  const id = useId()
  const [focused, setFocused] = useState(false)
  const [reveal, setReveal] = useState(false)
  const { style: shakeStyle, shake } = useShake()
  const lastError = useRef<string | null | undefined>(null)

  useEffect(() => {
    if (error && error !== lastError.current) { shake(); haptic.error() }
    lastError.current = error
  }, [error, shake])

  const dark = scheme === 'dark'
  const borderColor = error ? (dark ? '#ef4444' : '#f87171') : focused ? (dark ? '#d4d4d8' : '#3f3f46') : c.edge
  const quiet = dark ? '#71717a' : '#a1a1aa' // zinc-500 / zinc-400: label, icon and hint at rest
  const border = useAnimatedStyle(() => ({ borderColor: withTiming(borderColor, { duration: duration.quick }) }), [borderColor])
  const count = value?.length ?? 0
  const below = error || hint

  return (
    <View style={[{ gap: 6 }, style]}>
      {label && (
        <Text nativeID={`${id}-label`} variant="label" color={error ? 'danger' : focused ? c.ink : quiet} style={{ paddingLeft: 2, letterSpacing: -0.13 }}>
          {label}
        </Text>
      )}
      <AnimatedSquircle
        style={[
          {
            minHeight: 44, borderRadius: 18, borderWidth: 1, backgroundColor: dark ? '#18181b' : '#ffffff',
            flexDirection: 'row', alignItems: multiline ? 'flex-start' : 'center', opacity: editable ? 1 : 0.5,
          },
          border, shakeStyle,
        ]}
      >
        {icon && (
          <View style={{ paddingLeft: 13, paddingTop: multiline ? 12 : 0 }}>
            <Icon icon={icon} size={18} strokeWidth={focused ? 2 : 1.5} color={error ? c.danger : focused ? (dark ? '#d4d4d8' : '#52525b') : quiet} />
          </View>
        )}
        <TextInput
          ref={inputRef}
          accessibilityLabel={label}
          aria-invalid={!!error}
          accessibilityHint={error ?? hint}
          value={value}
          editable={editable}
          maxLength={showCount ? undefined : maxLength}
          multiline={multiline}
          secureTextEntry={secureTextEntry && !reveal}
          placeholderTextColor={quiet}
          selectionColor={c.tube}
          cursorColor={c.tube}
          keyboardAppearance={scheme}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          style={[
            typeScale.body,
            {
              flex: 1, color: c.ink, paddingLeft: icon ? 11 : 14, paddingRight: 14, letterSpacing: -0.45,
              paddingTop: multiline ? 11 : 0, paddingBottom: multiline ? 11 : 0,
              minHeight: multiline ? 96 : 42, textAlignVertical: multiline ? 'top' : 'center',
            },
            inputStyle,
          ]}
          {...props}
        />
        {secureTextEntry && (
          <Press
            radius={14}
            accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
            onPress={() => setReveal((r) => !r)}
            outerStyle={{ marginRight: 4 }}
            style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          >
            <IconSwap swapKey={reveal ? 'hide' : 'show'}>
              <Icon icon={reveal ? ViewOffIcon : ViewIcon} size={18} color="ink3" />
            </IconSwap>
          </Press>
        )}
      </AnimatedSquircle>
      {(below || showCount) && (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 2, minHeight: 16 }}>
          <View style={{ flex: 1 }}>
            {below && (
              <Animated.View key={error ? 'e' : 'h'} entering={FadeIn.duration(duration.quick)} exiting={FadeOut.duration(duration.quick)}>
                <Text variant="footnote" color={error ? 'danger' : quiet} accessibilityLiveRegion={error ? 'polite' : 'none'}>
                  {below}
                </Text>
              </Animated.View>
            )}
          </View>
          {showCount && maxLength != null && (
            <Text variant="footnote" tabular color={count > maxLength ? 'danger' : 'ink3'}>
              {count}/{maxLength}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

export interface SearchFieldProps extends Omit<TextInputProps, 'style' | 'onChangeText' | 'value'> {
  value: string
  onChangeText: (t: string) => void
  style?: StyleProp<ViewStyle>
}

/** Compact search input with a clear button. */
export function SearchField({ value, onChangeText, placeholder = 'Search', style, ...props }: SearchFieldProps) {
  const { c, scheme } = useTheme()
  return (
    <AnimatedSquircle cornerSmoothing={0} style={[{ height: 40, borderRadius: 20, backgroundColor: c.panel2, flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }, style]}>
      <Icon icon={Search01Icon} size={18} color="ink3" />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        placeholderTextColor={c.ink3}
        selectionColor={c.tube}
        cursorColor={c.tube}
        keyboardAppearance={scheme}
        returnKeyType="search"
        autoCorrect={false}
        style={[typeScale.body, { flex: 1, color: c.ink, paddingHorizontal: 8, height: 40 }]}
        {...props}
      />
      {value.length > 0 && (
        <Animated.View entering={FadeIn.duration(duration.quick)} exiting={FadeOut.duration(duration.quick)}>
          <Press radius={12} accessibilityLabel="Clear search" onPress={() => onChangeText('')} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={Cancel01Icon} size={16} color="ink3" />
          </Press>
        </Animated.View>
      )}
    </AnimatedSquircle>
  )
}
