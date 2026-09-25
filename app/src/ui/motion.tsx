// Ports of the transitions.dev choreographies to Reanimated. Each honours Reduce Motion
// (Reanimated layout animations skip themselves; manual ones check useReducedMotion()).
import { useEffect, useState, type ReactNode } from 'react'
import { Platform, View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import Animated, {
  FadeIn, FadeOut, Keyframe, LayoutAnimationConfig, ReduceMotion, useAnimatedProps, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated'
import Svg, { Circle, Path } from 'react-native-svg'

import { motion, type Palette, useTheme } from '@/theme'

import { Text, type TextProps } from './text'

const { duration, ease, distance } = motion

// ------------------------------------------------------------------ icon swap (09)
// scale 0.25 → 1 + opacity, 250ms, icon easing. Blur is left out: RN has no cheap view blur.
const iconIn = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.25 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: ease.icon },
}).duration(duration.fast).reduceMotion(ReduceMotion.System)
const iconOut = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.25 }], easing: ease.icon },
}).duration(duration.fast).reduceMotion(ReduceMotion.System)

/** Cross-fades two icons in one slot. Change `swapKey` to swap. First render doesn't animate. */
export function IconSwap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  return (
    <LayoutAnimationConfig skipEntering>
      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View key={swapKey} entering={iconIn} exiting={iconOut}>
          {children}
        </Animated.View>
      </View>
    </LayoutAnimationConfig>
  )
}

// ------------------------------------------------------------------ text states swap (04)
// Old label leaves up 4px, new one arrives from 4px below; 150ms ease-in-out.
const textIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: distance.micro }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: ease.inOut },
}).duration(duration.quick)
const textOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: -distance.micro }], easing: ease.inOut },
}).duration(duration.quick)

/** Swaps a text label in place ("Thinking" → "Searching inbox"). */
export function TextSwap({ children, style, ...props }: Omit<TextProps, 'children'> & { children: string; style?: StyleProp<TextStyle> }) {
  return (
    <LayoutAnimationConfig skipEntering>
      <View style={{ overflow: 'hidden' }}>
        <Animated.View key={children} entering={textIn} exiting={textOut}>
          <Text numberOfLines={1} style={style} {...props}>{children}</Text>
        </Animated.View>
      </View>
    </LayoutAnimationConfig>
  )
}

