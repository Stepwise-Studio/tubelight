import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native'
import Animated, {
  FadeIn, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming,
} from 'react-native-reanimated'
import { Cancel01Icon, Search01Icon, ViewIcon, ViewOffIcon } from '@hugeicons/core-free-icons'

import { motion, radius, type as typeScale, useTheme } from '@/theme'

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
    x.value = withSequence(t(distance.small, 80), t(-distance.small, 80), t(distance.micro, 60), t(0, 60))
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

/** Labelled text input: focus ring in tube, error shake, secure toggle, multiline, character count. */
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

  const borderColor = error ? c.danger : focused ? c.tube : c.edge
  const border = useAnimatedStyle(() => ({ borderColor: withTiming(borderColor, { duration: duration.quick }) }), [borderColor])
  const count = value?.length ?? 0
  const below = error || hint

  return (
    <View style={[{ gap: 6 }, style]}>
      {label && (
        <Text nativeID={`${id}-label`} variant="label" color={error ? 'danger' : 'ink2'} style={{ paddingLeft: 2 }}>
          {label}
        </Text>
      )}
      <AnimatedSquircle
        style={[
          {
            minHeight: 48, borderRadius: radius.md, borderWidth: 1, backgroundColor: c.panel,
            flexDirection: 'row', alignItems: multiline ? 'flex-start' : 'center', opacity: editable ? 1 : 0.5,
          },
          border, shakeStyle,
        ]}
      >
        {icon && <View style={{ paddingLeft: 14, paddingTop: multiline ? 14 : 0 }}><Icon icon={icon} size={18} color={focused ? 'ink2' : 'ink3'} /></View>}
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
          placeholderTextColor={c.ink4}
          selectionColor={c.tube}
          cursorColor={c.tube}
          keyboardAppearance={scheme}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          style={[
            typeScale.body,
            {
              flex: 1, color: c.ink, paddingHorizontal: icon ? 10 : 14,
              paddingTop: multiline ? 13 : 0, paddingBottom: multiline ? 13 : 0,
              minHeight: multiline ? 96 : 46, textAlignVertical: multiline ? 'top' : 'center',
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
                <Text variant="footnote" color={error ? 'danger' : 'ink3'} accessibilityLiveRegion={error ? 'polite' : 'none'}>
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
    <AnimatedSquircle style={[{ height: 40, borderRadius: radius.md, backgroundColor: c.panel2, flexDirection: 'row', alignItems: 'center', paddingLeft: 12 }, style]}>
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