// ------------------------------------------------------------------ number pop-in (02)
// Changed digits re-enter from 8px below with the bounce ease, 500ms; last two stagger.
const digitKeyframes = [0, 70].map((stagger) => new Keyframe({
  0: { opacity: 0, transform: [{ translateY: distance.base }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: ease.bounce },
}).duration(duration.verySlow).delay(stagger))
const digitIn = (stagger: number) => digitKeyframes[stagger ? 1 : 0]

export function NumberPop({ value, style, ...props }: Omit<TextProps, 'children'> & { value: number | string }) {
  const chars = String(value).split('')
  return (
    <LayoutAnimationConfig skipEntering>
    <View style={{ flexDirection: 'row' }} accessible accessibilityLabel={String(value)}>
      {chars.map((ch, i) => {
        const fromEnd = chars.length - 1 - i
        return (
          <Animated.View key={`${i}-${ch}`} entering={digitIn(fromEnd < 2 ? (1 - fromEnd) * 70 : 0)}>
            <Text tabular style={style} {...props}>{ch}</Text>
          </Animated.View>
        )
      })}
    </View>
    </LayoutAnimationConfig>
  )
}

// ------------------------------------------------------------------ skeleton + reveal (14)
/** Placeholder block. Pulses 1 → 0.5 → 1 (1000ms, linear). */
export function Skeleton({ width, height = 12, radius = 6, style }: { width?: ViewStyle['width']; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const o = useSharedValue(1)
  useEffect(() => {
    if (reduced) return
    o.value = withRepeat(withSequence(withTiming(0.5, { duration: 500, easing: ease.linear }), withTiming(1, { duration: 500, easing: ease.linear })), -1)
  }, [o, reduced])
  const s = useAnimatedStyle(() => ({ opacity: o.value }))
  return <Animated.View accessibilityElementsHidden style={[{ width, height, borderRadius: radius, backgroundColor: c.panel2 }, s, style]} />
}

/** Cross-fades skeleton → content (400ms ease-in-out) once `ready` flips. Same box, so no jump. */
export function Reveal({ ready, skeleton, children, style }: { ready: boolean; skeleton: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      {ready ? (
        <Animated.View key="content" entering={FadeIn.duration(duration.slow)}>{children}</Animated.View>
      ) : (
        <Animated.View key="skeleton" exiting={FadeOut.duration(duration.quick)} accessibilityLabel="Loading" accessible>{skeleton}</Animated.View>
      )}
    </View>
  )
}

// ------------------------------------------------------------------ texts reveal (18)
/** Staggered rise (12px, 40ms apart, capped at 300ms) for a stack of lines. Use for infrequent entrances. */
const riseCache = new Map<number, InstanceType<typeof Keyframe>>()
const rise = (index: number) => {
  if (!riseCache.has(index)) riseCache.set(index, new Keyframe({
    0: { opacity: 0, transform: [{ translateY: distance.medium }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: ease.smoothOut },
  }).duration(duration.verySlow).delay(motion.staggerDelay(index, 60)))
  return riseCache.get(index)!
}

export function Rise({ index = 0, children, style }: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  // Reanimated web leaves delayed keyframe entrances hidden; web is only a preview, so skip it there.
  return <Animated.View entering={Platform.OS === 'web' ? undefined : rise(index)} style={style}>{children}</Animated.View>
}

// ------------------------------------------------------------------ success check (10)
const AnimatedPath = Animated.createAnimatedComponent(Path)
const CHECK_LEN = 15

/** Fade + rotate from 80° + bob, then the check draws itself (80ms intent delay). 500ms. */
export function SuccessCheck({ size = 20, color = 'success' }: { size?: number; color?: keyof Palette }) {
  const { c } = useTheme()
  const reduced = useReducedMotion()
  const p = useSharedValue(reduced ? 1 : 0)
  const draw = useSharedValue(reduced ? 1 : 0)
  useEffect(() => {
    if (reduced) return
    p.value = withTiming(1, { duration: duration.verySlow, easing: ease.smoothOut })
    draw.value = withDelay(duration.micro, withTiming(1, { duration: duration.verySlow, easing: ease.smoothOut }))
  }, [p, draw, reduced])
  const wrap = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ rotate: `${(1 - p.value) * 80}deg` }, { translateY: (1 - p.value) * distance.base }],
  }))
  const pathProps = useAnimatedProps(() => ({ strokeDashoffset: CHECK_LEN * (1 - draw.value) }))
  const col = c[color]
  return (
    <Animated.View style={wrap} accessibilityElementsHidden>
      <Svg width={size} height={size} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={9} fill={c[`${color}Soft` as keyof Palette] ?? 'transparent'} stroke={col} strokeOpacity={0.35} strokeWidth={1} />
        <AnimatedPath d="M6 10.4l2.6 2.6L14 7.4" stroke={col} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" strokeDasharray={CHECK_LEN} animatedProps={pathProps} />
      </Svg>
    </Animated.View>
  )
}

// ------------------------------------------------------------------ accordion (21)
/** Height grows/shrinks over 250ms (smooth out), symmetric. Measures its content; no jump. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [h, setH] = useState(0)
  const reduced = useReducedMotion()
  const p = useSharedValue(open ? 1 : 0)
  useEffect(() => {
    p.value = reduced ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: duration.fast, easing: ease.smoothOut })
  }, [open, p, reduced])
  const s = useAnimatedStyle(() => ({ height: h * p.value, opacity: p.value }))
  return (
    <Animated.View style={[{ overflow: 'hidden' }, s]}>
      <View style={{ position: 'absolute', left: 0, right: 0 }} onLayout={(e: LayoutChangeEvent) => setH(e.nativeEvent.layout.height)}>
        {children}
      </View>
    </Animated.View>
  )
}

/** Chevron that flips vertically (scaleY -1) as a Collapse opens. */
export function useFlip(open: boolean) {
  const p = useSharedValue(open ? 1 : 0)
  useEffect(() => { p.value = withTiming(open ? 1 : 0, { duration: duration.fast, easing: ease.smoothOut }) }, [open, p])
  return useAnimatedStyle(() => ({ transform: [{ scaleY: 1 - 2 * p.value }] }))
}
